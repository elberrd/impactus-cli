#!/usr/bin/env node
/** FDA Bug — plan → failing reproduction (valid RED) → fix → green suite → commit. */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import {
  artifactsExist,
  filesNonEmpty,
  validateRedReason,
  replayableRedProof,
  parseSpecLine,
  checkSpecCoverage,
  checkSpecDiagram,
} from './modules/gates.mjs';
import { resolveBriefPath, runChecklistGate } from './modules/checklist.mjs';
import { runUiGate } from './modules/ui-gate.mjs';
import { runTestsForBrief, runFocalTests, asEnvelope } from './modules/quality.mjs';
import { floorPath } from './modules/floor.mjs';
import { runSpecDeliveryClose } from './modules/spec-lifecycle.mjs';
import { OUTCOMES } from './modules/outcome.mjs';
import { changedContentSignature, createRepairTracker } from './modules/stop.mjs';
import { builderDeclaredFiles, savedPhaseKey } from './modules/utils.mjs';
import * as git from './modules/git-helper.mjs';

/** This runner's builder rounds include the RED reproduction test. */
const BUG_RESULT_FILES = /^(red_test|build|fix_\d+|fix_checklist|fix_ui)\.json$/;

/** The persisted result of an earlier phase of this fda_id, or null. */
function savedPhaseResult(run, name) {
  try {
    return JSON.parse(readFileSync(join(run.phaseResultsDir, `${name}.json`), 'utf8')).result ?? null;
  } catch {
    return null;
  }
}

