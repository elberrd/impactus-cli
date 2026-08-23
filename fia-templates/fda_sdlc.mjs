#!/usr/bin/env node
/** FDA SDLC — plan (when the brief needs one) → build → test + repair loop → review → document. */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist, filesNonEmpty, verdictConsistent, parseSpecLine, checkSpecCoverage, checkSpecDiagram, isFoundationBrief } from './modules/gates.mjs';
import { resolveBriefPath, runChecklistGate } from './modules/checklist.mjs';
import { runUiGate } from './modules/ui-gate.mjs';
import { runTestsForBrief, asEnvelope } from './modules/quality.mjs';
import { floorPath } from './modules/floor.mjs';
import { runHoldoutGate } from './modules/holdout.mjs';
import { runSpecDeliveryClose } from './modules/spec-lifecycle.mjs';
import { OUTCOMES } from './modules/outcome.mjs';
import { changedContentSignature, createRepairTracker } from './modules/stop.mjs';
import { builderDeclaredFiles } from './modules/utils.mjs';
import { sdlcPolicyOf, briefWantsPlanner } from './modules/sdlc-policy.mjs';
import * as git from './modules/git-helper.mjs';

await runFda(
  async ({ run, cfg, prompt, args }) => {
    const sdlc = sdlcPolicyOf(cfg);
    for (const warning of sdlc.warnings) run.console.note(warning);
    // The repair cap and the no-progress window come from the student's
    // `stop:` config, with code defaults when the block is absent — the same
    // tracker the sibling FDAs use (modules/stop.mjs), so the rules cannot
    // drift between runners.
    const repair = createRepairTracker(run.stop);
    const briefPath = resolveBriefPath(run, args.prompt);
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the SDLC feature request'), async (ph) => {
      ph.log({ input: prompt });
    });

    // Planner only when the brief needs one: a sequencer brief already carries
    // scope, spec scenarios, seams and an acceptance checklist — re-planning
    // it from the repository re-spends a full planner session on work the
    // sequencer already did (see modules/sdlc-policy.mjs for the exact rule).
    let plan = null;
    if (briefWantsPlanner(prompt, sdlc.plan)) {
      plan = await run.runPhase(
        phaseParams('plan', 'agent', 'planner', 'Define scope and steps before implementation'),
        async (ph) => ph.call({ outputType: 'PlanOutput', prompt, gates: [artifactsExist, filesNonEmpty] }),
      );
    } else {
      // A free code phase so the timeline says WHY there is no plan — and the
      // name differs from 'plan' so a resume never replays a skip as a plan.
      await run.runPhase(
        phaseParams('plan_skip', 'code', 'quality', 'Skip the planner — the brief already carries the plan'),
        async (ph) => {
          ph.log({ skipped: true, mode: sdlc.plan, reason: 'self-contained brief (sections + acceptance checklist)' });
        },
      );
    }

    let previous = await run.runPhase(
      phaseParams('build', 'agent', 'builder', 'Implement according to the brief and plan'),
      async (ph) => ph.call({ outputType: 'BuildOutput', prompt, ...(plan ? { previous: plan } : {}), gates: [artifactsExist] }),
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
    // last repair round is never left untested. Repairing in-run keeps the
    // whole cycle inside one small builder session — the alternative (fail the
    // run and recover through orchestrator resumes) re-resumes every agent
    // session at full width for each round.
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

    let reconcile = null;
    let uiFix = null;
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
      // reconciled before REVIEW — the reviewer audits the ticks against the
      // diff (a false tick is grounds for rejection), and the run cannot
      // close with boxes left unchecked (see modules/checklist.mjs).
      reconcile = await runChecklistGate(run, briefPath);

      // UI-conformance gate: runs whenever this run changed frontend
      // component files (a `Surface:` line without `ui` stands it down) —
      // before review, so the reviewer sees conformance already settled
      // (see modules/ui-gate.mjs).
      uiFix = await runUiGate(run, prompt);

      // Holdout probes: acceptance checks written with the brief, stored where
      // agents cannot write, run with NO repair round (modules/holdout.mjs).
      // Skips itself when imp/data/holdout/ carries no probes.
      await runHoldoutGate(run);
    }

    // The reviewer audits work the gates must refuse anyway when the suite is
    // still red after the repair rounds — the skip is its own (free) phase so
    // the timeline stays honest, and the name differs from 'review' so a
    // post-fix resume replays nothing and runs the real review.
    let review = { approved: false, summary: 'Review skipped — the test suite is red; fix the failures first.' };
    if (test.passed) {
      review = await run.runPhase(
        // retries: 1 — an inconsistent verdict (approved=true with unmet findings)
        // gets one correction round: the reviewer re-emits either a clean approval or
        // a rejection with findings, instead of crashing the run on the gate.
        phaseParams('review', 'agent', 'reviewer', 'Confirm the build matches the original ask', { retries: 1 }),
        async (ph) =>
          ph.call({
            outputType: 'ReviewOutput',
            prompt,
            previous,
            gates: [verdictConsistent],
          }),
      );
    } else {
      await run.runPhase(
        phaseParams('review_skip', 'code', 'quality', 'Skip the review — the suite is red, there is nothing to approve'),
        async (ph) => {
          ph.log({ skipped: true, reason: 'the test suite failed — the review runs only after tests go green' });
        },
      );
    }

    // Commit and document ONLY approved, green work: a rejected build must not
    // be swept into git (commitPaths never uses `git add -A`, so the user's
    // parallel WIP stays out of FIA commits either way).
    if (test.passed && review.approved) {
      // Planning close-out is code, not agent memory: the last successful
      // task linked to a spec stamps its Delivery Gate and Status: done.
      const specClose = await runSpecDeliveryClose(run, prompt, briefPath);

      await run.runPhase(phaseParams('commit_code', 'code', 'git', 'Commit implementation after green tests and approval'), async (ph) => {
        let paths = [
          ...new Set([
            ...(plan?.artifacts || []),
            ...(previous.changed_files || []),
            ...(previous.artifacts || []),
            // The union covers ALL builder rounds (build + every fix), not just
            // the last envelope in hand — see builderDeclaredFiles.
            ...builderDeclaredFiles(run),
            // The checklist reconciliation ticks the brief itself — the run's
            // own change, committed with the work it certifies.
            ...(reconcile?.changed_files || []),
            ...(reconcile?.artifacts || []),
            // The UI repair round is the run's own change too.
            ...(uiFix?.changed_files || []),
            ...(uiFix?.artifacts || []),
            ...(specClose.changed_files || []),
            // The regression floor rises on a green suite (modules/floor.mjs) and
            // rides the SAME commit as the work that raised it — unchanged or
            // pre-run-dirty it is filtered out by commitPaths' baseline.
            floorPath(run.cfg?.defaults?.data_dir),
          ]),
        ];
        // A foundation run scaffolds far more files than any envelope can
        // enumerate — widen to everything the RUN itself changed. The baseline
        // diff keeps the engineer's pre-run WIP out either way.
        if (isFoundationBrief(prompt)) paths = [...paths, ...git.runChangedPaths(run.repoRoot, run.baseline)];
        const { sha, committed, excluded } = git.commitPaths(
          previous.commit_message || `fia(${run.fdaId}): ${previous.summary}`,
          paths,
          run.repoRoot,
          { baseline: run.baseline },
        );
        ph.log({ sha: sha || '(nothing to commit)', files: committed.length });
        if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
        const leftover = git.runChangedPaths(run.repoRoot, run.baseline);
        if (leftover.length) ph.log({ changed_by_run_but_uncommitted: leftover.join(', ') });
      });

      // Per-task documentation is opt-in (`sdlc.document: per_task`): the
      // default drains documentation ONCE per milestone — /goal dispatches
      // fda_document when a milestone closes, so 20 tasks cost one documenter
      // call instead of 20.
      if (sdlc.document === 'per_task') {
        const doc = await run.runPhase(
          phaseParams('document', 'agent', 'documenter', 'Document what shipped'),
          async (ph) => ph.call({ outputType: 'DocumentOutput', prompt, previous, gates: [artifactsExist] }),
        );

        if (doc.document_path) {
          await run.runPhase(phaseParams('commit_docs', 'code', 'git', 'Commit documentation as its own change'), async (ph) => {
            const paths = [doc.document_path, ...(doc.documented_files || [])];
            const { sha, excluded } = git.commitPaths(doc.commit_message || `docs: ${doc.summary}`, paths, run.repoRoot, {
              baseline: run.baseline,
            });
            ph.log({ sha: sha || '(nothing to commit)' });
            if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
          });
        }
      } else {
        await run.runPhase(
          phaseParams('document_skip', 'code', 'quality', 'Defer documentation to the milestone boundary'),
          async (ph) => {
            ph.log({ skipped: true, reason: 'sdlc.document: per_milestone — /goal drains docs with fda_document when the milestone closes' });
          },
        );
      }
    }

    return run.finish({
      accepted: Boolean(test.passed && review.approved),
      // Reaching here still red means the configured cap was spent; a green
      // suite with a rejected review is the plain "verification failed" that
      // finish() derives on its own.
      outcome: test.passed ? null : OUTCOMES.ATTEMPT_CAP,
      reason: test.passed ? 'the reviewer did not approve the build' : `suite failed after ${repair.cap} fix attempt(s)`,
    });
  },
  { agents: ['planner', 'builder', 'reviewer', 'documenter'] },
);
