import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';
import { EngineFailure, engineAdapters, execute } from '../fia-templates/modules/agents.mjs';
import { STOP_DEFAULTS, stopPolicyOf } from '../fia-templates/modules/stop.mjs';
import { armLimits } from '../fia-templates/modules/agent-limits.mjs';
import { OUTCOMES } from '../fia-templates/modules/outcome.mjs';

// Budgets run against IN-PROCESS engine fakes swapped into the exported
// engineAdapters dispatch table — no CLI is ever spawned (same harness as
// test/fia-relay.test.js). git is only used by the permission snapshots.

function initGitRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fia@test.dev'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'FIA Budget'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# budget\n');
  writeFileSync(join(root, '.gitignore'), 'imp/\npe/\n');
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

function makeSetup({ stop = {}, resume = false, seedTokens = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fia-budget-'));
  initGitRepo(root);
  process.chdir(root);
  const promptsDir = join(root, 'pe');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, 'system.md'), 'You are the builder.');
  writeFileSync(join(promptsDir, 'user.md'), 'Task: {{prompt}}');
  const cfg = {
    defaults: { data_dir: join(root, 'imp/data') },
    observability: { db: join(root, 'imp/data/fia.db') },
    stop,
    agents: [
      {
        name: 'builder',
        coding_agent: 'claude_code',
        model: 'sonnet',
        writes: [],
        tools: ['read'],
        prompt_engineering: { system: join(promptsDir, 'system.md'), user: join(promptsDir, 'user.md') },
      },
    ],
  };
  const tracer = new Tracer(cfg.observability.db, join(cfg.defaults.data_dir, 'sessions', 'run1', 'events.jsonl'));
  tracer.sessionStart('run1', 'Tester', 'fda_test');
  if (seedTokens) tracer.sessionAddUsage('run1', seedTokens, 0);
  const run = new Run(cfg, 'run1', tracer, 'Tester', { resume });
  const phaseOf = (name) => ({
    phase_id: `run1_${name}`,
    fda_id: 'run1',
    params: { name, owner: 'builder', kind: 'agent' },
  });
  const call = { prompt: 'build the thing', outputType: 'GenericOutput', gates: [] };
  return { root, cfg, run, phaseOf, call };
}

async function withAdapters(fakes, fn) {
  const saved = { ...engineAdapters };
  Object.assign(engineAdapters, fakes);
  try {
    return await fn();
  } finally {
    Object.assign(engineAdapters, saved);
  }
}

const okResult = (extra = {}) => ({
  text: JSON.stringify({ status: 'success', summary: 'done' }),
  returncode: 0,
  tokens: 100,
  cost: 0,
  input_tokens: 80,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  session_id: 'sess-1',
  context_tokens: 0,
  context_window: 0,
  terminated: '',
  ...extra,
});

