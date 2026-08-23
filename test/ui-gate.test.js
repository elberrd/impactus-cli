import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSurfaceLine } from '../fia-templates/modules/gates.mjs';
import { FRONTEND_FILE, runUiGate, uiGateRulePlan } from '../fia-templates/modules/ui-gate.mjs';
import { expectedUiKitResolution } from '../fia-templates/modules/ui-kit-receipt.mjs';
import {
  defaultContract,
  inspectUiImplementationMaterialization,
  saveUiContract,
} from '../fia-templates/scripts/ui-contract.mjs';

// ── parseSurfaceLine ─────────────────────────────────────────────────────────

test('parseSurfaceLine: no Surface line → null (the gate still self-arms on files)', () => {
  assert.equal(parseSurfaceLine('# Task 05\n\nSpec: 0002 (S-1)\n\n## Overview'), null);
  assert.equal(parseSurfaceLine(''), null);
  assert.equal(parseSurfaceLine(null), null);
});

test('parseSurfaceLine: single and multi-token lines, lowercased and trimmed', () => {
  assert.deepEqual(parseSurfaceLine('Surface: ui'), ['ui']);
  assert.deepEqual(parseSurfaceLine('Surface: UI, API'), ['ui', 'api']);
  assert.deepEqual(parseSurfaceLine('Surface:  api '), ['api']);
});

test('parseSurfaceLine: matches at line start anywhere in the brief, not mid-line', () => {
  const brief = '# Task\n\nSpec: 0001 (S-1)\nSurface: ui\n\ntext mentioning Surface: api inline';
  assert.deepEqual(parseSurfaceLine(brief), ['ui']);
  assert.equal(parseSurfaceLine('the Surface: ui convention'), null);
});

test('parseSurfaceLine: empty token list → null', () => {
  assert.equal(parseSurfaceLine('Surface: ,'), null);
});

// ── runUiGate ────────────────────────────────────────────────────────────────

/** A git repo whose only change vs the (empty) baseline is one .tsx file. */
function seedVerifiedUiKitReceipt(repo, contract) {
  const expected = expectedUiKitResolution(contract);
  if (!expected.required) return;
  const pkgPath = join(repo, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const registryRows = [];
  for (const alternate of expected.alternate) {
    const entrypoint = join(repo, alternate.path);
    mkdirSync(dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, `export const ${alternate.surface.replaceAll('_', '')}Fixture = true;\n`);
    registryRows.push(
      `| ${alternate.surface} | data | project | ${alternate.path} | — | — | installed | default | selected |`,
    );
    if (alternate.mode !== 'custom') {
      const packageName = alternate.package.startsWith('@')
        ? alternate.package.slice(1).includes('@')
          ? alternate.package.slice(0, alternate.package.indexOf('@', 1))
          : alternate.package
        : alternate.package.replace(/@[^@]+$/, '');
      pkg.dependencies = { ...(pkg.dependencies ?? {}), [packageName]: '^1.0.0' };
    }
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  if (registryRows.length) {
    const registryPath = join(repo, 'ai-docs', 'components', 'registry.md');
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(
      registryPath,
      ['# Registry', '<!-- registry:start -->', ...registryRows, '<!-- registry:end -->', ''].join('\n'),
    );
  }
  const installedPath = join(repo, 'components', 'canonical-ui-fixture.tsx');
  mkdirSync(join(repo, 'components'), { recursive: true });
  const contents = 'export const CanonicalUiFixture = true;\n';
  writeFileSync(installedPath, contents);
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const manifestDir = join(
    repo,
    '.claude',
    'skills',
    'design-system',
    'assets',
    'canonical-next-shadcn',
  );
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    join(manifestDir, 'manifest.json'),
    JSON.stringify({
      preset: 'fia-universal',
      presetVersion: 1,
      files: [
        {
          source: 'components/canonical-ui-fixture.tsx',
          destination: 'components/canonical-ui-fixture.tsx',
          surfaces: expected.canonical,
          sha256,
        },
      ],
    }),
  );
  const receiptDir = join(repo, 'ai-docs', 'ui');
  mkdirSync(receiptDir, { recursive: true });
  writeFileSync(
    join(receiptDir, 'kit-receipt.json'),
    JSON.stringify({
      schemaVersion: 2,
      target: '.',
      preset: 'fia-universal',
      presetVersion: 1,
      sourceRoot: '.',
      surfaces: expected.canonical,
      skipped: expected.alternate,
      alternateVerification: expected.alternate.map((selected) =>
        inspectUiImplementationMaterialization(repo, selected),
      ),
      verificationStatus: 'verified',
    }),
  );
}

function uiFixture({
  testExit = 0,
  withContract = true,
  withReceipt = true,
  profile = 'enterprise-admin',
  contract = null,
} = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ui-gate-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: `node -e "process.exit(${testExit})"` } }) + '\n',
  );
  mkdirSync(join(repo, 'app'), { recursive: true });
  writeFileSync(join(repo, 'app', 'Form.tsx'), 'export const Form = () => null;\n');
  if (withContract) {
    const selectedContract = contract || defaultContract(profile);
    saveUiContract(repo, selectedContract);
    if (withReceipt) seedVerifiedUiKitReceipt(repo, selectedContract);
  }
  return repo;
}

