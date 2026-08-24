// Run-scoped LLM override (`--llm`) — fia-templates/modules/llm-target.mjs +
// the FDA prologue in fda-cli.mjs. The roster on disk is never written: the
// spec is parsed with the same grammar `imp llm set` uses, applied to the
// run's config copy, printed, and saved with the run so `--resume` keeps the
// same LLM (a model that changed mid-run would break the session + cache).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LLM_OVERRIDE_FILE,
  applyLlmOverrides,
  describeLlm,
  engineLevels,
  levelField,
  normalizeLevel,
  parseLlmSpec,
  readLlmOverride,
  resolveTarget,
  writeLlmOverride,
} from '../fia-templates/modules/llm-target.mjs';
import { applyRunLlm, parseFdaArgs } from '../fia-templates/modules/fda-cli.mjs';
import { loadConfig } from '../fia-templates/modules/agents.mjs';

const TEMPLATE_CONFIG = fileURLToPath(new URL('../fia-templates/fia.config.yaml', import.meta.url));

/** The shipped roster, loaded the way an FDA loads it (defaults merged). */
function shippedCfg() {
  return loadConfig(TEMPLATE_CONFIG);
}

test('resolveTarget: grok spellings all land on the grok engine with a canonical id', () => {
  assert.deepEqual(resolveTarget('grok-4.6'), { coding_agent: 'grok', model: 'grok-4.6' });
  assert.deepEqual(resolveTarget('grok 4.6'), { coding_agent: 'grok', model: 'grok-4.6' });
  assert.deepEqual(resolveTarget('grok grok-4.5'), { coding_agent: 'grok', model: 'grok-4.5' });
  assert.deepEqual(resolveTarget('4.6', { engine: 'grok' }), { coding_agent: 'grok', model: 'grok-4.6' });
  // The API-key route stays what it always was: Pi + xai provider.
  assert.deepEqual(resolveTarget('xai/grok-4.5'), { coding_agent: 'pi', model: 'xai/grok-4.5' });
  assert.throws(() => resolveTarget('opus', { engine: 'grok' }), /grok models are grok-<version> ids/);
  assert.throws(() => resolveTarget('grok'), /cannot tell which engine/);
});

test('levels: field + ladder per engine, clamping across ladders', () => {
  assert.equal(levelField('claude_code'), 'effort');
  assert.equal(levelField('grok'), 'effort');
  assert.equal(levelField('pi'), 'thinking');
  assert.equal(levelField('cursor'), null);
  assert.deepEqual(engineLevels('grok'), ['low', 'medium', 'high', 'xhigh']);
  assert.equal(normalizeLevel('grok', 'max'), 'xhigh', 'grok has no max');
  assert.equal(normalizeLevel('grok', 'ultracode'), 'xhigh');
  assert.equal(normalizeLevel('grok', 'minimal'), 'low');
  assert.equal(normalizeLevel('pi', 'xhigh'), 'high', 'pi tops out at high');
  assert.equal(normalizeLevel('claude_code', 'minimal'), 'low');
  assert.equal(normalizeLevel('claude_code', 'ultracode'), 'ultracode');
  assert.equal(normalizeLevel('cursor', 'high'), null, 'cursor carries the level in the model id');
  assert.equal(normalizeLevel('grok', ''), null);
  assert.equal(normalizeLevel('grok', 'bogus'), null);
});

test('parseLlmSpec: the grammar an engineer actually types', () => {
  assert.deepEqual(parseLlmSpec('grok-4.6@high'), { agents: null, coding_agent: 'grok', model: 'grok-4.6', level: 'high', raw: 'grok-4.6@high' });
  assert.equal(parseLlmSpec('grok 4.6 high').model, 'grok-4.6');
  assert.equal(parseLlmSpec('grok 4.6 High').level, 'high', 'case-insensitive level');
  assert.equal(parseLlmSpec('grok 4.6').level, null);
  assert.deepEqual(parseLlmSpec('builder=opus xhigh').agents, ['builder']);
  assert.equal(parseLlmSpec('builder=opus xhigh').coding_agent, 'claude_code');
  assert.deepEqual(parseLlmSpec('builder, reviewer = openai-codex/gpt-5.6-sol:high').agents, ['builder', 'reviewer']);
  assert.equal(parseLlmSpec('builder, reviewer = openai-codex/gpt-5.6-sol:high').level, 'high');
  assert.equal(parseLlmSpec('cursor sonnet-4.5-thinking').coding_agent, 'cursor');
  assert.equal(parseLlmSpec('fable').model, 'fable');
  assert.throws(() => parseLlmSpec(''), /--llm needs a value/);
  assert.throws(() => parseLlmSpec('=opus'), /agent name/);
  assert.throws(() => parseLlmSpec('bad agent=opus'), /agent name/);
  assert.throws(() => parseLlmSpec('gpt-5.6'), /cannot tell which engine/);
  assert.throws(() => parseLlmSpec('anthropic/claude-opus-5'), /extra usage/);
});

