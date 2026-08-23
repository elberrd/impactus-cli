import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolveForPhase, validate } from '../fia-templates/modules/agents.mjs';

const SYSTEM = fileURLToPath(new URL('../fia-templates/data/prompt_engineering/builder/system.md', import.meta.url));
const USER = fileURLToPath(new URL('../fia-templates/data/prompt_engineering/builder/user.md', import.meta.url));

function builder(phase_overrides) {
  return {
    name: 'builder',
    coding_agent: 'pi',
    model: 'openai-codex/gpt-5.6-sol',
    thinking: 'high',
    effort: 'high',
    writes: ['src/'],
    prompt_engineering: { system: SYSTEM, user: USER },
    phase_overrides,
  };
}

test('resolveForPhase: exact/wildcard tuning applies without mutating the base agent', () => {
  const base = builder({ 'fix_*': { thinking: 'low' }, fix_ui: { effort: 'medium' } });
  const cfg = { agents: [base] };

  const wildcard = resolveForPhase(cfg, 'builder', 'fix_1');
  assert.equal(wildcard.thinking, 'low');
  assert.equal(wildcard.effort, 'high');

  const exact = resolveForPhase(cfg, 'builder', 'fix_ui');
  assert.equal(exact.thinking, 'high', 'an exact entry wins instead of merging an earlier wildcard');
  assert.equal(exact.effort, 'medium');
  assert.equal(base.thinking, 'high', 'phase resolution never mutates the canonical roster');
});

test('resolveForPhase: protected fields are ignored defensively even before validation', () => {
  const base = builder({
    build: {
      coding_agent: 'claude_code',
      model: 'opus',
      writes: [],
      prompt_engineering: { system: '/tmp/other', user: '/tmp/other' },
      thinking: 'low',
    },
  });
  const resolved = resolveForPhase({ agents: [base] }, 'builder', 'build');
  assert.equal(resolved.coding_agent, 'pi');
  assert.equal(resolved.model, 'openai-codex/gpt-5.6-sol');
  assert.deepEqual(resolved.writes, ['src/']);
  assert.equal(resolved.prompt_engineering, base.prompt_engineering);
  assert.equal(resolved.thinking, 'low');
});

test('validate: phase overrides reject engine/permission changes and malformed patterns', () => {
  assert.throws(
    () => validate({ agents: [builder({ build: { coding_agent: 'claude_code' } })] }, ['builder']),
    /unsupported field\(s\): coding_agent/,
  );
  assert.throws(
    () => validate({ agents: [builder({ 'fix_*_later': { thinking: 'low' } })] }, ['builder']),
    /invalid phase_overrides pattern/,
  );
});

test('validate: thinking/effort overrides pass', () => {
  assert.doesNotThrow(() =>
    validate({ agents: [builder({ 'fix_*': { thinking: 'low' }, review: { effort: 'medium' } })] }, ['builder']),
  );
});

// ── the SHIPPED roster carries the recipes (they used to be docs-only) ───────

test('the shipped fia.config.yaml pre-seeds low-reasoning overrides on repair and UI-verify phases', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const template = parse(readFileSync(new URL('../fia-templates/fia.config.yaml', import.meta.url), 'utf8'));
  const byName = Object.fromEntries(template.agents.map((a) => [a.name, a]));

  assert.deepEqual(byName.builder.phase_overrides['fix_*'], { thinking: 'low', effort: 'low' });
  assert.deepEqual(byName.builder.phase_overrides.fix, { thinking: 'low', effort: 'low' });
  assert.deepEqual(byName.reviewer.phase_overrides.ui_check, { effort: 'low', thinking: 'low' });
  assert.deepEqual(byName.reviewer.phase_overrides.ui_verify, { effort: 'low', thinking: 'low' });
  assert.equal(byName.documenter.thinking, 'low', 'the documenter narrates an existing diff');
  // Models stay exactly the engineer-facing defaults — overrides tune
  // reasoning only, never the model (that choice belongs to the user).
  for (const agent of template.agents) {
    for (const override of Object.values(agent.phase_overrides || {})) {
      assert.deepEqual(
        Object.keys(override).filter((k) => k !== 'thinking' && k !== 'effort'),
        [],
        `${agent.name}: an override may tune reasoning only`,
      );
    }
  }

  // The shipped shapes pass the real validator (prompt paths rewritten to the
  // repo copies — the template's imp/ paths only exist in a stamped project).
  const cfg = {
    ...template,
    agents: template.agents.map((a) => ({ ...a, prompt_engineering: { system: SYSTEM, user: USER } })),
  };
  assert.doesNotThrow(() => validate(cfg, ['builder', 'reviewer', 'documenter']));

  // And resolveForPhase applies them where the runners will ask.
  assert.equal(resolveForPhase(cfg, 'builder', 'fix_2').thinking, 'low');
  assert.equal(resolveForPhase(cfg, 'builder', 'build').thinking, 'medium', 'build keeps the base reasoning');
  assert.equal(resolveForPhase(cfg, 'reviewer', 'ui_verify').effort, 'low');
  assert.equal(resolveForPhase(cfg, 'reviewer', 'review').effort, 'high', 'the functional review keeps full effort');
});
