#!/usr/bin/env node
/** FDA Plan Build Test — plan → build → test → commit. */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist, filesNonEmpty, parseSpecLine, checkSpecCoverage, checkSpecDiagram, isFoundationBrief } from './modules/gates.mjs';
import { resolveBriefPath, runChecklistGate } from './modules/checklist.mjs';
import { runUiGate } from './modules/ui-gate.mjs';
import { runTestsForBrief, asEnvelope } from './modules/quality.mjs';
import { floorPath } from './modules/floor.mjs';
import { runHoldoutGate } from './modules/holdout.mjs';
import { runSpecDeliveryClose } from './modules/spec-lifecycle.mjs';
import { OUTCOMES } from './modules/outcome.mjs';
import { changedContentSignature, createRepairTracker } from './modules/stop.mjs';
import { builderDeclaredFiles } from './modules/utils.mjs';
import * as git from './modules/git-helper.mjs';

await runFda(
  async ({ run, prompt, args }) => {
    // The repair cap and the no-progress window come from the student's
    // `stop:` config, with code defaults when the block is absent.
    // The tracker owns the whole round accounting (modules/stop.mjs), so the
    // rules cannot drift between this FDA and its sibling.
    const repair = createRepairTracker(run.stop);
    const briefPath = resolveBriefPath(run, args.prompt);
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the feature request'), async (ph) => {
      ph.log({ input: prompt });
    });

    const plan = await run.runPhase(
      phaseParams('plan', 'agent', 'planner', 'Produce an implementable plan before any code changes'),
      async (ph) => ph.call({ outputType: 'PlanOutput', prompt, gates: [artifactsExist, filesNonEmpty] }),
    );

    let previous = await run.runPhase(
      phaseParams('build', 'agent', 'builder', 'Implement the approved plan in the repository'),
      async (ph) => ph.call({ outputType: 'BuildOutput', prompt, previous: plan, gates: [artifactsExist] }),
    );

    const runTestPhase = (n, { repairExecuted = false } = {}) =>
      run.runPhase(
        phaseParams(`test_${n}`, 'code', 'quality', 'Run the test suite — a known command executed by code, not an agent'),
        async (ph) => {
          // Foundation briefs also run `npm run build` (runTestsForBrief) —
          // and the fix loop then repairs build failures like any red test.
          const result = await runTestsForBrief(run, prompt);
          ph.log({ passed: result.passed, checks: result.checks.map((c) => c.name).join('+') });
          // No-progress detection. The signature is CONTENT-addressed (failing
          // check names plus `path:hash` for everything this run changed), so a
          // repair that edits the same file again reads as progress — a bare
          // path list could not tell those apart. The tree is only fingerprinted
          // on a red round, so a green suite costs no extra git call.
          const round = repair.noteRound({
            passed: result.passed,
            failures: result.passed ? [] : result.checks.filter((c) => !c.passed).map((c) => c.name),
            changed: result.passed ? [] : changedContentSignature(run.repoRoot, run.baseline),
            repairExecuted,
          });
          if (!result.passed) {
            ph.log({
              identical_rounds: round.repeats,
              counted_as_a_round: round.counted,
              no_progress_window: repair.window || 'off',
              stalled: round.stalled,
            });
          }
          return result;
        },
      );

    // Every fix is followed by a test: fix_i is verified by test_{i+1}, so the
    // last repair round is never left untested.
    let test = await runTestPhase(1);
    for (let i = 1; i <= repair.cap && !test.passed && !repair.stalled; i++) {
      const replayedBefore = run.replayed;
      previous = await run.runPhase(
        phaseParams(`fix_${i}`, 'agent', 'builder', 'Repair failures reported by the test suite', { retries: 1 }),
        async (ph) =>
          ph.call({
            outputType: 'BuildOutput',
            prompt,
            previous: asEnvelope(test, 'tests'),
            gates: [artifactsExist],
          }),
      );
      // On --resume every fix_i is REPLAYED from disk as a no-op while the
      // code-kind test phases re-execute. A round behind a replayed repair
      // proves nothing and must never count toward the stall streak, or the
      // documented recovery path dead-ends before a single repair is tried.
      test = await runTestPhase(i + 1, { repairExecuted: run.replayed === replayedBefore });
    }

    // Stalled: the same checks failing over a tree the repair did not change,
    // round after round. More rounds would cost tokens and change nothing.
    if (!test.passed && repair.stalled) {
      return run.finish({
        accepted: false,
        outcome: OUTCOMES.NO_PROGRESS,
        reason:
          `the same checks failed over an unchanged tree ${repair.repeats} repair round(s) in a row — ` +
          'stopping instead of spending more of your plan',
      });
    }

    if (test.passed) {
      // Spec-coverage gate (C7): active only when the brief carries a
      // `Spec: NNNN (…)` line — briefs without one skip it, by design.
      const ref = parseSpecLine(prompt);
      await run.runPhase(
        phaseParams('spec_coverage', 'code', 'quality', 'Verify every promised spec id has a test marker covering it'),
        async (ph) => {
          if (!ref) {
            ph.log({ skipped: 'no Spec: line in the brief' });
            return;
          }
          const report = checkSpecCoverage({ specId: ref.specId, ids: ref.ids, repoRoot: run.repoRoot });
          if (!report.passed) throw new Error(`spec coverage incomplete:\n- ${report.violations.join('\n- ')}`);
          ph.log({ spec: ref.specId, covered: ref.ids.join(',') });
          // A spec with no `## Flow` diagram is a documentation gap, not a broken
          // build: it is recorded in the trace here and enforced (warn) by the
          // launch check, so a missing diagram never blocks an otherwise green run.
          const diagram = checkSpecDiagram({
            specId: ref.specId,
            aiDocsDir: process.env.FIA_AI_DOCS || 'ai-docs',
            repoRoot: run.repoRoot,
          });
          if (!diagram.passed) ph.log({ diagram: `missing — ${diagram.violations[0]}` });
        },
      );

      // Acceptance-checklist gate (C8): the brief's checkboxes must all be
      // reconciled — ticked after verification or annotated N/A — before the
      // run may close. One builder round repairs a forgotten checklist; boxes
      // that survive it fail the run (see modules/checklist.mjs).
      await runChecklistGate(run, briefPath);

      // UI-conformance gate: arms itself when the run changed frontend
      // component files (a `Surface:` line without `ui` stands it down); its
      // repair round lands in phase_results, so builderDeclaredFiles commits
      // it (see modules/ui-gate.mjs).
      await runUiGate(run, prompt);

      // Holdout probes: acceptance checks written with the brief, stored where
      // agents cannot write, run with NO repair round (modules/holdout.mjs).
      // Skips itself when imp/data/holdout/ carries no probes.
      await runHoldoutGate(run);

      // Planning close-out is code, not agent memory: the last successful
      // task linked to a spec stamps its Delivery Gate and Status: done.
      const specClose = await runSpecDeliveryClose(run, prompt, briefPath);

      await run.runPhase(
        phaseParams('commit', 'code', 'git', 'Commit only after the test suite passed'),
        async (ph) => {
          // Commit ONLY what the run itself produced (envelope-declared files) —
          // never `git add -A`, which would sweep the user's parallel WIP. The
          // union covers ALL builder rounds, not just the last envelope in hand.
          const paths = [
            ...new Set([
              ...(plan.artifacts || []),
              ...(previous.changed_files || []),
              ...(previous.artifacts || []),
              ...builderDeclaredFiles(run),
              ...(specClose.changed_files || []),
              // The regression floor rises on a green suite (modules/floor.mjs)
              // and rides the SAME commit as the work that raised it — unchanged
              // or pre-run-dirty it is filtered out by commitPaths' baseline.
              floorPath(run.cfg?.defaults?.data_dir),
              // A foundation run scaffolds far more files than any envelope can
              // enumerate — widen to everything the RUN itself changed. The
              // baseline diff keeps the engineer's pre-run WIP out either way.
              ...(isFoundationBrief(prompt) ? git.runChangedPaths(run.repoRoot, run.baseline) : []),
            ]),
          ];
          const message = previous.commit_message || `fia(${run.fdaId}): ${previous.summary}`;
          const { sha, committed, excluded } = git.commitPaths(message, paths, run.repoRoot, { baseline: run.baseline });
          ph.log({ sha: sha || '(nothing to commit)', message, files: committed.length });
          if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
          const leftover = git.runChangedPaths(run.repoRoot, run.baseline);
          if (leftover.length) ph.log({ changed_by_run_but_uncommitted: leftover.join(', ') });
        },
      );
    }

    return run.finish({
      accepted: Boolean(test.passed),
      // Reaching here still red means the configured cap was spent.
      outcome: test.passed ? null : OUTCOMES.ATTEMPT_CAP,
      reason: `suite failed after ${repair.cap} fix attempt(s)`,
    });
  },
  { agents: ['planner', 'builder', 'reviewer'] },
);
