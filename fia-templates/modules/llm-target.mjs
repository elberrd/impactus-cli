/**
 * LLM target resolution — the ONE place that turns what an engineer typed
 * ("fable", "grok 4.6 high", "builder=openai-codex/gpt-5.6-sol", "cursor
 * sonnet-4.5-thinking") into `{ coding_agent, model, level }`.
 *
 * Two consumers, one grammar:
 *   - the roster switcher (`imp llm set …` / `/llm`) — a DURABLE change,
 *     written to imp/fia.config.yaml through roster.mjs;
 *   - the run-scoped override (`node imp/fda_*.mjs … --llm "<spec>"`) — ONE
 *     run only: the roster is never touched, the choice is printed, traced,
 *     and saved with the run so `--resume` keeps the same LLM (a model that
 *     changed mid-run would break the engine session and the cache).
 *
 * Levels are normalized per engine (claude_code: effort ladder incl.
 * max/ultracode; grok: low…xhigh; pi: minimal…high; cursor: none — the level
 * lives in the model id), so "grok 4.6 max" clamps to xhigh instead of
 * crashing the CLI with an unknown level.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_NAMES, GROK_EFFORTS, isGrokModelId, providerOfModel } from './engines.mjs';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
export const PI_THINKING = ['minimal', 'low', 'medium', 'high'];
/** Every level word the grammar accepts, in ascending order. */
export const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

export const CLAUDE_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable']);
/** Leading words that name an engine ("claude opus", "grok 4.6", "cursor gpt-5"). */
export const ENGINE_WORDS = {
  claude: 'claude_code',
  claude_code: 'claude_code',
  pi: 'pi',
  codex: 'pi',
  cursor: 'cursor',
  grok: 'grok',
  grok_build: 'grok',
};

/** The roster field that carries the reasoning level for this engine. */
export function levelField(engine) {
  if (engine === 'claude_code' || engine === 'grok') return 'effort';
  if (engine === 'pi') return 'thinking';
  return null;
}

/** The ladder of levels this engine accepts. */
export function engineLevels(engine) {
  if (engine === 'claude_code') return CLAUDE_EFFORTS;
  if (engine === 'grok') return GROK_EFFORTS;
  if (engine === 'pi') return PI_THINKING;
  return [];
}

/**
 * Clamp a level onto the engine's ladder: unknown tiers snap to the nearest
 * one the engine has (grok has no max → xhigh; pi has no xhigh → high; claude
 * has no minimal → low). Null for cursor, or when nothing was given.
 */
export function normalizeLevel(engine, level) {
  const ladder = engineLevels(engine);
  const v = String(level || '')
    .trim()
    .toLowerCase();
  if (!ladder.length || !v) return null;
  if (ladder.includes(v)) return v;
  const idx = LEVELS.indexOf(v);
  if (idx === -1) return null;
  // Nearest tier below on the shared scale, else the ladder's floor.
  for (let i = idx; i >= 0; i--) if (ladder.includes(LEVELS[i])) return LEVELS[i];
  return ladder[0];
}

/**
 * `{ coding_agent, model }` from what the engineer typed. Claude aliases and
 * `claude-*` ids imply claude_code; `grok-<version>` ids imply grok;
 * `provider/id` implies pi; anything else needs an explicit engine (cursor
 * ids look like bare words). Guards the two billing traps: Claude through Pi
 * (extra usage) is refused with the fix, and a leading engine word ("cursor
 * sonnet-4.5", "claude opus", "grok 4.6") is accepted.
 */