/**
 * A minimal Run double: executes phases inline, records their params, and
 * scripts what each agent phase returns. Carries the members runSpec needs so
 * the real ui_retest phase can spawn the fixture's npm test.
 */
function fakeUiRun(repo, { onCall }) {
  const params = [];
  let seq = 0;
  const run = {
    repoRoot: repo,
    baseline: {},
    fdaId: 'ui-test',
    env: process.env,
    console: { note: () => {} },
    tracer: { event: () => {} },
    contextHandoffDir: mkdtempSync(join(tmpdir(), 'ui-gate-handoff-')),
    phases: [],
    params,
    runPhase: async (p, fn) => {
      params.push(p);
      seq += 1;
      run.phases.push({ phase_id: `t_${p.name}`, seq, params: p });
      return fn({ log: () => {}, call: async (call) => onCall(p.name, call) });
    },
  };
  return run;
}

const UI_BRIEF = '# Task 07: Patient form\n\nSpec: 0003 (S-1)\n\nBuild the patient create form.';

test('runUiGate: reject → repair → approve → retest green; ui_verify never replays', async () => {
  const repo = uiFixture({ testExit: 0 });
  const fix = { status: 'success', changed_files: ['app/Form.tsx'], artifacts: [] };
  const run = fakeUiRun(repo, {
    onCall: (name) => {
      if (name === 'ui_check') return { approved: false, blocking: ['field errors render in a banner'], findings: [] };
      if (name === 'fix_ui') return fix;
      if (name === 'ui_verify') return { approved: true, findings: [] };
      throw new Error(`unexpected agent phase ${name}`);
    },
  });
  assert.equal(await runUiGate(run, UI_BRIEF), fix);
  assert.deepEqual(
    run.params.map((p) => p.name),
    ['ui_scope', 'ui_check', 'fix_ui', 'ui_verify', 'ui_gate', 'ui_retest'],
  );
  const verify = run.params.find((p) => p.name === 'ui_verify');
  assert.equal(verify.replay, false, 'ui_verify must never replay a stale verdict on --resume');
});

test('runUiGate: repair round breaks the suite → ui_retest refuses the close', async () => {
  const repo = uiFixture({ testExit: 1 });
  const run = fakeUiRun(repo, {
    onCall: (name) => {
      if (name === 'ui_check') return { approved: false, blocking: ['x'], findings: [] };
      if (name === 'fix_ui') return { status: 'success', changed_files: ['app/Form.tsx'], artifacts: [] };
      if (name === 'ui_verify') return { approved: true, findings: [] };
      throw new Error(`unexpected agent phase ${name}`);
    },
  });
  await assert.rejects(() => runUiGate(run, UI_BRIEF), /suite went red after the UI repair round/);
});

test('runUiGate: verify still rejecting → the gate throws before any retest', async () => {
  const repo = uiFixture();
  const run = fakeUiRun(repo, {
    onCall: (name) => {
      if (name === 'ui_check') return { approved: false, blocking: ['x'], findings: [] };
      if (name === 'fix_ui') return { status: 'success', changed_files: [], artifacts: [] };
      if (name === 'ui_verify') return { approved: false, blocking: ['still broken'], findings: [] };
      throw new Error(`unexpected agent phase ${name}`);
    },
  });
  await assert.rejects(() => runUiGate(run, UI_BRIEF), /ui conformance incomplete/);
  assert.ok(!run.params.some((p) => p.name === 'ui_retest'), 'no retest after a refused gate');
});

test('runUiGate: Surface without ui stands the gate down', async () => {
  const repo = uiFixture({ withContract: false });
  const run = fakeUiRun(repo, { onCall: () => assert.fail('no agent phase may run') });
  assert.equal(await runUiGate(run, 'Surface: api\n\nBackend-only task.'), null);
  assert.deepEqual(
    run.params.map((p) => p.name),
    ['ui_scope'],
  );
});

test('runUiGate: UI work fails closed when ai-docs/ui/contract.json is missing', async () => {
  const repo = uiFixture({ withContract: false });
  const run = fakeUiRun(repo, { onCall: () => assert.fail('no agent phase may run') });
  await assert.rejects(() => runUiGate(run, UI_BRIEF), /UI contract not found/);
});