test('applyLlmOverrides: a bare spec retargets every agent; the roster copy only', () => {
  const cfg = shippedCfg();
  const decisions = applyLlmOverrides(cfg, ['grok 4.6 high']);
  assert.equal(decisions.length, cfg.agents.length);
  for (const a of cfg.agents) {
    assert.equal(a.coding_agent, 'grok');
    assert.equal(a.model, 'grok-4.6');
    assert.equal(a.effort, 'high');
    assert.equal(a.thinking, 'high', 'both fields set so the choice survives an engine relay');
    assert.equal(a.phase_overrides, undefined, 'an explicit level applies to EVERY phase of this run');
  }
  const builder = decisions.find((d) => d.agent === 'builder');
  assert.deepEqual(builder.from, { coding_agent: 'pi', model: 'openai-codex/gpt-5.6-sol', level: 'medium' });
  assert.deepEqual(builder.to, { coding_agent: 'grok', model: 'grok-4.6', level: 'high' });
  assert.equal(builder.level_given, true);
  // The YAML on disk is untouched.
  assert.match(readFileSync(TEMPLATE_CONFIG, 'utf8'), /name: builder\n\s+coding_agent: pi/);
});

test('applyLlmOverrides: named specs win over the bare one; no level carries the agent level, clamped', () => {
  const cfg = shippedCfg();
  const decisions = applyLlmOverrides(cfg, ['grok-4.6', 'builder=opus xhigh', 'reviewer,scout=openai-codex/gpt-5.6-sol']);
  const by = Object.fromEntries(cfg.agents.map((a) => [a.name, a]));
  assert.equal(by.builder.coding_agent, 'claude_code');
  assert.equal(by.builder.effort, 'xhigh');
  assert.equal(by.builder.phase_overrides, undefined);
  assert.equal(by.reviewer.coding_agent, 'pi');
  assert.equal(by.reviewer.thinking, 'high', 'reviewer kept its own level (high)');
  assert.ok(by.reviewer.phase_overrides, 'no explicit level → the per-phase tuning stays');
  assert.equal(by.scout.thinking, 'low', 'scout kept low');
  // planner + documenter fall to the bare spec; planner (claude effort high) → grok effort high.
  assert.equal(by.planner.coding_agent, 'grok');
  assert.equal(by.planner.effort, 'high');
  assert.equal(by.documenter.coding_agent, 'grok');
  assert.equal(by.documenter.effort, 'low', 'documenter thinking low → grok effort low');
  assert.equal(decisions.length, 5);
  assert.equal(decisions.find((d) => d.agent === 'reviewer').level_given, false);
});

test('applyLlmOverrides: cursor drops the level fields; unknown agents are refused by name', () => {
  const cfg = shippedCfg();
  applyLlmOverrides(cfg, ['builder=cursor sonnet-4.5-thinking']);
  const builder = cfg.agents.find((a) => a.name === 'builder');
  assert.equal(builder.coding_agent, 'cursor');
  assert.equal(builder.effort, undefined);
  assert.equal(builder.thinking, undefined);
  assert.throws(() => applyLlmOverrides(shippedCfg(), ['ghost=opus']), /no agent "ghost" in the roster — agents: planner, builder/);
  assert.throws(() => applyLlmOverrides({ agents: [] }, ['opus']), /matched no agent/);
});

