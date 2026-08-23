import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import {
  OUTCOMES,
  TERMINAL_OUTCOMES,
  classifyFailure,
  isTerminalOutcome,
  outcomeIsSuccess,
  outcomeLabel,
} from '../fia-templates/modules/outcome.mjs';
import {
  STOP_DEFAULTS,
  StopCondition,
  changedContentSignature,
  createProgressTracker,
  createRepairTracker,
  progressSignature,
  stopPolicyOf,
} from '../fia-templates/modules/stop.mjs';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';
import { phaseParams } from '../fia-templates/modules/fda-cli.mjs';
// The real error classes, imported from the real modules: outcome.mjs must
// classify them by duck typing (it may never import them — that would be a
// cycle), so the proof has to use genuine instances.
import { EngineFailure, GateFailure } from '../fia-templates/modules/agents.mjs';
import { PermissionBreach } from '../fia-templates/modules/permissions.mjs';

const REPO = join(import.meta.dirname, '..');

function makeRun(root, id, opts, extraCfg = {}) {
  const cfg = { defaults: { data_dir: root }, observability: { db: join(root, 'fia.db') }, ...extraCfg };
  const tracer = new Tracer(cfg.observability.db, join(root, 'sessions', id, 'events.jsonl'));
  tracer.sessionStart(id, 'Tester', 'fda_test');
  return new Run(cfg, id, tracer, 'Tester', opts);
}

function sessionRow(run) {
  return run.tracer.db.prepare('SELECT status, outcome, outcome_reason FROM sessions WHERE fda_id=?').get(run.fdaId);
}

// ── the vocabulary ───────────────────────────────────────────────────────────

test('outcomes: the vocabulary is frozen, complete and listed in a stable order', () => {
  assert.deepEqual(TERMINAL_OUTCOMES, [
    'goal_met',
    'verification_failed',
    'attempt_cap',
    'no_progress',
    'budget_exhausted',
    'breadth_exceeded',
    'blocked_by_gate',
    'engine_exhausted',
    'stopped_by_request',
    'aborted',
    'failed',
  ]);
  assert.equal(TERMINAL_OUTCOMES.length, Object.keys(OUTCOMES).length);
  for (const value of Object.values(OUTCOMES)) assert.ok(isTerminalOutcome(value), `${value} must be terminal`);
});

test('outcomes: only goal_met is a success, and every outcome has a short English label', () => {
  assert.equal(outcomeIsSuccess(OUTCOMES.GOAL_MET), true);
  for (const value of TERMINAL_OUTCOMES.filter((v) => v !== 'goal_met')) {
    assert.equal(outcomeIsSuccess(value), false, `${value} must not read as success`);
  }
  assert.equal(outcomeLabel(OUTCOMES.GOAL_MET), 'goal met');
  assert.equal(outcomeLabel(OUTCOMES.NO_PROGRESS), 'no progress');
  for (const value of TERMINAL_OUTCOMES) {
    assert.match(outcomeLabel(value), /^[a-z]/);
    assert.notEqual(outcomeLabel(value), 'unknown outcome');
  }
  assert.equal(outcomeLabel('not_a_real_outcome'), 'unknown outcome');
});

test('isTerminalOutcome: non-strings and unknown words are not outcomes', () => {
  for (const value of [undefined, null, 42, {}, [], '', 'GOAL_MET', 'goal met']) {
    assert.equal(isTerminalOutcome(value), false, `${JSON.stringify(value)} must not be terminal`);
  }
});

// ── classifyFailure ──────────────────────────────────────────────────────────

test('classifyFailure: real gate/permission/engine errors map to their outcome despite the inherited name', () => {
  const gate = new GateFailure('artifactsExist: declared file missing');
  const breach = new PermissionBreach('builder wrote outside its allowed paths');
  const engine = new EngineFailure('claude exited 1', { kind: 'crash', coding_agent: 'claude_code', model: 'sonnet' });
  // The trap this guards: `class X extends Error {}` inherits name 'Error'.
  assert.equal(gate.name, 'Error');
  assert.equal(breach.name, 'Error');
  assert.equal(engine.name, 'Error');
  assert.equal(classifyFailure(gate), OUTCOMES.BLOCKED_BY_GATE);
  assert.equal(classifyFailure(breach), OUTCOMES.BLOCKED_BY_GATE);
  assert.equal(classifyFailure(engine), OUTCOMES.ENGINE_EXHAUSTED);
});