test('runUiGate: UI work fails closed before reviewer when the executable kit receipt is missing', async () => {
  const repo = uiFixture({ withReceipt: false });
  const run = fakeUiRun(repo, { onCall: () => assert.fail('no reviewer phase may run') });
  await assert.rejects(() => runUiGate(run, UI_BRIEF), /ui kit receipt incomplete: receipt_missing/);
  assert.deepEqual(
    run.params.map((p) => p.name),
    ['ui_scope'],
  );
});

test('runUiGate: product capability skips are named in the reviewer prompt', async () => {
  const repo = uiFixture({ profile: 'immersive-game' });
  let auditPrompt = '';
  const run = fakeUiRun(repo, {
    onCall: (name, call) => {
      if (name === 'ui_check') {
        auditPrompt = call.prompt;
        return { approved: true, findings: [] };
      }
      throw new Error(`unexpected agent phase ${name}`);
    },
  });
  assert.equal(await runUiGate(run, UI_BRIEF), null);
  assert.match(auditPrompt, /SKIP components\.data_table — profile_not_applicable/);
  assert.doesNotMatch(auditPrompt, /Lists of records render through.*DataTable/);
  assert.match(auditPrompt, /quality\.overflow_containment/);
});

test('runUiGate: a base-only DataTable does not activate the advanced table rubric', async () => {
  const contract = defaultContract('operational-saas');
  contract.capabilities.dataTables = true;
  const repo = uiFixture({ contract });
  let reviewerPrompt = '';
  const run = fakeUiRun(repo, {
    onCall: (name, call) => {
      if (name === 'ui_check') {
        reviewerPrompt = call.prompt;
        return { approved: true, findings: [] };
      }
      throw new Error(`unexpected agent phase ${name}`);
    },
  });

  assert.equal(await runUiGate(run, UI_BRIEF), null);
  assert.match(reviewerPrompt, /selected shared table\/data-grid implementation/i);
  assert.match(reviewerPrompt, /FIA canonical TanStack implementation/i);
  assert.match(reviewerPrompt, /one Filter control/i);
  assert.match(reviewerPrompt, /visible header button/i);
  assert.match(reviewerPrompt, /left-click/i);
  assert.match(reviewerPrompt, /right-click/i);
  assert.match(reviewerPrompt, /Shift\+F10/i);
  assert.match(reviewerPrompt, /compact removable filter chips/i);
  assert.match(reviewerPrompt, /Clear filters/i);
  assert.match(reviewerPrompt, /sort.*hide.*reset/i);
  assert.match(reviewerPrompt, /advancedControls=\{false\}/i);
  assert.match(reviewerPrompt, /no advanced-only/i);
  assert.match(reviewerPrompt, /SKIP data_table\.advanced_controls/);
  assert.doesNotMatch(
    reviewerPrompt,
    /ordered grouping lane|dedicated column-drag handle|pinning|versioned per-user|Restore defaults|sticky header|server-side sorting|virtualization/i,
  );
});

test('runUiGate: advanced DataTable rubric requires truthful grouped counts and durable restore', async () => {
  const repo = uiFixture({ profile: 'enterprise-admin' });
  let reviewerPrompt = '';
  const run = fakeUiRun(repo, {
    onCall: (name, call) => {
      if (name === 'ui_check') {
        reviewerPrompt = call.prompt;
        return { approved: true, findings: [] };
      }
      throw new Error(`unexpected agent phase ${name}`);
    },
  });

  assert.equal(await runUiGate(run, UI_BRIEF), null);
  assert.match(reviewerPrompt, /APPLY data_table\.advanced_controls/);
  assert.match(reviewerPrompt, /advancedControls.*(?:omitted|default true|pass true)/i);
  assert.match(reviewerPrompt, /ordered grouping lane/i);
  assert.match(reviewerPrompt, /leaf-record counts.*never expanded DOM leaves/i);
  assert.match(reviewerPrompt, /Restore defaults survives reload/i);
  assert.match(reviewerPrompt, /server-side sorting, filtering, and pagination/i);
});