const readEvents = (run) =>
  readFileSync(join(run.sessionDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('stopPolicyOf: the token ceilings ship ON with generous defaults, 0 turns each off, typos warn', () => {
  assert.equal(STOP_DEFAULTS.token_budget, 30000000);
  assert.equal(STOP_DEFAULTS.phase_token_budget, 8000000);
  assert.equal(STOP_DEFAULTS.phase_timeout_minutes, 50);
  const off = stopPolicyOf({ stop: { token_budget: 0, phase_token_budget: 0, phase_timeout_minutes: 0 } });
  assert.equal(off.token_budget, 0);
  assert.equal(off.phase_token_budget, 0);
  assert.equal(off.phase_timeout_minutes, 0);
  for (const key of ['token_budget', 'phase_token_budget', 'phase_timeout_minutes']) {
    const policy = stopPolicyOf({ stop: { [key]: 'lots' } });
    assert.equal(policy[key], STOP_DEFAULTS[key]);
    assert.equal(policy.warnings.length, 1);
    assert.match(policy.warnings[0], new RegExp(`stop\\.${key}`));
    assert.match(policy.warnings[0], /keeping the default/);
  }
});

test('armLimits: cuts at the token ceiling exactly once, times out, finish clears and reports', async () => {
  const kills = [];
  const child = { kill: (sig) => kills.push(sig) };
  const limiter = armLimits(child, { maxTokens: 1000 });
  limiter.noteTokens(999);
  assert.deepEqual(kills, []);
  limiter.noteTokens(1000);
  limiter.noteTokens(5000);
  assert.deepEqual(kills, ['SIGTERM'], 'the second breach must not re-kill');
  assert.equal(limiter.finish(), 'token_budget');

  const slow = { kill: (sig) => kills.push(`slow:${sig}`) };
  const timed = armLimits(slow, { timeoutMs: 10 });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(kills.includes('slow:SIGTERM'));
  assert.equal(timed.finish(), 'timeout');

  const idle = armLimits({ kill: () => {} }, {});
  idle.noteTokens(10_000_000);
  assert.equal(idle.finish(), '', 'no limits = never cut');
});

test('run token budget: the second phase stops as budget_exhausted, with 50%/80% warnings once each', async () => {
  const { run, phaseOf, call } = makeSetup({
    stop: { token_budget: 1000, phase_token_budget: 0, phase_timeout_minutes: 0 },
  });
  let error = null;
  await withAdapters(
    { claude_code: async () => okResult({ tokens: 600 }) },
    async () => {
      await execute(run, phaseOf('build'), call);
      try {
        await execute(run, phaseOf('fix_1'), call);
      } catch (e) {
        error = e;
      }
    },
  );
  assert.ok(error, 'the second phase must throw');
  assert.equal(error.name, 'StopCondition');
  assert.equal(error.outcome, OUTCOMES.BUDGET_EXHAUSTED);
  assert.match(error.message, /token budget of 1000 is used up/);
  assert.equal(run.outcome, OUTCOMES.BUDGET_EXHAUSTED, 'the run settles with the precise reason');
  const warnings = readEvents(run).filter((e) => e.name === 'budget_warning');
  assert.deepEqual(warnings.map((w) => w.payload.pct), [50, 80]);
});

test('phase token budget: one runaway phase stops without touching the run budget', async () => {
  const { run, phaseOf, call } = makeSetup({
    stop: { token_budget: 0, phase_token_budget: 500, phase_timeout_minutes: 0 },
  });
  await withAdapters(
    { claude_code: async () => okResult({ tokens: 600 }) },
    async () => {
      await assert.rejects(
        () => execute(run, phaseOf('build'), call),
        (e) => e.name === 'StopCondition' && /this phase alone spent 600 tokens/.test(e.message),
      );
    },
  );
  assert.equal(run.outcome, OUTCOMES.BUDGET_EXHAUSTED);
});

test('adapters receive the remaining room as limits: min(phase, run) tokens + the timeout', async () => {
  const { run, phaseOf, call } = makeSetup({
    stop: { token_budget: 700, phase_token_budget: 8000000, phase_timeout_minutes: 50 },
  });
  const seen = [];
  await withAdapters(
    {
      claude_code: async (request) => {
        seen.push(request.limits);
        return okResult({ tokens: 100 });
      },
    },
    async () => {
      await execute(run, phaseOf('build'), call);
      await execute(run, phaseOf('fix_1'), call);
    },
  );
  assert.equal(seen[0].timeoutMs, 50 * 60000);
  assert.equal(seen[0].maxTokens, 700, 'the run budget is the tighter ceiling');
  assert.equal(seen[1].maxTokens, 600, 'the second phase sees what the first already spent');
});

test('resume carries the lifetime baseline: a resumed run cannot reset the meter', async () => {
  const { run, phaseOf, call } = makeSetup({
    stop: { token_budget: 1000, phase_token_budget: 0, phase_timeout_minutes: 0 },
    resume: true,
    seedTokens: 900,
  });
  assert.equal(run.lifetimeTokens(), 900);
  await withAdapters(
    { claude_code: async () => okResult({ tokens: 200 }) },
    async () => {
      await assert.rejects(
        () => execute(run, phaseOf('build'), call),
        (e) => e.outcome === OUTCOMES.BUDGET_EXHAUSTED,
      );
    },
  );
  // A FRESH run of the same fda_id ignores the baseline (only --resume carries it).
  const fresh = makeSetup({ stop: { token_budget: 1000 }, seedTokens: 900 });
  assert.equal(fresh.run.lifetimeTokens(), 0);
});

test('timeout with almost no spend is a crash (same-engine retry, then relay); after real spend it stops', async () => {
  // Hung CLI: little spend → EngineFailure. With no fallbacks the second
  // consecutive kill exhausts the phase and the failure surfaces.
  const hung = makeSetup({ stop: { token_budget: 0, phase_token_budget: 0, phase_timeout_minutes: 5 } });
  let calls = 0;
  await withAdapters(
    {
      claude_code: async () => {
        calls += 1;
        return okResult({ tokens: 10, returncode: 1, terminated: 'timeout', text: '' });
      },
    },
    async () => {
      await assert.rejects(
        () => execute(hung.run, hung.phaseOf('build'), hung.call),
        (e) => e instanceof EngineFailure && /killed as hung/.test(e.message),
      );
    },
  );
  assert.equal(calls, 2, 'a first crash retries the same engine once');

  // Real work underway: stopping beats re-spending the phase anywhere.
  const busy = makeSetup({ stop: { token_budget: 0, phase_token_budget: 0, phase_timeout_minutes: 5 } });
  await withAdapters(
    { claude_code: async () => okResult({ tokens: 600000, returncode: 1, terminated: 'timeout', text: '' }) },
    async () => {
      await assert.rejects(
        () => execute(busy.run, busy.phaseOf('build'), busy.call),
        (e) => e.name === 'StopCondition' && /phase timeout after 600000 tokens/.test(e.message),
      );
    },
  );
  assert.equal(busy.run.outcome, OUTCOMES.BUDGET_EXHAUSTED);
});

test('every adapter arms the limits and reports terminated', () => {
  for (const file of ['agent-claude.mjs', 'agent-pi.mjs', 'agent-cursor.mjs']) {
    const source = readFileSync(new URL(`../fia-templates/modules/${file}`, import.meta.url), 'utf8');
    assert.match(source, /armLimits\(child, request\.limits\)/, `${file} must arm the limits`);
    assert.match(source, /terminated: limiter\.finish\(\)/, `${file} must report why it was cut`);
  }
});