test('classifyFailure: a StopCondition reports its own outcome verbatim', () => {
  const stop = new StopCondition(OUTCOMES.BUDGET_EXHAUSTED, 'the time budget is used up');
  assert.equal(stop.name, 'StopCondition');
  assert.equal(classifyFailure(stop), OUTCOMES.BUDGET_EXHAUSTED);
  assert.equal(classifyFailure(new StopCondition(OUTCOMES.BREADTH_EXCEEDED, 'too wide')), OUTCOMES.BREADTH_EXCEEDED);
});

test('classifyFailure: anything else is failed, and an explicit name still works', () => {
  assert.equal(classifyFailure(new Error('boom')), OUTCOMES.FAILED);
  assert.equal(classifyFailure(new TypeError('x is not a function')), OUTCOMES.FAILED);
  assert.equal(classifyFailure(undefined), OUTCOMES.FAILED);
  assert.equal(classifyFailure({}), OUTCOMES.FAILED);
  const named = new Error('gate refused');
  named.name = 'GateFailure';
  assert.equal(classifyFailure(named), OUTCOMES.BLOCKED_BY_GATE);
});

test('classifyFailure: the marker as CONTENT is not a classification', () => {
  // A message that merely TALKS about a gate, or a bogus outcome value, must
  // not be promoted — only the error's identity classifies it.
  const chatty = new Error('the builder reported GateFailure and EngineFailure in its summary');
  assert.equal(classifyFailure(chatty), OUTCOMES.FAILED);
  const lying = new Error('nice try');
  lying.outcome = 'goal_met_please';
  assert.equal(classifyFailure(lying), OUTCOMES.FAILED);
  const notString = new Error('nice try');
  notString.outcome = { outcome: 'goal_met' };
  assert.equal(classifyFailure(notString), OUTCOMES.FAILED);
});

// ── stopPolicyOf ─────────────────────────────────────────────────────────────

test('stopPolicyOf: an absent config or an absent stop block is exactly the defaults', () => {
  for (const cfg of [undefined, null, {}, { stop: undefined }, { stop: 'nonsense' }, { defaults: {} }]) {
    const policy = stopPolicyOf(cfg);
    assert.equal(policy.attempt_cap, STOP_DEFAULTS.attempt_cap);
    assert.equal(policy.no_progress_window, STOP_DEFAULTS.no_progress_window);
    assert.equal(policy.budget_minutes, 0);
    assert.equal(policy.breadth_ceiling, 0);
    assert.deepEqual(policy.warnings, []);
  }
});

test('stopPolicyOf: overrides win, 0 turns the optional limits off, attempt_cap is clamped to >= 1', () => {
  const policy = stopPolicyOf({
    stop: { attempt_cap: 5, no_progress_window: 0, budget_minutes: 45, breadth_ceiling: 12 },
  });
  assert.deepEqual(policy, {
    attempt_cap: 5,
    no_progress_window: 0,
    budget_minutes: 45,
    breadth_ceiling: 12,
    token_budget: STOP_DEFAULTS.token_budget,
    phase_token_budget: STOP_DEFAULTS.phase_token_budget,
    phase_timeout_minutes: STOP_DEFAULTS.phase_timeout_minutes,
    warnings: [],
  });
  assert.equal(stopPolicyOf({ stop: { token_budget: 0, phase_token_budget: 0, phase_timeout_minutes: 0 } }).token_budget, 0);
  assert.equal(stopPolicyOf({ stop: { attempt_cap: 0 } }).attempt_cap, 1);
  assert.equal(stopPolicyOf({ stop: { budget_minutes: '30' } }).budget_minutes, 30, 'a YAML string number is accepted');
  assert.equal(stopPolicyOf({ stop: { breadth_ceiling: 8.7 } }).breadth_ceiling, 8);
});