export function resolveTarget(raw, { engine } = {}) {
  let model = String(raw ?? '').trim();
  if (engine !== undefined && !ENGINE_NAMES.includes(engine)) {
    throw new Error(`--engine must be one of ${ENGINE_NAMES.join('|')}`);
  }
  const words = model.split(/\s+/);
  if (!engine && words.length > 1 && ENGINE_WORDS[words[0].toLowerCase()]) {
    engine = ENGINE_WORDS[words[0].toLowerCase()];
    model = words.slice(1).join(' ');
  }
  if (!model) throw new Error('missing model — e.g. fable, opus, grok-4.6, openai-codex/gpt-5.6-sol');
  // "grok 4.6" / "grok-4.6" / "grok 4.6" after the engine word → grok-4.6.
  if (engine === 'grok' || /^grok[\s-]\d/i.test(model)) {
    const version = model.replace(/^grok[\s-]*/i, '').trim();
    if (/^\d/.test(version)) model = `grok-${version.replace(/\s+/g, '')}`;
    engine = engine || 'grok';
  }
  let coding_agent = engine;
  if (!coding_agent) {
    if (CLAUDE_ALIASES.has(model.toLowerCase()) || /^claude-/i.test(model)) coding_agent = 'claude_code';
    else if (isGrokModelId(model)) coding_agent = 'grok';
    else if (model.includes('/')) coding_agent = 'pi';
    else {
      throw new Error(
        `cannot tell which engine runs "${model}" — name it: --engine ${ENGINE_NAMES.join('|')} ` +
          '(pi models are provider/id like openai-codex/gpt-5.6-sol; grok ids are grok-4.6 / grok-4.5; cursor ids come from `cursor-agent --list-models`)',
      );
    }
  }
  if (coding_agent === 'pi') {
    if (!model.includes('/')) throw new Error(`pi models are provider/model-id (e.g. openai-codex/${model || 'gpt-5.6-sol'})`);
    if (providerOfModel(model) === 'anthropic') {
      throw new Error(
        'Claude INSIDE Pi bills per token as "extra usage" — use the claude_code engine instead ' +
          '(e.g. `set <agent> opus`): the official `claude` CLI runs on the Claude Pro/Max plan.',
      );
    }
    if (providerOfModel(model) === 'xai') {
      // Not refused (an engineer may hold an xAI API key on purpose) — but the
      // subscription route exists and is what the installer promises.
      // The run-start warning (api_key_billing_warning) says the rest.
    }
  }
  if (coding_agent === 'grok' && !isGrokModelId(model)) {
    throw new Error(`grok models are grok-<version> ids (grok-4.6, grok-4.5 — \`grok models\` lists them), not "${model}"`);
  }
  return { coding_agent, model };
}

/**
 * Parse ONE `--llm` spec. Grammar (whitespace, `@` and `:` all separate):
 *   [<agent>[,<agent>…]=]<model>[ <level>]
 * so "grok-4.6@high", "grok 4.6 high", "builder=opus xhigh",
 * "builder,reviewer=openai-codex/gpt-5.6-sol high" and "cursor sonnet-4.5"
 * all parse. Returns { agents: string[]|null, coding_agent, model, level }.
 */
export function parseLlmSpec(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) throw new Error('--llm needs a value, e.g. --llm "grok-4.6 high" or --llm "builder=opus xhigh"');
  let agents = null;
  let rest = raw;
  const eq = raw.indexOf('=');
  if (eq !== -1) {
    agents = raw
      .slice(0, eq)
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    if (!agents.length || agents.some((a) => !/^[a-z0-9_-]+$/.test(a))) {
      throw new Error(`--llm "${raw}": the part before "=" must be agent name(s), e.g. builder=grok-4.6`);
    }
    rest = raw.slice(eq + 1).trim();
  }
  const tokens = rest.split(/[\s@:]+/).filter(Boolean);
  let level = null;
  if (tokens.length > 1 && LEVELS.includes(tokens[tokens.length - 1].toLowerCase())) {
    level = tokens.pop().toLowerCase();
  }
  const target = resolveTarget(tokens.join(' '));
  return { agents, coding_agent: target.coding_agent, model: target.model, level, raw };
}

