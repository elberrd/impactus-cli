// The LLM switcher (imp/scripts/fia-llm.mjs): numbered roster view, spoken
// target resolution (claude alias / provider/id / engine word prefixes), and
// the guarded write — comments preserved, backup kept, extra-usage and
// mid-run traps refused. The write path itself is roster.mjs, shared with the
// viewer's Agents tab (covered by fia-viewer.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyChange, pickAgent, resolveTarget, rosterView, runCli } from '../fia-templates/scripts/fia-llm.mjs';

const TEMPLATE_CONFIG = fileURLToPath(new URL('../fia-templates/fia.config.yaml', import.meta.url));

/** A throwaway project root with the shipped roster stamped at imp/fia.config.yaml. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'fia-llm-'));
  mkdirSync(join(root, 'imp'), { recursive: true });
  writeFileSync(join(root, 'imp', 'fia.config.yaml'), readFileSync(TEMPLATE_CONFIG, 'utf8'));
  return { root, configPath: join(root, 'imp', 'fia.config.yaml') };
}

test('rosterView numbers the shipped agents in order, with their phases', () => {
  const { configPath } = makeProject();
  const view = rosterView(configPath);
  assert.equal(view.available, true);
  assert.deepEqual(
    view.agents.map((a) => [a.n, a.name]),
    [[1, 'planner'], [2, 'builder'], [3, 'scout'], [4, 'reviewer'], [5, 'documenter']],
  );
  assert.equal(view.agents[0].phases, 'plan');
  assert.match(view.agents[1].phases, /build/);
  assert.equal(view.defaults.coding_agent, 'pi');
});

test('pickAgent resolves 1-based numbers and names, and names the options on a miss', () => {
  const { configPath } = makeProject();
  const { agents } = rosterView(configPath);
  assert.equal(pickAgent(agents, '2').name, 'builder');
  assert.equal(pickAgent(agents, 'reviewer').name, 'reviewer');
  assert.throws(() => pickAgent(agents, '9'), /1 planner.*5 documenter/s);
  assert.throws(() => pickAgent(agents, 'nope'), /no agent "nope"/);
});

test('resolveTarget routes aliases, provider ids and engine-word prefixes', () => {
  assert.deepEqual(resolveTarget('fable'), { coding_agent: 'claude_code', model: 'fable' });
  assert.deepEqual(resolveTarget('claude-opus-5'), { coding_agent: 'claude_code', model: 'claude-opus-5' });
  assert.deepEqual(resolveTarget('xai/grok-4.5'), { coding_agent: 'pi', model: 'xai/grok-4.5' });
  // A leading engine word disambiguates bare ids ("cursor sonnet-4.5-thinking").
  assert.deepEqual(resolveTarget('cursor sonnet-4.5-thinking'), { coding_agent: 'cursor', model: 'sonnet-4.5-thinking' });
  assert.deepEqual(resolveTarget('claude opus'), { coding_agent: 'claude_code', model: 'opus' });
  // Explicit --engine wins over inference.
  assert.deepEqual(resolveTarget('gpt-5', { engine: 'cursor' }), { coding_agent: 'cursor', model: 'gpt-5' });
});

test('resolveTarget refuses what would burn money or silently misroute', () => {
  // Claude through Pi = per-token extra usage — the whole point of the guard.
  assert.throws(() => resolveTarget('anthropic/claude-opus-5'), /extra usage/);
  // A bare unknown id has no engine to run on — the student must name it.
  assert.throws(() => resolveTarget('gpt-5.6'), /--engine/);
  // Pi models are always provider/id.
  assert.throws(() => resolveTarget('gpt-5.6', { engine: 'pi' }), /provider\/model-id/);
  assert.throws(() => resolveTarget('opus', { engine: 'bogus' }), /--engine must be one of/);
  assert.throws(() => resolveTarget('   '), /missing model/);
});

test('applyChange switches the agent, preserves comments and keeps a backup', () => {
  const { root, configPath } = makeProject();
  const result = applyChange({ root, configPath }, { agent: '1', target: 'fable' });
  assert.equal(result.name, 'planner');
  assert.deepEqual(result.from, { coding_agent: 'claude_code', model: 'opus' });
  assert.deepEqual(result.to, { coding_agent: 'claude_code', model: 'fable' });

  const after = readFileSync(configPath, 'utf8');
  assert.match(after, /name: planner[\s\S]*?model: fable/, 'the planner now runs fable');
  // parseDocument edits the AST in place — the shipped header must survive.
  assert.match(after, /EACH AGENT WITH ITS ENGINE AND MODEL/, 'comments preserved');
  assert.ok(existsSync(result.backup), 'backup written');
  assert.ok(result.backup.includes(join('imp', 'data', 'backups')), 'backup lands in imp/data/backups');
  assert.match(readFileSync(result.backup, 'utf8'), /model: opus/, 'backup holds the previous roster');

  // The re-read view reflects the switch (what /llm re-lists afterwards).
  assert.equal(rosterView(configPath).agents[0].model, 'fable');
});

test('applyChange carries --effort/--thinking through validation', () => {
  const { root, configPath } = makeProject();
  applyChange({ root, configPath }, { agent: 'builder', target: 'sonnet', effort: 'xhigh' });
  const view = rosterView(configPath);
  assert.equal(view.agents[1].coding_agent, 'claude_code');
  assert.equal(view.agents[1].effort, 'xhigh');
  assert.throws(() => applyChange({ root, configPath }, { agent: 'builder', target: 'sonnet', effort: 'extreme' }), /effort must be/);
  assert.throws(() => applyChange({ root, configPath }, { agent: 'ghost', target: 'sonnet' }), /no agent "ghost"/);
});

test('applyChange warns about API-key billing (outside the subscriptions)', () => {
  const { root, configPath } = makeProject();
  const result = applyChange({ root, configPath }, { agent: 'scout', target: 'xai/grok-4.5' });
  assert.ok(
    result.warnings.some((w) => /xai API key/.test(w) && /OUTSIDE/.test(w)),
    `expected the xai billing warning, got: ${JSON.stringify(result.warnings)}`,
  );
});

test('applyChange refuses while an FDA run holds the lock', () => {
  const { root, configPath } = makeProject();
  mkdirSync(join(root, 'imp', 'data'), { recursive: true });
  const lockPath = join(root, 'imp', 'data', '.fda.lock');
  // process.ppid is a live pid that is NOT this process — the lock reader
  // treats it as an active run (its own pid would be ignored by design).
  writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, fda_id: 'testrun1', started_at: 'now' }));
  assert.throws(() => applyChange({ root, configPath }, { agent: '1', target: 'fable' }), /locked mid-run/);
  assert.match(readFileSync(configPath, 'utf8'), /model: opus/, 'nothing was written');
  rmSync(lockPath);
  applyChange({ root, configPath }, { agent: '1', target: 'fable' }); // lock gone → the switch lands
});

test('runCli --json is machine-readable; set exits 0/1 by outcome', async () => {
  const { root } = makeProject();
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(await runCli(['--json'], { root }), 0);
    const payload = JSON.parse(logs.at(-1));
    assert.equal(payload.available, true);
    assert.equal(payload.agents.length, 5);
    assert.ok(Array.isArray(payload.efforts) && payload.efforts.includes('ultracode'));
    assert.ok(payload.agents[0].n === 1 && payload.agents[0].phases === 'plan');

    assert.equal(await runCli(['set', '2', 'fable'], { root }), 0);
    assert.equal(await runCli(['set', '2', 'gpt-5.6'], { root }), 1, 'ambiguous bare id fails');

    // Outside a project: --json still answers (available: false), plain errors.
    const empty = mkdtempSync(join(tmpdir(), 'fia-llm-empty-'));
    assert.equal(await runCli(['--json'], { root: empty }), 0);
    assert.equal(JSON.parse(logs.at(-1)).available, false);
    assert.equal(await runCli([], { root: empty }), 1);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

test('a backup accumulates per switch (nothing is ever overwritten in place)', () => {
  const { root, configPath } = makeProject();
  applyChange({ root, configPath }, { agent: '1', target: 'fable' });
  applyChange({ root, configPath }, { agent: '1', target: 'opus' });
  const backups = readdirSync(join(root, 'imp', 'data', 'backups')).filter((f) => f.startsWith('fia.config.'));
  assert.ok(backups.length >= 1, 'at least one backup kept');
});

// ── Grok Build (xAI subscription) through the switcher ──────────────────────

test('resolveTarget: grok-<version> ids and "grok 4.6" route to the grok engine', () => {
  assert.deepEqual(resolveTarget('grok-4.6'), { coding_agent: 'grok', model: 'grok-4.6' });
  assert.deepEqual(resolveTarget('grok 4.6'), { coding_agent: 'grok', model: 'grok-4.6' });
  assert.deepEqual(resolveTarget('grok-4.5', { engine: 'grok' }), { coding_agent: 'grok', model: 'grok-4.5' });
  // The per-token route is still spelled provider/id on pi — a different thing on purpose.
  assert.deepEqual(resolveTarget('xai/grok-4.6'), { coding_agent: 'pi', model: 'xai/grok-4.6' });
});

test('applyChange: grok accepts its own effort ladder and refuses claude-only tiers', () => {
  const { root, configPath } = makeProject();
  const result = applyChange({ root, configPath }, { agent: 'builder', target: 'grok-4.6', effort: 'xhigh' });
  assert.deepEqual(result.to, { coding_agent: 'grok', model: 'grok-4.6' });
  const view = rosterView(configPath);
  assert.equal(view.agents[1].coding_agent, 'grok');
  assert.equal(view.agents[1].effort, 'xhigh');
  assert.ok(!result.warnings.some((w) => /API key/.test(w)), 'subscription engine — no per-token warning');
  assert.throws(
    () => applyChange({ root, configPath }, { agent: 'builder', target: 'grok-4.6', effort: 'max' }),
    /grok effort must be low\|medium\|high\|xhigh/,
  );
});

test('runCli --json exposes the grok ladder alongside the claude one', async () => {
  const { root } = makeProject();
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    assert.equal(await runCli(['--json'], { root }), 0);
    const payload = JSON.parse(logs.at(-1));
    assert.deepEqual(payload.grok_efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.ok(payload.coding_agents.includes('grok'));
    assert.ok('grok' in payload.engines, 'engine snapshot carries grok');
  } finally {
    console.log = origLog;
  }
});
