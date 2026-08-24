/**
 * Roster writer — the ONE code path that edits `imp/fia.config.yaml`.
 *
 * Shared by the viewer's Agents tab (POST /api/roster in fia-viewer.mjs) and
 * the terminal/agent switcher (fia-llm.mjs), so both editors validate with the
 * same rules and write with the same guarantees:
 *   - comments preserved: parseDocument edits the YAML AST in place instead of
 *     re-serializing from scratch
 *   - backup first (imp/data/backups/), then atomic write (tmp + rename)
 *   - agents can be changed, never added or removed
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, parseDocument } from 'yaml';
import { ENGINE_NAMES, GROK_EFFORTS, MAX_FALLBACKS } from '../modules/engines.mjs';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
export const THINKING = ['minimal', 'low', 'medium', 'high'];
/** claude_code | pi | cursor | grok — ONE list, read from the engine registry. */
export const CODING_AGENTS = [...ENGINE_NAMES];
export { GROK_EFFORTS };

/** The `effort` problem for an entry, or null: grok has a shorter ladder than claude. */
function effortIssue(entry) {
  if (entry.effort == null) return null;
  if (!EFFORTS.includes(entry.effort)) return `effort must be ${EFFORTS.join('|')}`;
  if (entry.coding_agent === 'grok' && !GROK_EFFORTS.includes(entry.effort)) {
    return `grok effort must be ${GROK_EFFORTS.join('|')} (Grok Build has no max/ultracode)`;
  }
  return null;
}

export const modelOk = (m) => typeof m === 'string' && m.trim() && m.length <= 200 && !/[\n\r]/.test(m);

/**
 * Roster for display — defaults merged into each agent (viewer semantics),
 * plus the defaults themselves and per-agent `explicit` flags so a UI can
 * tell "chosen for this agent" from "inherited from the default LLM".
 */
export function loadRoster(configPath) {
  let cfg = {};
  try {
    cfg = parseYaml(readFileSync(configPath, 'utf8')) || {};
  } catch {
    return { available: false, defaults: null, agents: [] };
  }
  const defaults = cfg.defaults || {};
  const agents = (cfg.agents || []).map((a) => ({
    name: a.name,
    color: a.color || null,
    coding_agent: a.coding_agent ?? defaults.coding_agent ?? 'pi',
    model: a.model ?? defaults.model ?? '',
    thinking: a.thinking ?? defaults.thinking ?? '',
    effort: a.effort ?? defaults.effort ?? '',
    purpose: a.purpose || '',
    fallbacks: Array.isArray(a.fallbacks) ? a.fallbacks : [],
    explicit: { coding_agent: a.coding_agent != null, model: a.model != null },
  }));
  return {
    available: agents.length > 0,
    defaults: {
      coding_agent: defaults.coding_agent ?? 'pi',
      model: defaults.model ?? '',
      effort: defaults.effort ?? '',
      thinking: defaults.thinking ?? '',
    },
    agents,
  };
}

/** First problem with the patch as a human sentence, or null when valid. */
export function validateRosterPatch(patch) {
  if (!patch || !Array.isArray(patch.agents) || !patch.agents.length) return 'body must be { agents: [...] }';
  for (const a of patch.agents) {
    if (!a || typeof a.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(a.name)) return 'agent name missing or invalid';
    if (!CODING_AGENTS.includes(a.coding_agent)) return `${a.name}: coding_agent must be one of ${CODING_AGENTS.join('|')}`;
    if (!modelOk(a.model)) return `${a.name}: model is required`;
    const effortProblem = effortIssue(a);
    if (effortProblem) return `${a.name}: ${effortProblem}`;
    if (a.thinking != null && !THINKING.includes(a.thinking)) return `${a.name}: thinking must be ${THINKING.join('|')}`;
    if (a.fallbacks !== undefined) {
      if (!Array.isArray(a.fallbacks) || a.fallbacks.length > MAX_FALLBACKS)
        return `${a.name}: fallbacks must be a list of at most ${MAX_FALLBACKS}`;
      for (const fb of a.fallbacks) {
        if (!fb || !CODING_AGENTS.includes(fb.coding_agent) || !modelOk(fb.model)) {
          return `${a.name}: each fallback needs coding_agent and model`;
        }
        if (effortIssue(fb)) return `${a.name}: fallback ${effortIssue(fb)}`;
        if (fb.thinking != null && !THINKING.includes(fb.thinking)) return `${a.name}: fallback thinking invalid`;
      }
    }
  }
  return null;
}

/**
 * Apply the patch to the config PRESERVING comments. Per agent entry:
 * `coding_agent` and `model` are always set; `effort`/`thinking` are set when
 * given, deleted when `null`, left untouched when `undefined`; `fallbacks`
 * replaces the whole chain (empty list deletes it), `undefined` leaves it.
 */
export function saveRoster({ configPath, backupDir }, patch) {
  const text = readFileSync(configPath, 'utf8');
  const doc = parseDocument(text);
  if (doc.errors?.length) throw new Error(`config has YAML errors: ${doc.errors[0].message}`);
  const seq = doc.get('agents');
  if (!seq || !Array.isArray(seq.items)) throw new Error('config has no agents list');
  for (const a of patch.agents) {
    const item = seq.items.find((it) => it.get && it.get('name') === a.name);
    if (!item) throw new Error(`unknown agent "${a.name}" — the editor cannot add or remove agents`);
    item.set('coding_agent', a.coding_agent);
    item.set('model', a.model);
    for (const [key, allowed] of [['effort', EFFORTS], ['thinking', THINKING]]) {
      if (a[key] === null) {
        if (item.has(key)) item.delete(key);
      } else if (a[key] !== undefined && allowed.includes(a[key])) {
        item.set(key, a[key]);
      }
    }
    if (a.fallbacks !== undefined) {
      if (!a.fallbacks.length) {
        if (item.has('fallbacks')) item.delete('fallbacks');
      } else {
        const node = doc.createNode(a.fallbacks);
        for (const fb of node.items) fb.flow = true; // keep the compact one-line style
        item.set('fallbacks', node);
      }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `fia.config.${stamp}.yaml`);
  copyFileSync(configPath, backup);
  const tmp = join(dirname(configPath), `.fia.config.yaml.tmp-${process.pid}`);
  writeFileSync(tmp, String(doc), 'utf8');
  renameSync(tmp, configPath);
  return { saved: configPath, backup };
}
