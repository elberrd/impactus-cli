#!/usr/bin/env node
/** FDA Prototype — build → lint/typecheck → commit (no plan, no tests, no review). */
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist, isFoundationBrief, isPrototypeBrief } from './modules/gates.mjs';
import { defaultSpecs, runQuality, asEnvelope } from './modules/quality.mjs';
import { OUTCOMES } from './modules/outcome.mjs';
import { builderDeclaredFiles } from './modules/utils.mjs';
import * as git from './modules/git-helper.mjs';

/** This runner has a single fix round, persisted as `fix.json`. */
const PROTOTYPE_RESULT_FILES = /^(build|fix)\.json$/;

function protoSpecs(projectRoot) {
  return defaultSpecs(projectRoot).filter((s) => s.name === 'lint' || s.name === 'typecheck');
}

await runFda(
  async ({ run, prompt }) => {
    // This runner commits without tests/review. A plain script invocation is
    // not enough authorization to weaken a normal task: the brief must carry
    // the explicit marker that /task and /goal route deterministically.
    if (!isPrototypeBrief(prompt)) {
      throw new Error(
        'fda_prototype requires an explicit `Mode: prototype` line in the brief — ' +
          'use fda_build_test/fda_plan_build_test for normal work',
      );
    }
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the prototype request'), async (ph) => {
      ph.log({ input: prompt });
    });

    let build = await run.runPhase(
      phaseParams('build', 'agent', 'builder', 'Implement the prototype — speed over correctness'),
      async (ph) => ph.call({ outputType: 'BuildOutput', prompt, gates: [artifactsExist] }),
    );

    let quality = await run.runPhase(
      phaseParams('quality_1', 'code', 'quality', 'Lint + typecheck only — no test suite'),
      async (ph) => {
        const result = await runQuality(run, protoSpecs(run.repoRoot));
        ph.log({ passed: result.passed, checks: result.checks.map((c) => c.name).join('/') });
        return result;
      },
    );

    if (!quality.passed) {
      build = await run.runPhase(
        phaseParams('fix', 'agent', 'builder', 'Single repair round for lint/typecheck failures', { retries: 1 }),
        async (ph) =>
          ph.call({
            outputType: 'BuildOutput',
            prompt,
            previous: asEnvelope(quality, 'quality'),
            gates: [artifactsExist],
          }),
      );
      quality = await run.runPhase(
        phaseParams('quality_2', 'code', 'quality', 'Lint + typecheck after repair'),
        async (ph) => {
          const result = await runQuality(run, protoSpecs(run.repoRoot));
          ph.log({ passed: result.passed, checks: result.checks.map((c) => c.name).join('/') });
          return result;
        },
      );
    }

    if (quality.passed) {
      await run.runPhase(
        phaseParams('commit', 'code', 'git', 'Commit the prototype'),
        async (ph) => {
          const paths = [
            ...new Set([
              ...(build.changed_files || []),
              ...(build.artifacts || []),
              ...builderDeclaredFiles(run, PROTOTYPE_RESULT_FILES),
              ...(isFoundationBrief(prompt) ? git.runChangedPaths(run.repoRoot, run.baseline) : []),
            ]),
          ];
          const message = build.commit_message || `fia(${run.fdaId}): ${build.summary}`;
          const { sha, committed, excluded } = git.commitPaths(message, paths, run.repoRoot, { baseline: run.baseline });
          ph.log({ sha: sha || '(nothing to commit)', message, files: committed.length });
          if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
        },
      );
    }

    return run.finish({
      accepted: Boolean(quality.passed),
      outcome: quality.passed ? null : OUTCOMES.ATTEMPT_CAP,
      reason: 'lint/typecheck still failing after the single repair round',
    });
  },
  { agents: ['builder'] },
);