test('stopPolicyOf: every bad value keeps the default and warns in English, naming key and value', () => {
  for (const [key, bad] of [
    ['attempt_cap', 'many'],
    ['no_progress_window', -1],
    ['budget_minutes', 'soon'],
    ['breadth_ceiling', -5],
  ]) {
    const policy = stopPolicyOf({ stop: { [key]: bad } });
    assert.equal(policy[key], STOP_DEFAULTS[key], `${key} must keep its default`);
    assert.equal(policy.warnings.length, 1);
    assert.match(policy.warnings[0], new RegExp(`stop\\.${key}`));
    assert.ok(policy.warnings[0].includes(JSON.stringify(bad)), 'the warning must quote the bad value');
    assert.match(policy.warnings[0], /keeping the default/);
  }
  assert.equal(stopPolicyOf({ stop: { attempt_cap: 'x', budget_minutes: 'y' } }).warnings.length, 2);
  assert.doesNotThrow(() => stopPolicyOf({ stop: { attempt_cap: {} } }));
});

// ── progressSignature + tracker ──────────────────────────────────────────────

test('progressSignature: order-insensitive, duplicate-insensitive and sha1-shaped', () => {
  const a = progressSignature({ failures: ['lint', 'tests'], changed: ['src/a.ts', 'src/b.ts'] });
  const b = progressSignature({ failures: ['tests', 'lint'], changed: ['src/b.ts', 'src/a.ts'] });
  const c = progressSignature({ failures: ['tests', 'lint', 'lint'], changed: ['src/b.ts', 'src/a.ts', 'src/a.ts'] });
  assert.equal(a, b);
  assert.equal(a, c);
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.equal(progressSignature(), progressSignature({ failures: [], changed: [] }));
});

test('progressSignature: a different failure set or a different file set is a different signature', () => {
  const base = progressSignature({ failures: ['tests'], changed: ['src/a.ts'] });
  assert.notEqual(base, progressSignature({ failures: ['lint'], changed: ['src/a.ts'] }));
  assert.notEqual(base, progressSignature({ failures: ['tests'], changed: ['src/b.ts'] }));
  assert.notEqual(base, progressSignature({ failures: ['tests', 'lint'], changed: ['src/a.ts'] }));
  // A name that contains the separator must not collide with two names.
  assert.notEqual(
    progressSignature({ failures: ['a b'] }),
    progressSignature({ failures: ['a', 'b'] }),
    'a check name containing a space must not look like two checks',
  );
  // The two halves must not bleed into each other either.
  assert.notEqual(progressSignature({ failures: ['x'] }), progressSignature({ changed: ['x'] }));
});

test('createProgressTracker: counts consecutive repeats, resets on a change, exhausts at the window', () => {
  const tracker = createProgressTracker(2);
  assert.deepEqual(tracker.note('aaa'), { repeats: 1, exhausted: false });
  assert.deepEqual(tracker.note('aaa'), { repeats: 2, exhausted: true });
  assert.deepEqual(tracker.note('bbb'), { repeats: 1, exhausted: false }, 'a new signature must reset the streak');
  assert.equal(tracker.repeats, 1);
  assert.equal(tracker.last, 'bbb');
  assert.deepEqual(tracker.note('bbb'), { repeats: 2, exhausted: true });
});

test('createProgressTracker: window 0 (and any junk window) turns the detector off forever', () => {
  for (const window of [0, -3, undefined, null, 'two', NaN]) {
    const tracker = createProgressTracker(window);
    for (let i = 0; i < 6; i++) assert.equal(tracker.note('same').exhausted, false);
    assert.equal(tracker.repeats, 6);
  }
  assert.equal(createProgressTracker(1).note('same').exhausted, true, 'window 1 stops after a single round');
});

// ── the tracer columns + migration ───────────────────────────────────────────

