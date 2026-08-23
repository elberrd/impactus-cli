#!/usr/bin/env node
/** FDA QA — browser verification at milestone, spec, or task boundaries. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFda, phaseParams } from './modules/fda-cli.mjs';
import { artifactsExist, verdictConsistent } from './modules/gates.mjs';
import {
  auditPrompt,
  authorPrompt,
  formatQaReport,
  parseQaCli,
  preflightFailMessage,
  qaArtifactDir,
  resolveQaScope,
  routesForQaScope,
  scopeNeedsUi,
  writeQaReport,
} from './modules/qa-gate.mjs';
import {
  clearE2eAttempt,
  ensurePlaywrightSetup,
  preflightPlaywright,
  readE2eAttempt,
  recordE2eFailure,
  repoStamp,
  runPlaywrightE2e,
  unchangedRetryError,
} from './modules/qa-playwright.mjs';
import { clearAttempt, readAttempt, recordAttemptFailure, unchangedSinceFailure } from './modules/tree-guard.mjs';
import { loadUiContract } from './scripts/ui-contract.mjs';
import { verifyUiKitReceipt } from './modules/ui-kit-receipt.mjs';

function credentialsHint(repoRoot) {
  const path = join(repoRoot, 'ai-docs', 'test-credentials.md');
  if (!existsSync(path)) {
    return 'No ai-docs/test-credentials.md yet — use Clerk test mode (+clerk_test / 424242) or skip auth-only flows.';
  }
  return 'Sign-in roster: ai-docs/test-credentials.md (never paste real secrets into tests).';
}

await runFda(
  async ({ run, cfg, prompt }) => {
    const cli = parseQaCli(prompt, cfg);
    for (const w of cli.warnings) run.console.note(w);

    await run.runPhase(phaseParams('request', 'engineer', run.engineer, 'Capture the QA scope and video policy'), async (ph) => {
      ph.log({ input: cli.scopeRaw || '(infer)', video: cli.video });
    });

    const resolved = await run.runPhase(
      phaseParams('scope', 'code', 'quality', 'Resolve milestone, spec, or task scope from ai-docs planning artifacts'),
      async (ph) => {
        const out = resolveQaScope(cli.scopeRaw, run.repoRoot);
        if (out.ambiguous) {
          throw new Error(
            `multiple scopes qualify for QA — pick one: ${out.candidates.join('; ')}`,
          );
        }
        const { scope, inferred } = out;
        ph.log({ scope: scope.label, kind: scope.kind, inferred });
        if (!scopeNeedsUi(scope, run.repoRoot)) {
          ph.log({ skipped: 'scope has no user-facing UI to exercise in a browser' });
          return { scope, skip: true, skipReason: 'API-only or non-UI scope — browser QA does not apply' };
        }
        const routes = routesForQaScope(scope, run.repoRoot);
        const contract = loadUiContract(run.repoRoot, { required: true });
        const kitReceipt = verifyUiKitReceipt(run.repoRoot, contract);
        if (kitReceipt.required && !kitReceipt.ok) {
          throw new Error(
            `ui kit receipt incomplete before browser QA: ${kitReceipt.errors
              .map((error) => error.code)
              .join(', ')}\n` +
              'Recover: `node .agents/scripts/ui-kit.mjs verify --target . --json` re-inspects the selected implementations and re-stamps ai-docs/ui/kit-receipt.json (legitimate edits to an alternate entrypoint need exactly this); a missing receipt means the kit was never installed — run `node .agents/scripts/ui-kit.mjs install --target . --json` (brownfield: /kit) first.',
          );
        }
        return {
          scope: { ...scope, routes },
          skip: false,
          routes,
          contract,
          kitReceipt,
        };
      },
    );

    if (resolved.skip) {
      const body = formatQaReport({
        scope: resolved.scope,
        e2ePassed: false,
        auditPassed: false,
        skipped: true,
        skipReason: resolved.skipReason,
        fdaId: run.fdaId,
      });
      const reportPath = writeQaReport(run.repoRoot, resolved.scope, body);
      await run.runPhase(
        phaseParams('gate', 'code', 'quality', 'Record skipped QA — no browser work required'),
        async (ph) => {
          ph.log({ report: reportPath, skipped: true });
        },
      );
      return run.finish({ accepted: true, reason: resolved.skipReason });
    }

    const artifactRelDir = qaArtifactDir(run.fdaId);

    await run.runPhase(
      phaseParams('preflight', 'code', 'quality', 'Verify Playwright and the test:e2e script are available before authoring'),
      async (ph) => {
        // Self-healing: ensurePlaywrightSetup installs @playwright/test,
        // Chromium, the config and the test:e2e script — so a missing piece is
        // installed HERE instead of failing the run with the very command this
        // code can run itself. Only a project that is not npm at all (no
        // package.json) or a setup that genuinely fails (offline, npm error)
        // still stops, with the manual commands.
        if (!existsSync(join(run.repoRoot, 'package.json'))) {
          throw new Error(`${preflightFailMessage(run.repoRoot)}\n(no package.json — browser QA needs an npm project)`);
        }
        const check = await preflightPlaywright(run.repoRoot);
        if (!check.ok) {
          ph.log({ missing: check.problems, auto_setup: true });
          run.console.note(
            `qa preflight: ${check.problems.join('; ')} — setting Playwright up now (first install downloads Chromium, give it a few minutes)`,
          );
        }
        await ensurePlaywrightSetup(run.repoRoot, {
          artifactRelDir,
          videoPolicy: cli.video,
        });
        const after = check.ok ? check : await preflightPlaywright(run.repoRoot);
        if (!after.ok) {
          throw new Error(`${preflightFailMessage(run.repoRoot)}\n(${after.problems.join('; ')})`);
        }
        ph.log({ ready: true, artifact_dir: artifactRelDir, ...(check.ok ? {} : { installed: check.problems }) });
      },
    );

    await run.runPhase(
      phaseParams('author', 'agent', 'builder', 'Author durable Playwright tests under e2e/ for the resolved scope'),
      async (ph) =>
        ph.call({
          outputType: 'BuildOutput',
          prompt: authorPrompt(resolved.scope, {
            routes: resolved.routes,
            credentialsHint: credentialsHint(run.repoRoot),
            contract: resolved.contract,
          }),
          gates: [artifactsExist],
        }),
    );

    const e2e = await run.runPhase(
      phaseParams('e2e', 'code', 'quality', 'Run Playwright e2e with configured viewports and optional video capture'),
      async (ph) => {
        // Unchanged-retry guard: a resume re-executes this phase, and a failed
        // suite on the EXACT same tree can only fail again — refuse before
        // spending anything (a real run burned 8 identical rounds this way).
        const artifactAbsDir = join(run.repoRoot, artifactRelDir);
        const stamp = repoStamp(run.repoRoot);
        const futile = unchangedRetryError({
          prior: readE2eAttempt(artifactAbsDir),
          stamp,
          fdaId: run.fdaId,
          artifactRelDir,
          override: cli.retryUnchanged || run.retryUnchanged,
        });
        if (futile) throw new Error(futile);
        const result = await runPlaywrightE2e(run, {
          artifactRelDir,
          videoPolicy: cli.video,
        });
        if (result.passed) clearE2eAttempt(artifactAbsDir);
        else recordE2eFailure(artifactAbsDir, stamp);
        ph.log({ passed: result.passed, artifact_dir: artifactRelDir });
        return result;
      },
    );

    let auditSummary = '';
    try {
      auditSummary = readFileSync(e2e.output_artifact, 'utf8').slice(-3000);
    } catch {
      /* log may be absent on catastrophic failure */
    }

    // The reviewer audit only runs on a GREEN e2e: auditing screenshots of a
    // failed run spends 1M+ reviewer tokens on a verdict the gate must refuse
    // anyway. The skip is its own (free) phase so the timeline stays honest;
    // the name differs from 'audit' so a later resume with a fixed suite
    // replays nothing and runs the real audit.
    let audit = { approved: false, summary: 'Design audit skipped — Playwright e2e failed; fix the e2e failures first.', blocking: [] };
    if (e2e.passed) {
      audit = await run.runPhase(
        phaseParams(
          'audit',
          'agent',
          'reviewer',
          'Audit screenshots and Playwright output against registry, patterns, and responsiveness',
          { retries: 1, replay: false },
        ),
        async (ph) => {
          // Unchanged-retry guard, same rule as the e2e phase above: this
          // phase re-executes on every resume (replay: false) and costs a full
          // reviewer pass — a rejected audit over the EXACT same tree can only
          // be rejected again, so refuse before spending anything.
          const artifactAbsDir = join(run.repoRoot, artifactRelDir);
          const auditStamp = repoStamp(run.repoRoot);
          const prior = readAttempt(artifactAbsDir, 'audit');
          if (unchangedSinceFailure({ prior, stamp: auditStamp, override: cli.retryUnchanged || run.retryUnchanged })) {
            throw new Error(
              `the design audit already rejected this exact tree ${prior.count === 1 ? 'once' : `${prior.count} times`} — nothing changed in the repo since, so re-auditing cannot approve.\n` +
                `Fix the violations first (report: ai-docs/qa/), then resume:\n` +
                `  node imp/fda_qa.mjs --resume --fda-id ${run.fdaId}\n` +
                'Deliberate re-audit of the same tree? Re-run with --retry-unchanged.',
            );
          }
          const verdict = await ph.call({
            outputType: 'ReviewOutput',
            prompt: auditPrompt(resolved.scope, {
              artifactDir: artifactRelDir,
              e2eSummary: auditSummary,
              routes: resolved.routes,
              contract: resolved.contract,
            }),
            gates: [verdictConsistent],
          });
          if (verdict.approved) clearAttempt(artifactAbsDir, 'audit');
          else recordAttemptFailure(artifactAbsDir, 'audit', auditStamp);
          return verdict;
        },
      );
    } else {
      await run.runPhase(
        phaseParams('audit_skip', 'code', 'quality', 'Skip the design audit — e2e failed, there is nothing to approve'),
        async (ph) => {
          ph.log({ skipped: true, reason: 'Playwright e2e failed — the design audit runs only after e2e goes green' });
        },
      );
    }

    const reportBody = formatQaReport({
      scope: resolved.scope,
      e2ePassed: e2e.passed,
      auditPassed: audit.approved,
      doneWhen: resolved.scope.doneWhen || [],
      artifactDir: artifactRelDir,
      fdaId: run.fdaId,
      notes: audit.summary || '',
      routes: resolved.routes,
      contract: resolved.contract,
      kitReceipt: resolved.kitReceipt,
    });

    const reportPath = await run.runPhase(
      phaseParams('report', 'code', 'quality', 'Write the durable QA report under ai-docs/qa/'),
      async (ph) => {
        const rel = writeQaReport(run.repoRoot, resolved.scope, reportBody);
        ph.log({ report: rel });
        return rel;
      },
    );

    await run.runPhase(
      phaseParams('gate', 'code', 'quality', 'Refuse to close while e2e or the design audit failed'),
      async (ph) => {
        if (!e2e.passed) {
          throw new Error(
            `Playwright e2e failed — see ${artifactRelDir}/playwright.log\n` +
              'Fix the failures first (/bug for app defects, /task for missing work) — re-running QA on an unchanged repo is refused by the e2e guard.',
          );
        }
        if (!audit.approved) {
          const blocking = [...(audit.blocking || []), ...(audit.findings || []).filter((f) => !f.met).map((f) => f.requirement)];
          throw new Error(`QA design audit failed:\n- ${blocking.join('\n- ')}`);
        }
        ph.log({ report: reportPath, passed: true });
      },
    );

    return run.finish({
      accepted: true,
      reason: 'browser QA passed',
    });
  },
  { agents: ['builder', 'reviewer'] },
);