test('describeLlm renders the engine-specific level field', () => {
  assert.equal(describeLlm({ coding_agent: 'grok', model: 'grok-4.6', effort: 'high', thinking: 'high' }), 'grok · grok-4.6 · effort high');
  assert.equal(describeLlm({ coding_agent: 'pi', model: 'openai-codex/gpt-5.6-sol', thinking: 'medium' }), 'pi · openai-codex/gpt-5.6-sol · thinking medium');
  assert.equal(describeLlm({ coding_agent: 'cursor', model: 'sonnet-4.5-thinking', effort: 'high' }), 'cursor · sonnet-4.5-thinking');
});

test('write/readLlmOverride: round-trip with the run; malformed reads as absent', () => {
  const sessionDir = join(mkdtempSync(join(tmpdir(), 'fia-llm-ov-')), 'sessions', 'run1');
  const record = writeLlmOverride(sessionDir, { specs: ['grok-4.6 high'], decisions: [{ agent: 'builder' }] });
  assert.ok(record.at);
  const back = readLlmOverride(sessionDir);
  assert.deepEqual(back.specs, ['grok-4.6 high']);
  assert.equal(back.decisions[0].agent, 'builder');
  writeFileSync(join(sessionDir, LLM_OVERRIDE_FILE), '{"specs": "not a list"}');
  assert.equal(readLlmOverride(sessionDir), null);
  assert.equal(readLlmOverride(join(sessionDir, 'nope')), null);
});

test('parseFdaArgs: --llm is repeatable and trimmed', () => {
  const args = parseFdaArgs(['do it', '--llm', ' grok-4.6 high ', '--llm', 'builder=opus']);
  assert.deepEqual(args.llm, ['grok-4.6 high', 'builder=opus']);
  assert.deepEqual(parseFdaArgs(['do it']).llm, []);
});

test('applyRunLlm: the flag applies and prints; a resume without the flag re-applies the saved override', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-llm-run-'));
  const dataDir = join(root, 'imp', 'data');
  mkdirSync(join(dataDir, 'sessions', 'abc12345'), { recursive: true });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const cfg = shippedCfg();
    cfg.defaults.data_dir = dataDir;
    const fresh = applyRunLlm(cfg, { llm: ['scout=grok 4.6 low'], resume: false, fdaId: null });
    assert.equal(fresh.source, 'flag');
    assert.equal(fresh.decisions.length, 1);
    assert.equal(cfg.agents.find((a) => a.name === 'scout').coding_agent, 'grok');
    assert.ok(logs.some((l) => /LLM override for THIS run only/.test(l)));
    assert.ok(logs.some((l) => /scout: pi · openai-codex\/gpt-5.6-sol \(low\)\s+→\s+grok · grok-4.6 · effort low/.test(l)), logs.join('\n'));

    // Nothing saved yet for that run → a resume runs on the roster.
    const cfg2 = shippedCfg();
    cfg2.defaults.data_dir = dataDir;
    const none = applyRunLlm(cfg2, { llm: [], resume: true, fdaId: 'abc12345' });
    assert.equal(none.decisions.length, 0);
    assert.equal(cfg2.agents.find((a) => a.name === 'scout').coding_agent, 'pi');

    // Saved with the run → the resume keeps the same LLM without the flag.
    writeLlmOverride(join(dataDir, 'sessions', 'abc12345'), { specs: fresh.specs, decisions: fresh.decisions });
    const cfg3 = shippedCfg();
    cfg3.defaults.data_dir = dataDir;
    const resumed = applyRunLlm(cfg3, { llm: [], resume: true, fdaId: 'abc12345' });
    assert.equal(resumed.source, 'saved');
    assert.equal(cfg3.agents.find((a) => a.name === 'scout').model, 'grok-4.6');
    assert.ok(logs.some((l) => /re-applied from run abc12345/.test(l)));

    // An explicit flag on resume wins over the saved one.
    const cfg4 = shippedCfg();
    cfg4.defaults.data_dir = dataDir;
    const replaced = applyRunLlm(cfg4, { llm: ['scout=fable'], resume: true, fdaId: 'abc12345' });
    assert.equal(replaced.source, 'flag');
    assert.equal(cfg4.agents.find((a) => a.name === 'scout').model, 'fable');
  } finally {
    console.log = orig;
  }
});