test('tracer: a database created WITHOUT the outcome columns is migrated in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const dbPath = join(root, 'legacy.db');
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE sessions (
    fda_id TEXT PRIMARY KEY, fda_name TEXT, request TEXT, status TEXT, engineer TEXT,
    started_at TEXT, ended_at TEXT, total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0
  );`);
  legacy.close();

  const tracer = new Tracer(dbPath, join(root, 'events.jsonl'));
  const columns = new Set(
    tracer.db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .map((c) => c.name),
  );
  assert.ok(columns.has('outcome'), 'the migration must add outcome');
  assert.ok(columns.has('outcome_reason'), 'the migration must add outcome_reason');

  tracer.sessionStart('legacy1', 'Tester', 'fda_test');
  tracer.sessionFinish('legacy1', false, { outcome: OUTCOMES.NO_PROGRESS, reason: 'the same failures twice' });
  const row = tracer.db.prepare('SELECT status, outcome, outcome_reason FROM sessions WHERE fda_id=?').get('legacy1');
  assert.equal(row.status, 'fail');
  assert.equal(row.outcome, OUTCOMES.NO_PROGRESS);
  assert.equal(row.outcome_reason, 'the same failures twice');

  // Idempotent: reopening the same database must not fail on an ALTER re-run.
  assert.doesNotThrow(() => new Tracer(dbPath, join(root, 'events.jsonl')));
});

test('tracer: a two-argument sessionFinish keeps working and never clears a stored outcome', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const tracer = new Tracer(join(root, 'fia.db'), join(root, 'events.jsonl'));
  tracer.sessionStart('two1', 'Tester', 'fda_test');
  tracer.sessionFinish('two1', false, { outcome: OUTCOMES.BLOCKED_BY_GATE, reason: 'gate refused' });
  tracer.sessionFinish('two1', false);
  const row = tracer.db.prepare('SELECT status, outcome, outcome_reason FROM sessions WHERE fda_id=?').get('two1');
  assert.equal(row.status, 'fail');
  assert.equal(row.outcome, OUTCOMES.BLOCKED_BY_GATE, 'a vaguer later write must not erase the precise one');
  assert.equal(row.outcome_reason, 'gate refused');
});

// ── Run.settle / finish ──────────────────────────────────────────────────────

test('settle: first writer wins — the precise reason is never overwritten', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const run = makeRun(root, 's1');
  assert.equal(run.settled, false);
  assert.equal(run.settle(OUTCOMES.ABORTED, 'the run was interrupted by a signal'), OUTCOMES.ABORTED);
  assert.equal(run.settled, true);
  assert.equal(run.settle(OUTCOMES.GOAL_MET, 'too late'), OUTCOMES.ABORTED);
  assert.equal(run.outcome, OUTCOMES.ABORTED);
  assert.equal(run.outcomeReason, 'the run was interrupted by a signal');
  const row = sessionRow(run);
  assert.equal(row.status, 'fail');
  assert.equal(row.outcome, OUTCOMES.ABORTED);

  // And a later finish() reports the settled outcome instead of inventing one
  // (a run with no phase at all is not ok, so the exit code stays 1).
  assert.equal(run.finish({ accepted: true }), 1);
  assert.equal(sessionRow(run).outcome, OUTCOMES.ABORTED);
  assert.equal(sessionRow(run).outcome_reason, 'the run was interrupted by a signal');
});

test('settle: exactly one run_end event is traced, carrying the outcome and the totals', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const run = makeRun(root, 's2');
  run.settle(OUTCOMES.NO_PROGRESS, 'stalled');
  run.settle(OUTCOMES.FAILED, 'ignored');
  const rows = run.tracer.db.prepare("SELECT name, payload_json FROM events WHERE type='run_end'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, OUTCOMES.NO_PROGRESS);
  const payload = JSON.parse(rows[0].payload_json);
  assert.equal(payload.outcome, OUTCOMES.NO_PROGRESS);
  assert.equal(payload.reason, 'stalled');
  assert.equal(payload.accepted, false);
  assert.equal(payload.phases, 0);
  assert.equal(payload.tokens, 0);
});

test('finish: a green run settles goal_met and stays synchronous, returning 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const run = makeRun(root, 'f1');
  await run.runPhase(phaseParams('plan', 'engineer', 'engineer', 'Capture the ask'), async () => ({ ok: true }));
  const code = run.finish({ accepted: true });
  assert.equal(code, 0, 'finish must return the exit code synchronously');
  assert.equal(run.outcome, OUTCOMES.GOAL_MET);
  const row = sessionRow(run);
  assert.equal(row.status, 'success');
  assert.equal(row.outcome, OUTCOMES.GOAL_MET);
});

test('finish: accepted:false derives verification_failed; an explicit outcome wins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const run = makeRun(root, 'f2');
  await run.runPhase(phaseParams('test_1', 'code', 'quality', 'Run the suite'), async () => ({ passed: false }));
  assert.equal(run.finish({ accepted: false, reason: 'the suite stayed red' }), 1);
  const row = sessionRow(run);
  assert.equal(row.status, 'fail');
  assert.equal(row.outcome, OUTCOMES.VERIFICATION_FAILED);
  assert.equal(row.outcome_reason, 'the suite stayed red');

  const other = makeRun(root, 'f3');
  await other.runPhase(phaseParams('test_1', 'code', 'quality', 'Run the suite'), async () => ({ passed: false }));
  assert.equal(other.finish({ accepted: false, outcome: OUTCOMES.NO_PROGRESS, reason: 'same failures twice' }), 1);
  assert.equal(sessionRow(other).outcome, OUTCOMES.NO_PROGRESS);

  // A junk outcome is ignored, never stored — the derivation still applies.
  const third = makeRun(root, 'f4');
  await third.runPhase(phaseParams('test_1', 'code', 'quality', 'Run the suite'), async () => ({ passed: false }));
  assert.equal(third.finish({ accepted: false, outcome: 'whatever' }), 1);
  assert.equal(sessionRow(third).outcome, OUTCOMES.VERIFICATION_FAILED);
});

test('runPhase: a GateFailure thrown inside a phase settles blocked_by_gate and still rethrows', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const run = makeRun(root, 'g1');
  await assert.rejects(
    () =>
      run.runPhase(phaseParams('build', 'agent', 'builder', 'Implement the plan'), async () => {
        throw new GateFailure('artifactsExist: src/missing.ts was declared but does not exist');
      }),
    /artifactsExist/,
  );
  assert.equal(run.outcome, OUTCOMES.BLOCKED_BY_GATE);
  const row = sessionRow(run);
  assert.equal(row.status, 'fail');
  assert.equal(row.outcome, OUTCOMES.BLOCKED_BY_GATE);
  assert.match(row.outcome_reason, /artifactsExist/);
});

test('runPhase: a plain failure settles failed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const run = makeRun(root, 'g2');
  await assert.rejects(
    () =>
      run.runPhase(phaseParams('build', 'code', 'quality', 'Run a command'), async () => {
        throw new Error('npm run build exited 1');
      }),
    /exited 1/,
  );
  assert.equal(sessionRow(run).outcome, OUTCOMES.FAILED);
});

// ── the run-level stop conditions ────────────────────────────────────────────

test('budget: the wall-clock budget stops the run before the next phase exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const run = makeRun(root, 'b1', undefined, { stop: { budget_minutes: 1 } });
  assert.equal(run.stop.budget_minutes, 1);
  run.startedAtMs = Date.now() - 5 * 60_000; // five minutes of a one-minute budget
  let executed = false;
  await assert.rejects(
    () =>
      run.runPhase(phaseParams('build', 'agent', 'builder', 'Implement the plan'), async () => {
        executed = true;
      }),
    (error) => {
      assert.equal(error.name, 'StopCondition');
      assert.equal(error.outcome, OUTCOMES.BUDGET_EXHAUSTED);
      assert.match(error.message, /time budget of 1 minute/);
      return true;
    },
  );
  assert.equal(executed, false, 'the phase body must never run');
  assert.equal(run.phases.length, 0, 'a stopped run must not leave a half-started phase');
  assert.equal(run.outcome, OUTCOMES.BUDGET_EXHAUSTED);
  const row = sessionRow(run);
  assert.equal(row.status, 'fail');
  assert.equal(row.outcome, OUTCOMES.BUDGET_EXHAUSTED);
});

test('budget: off by default — a long-running run is never stopped by the clock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const run = makeRun(root, 'b2');
  assert.equal(run.stop.budget_minutes, 0);
  assert.equal(run.stop.breadth_ceiling, 0);
  run.startedAtMs = Date.now() - 999 * 60_000;
  const result = await run.runPhase(phaseParams('plan', 'engineer', 'engineer', 'Capture the ask'), async () => 'ok');
  assert.equal(result, 'ok');
  assert.equal(run.finish({ accepted: true }), 0);
});

test('stop policy warnings reach the student once, through the run console', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    makeRun(root, 'w1', undefined, { stop: { attempt_cap: 'many' } });
  } finally {
    console.log = original;
  }
  const warnings = lines.filter((l) => l.includes('stop.attempt_cap'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /keeping the default 3/);
});

// ── the modules under a real child process ───────────────────────────────────

test('child process: a red run exits 1 and reports the derived outcome as JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-outcome-'));
  const url = (relative) => pathToFileURL(join(REPO, 'fia-templates', relative)).href;
  const driver = join(root, 'driver.mjs');
  writeFileSync(
    driver,
    [
      `import { Tracer } from '${url('modules/tracer.mjs')}';`,
      `import { Run } from '${url('modules/runner.mjs')}';`,
      `import { phaseParams } from '${url('modules/fda-cli.mjs')}';`,
      '',
      "const cfg = { defaults: { data_dir: 'imp/data' }, observability: { db: 'imp/data/fia.db' },",
      "  stop: { attempt_cap: 'many', budget_minutes: 30 } };",
      "const tracer = new Tracer(cfg.observability.db, 'imp/data/events.jsonl');",
      "tracer.sessionStart('child1', 'Tester', 'fda_child');",
      "const run = new Run(cfg, 'child1', tracer, 'Tester');",
      "await run.runPhase(phaseParams('test_1', 'code', 'quality', 'Run the suite'), async () => ({ passed: false }));",
      "const code = run.finish({ accepted: false, reason: 'the suite stayed red' });",
      "const row = tracer.db.prepare('SELECT status, outcome, outcome_reason FROM sessions WHERE fda_id=?').get('child1');",
      'console.log(',
      "  '__OUTCOME__' +",
      '    JSON.stringify({',
      '      code,',
      '      status: row.status,',
      '      outcome: row.outcome,',
      '      reason: row.outcome_reason,',
      '      attempt_cap: run.stop.attempt_cap,',
      '      budget_minutes: run.stop.budget_minutes,',
      '      warnings: run.stop.warnings.length,',
      '    }),',
      ');',
      'process.exit(code);',
      '',
    ].join('\n'),
  );

  const result = spawnSync(process.execPath, [driver], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
  const line = result.stdout.split('\n').find((l) => l.startsWith('__OUTCOME__'));
  assert.ok(line, `no __OUTCOME__ line in:\n${result.stdout}\n${result.stderr}`);
  assert.deepEqual(JSON.parse(line.slice('__OUTCOME__'.length)), {
    code: 1,
    status: 'fail',
    outcome: 'verification_failed',
    reason: 'the suite stayed red',
    attempt_cap: 3,
    budget_minutes: 30,
    warnings: 1,
  });
  assert.match(result.stdout, /FAILED \(verification failed\)/, 'the banner must name WHY the run ended');
});

// ── the repair-loop round accounting ─────────────────────────────────────────
// The two brief-driven FDAs drive createRepairTracker instead of hand-rolling
// the rules, and these are the two ways getting it wrong costs a student real
// work: stopping a run that IS progressing, and dead-ending a --resume.

test('repair tracker: a run that is progressing never stalls, even with identical check names', () => {
  // A normal brief reports exactly ONE check, named `test`, whether 12
  // assertions fail or 1 — so the failing names alone can never see progress.
  // The content half is what distinguishes a real repair.
  const repair = createRepairTracker({ attempt_cap: 3, no_progress_window: 2 });
  const round1 = repair.noteRound({ failures: ['test'], changed: ['src/a.ts:100,aaa'], repairExecuted: false });
  assert.equal(round1.stalled, false);
  // fix_1 edited the SAME file: the path set repeats, the content does not.
  const round2 = repair.noteRound({ failures: ['test'], changed: ['src/a.ts:120,bbb'], repairExecuted: true });
  assert.equal(round2.stalled, false, 'an edit to the same file is progress, not a stall');
  assert.equal(round2.repeats, 1, 'the streak resets when the tree changed');
  const round3 = repair.noteRound({ failures: ['test'], changed: ['src/a.ts:140,ccc'], repairExecuted: true });
  assert.equal(round3.stalled, false, 'still progressing after the second repair');
});

test('repair tracker: identical failures over an unchanged tree stall at the window', () => {
  const repair = createRepairTracker({ attempt_cap: 3, no_progress_window: 2 });
  const stuck = { failures: ['test'], changed: ['src/a.ts:100,aaa'] };
  assert.equal(repair.noteRound({ ...stuck, repairExecuted: false }).stalled, false, 'the first round is a baseline');
  const second = repair.noteRound({ ...stuck, repairExecuted: true });
  assert.equal(second.repeats, 2);
  assert.equal(second.stalled, true, 'a repair that changed nothing, with the same failures, is a stall');
});

test('repair tracker: a REPLAYED repair never counts toward the streak (the --resume path)', () => {
  // On --resume every fix_i is replayed from disk as a no-op while the
  // code-kind test phases re-execute. Counting those as stalled rounds would
  // dead-end the documented recovery path before a single repair is tried.
  const repair = createRepairTracker({ attempt_cap: 3, no_progress_window: 2 });
  const same = { failures: ['test'], changed: ['src/a.ts:100,aaa'] };
  repair.noteRound({ ...same, repairExecuted: false });
  for (let i = 0; i < 5; i += 1) {
    const round = repair.noteRound({ ...same, repairExecuted: false });
    assert.equal(round.counted, false);
    assert.equal(round.stalled, false, 'a round behind a replayed repair proves nothing');
  }
  // The first round behind a REAL repair can stall, and does.
  assert.equal(repair.noteRound({ ...same, repairExecuted: true }).stalled, true);
});

test('repair tracker: a green round clears the streak, and window 0 turns the detector off', () => {
  const repair = createRepairTracker({ attempt_cap: 3, no_progress_window: 2 });
  const same = { failures: ['test'], changed: ['src/a.ts:100,aaa'] };
  repair.noteRound({ ...same, repairExecuted: false });
  assert.equal(repair.noteRound({ passed: true, repairExecuted: true }).stalled, false);
  assert.equal(repair.repeats, 0, 'a passing suite is never a stall');
  assert.equal(repair.noteRound({ ...same, repairExecuted: true }).stalled, false, 'the streak restarted');

  const off = createRepairTracker({ attempt_cap: 3, no_progress_window: 0 });
  for (let i = 0; i < 6; i += 1) {
    assert.equal(off.noteRound({ ...same, repairExecuted: true }).stalled, false);
  }
});

test('repair tracker: the cap comes from the policy, clamped to at least one round', () => {
  assert.equal(createRepairTracker({ attempt_cap: 5 }).cap, 5);
  assert.equal(createRepairTracker({}).cap, STOP_DEFAULTS.attempt_cap);
  assert.equal(createRepairTracker({ attempt_cap: 0 }).cap, 1, 'zero repair rounds would make the loop pointless');
  assert.equal(createRepairTracker().window, STOP_DEFAULTS.no_progress_window);
  assert.equal(createRepairTracker({ no_progress_window: 0 }).window, 0);
});

test('changedContentSignature: carries the content hash, so re-editing one file is a new signature', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-progress-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 't@t.dev'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'init\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });

  const baseline = {};
  writeFileSync(join(root, 'a.js'), 'one\n');
  const first = changedContentSignature(root, baseline);
  assert.deepEqual(
    first.map((entry) => entry.split(':')[0]),
    ['a.js'],
  );
  assert.match(first[0], /^a\.js:\d+,[0-9a-f]{40}$/, 'path:size,sha1 — the content is in the signature');

  // Same path, new content: the PATH list is identical but the signature is not.
  writeFileSync(join(root, 'a.js'), 'two\n');
  const second = changedContentSignature(root, baseline);
  assert.deepEqual(
    second.map((entry) => entry.split(':')[0]),
    ['a.js'],
    'the path set did not move',
  );
  assert.notDeepEqual(second, first, 'but the content signature did');
  assert.notEqual(
    progressSignature({ failures: ['test'], changed: first }),
    progressSignature({ failures: ['test'], changed: second }),
  );
});

test('the viewer page mirrors the outcome labels it cannot import', () => {
  // fia-viewer-page.mjs is one big template literal, so it hand-copies LABELS
  // from modules/outcome.mjs. This is the guard that keeps the two in step.
  const page = readFileSync(join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'fia-viewer-page.mjs'), 'utf8');
  const block = /var OUTCOME_LABELS = \{([\s\S]*?)\};/.exec(page);
  assert.ok(block, 'the page declares an OUTCOME_LABELS map');
  for (const outcome of TERMINAL_OUTCOMES) {
    assert.ok(
      new RegExp(`\\b${outcome}\\s*:\\s*'${outcomeLabel(outcome).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(
        block[1],
      ),
      `the page is missing the label for ${outcome} (expected "${outcomeLabel(outcome)}")`,
    );
  }
});