await runFda(
  async ({ run, prompt, args }) => {
    // The repair cap and the no-progress window come from the student's
    // `stop:` config, with code defaults when the block is absent.
    // The tracker owns the whole round accounting (modules/stop.mjs), so the
    // rules cannot drift between this FDA and its sibling.
    const repair = createRepairTracker(run.stop);
    const briefPath = resolveBriefPath(run, args.prompt);
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the bug report'), async (ph) => {
      ph.log({ input: prompt });
    });

    const plan = await run.runPhase(
      phaseParams('plan', 'agent', 'planner', 'Locate the defect and plan reproduction + fix'),
      async (ph) => ph.call({ outputType: 'PlanOutput', prompt, gates: [artifactsExist, filesNonEmpty] }),
    );

    // RED first: the reproduction is the proof the bug exists — and later the
    // proof the fix works. Production code stays untouched until it fails.
    const redPrompt = [
      'Write ONLY a failing reproduction test for the bug below. RED rules:',
      '- NO production code changes — test file(s) only, declared in changed_files.',
      '- The test must fail with a test-level assertion (expected vs actual on the buggy behavior).',
      '- A failure from a missing module, a syntax error or a broken environment is NOT a reproduction and will be rejected.',
      '- When the brief cites a `Spec:` line, carry its marker in the test file: `// spec:NNNN covers:<ids>`.',
      '',
      `Bug report:\n${prompt}`,
    ].join('\n');
    // Whether the reproduction below is REPLAYED (reused from disk) or written
    // fresh decides what red_check does with its saved proof — see there.
    const replayedBeforeRed = run.replayed;
    const red = await run.runPhase(
      phaseParams('red_test', 'agent', 'builder', 'Write ONLY the failing reproduction test — no production code'),
      async (ph) => ph.call({ outputType: 'BuildOutput', prompt: redPrompt, previous: plan, gates: [artifactsExist] }),
    );
    const redReplayed = run.replayed > replayedBeforeRed;
    const redKey = savedPhaseKey(run, 'red_test');
    const redFiles = [...new Set([...(red.changed_files || []), ...(red.artifacts || [])])];

    const redCheck = await run.runPhase(
      phaseParams('red_check', 'code', 'quality', 'Prove the reproduction fails for the right reason before any fix'),
      async (ph) => {
        // `code` phases always re-run on resume — right for suites and commits,
        // wrong here: this is a ONE-WAY gate. Once the fix is on disk the
        // reproduction PASSES, and re-running would close the run as "bug not
        // reproduced" — a dead end that spends a recovery for zero tokens. The
        // proof is bound to the REPRODUCTION, not to a saved `build` result: a
        // builder round that reported status=fail after applying the fix, and
        // a verdict `--redo build`, both leave no build.json, and both used to
        // dead-end here (twice in one real run, 2 of its 4 recoveries). Replay
        // the proof whenever the reproduction itself was replayed; validate
        // whenever red_test wrote a new one (`--redo red_test`), dropping the
        // stale proof first so a failed validation can never be mistaken for
        // it on a later resume.
        if (!redReplayed) rmSync(join(run.phaseResultsDir, 'red_check.json'), { force: true });
        const proof = replayableRedProof({ redReplayed, proof: savedPhaseResult(run, 'red_check'), redKey });
        if (proof) {
          ph.log({
            reproduced: true,
            classification: proof.red.classification,
            note: 'already proven for this reproduction before the fix — replayed on resume',
          });
          return proof;
        }
        const result = await runFocalTests(run, redFiles);
        if (result.passed) {
          throw new Error('bug not reproduced — the reproduction test PASSED on the current code; write a test that fails on the reported behavior');
        }
        const reason = validateRedReason(result.checks.map((c) => c.output_tail).join('\n'));
        if (!reason.valid) throw new Error(`invalid RED (${reason.classification}): ${reason.note}`);
        ph.log({ reproduced: true, classification: reason.classification, files: redFiles.join(', ') });
        return { ...result, red: reason, proof_of: redKey };
      },
    );

    const fixPrompt = [
      'Fix the bug so the reproduction test (and the whole suite) passes.',
      '- Do NOT weaken, skip or delete the reproduction test — it is the proof.',
      '- Smallest correct fix; no drive-by refactors.',
      '',
      `Bug report:\n${prompt}`,
    ].join('\n');
    let previous = await run.runPhase(
      phaseParams('build', 'agent', 'builder', 'Fix the defect so the reproduction test passes'),
      async (ph) =>
        ph.call({
          outputType: 'BuildOutput',
          prompt: fixPrompt,
          previous: asEnvelope(redCheck, 'reproduction test (failing as intended)'),
          gates: [artifactsExist],
        }),
    );

    const runTestPhase = (n, { repairExecuted = false } = {}) =>
      run.runPhase(
        phaseParams(`test_${n}`, 'code', 'quality', 'Run the test suite — a known command executed by code, not an agent'),
        async (ph) => {
          // runTestsForBrief, not runTests: a bug fix must clear the regression
          // floor like any other full-suite run (modules/floor.mjs) — deleting
          // or skipping the tests that keep going red is the most tempting way
          // to "fix" a bug. A bug brief never carries `Kind: foundation`, so
          // this stays the same single test command plus the floor pass.
          let result = await runTestsForBrief(run, prompt);
          // The reproduction is this FDA's whole premise, and the regression
          // floor cannot defend it: the floor only ratchets on a GREEN suite,
          // while the reproduction exists precisely while the suite is RED —
          // so a repair round that DELETES the repro produces a green suite
          // whose counts match the old floor exactly, and the run would close
          // accepted with its own proof gone. Verified here, in code, on every
          // green round: the files must still be on disk AND still pass.
          if (result.passed) {
            const missing = redFiles.filter((f) => !existsSync(resolve(run.repoRoot, f)));
            const focal = missing.length ? null : await runFocalTests(run, redFiles);
            if (missing.length || !focal.passed) {
              const why = missing.length
                ? `the reproduction test is gone from the tree: ${missing.join(', ')} — restore it; never delete or weaken the test that proved the bug`
                : 'the reproduction test does not pass after the fix — the reported defect is still there';
              result = {
                ...result,
                passed: false,
                checks: [
                  ...result.checks,
                  {
                    name: 'repro',
                    command: 'reproduction intact (imp/fda_bug.mjs)',
                    returncode: 1,
                    passed: false,
                    duration_seconds: 0,
                    output_artifact: focal?.artifacts?.[0] || '',
                    output_tail: why,
                  },
                ],
                failures: [...result.failures, `repro: ${why}`],
              };
            }
          }
          ph.log({ passed: result.passed, checks: result.checks.length });
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
            prompt: fixPrompt,
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

      // Acceptance-checklist gate (C8): bug briefs with checkboxes must leave
      // the run reconciled too — free-form bug reports (no boxes) skip it.
      await runChecklistGate(run, briefPath);

      // UI-conformance gate: a bug fix that touched frontend component files
      // must not reintroduce banner errors, native confirms or silent
      // failures — same self-arming rule as the other FDAs (see
      // modules/ui-gate.mjs).
      await runUiGate(run, prompt);

      // Planning close-out is code, not agent memory: the last successful
      // task linked to a spec stamps its Delivery Gate and Status: done.
      const specClose = await runSpecDeliveryClose(run, prompt, briefPath);

      await run.runPhase(
        phaseParams('commit', 'code', 'git', 'Commit only after the reproduction is fixed and the suite is green'),
        async (ph) => {
          // Commit ONLY what the run itself produced (envelope-declared files) —
          // never `git add -A`, which would sweep the user's parallel WIP. The
          // union covers ALL builder rounds, not just the last envelope in hand.
          const paths = [
            ...new Set([
              ...(plan.artifacts || []),
              ...redFiles,
              ...(previous.changed_files || []),
              ...(previous.artifacts || []),
              ...builderDeclaredFiles(run, BUG_RESULT_FILES),
              ...(specClose.changed_files || []),
              // The regression floor rises on a green suite (modules/floor.mjs)
              // and rides the SAME commit as the work that raised it.
              floorPath(run.cfg?.defaults?.data_dir),
            ]),
          ];
          const message = previous.commit_message || `fia(${run.fdaId}): ${previous.summary}`;
          const { sha, committed, excluded } = git.commitPaths(message, paths, run.repoRoot, { baseline: run.baseline });
          ph.log({ sha: sha || '(nothing to commit)', message, files: committed.length });
          if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
          // Same visibility as the other tested FDAs: run-owned paths the
          // commit did not take are named in the trace, never dropped silently.
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