test('runUiGate: an explicit table library keeps the universal behavior contract without canonical APIs', async () => {
  const contract = defaultContract('enterprise-admin');
  contract.implementation.surfaces.data_table = {
    mode: 'specified-library',
    package: '@mui/x-data-grid-premium',
    path: 'components/data-table/mui-grid.tsx',
    reason: 'user_explicit_specified_library',
  };
  const repo = uiFixture({ contract });
  let reviewerPrompt = '';
  const run = fakeUiRun(repo, {
    onCall: (name, call) => {
      if (name === 'ui_check') {
        reviewerPrompt = call.prompt;
        return { approved: true, findings: [] };
      }
      throw new Error(`unexpected agent phase ${name}`);
    },
  });

  assert.equal(await runUiGate(run, UI_BRIEF), null);
  assert.match(reviewerPrompt, /data_table: specified-library @mui\/x-data-grid-premium/);
  assert.match(reviewerPrompt, /explicit project\/user choice; do not replace it/i);
  assert.match(reviewerPrompt, /semantic accessible table or grid/i);
  assert.match(reviewerPrompt, /selected implementation's explicit advanced configuration/i);
  assert.doesNotMatch(reviewerPrompt, /FIA canonical TanStack|advancedControls=\{true\}/i);
});

test('uiGateRulePlan separates applicability from a future compliance verdict', () => {
  const plan = uiGateRulePlan(defaultContract('enterprise-admin'), 'Route depth: 1');
  assert.deepEqual(
    plan.find((item) => item.ruleId === 'components.data_table'),
    {
      ruleId: 'components.data_table',
      status: 'required',
      reason: 'data_dense_workflow',
      applicable: true,
      label: 'APPLY',
    },
  );
  assert.deepEqual(
    plan.find((item) => item.ruleId === 'components.kanban'),
    {
      ruleId: 'components.kanban',
      status: 'optional',
      reason: 'feature_not_requested',
      applicable: false,
      label: 'SKIP',
    },
  );
  assert.ok(plan.every((item) => !('outcome' in item)));
});

// ── FRONTEND_FILE ────────────────────────────────────────────────────────────

test('FRONTEND_FILE: components and presentation styles arm the gate', () => {
  for (const f of [
    'app/pacientes/page.tsx',
    'src/Form.jsx',
    'src/App.vue',
    'lib/Card.svelte',
    'UPPER.TSX',
    'app/globals.css',
    'styles/card.module.scss',
    'src/theme.sass',
    'src/layout.less',
  ]) {
    assert.ok(FRONTEND_FILE.test(f), `${f} should count as frontend`);
  }
  for (const f of ['convex/schema.ts', 'app/api/route.ts', 'page.tsx.bak', 'notes.md', 'x.test.ts']) {
    assert.ok(!FRONTEND_FILE.test(f), `${f} should NOT count as frontend`);
  }
});

// ── verify pass scoped to the violations ─────────────────────────────────────

test('ui_verify re-audits ONLY the violations, never the whole rubric again', async () => {
  const repo = uiFixture({ testExit: 0 });
  const calls = {};
  const run = fakeUiRun(repo, {
    onCall: (name, call) => {
      calls[name] = call;
      if (name === 'ui_check')
        return {
          approved: false,
          blocking: ['field errors render in a banner'],
          findings: [{ requirement: 'toasts after mutations', met: false, evidence: 'app/Form.tsx:12 fires before resolve' }],
        };
      if (name === 'fix_ui') return { status: 'success', changed_files: ['app/Fixed.tsx'], artifacts: [] };
      if (name === 'ui_verify') return { approved: true, findings: [] };
      throw new Error(`unexpected agent phase ${name}`);
    },
  });
  await runUiGate(run, UI_BRIEF);
  // The first audit carries the full applicable rubric…
  assert.match(calls.ui_check.prompt, /Applicable rubric/);
  // …the verify pass carries only the delta: the violations and the touched files.
  assert.match(calls.ui_verify.prompt, /Re-audit ONLY the violations/);
  assert.match(calls.ui_verify.prompt, /field errors render in a banner/);
  assert.match(calls.ui_verify.prompt, /toasts after mutations/);
  assert.match(calls.ui_verify.prompt, /app\/Fixed\.tsx/);
  assert.ok(!calls.ui_verify.prompt.includes('Applicable rubric'), 'the full rubric must not be re-sent');
  assert.ok(
    !calls.ui_verify.prompt.includes('Deterministic contract decisions'),
    'the applicability table was already settled by the first audit',
  );
  assert.match(calls.ui_verify.prompt, /do not raise new findings outside this list/);
});

// ── reviewer prompts are diff-scoped and never re-audit the UI gate's work ───

test('reviewer prompts: scope is the diff, and the general review does not re-audit patterns.md', () => {
  const system = readFileSync(new URL('../fia-templates/data/prompt_engineering/reviewer/system.md', import.meta.url), 'utf8');
  const user = readFileSync(new URL('../fia-templates/data/prompt_engineering/reviewer/user.md', import.meta.url), 'utf8');
  assert.match(user, /Your scope is the DIFF/);
  assert.match(user, /never crawl the repository/);
  assert.ok(!user.includes('Use git diff and the codebase.'), 'the repo-wide instruction must be gone');
  assert.match(system, /do NOT re-audit `ai-docs\/ui\/patterns\.md`/);
  assert.match(system, /UI conformance is owned by the dedicated UI gate/);
});
