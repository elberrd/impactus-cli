/**
 * Engine readiness — deterministic, local-only checks of which coding engines
 * (claude_code, pi, cursor, grok) can actually run on this machine, plus the
 * fallback resolution used at the start of every FDA run.
 *
 * Hard signals only: a missing binary, a Pi provider with neither an OAuth
 * entry in ~/.pi/agent/auth.json nor its API-key env var, or a Grok Build
 * install with no subscription login in ~/.grok/auth.json. Soft signals (e.g.
 * "claude is installed but we cannot prove it is logged in") are reported for
 * display but never trigger a fallback — the engine itself is the authority.
 *
 * Fallbacks are declared per agent in imp/fia.config.yaml:
 *   fallbacks:
 *     - { coding_agent: pi, model: openai-codex/gpt-5.6-sol, thinking: high }
 * Resolution runs at every run start. A `--resume` additionally feeds the
 * interrupted run's engine-failure markers in as `runtimeFailures`, so an
 * engine that died at runtime (outage, plan limit, expired login) walks the
 * chain even though the local checks pass. Mid-run, agents.mjs relays down
 * the same chain on engine death (see modules/continuation.mjs).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, delimiter, resolve } from 'node:path';

const PI_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json');

// ── Grok Build (xAI subscription) ────────────────────────────────────────────
// The `grok` CLI logs in through `grok login` (OAuth at auth.x.ai) and keeps an
// OIDC token in ~/.grok/auth.json that it refreshes on its own. That file is
// the subscription signal. XAI_API_KEY is deliberately NOT a signal: it flips
// the CLI into per-token API billing, outside the subscription (agent-grok.mjs
// strips it from the child env for the same reason).
const GROK_HOME = join(homedir(), '.grok');
const GROK_AUTH_PATH = join(GROK_HOME, 'auth.json');
const GROK_TRUST_PATH = join(GROK_HOME, 'trusted_folders.toml');
const GROK_MODELS_CACHE = join(GROK_HOME, 'models_cache.json');
export const GROK_INSTALL_HINT = 'curl -fsSL https://grok.com/install.sh | bash';
/** Reasoning levels Grok Build accepts (no `max`/`ultracode` — those are Claude's). */
export const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
/** Shipped model list — only used when grok's own models cache is absent. */
export const GROK_MODELS = ['grok-4.6', 'grok-4.5'];

/** Pi providers that authenticate through an env var instead of /login. */
export const PI_ENV_KEYS = {
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  google: 'GEMINI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** Providers whose login lives in ~/.pi/agent/auth.json (subscription OAuth). */
export const PI_OAUTH_PROVIDERS = ['openai-codex', 'github-copilot'];

export const ENGINE_NAMES = ['claude_code', 'pi', 'cursor', 'grok'];
export const ENGINE_BINS = { claude_code: 'claude', pi: 'pi', cursor: 'cursor-agent', grok: 'grok' };

/** Is `bin` reachable on PATH? (no shell involved; Windows gets .exe/.cmd) */
export function binOnPath(bin, env = process.env) {
  const dirs = String(env.PATH || '').split(delimiter);
  const names = process.platform === 'win32' ? [bin, `${bin}.exe`, `${bin}.cmd`] : [bin];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      if (existsSync(join(dir, name))) return true;
    }
  }
  return false;
}

export function readPiAuth(path = PI_AUTH_PATH) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** First path segment of a Pi model id ("openrouter/x/y" → "openrouter"). */
export function providerOfModel(model) {
  const i = String(model || '').indexOf('/');
  return i === -1 ? null : String(model).slice(0, i);
}

/** Can Pi reach this provider right now? OAuth entry or API-key env var. */
export function piProviderReady(provider, auth = readPiAuth(), env = process.env) {
  const entry = auth?.[provider];
  if (entry) {
    if (entry.type === 'oauth' && (entry.access || entry.refresh)) return true;
    if (entry.type === 'api_key' && entry.key) return true;
    if (entry.refresh || entry.token) return true;
  }
  const envKey = PI_ENV_KEYS[provider];
  return Boolean(envKey && env[envKey]);
}

/**
 * Best-effort "is claude logged in" — display only, never a fallback trigger.
 * ~/.claude.json carries the account after any successful login; on macOS the
 * actual credential may live in the Keychain, so absence proves nothing.
 */
