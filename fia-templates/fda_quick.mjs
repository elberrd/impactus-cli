#!/usr/bin/env node
/** FDA Quick — guardrailed small change: build → quality → quick-log → commit. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist } from './modules/gates.mjs';
import { defaultSpecs, focalSpec, runQuality, asEnvelope } from './modules/quality.mjs';
import { appendQuickLog, setQuickLogCommit } from './modules/quicklog.mjs';
import { OUTCOMES } from './modules/outcome.mjs';
import { builderDeclaredFiles } from './modules/utils.mjs';
import * as git from './modules/git-helper.mjs';

/** This runner has a single fix round, persisted as `fix.json`. */
const QUICK_RESULT_FILES = /^(build|fix)\.json$/;

/** The persisted result of an earlier phase of this fda_id, or null. */
function savedPhaseResult(run, name) {
  try {
    return JSON.parse(readFileSync(join(run.phaseResultsDir, `${name}.json`), 'utf8')).result ?? null;
  } catch {
    return null;
  }
}

/**
 * Quick quality: lint + typecheck always; the FULL suite would be
 * disproportionate for a ≤3-file change, so tests run focally — and only when
 * the builder declared a test file.
 */
function quickSpecs(envelope, projectRoot) {
  const specs = defaultSpecs(projectRoot).filter((s) => s.name === 'lint' || s.name === 'typecheck');
  const tests = [...new Set([...(envelope.changed_files || []), ...(envelope.artifacts || [])])].filter((f) =>
    /\.(test|spec)\./.test(f),
  );
  if (tests.length) specs.push(focalSpec(tests));
  return specs;
}

await runFda(
  async ({ run, prompt }) => {
    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the quick-change request'), async (ph) => {
      ph.log({ input: prompt });
    });

    // The C6 guardrails travel INSIDE the prompt: the builder must honor the
    // registry/backend rules and abort (status:fail) when the change stops
    // being small — /quick never pushes complex work through.
    const quickPrompt = [
      'QUICK CHANGE — small, local, one obvious shape, blast radius ≤ ~3 files. Guardrails:',
      '- UI: reuse the design-system registry (ai-docs/components/registry.md) — never invent a component it already covers.',
      '- Backend: follow the stack rules in ai-docs/apis/<tech>.md.',
      '- TDD-lite: testable behavior gets ONE focal test (declare it in changed_files); visual-only work is verified by lint/build.',
      '- If mid-flight this turns out to need schema/migrations, auth/permissions, payments/billing, a new dependency, a new route/page, a new UI component, or a destructive data operation: STOP and return status:"fail" with a note routing the work to /feature (or /bug for a defect). Never push through.',
      '',
      `Change: ${prompt}`,
    ].join('\n');
    let build = await run.runPhase(
      phaseParams('build', 'agent', 'builder', 'Implement the small change inside the /quick guardrails'),
      async (ph) => ph.call({ outputType: 'BuildOutput', prompt: quickPrompt, gates: [artifactsExist] }),
    );

    const qualityPhase = (n, envelope) =>
      run.runPhase(
        phaseParams(`quality_${n}`, 'code', 'quality', 'Lint + typecheck, plus the focal test when one was declared'),
        async (ph) => {
          const result = await runQuality(run, quickSpecs(envelope, run.repoRoot));
          ph.log({ passed: result.passed, checks: result.checks.map((c) => c.name).join('/') });
          return result;
        },
      );

    // ONE repair round, by design: /quick that needs more than one fix is not
    // a quick change anymore — the run fails and routes the work to /feature.
    let quality = await qualityPhase(1, build);
    if (!quality.passed) {
      build = await run.runPhase(
        phaseParams('fix', 'agent', 'builder', 'Single repair round — a /quick that needs more is not quick', { retries: 1 }),
        async (ph) =>
          ph.call({
            outputType: 'BuildOutput',
            prompt: quickPrompt,
            previous: asEnvelope(quality, 'quality'),
            gates: [artifactsExist],
          }),
      );
      quality = await qualityPhase(2, build);
    }

    if (quality.passed) {
      const files = [
        ...new Set([...(build.changed_files || []), ...(build.artifacts || []), ...builderDeclaredFiles(run, QUICK_RESULT_FILES)]),
      ];
      const logPath = join(process.env.FIA_AI_DOCS || 'ai-docs', 'todos', 'quick-log.md');
      const logged = await run.runPhase(
        phaseParams('quicklog', 'code', 'quality', 'Append the C6 audit entry — deterministic code, from the envelope'),
        async (ph) => {
          // `code` phases always re-run on resume and the append is NOT
          // idempotent — a resumed run must reuse the entry it already wrote
          // instead of adding a second Q-NNN for the same change.
          const previous = savedPhaseResult(run, 'quicklog');
          if (previous?.id) {
            ph.log({ id: previous.id, path: logPath, note: 'entry already appended — skipped on resume' });
            return previous;
          }
          const id = appendQuickLog(logPath, {
            title: build.summary || prompt.split('\n')[0].slice(0, 80),
            files,
            verified: quality.checks.map((c) => c.name),
          });
          ph.log({ id, path: logPath });
          return { id, path: logPath };
        },
      );

      await run.runPhase(
        phaseParams('commit', 'code', 'git', 'Commit the change together with its quick-log entry'),
        async (ph) => {
          // Commit ONLY what the run itself produced — never `git add -A`.
          const paths = [...files, logPath];
          const message = build.commit_message || `fia(${run.fdaId}): ${build.summary}`;
          const { sha, committed, excluded } = git.commitPaths(message, paths, run.repoRoot, { baseline: run.baseline });
          // An entry can never name the commit that contains it, so the sha is
          // stamped afterwards — and that one-line edit is committed on its own,
          // otherwise the audit trail would read `Commit: —` forever.
          let stamped = null;
          if (sha && logged?.id && setQuickLogCommit(logPath, logged.id, sha)) {
            // The stamp edit happens NOW, after the baseline photo — no filter.
            stamped = git.commitPaths(`fia(${run.fdaId}): quick-log ${logged.id} → ${sha.slice(0, 7)}`, [logPath], run.repoRoot).sha;
          }
          ph.log({ sha: sha || '(nothing to commit)', message, files: committed.length, log: logged?.id || '—', logCommit: stamped || '—' });
          if (excluded.length) ph.log({ excluded_pre_existing: excluded.join(', ') });
        },
      );
    }

    return run.finish({
      accepted: Boolean(quality.passed),
      // /quick has a cap of exactly one repair round, by design — spending it
      // without going green IS the attempt cap, and it is known precisely here.
      outcome: quality.passed ? null : OUTCOMES.ATTEMPT_CAP,
      reason: 'quality still failing after the single /quick repair round — route the work through /feature',
    });
  },
  { agents: ['builder'] },
);