/** Human form of an agent's LLM, e.g. `pi · openai-codex/gpt-5.6-sol · thinking medium`. */
export function describeLlm(agent) {
  const field = levelField(agent.coding_agent);
  const level = field ? agent[field] : '';
  return [`${agent.coding_agent} · ${agent.model}`, level ? `${field} ${level}` : ''].filter(Boolean).join(' · ');
}

/**
 * Apply run-scoped overrides to the loaded config — MUTATES cfg.agents in
 * place (the run's copy, never the YAML on disk) and returns one decision per
 * changed agent: { agent, from, to, level_given }. A spec without agents
 * applies to every agent a named spec did not already claim; later specs win.
 *
 * Levels: when the spec names one it applies to EVERY phase of that agent —
 * the engineer asked for "high" for this run, so the roster's per-phase
 * reasoning overrides (which only ever lower the level on repair rounds) are
 * dropped for the agent. Without a level, the agent's own level is carried
 * over, clamped to the new engine's ladder. Both `effort` and `thinking` are
 * written so the choice survives an engine relay mid-run.
 */
export function applyLlmOverrides(cfg, specs) {
  const agents = cfg?.agents || [];
  const known = new Set(agents.map((a) => a.name));
  const parsed = (Array.isArray(specs) ? specs : [specs]).map(parseLlmSpec);
  const plan = new Map(); // agent name → spec
  for (const spec of parsed) {
    if (spec.agents) {
      for (const name of spec.agents) {
        if (!known.has(name)) {
          throw new Error(`--llm "${spec.raw}": no agent "${name}" in the roster — agents: ${[...known].join(', ')}`);
        }
        plan.set(name, spec);
      }
    }
  }
  const global = [...parsed].reverse().find((spec) => !spec.agents) || null;
  if (global) for (const name of known) if (!plan.has(name)) plan.set(name, global);

  const decisions = [];
  for (const agent of agents) {
    const spec = plan.get(agent.name);
    if (!spec) continue;
    const from = { coding_agent: agent.coding_agent, model: agent.model, effort: agent.effort, thinking: agent.thinking };
    const currentLevel = agent.effort || agent.thinking || null;
    const level = normalizeLevel(spec.coding_agent, spec.level || currentLevel);
    agent.coding_agent = spec.coding_agent;
    agent.model = spec.model;
    if (level) {
      agent.effort = level;
      agent.thinking = level;
    } else if (spec.coding_agent === 'cursor') {
      delete agent.effort;
      delete agent.thinking;
    }
    if (spec.level && agent.phase_overrides) delete agent.phase_overrides;
    decisions.push({
      agent: agent.name,
      from: { coding_agent: from.coding_agent, model: from.model, level: from.effort || from.thinking || null },
      to: { coding_agent: agent.coding_agent, model: agent.model, level: level || null },
      level_given: Boolean(spec.level),
      spec: spec.raw,
    });
  }
  if (!decisions.length) throw new Error('--llm matched no agent of this run');
  return decisions;
}

// ── persistence with the run (for --resume) ──────────────────────────────────

export const LLM_OVERRIDE_FILE = 'llm_override.json';

/** Save the run's override so a `--resume` without `--llm` re-applies it. */
export function writeLlmOverride(sessionDir, { specs, decisions }) {
  const record = { specs: [...specs], decisions, at: new Date().toISOString() };
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, LLM_OVERRIDE_FILE), JSON.stringify(record, null, 2));
  } catch {
    /* best-effort: a resume would then run on the roster — printed, never silent */
  }
  return record;
}

/** The run's saved override, or null when absent/unreadable/malformed. */
export function readLlmOverride(sessionDir) {
  try {
    const record = JSON.parse(readFileSync(join(sessionDir, LLM_OVERRIDE_FILE), 'utf8'));
    if (record && Array.isArray(record.specs) && record.specs.every((s) => typeof s === 'string')) return record;
  } catch {
    /* no override saved with this run */
  }
  return null;
}