function claudeLoggedHint() {
  try {
    const cfgPath = join(homedir(), '.claude.json');
    if (existsSync(join(homedir(), '.claude', '.credentials.json'))) return true;
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg && (cfg.oauthAccount || cfg.hasCompletedOnboarding)) return true;
    }
  } catch {
    /* display hint only — never block on a parse error */
  }
  return null; // unknown
}

/**
 * The generic `agent` binary name only counts as Cursor when it proves itself:
 * anything could ship a binary called "agent", so `agent --version` must
 * mention cursor before the engine is considered installed under that name.
 */
function agentBinIsCursor(env = process.env) {
  if (!binOnPath('agent', env)) return false;
  try {
    const out = execFileSync('agent', ['--version'], {
      env,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return /cursor/i.test(out);
  } catch {
    return false; // not executable, hung, or not Cursor — never block on it
  }
}

// ── Grok Build helpers ───────────────────────────────────────────────────────

/**
 * The grok binary to spawn: `GROK_PATH`, then PATH, then the installer's own
 * ~/.grok/bin (the official install.sh puts it there and only appends to the
 * shell rc — a run launched from an editor or a fresh shell may not see it on
 * PATH yet). Null when nothing is installed.
 */
export function grokBinary(env = process.env) {
  if (env.GROK_PATH) return env.GROK_PATH;
  if (binOnPath(ENGINE_BINS.grok, env)) return ENGINE_BINS.grok;
  const local = join(GROK_HOME, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
  return existsSync(local) ? local : null;
}

export function readGrokAuth(path = GROK_AUTH_PATH) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Is there a Grok subscription login? auth.json holds one entry per OIDC
 * issuer::client id, each with a bearer `key` and a `refresh_token`. The CLI
 * refreshes the token itself, so an expired `expires_at` is NOT a logout —
 * only an absent/empty entry is.
 */
export function grokLoggedIn(auth = readGrokAuth()) {
  if (!auth || typeof auth !== 'object') return false;
  return Object.values(auth).some(
    (entry) => entry && typeof entry === 'object' && Boolean(entry.refresh_token || entry.key || entry.access_token),
  );
}

/**
 * The models the logged-in account can use, with the reasoning levels each one
 * advertises — read from grok's own cache (refreshed by the CLI on every
 * launch). The shipped list when the cache is absent: `/llm`, the Agents tab
 * and `--llm` validation all read THIS, never a hardcoded copy.
 */
export function grokModels(path = GROK_MODELS_CACHE) {
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8'));
    const models = Object.values(cache?.models || {})
      .map((m) => m?.info)
      .filter((info) => info && typeof info.id === 'string' && !info.hidden);
    if (models.length) {
      return models.map((info) => ({
        id: info.id,
        name: info.name || info.id,
        efforts: (info.reasoning_efforts || []).map((e) => e?.id || e?.value).filter(Boolean),
        default_effort: info.reasoning_effort || null,
        context_window: Number(info.context_window) || 0,
      }));
    }
  } catch {
    /* no cache, or unreadable — the shipped list below is still correct */
  }
  return GROK_MODELS.map((id) => ({ id, name: id, efforts: [...GROK_EFFORTS], default_effort: 'high', context_window: 0 }));
}

/** Is this a Grok Build model id (the bare `grok-<version>` form the CLI takes)? */
export function isGrokModelId(model) {
  return /^grok-\d/i.test(String(model || '').trim());
}

/**
 * The comparable forms of a path for the trust store: resolved AND realpath'd
 * (when it exists — a not-yet-created subfolder still cascades from a trusted
 * parent whose realpath differs, e.g. macOS /var → /private/var). No trailing
 * slash; case-folded on Windows.
 */
function trustForms(path) {
  const norm = (p) => {
    const bare = p.replace(/[\\/]+$/, '') || p;
    return process.platform === 'win32' ? bare.toLowerCase() : bare;
  };
  const resolved = resolve(String(path || ''));
  const forms = new Set([norm(resolved)]);
  try {
    forms.add(norm(realpathSync(resolved)));
  } catch {
    /* does not exist (yet) — the resolved form alone is compared */
  }
  return forms;
}

/**
 * Is `root` (or an ancestor) trusted in grok's folder-trust store? Without
 * trust, grok SKIPS the project's `.claude/settings.json` hooks — the
 * desktop guard and the fda-lock gate — in silence. The store is a tiny TOML:
 *   [folders."/abs/path"]
 *   trusted = true
 * and trust cascades to subdirectories, so any trusted ancestor counts.
 */
export function grokFolderTrusted(root, path = GROK_TRUST_PATH) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const trusted = new Set();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[folders\."((?:[^"\\]|\\.)*)"\]$/.exec(line);
    if (header) {
      current = header[1].replace(/\\(["\\])/g, '$1');
      continue;
    }
    if (/^\[/.test(line)) {
      current = null;
      continue;
    }
    if (current && /^trusted\s*=\s*true\b/.test(line)) for (const form of trustForms(current)) trusted.add(form);
  }
  if (!trusted.size) return false;
  let dir = resolve(String(root || ''));
  for (;;) {
    for (const form of trustForms(dir)) if (trusted.has(form)) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Grant grok's folder trust for `root` once, so the project hooks run: the
 * CLI's own `--trust` flag is the only supported writer of the store (it holds
 * a lock file), so this spawns one deliberately tiny headless turn — no tools,
 * one turn, low effort. Returns { trusted, granted, error }. Never throws.
 */
export function ensureGrokTrust(root, { bin = grokBinary(), timeoutMs = 90000, env = process.env } = {}) {
  if (grokFolderTrusted(root)) return { trusted: true, granted: false };
  if (!bin) return { trusted: false, granted: false, error: 'grok CLI not found' };
  const childEnv = { ...env };
  delete childEnv.XAI_API_KEY;
  try {
    const r = spawnSync(
      bin,
      [
        '--trust',
        '-p',
        'Reply with the word ok',
        '--output-format',
        'json',
        '--max-turns',
        '1',
        '--reasoning-effort',
        'low',
        '--disallowed-tools',
        'run_terminal_command,search_replace,read_file,list_dir,grep,web_search,web_fetch,Agent',
      ],
      { cwd: root, env: childEnv, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const trusted = grokFolderTrusted(root);
    if (trusted) return { trusted: true, granted: true };
    const tail = String(r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' | ');
    return { trusted: false, granted: false, error: tail || `grok exited with ${r.status ?? 'signal'}` };
  } catch (err) {
    return { trusted: false, granted: false, error: String(err?.message || err) };
  }
}

/**
 * Snapshot of every engine's state on this machine.
 * `logged: null` means "cannot tell locally" (the CLI itself is the authority).
 * `grok.trusted` answers for `root` (the project the FDA runs in).
 */
export function checkEngines(env = process.env, { root = process.cwd() } = {}) {
  const auth = readPiAuth() || {};
  const providers = {};
  const names = new Set([...PI_OAUTH_PROVIDERS, ...Object.keys(PI_ENV_KEYS), ...Object.keys(auth)]);
  for (const p of names) providers[p] = piProviderReady(p, auth, env);
  const grokBin = grokBinary(env);
  return {
    claude_code: { installed: binOnPath(ENGINE_BINS.claude_code, env), logged: claudeLoggedHint() },
    pi: { installed: binOnPath(ENGINE_BINS.pi, env), providers },
    // Cursor ships as `cursor-agent`, but the adapter also accepts the newer
    // `agent` binary name — the latter only after `agent --version` proves it
    // is actually Cursor (the name is too generic to trust on its own).
    cursor: { installed: binOnPath(ENGINE_BINS.cursor, env) || agentBinIsCursor(env), logged: null },
    // Grok Build: the subscription login is a hard signal (auth.json is the
    // documented store, refreshed by the CLI); folder trust is informative —
    // session.ensure grants it automatically before the first grok phase.
    grok: {
      installed: Boolean(grokBin),
      logged: grokBin ? grokLoggedIn() : false,
      trusted: grokBin ? grokFolderTrusted(root) : false,
      api_key_env: Boolean(env.XAI_API_KEY),
    },
  };
}

/**
 * Hard-signal reason why `{ coding_agent, model }` cannot run, or null when it
 * can (as far as local checks can tell).
 */
export function engineIssue({ coding_agent, model }, engines) {
  if (coding_agent === 'claude_code') {
    return engines.claude_code.installed ? null : 'claude CLI not found on PATH (npm install -g @anthropic-ai/claude-code, then run `claude` once to log in)';
  }
  if (coding_agent === 'cursor') {
    return engines.cursor.installed ? null : 'cursor-agent not found on PATH (curl https://cursor.com/install -fsS | bash, then `cursor-agent login`)';
  }
  if (coding_agent === 'pi') {
    if (!engines.pi.installed) return 'pi not found on PATH (npm install -g @earendil-works/pi-coding-agent)';
    const provider = providerOfModel(model);
    if (provider && !engines.pi.providers[provider]) {
      const envKey = PI_ENV_KEYS[provider];
      return envKey
        ? `Pi provider "${provider}" has no ${envKey} set`
        : `Pi provider "${provider}" is not logged in (run \`pi\`, then /login ${provider})`;
    }
    return null;
  }
  if (coding_agent === 'grok') {
    if (!engines.grok?.installed) return `grok CLI (Grok Build) not found (${GROK_INSTALL_HINT}, then \`grok login\`)`;
    if (!engines.grok.logged) return 'grok is not logged in (run `grok login` — the xAI subscription; never set XAI_API_KEY, that bills per token)';
    return null;
  }
  return `unknown coding_agent "${coding_agent}"`;
}

/**
 * Resolve the effective engine for each agent, walking its fallback chain when
 * the primary is hard-unavailable. MUTATES cfg agents in place and returns
 * { engines, decisions } — one decision per inspected agent:
 *   { agent, changed:false }                              primary is fine
 *   { agent, changed:true, from, to, reason }             fell back
 *   { agent, changed:false, blocked:true, reason }        nothing available
 */
/**
 * Provider the EFFECTIVE engine bills per token through (API key), or null when
 * it runs inside a subscription (claude_code, cursor, grok, Pi OAuth providers).
 * Used to print a loud warning at run start — never to block anything.
 * (grok is always subscription here: the adapter strips XAI_API_KEY.)
 */
export function apiKeyProvider(agent) {
  if (agent.coding_agent !== 'pi') return null;
  const provider = providerOfModel(agent.model);
  if (!provider || PI_OAUTH_PROVIDERS.includes(provider)) return null;
  return provider;
}

/** Ceiling for a declared fallbacks chain — the viewer (server AND page) and
 *  config validation all read THIS, so the caps can never drift apart. */
export const MAX_FALLBACKS = 5;

export function resolveEngines(cfg, required = null, { runtimeFailures = {} } = {}) {
  const engines = checkEngines();
  const decisions = [];
  for (const agent of cfg.agents || []) {
    if (required && !required.includes(agent.name)) continue;
    const hardReason = engineIssue(agent, engines);
    // A marker from the interrupted run counts as unavailability even though
    // the local checks pass — that engine already proved it cannot finish.
    // Exact identity match only: a roster edited since the failure means the
    // marker no longer describes this agent's engine.
    const marker = runtimeFailures[agent.name];
    const markerApplies =
      !hardReason && marker && marker.coding_agent === agent.coding_agent && marker.model === agent.model;
    const reason = hardReason || (markerApplies ? `failed during the interrupted run (${marker.kind})` : null);
    let decision;
    if (!reason) {
      decision = { agent: agent.name, changed: false };
    } else {
      const chain = Array.isArray(agent.fallbacks) ? agent.fallbacks : [];
      const pick = chain.find(
        (fb) =>
          fb &&
          !(markerApplies && fb.coding_agent === marker.coding_agent && fb.model === marker.model) &&
          !engineIssue(fb, engines),
      );
      if (pick) {
        const from = { coding_agent: agent.coding_agent, model: agent.model };
        agent.coding_agent = pick.coding_agent;
        agent.model = pick.model;
        if (pick.effort !== undefined) agent.effort = pick.effort;
        if (pick.thinking !== undefined) agent.thinking = pick.thinking;
        decision = {
          agent: agent.name,
          changed: true,
          from,
          to: { coding_agent: pick.coding_agent, model: pick.model },
          reason,
        };
        if (markerApplies) {
          decision.runtime = true;
          decision.kind = marker.kind;
        }
      } else if (hardReason) {
        decision = { agent: agent.name, changed: false, blocked: true, reason };
      } else {
        // Runtime-only unavailability with no viable fallback must never
        // block: limits reset and outages end. Retry the engine the student
        // chose — loudly, so the retry is a decision the student can see.
        decision = { agent: agent.name, changed: false, retry_failed_engine: true, reason, kind: marker.kind };
      }
    }
    // Flag per-token billing on the engine that will ACTUALLY run (post-fallback).
    const provider = decision.blocked ? null : apiKeyProvider(agent);
    if (provider) decision.api_key_provider = provider;
    decisions.push(decision);
  }
  return { engines, decisions };
}