test('a run that MET its goal stores no failure sentence, and says nothing about recovery', async () => {
  // `reason` is by construction the not-accepted explanation, and finish() used
  // to store it either way — so a green run's trace, viewer tooltip and Slack
  // ping all read "suite failed after 3 fix attempt(s)" next to accepted:yes.
  const root = mkdtempSync(join(tmpdir(), 'fia-green-'));
  const run = makeRun(root, 'green1');
  // finish() only calls a run successful when a phase actually ran.
  await run.runPhase(phaseParams('check', 'code', 'quality', 'Verify the suite is green'), async () => ({ passed: true }));
  const printed = [];
  const realLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  let code;
  try {
    code = run.finish({ accepted: true, reason: 'suite failed after 3 fix attempt(s)' });
  } finally {
    console.log = realLog;
  }
  assert.equal(code, 0);
  assert.equal(run.outcome, OUTCOMES.GOAL_MET);
  assert.equal(run.outcomeReason, '', 'the failure sentence is not stored on a green run');

  const db = new Database(join(root, 'fia.db'), { readonly: true });
  const row = db.prepare('SELECT outcome, outcome_reason FROM sessions WHERE fda_id=?').get('green1');
  assert.equal(row.outcome, 'goal_met');
  assert.ok(!row.outcome_reason, 'and nothing contradictory reaches the trace');
  db.close();

  const out = printed.join('\n');
  assert.match(out, /ACCEPTED \(goal met\)/);
  assert.doesNotMatch(out, /--resume/, 'a successful run is not offered a recovery route');
});

test('a run that did NOT meet its goal prints its id and the routes back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-red-'));
  const run = makeRun(root, 'red1');
  await run.runPhase(phaseParams('check', 'code', 'quality', 'Verify the suite is green'), async () => ({ passed: false }));
  const printed = [];
  const realLog = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  try {
    run.finish({ accepted: false, outcome: OUTCOMES.NO_PROGRESS, reason: 'the same checks failed' });
  } finally {
    console.log = realLog;
  }
  const out = printed.join('\n');
  assert.match(out, /FAILED \(no progress\)/);
  assert.match(out, /red1/, 'the fda_id is at the bottom, where the student is looking');
  assert.match(out, /--fda-id red1 --resume/);
  assert.match(out, /verdict\.mjs set red1 --missing/, 'and the bounded-resume route');
});
