/**
 * Grok Build engine — runs the `grok` CLI headless on the user's xAI
 * subscription (login once: `grok login`; the OIDC token in ~/.grok/auth.json
 * refreshes on its own).
 *
 * Contract mirrors agent-claude: `--output-format streaming-messages-json` is
 * NDJSON in the Claude Code stream-json dialect (system/init, assistant with
 * content blocks + per-message usage, user/tool_result, result) — so the
 * stream recorder shows grok's tool calls live in the viewer and the TUI, and
 * `--resume <sessionId>` continues the same session for correction rounds.
 *
 * Verified against grok 1.0.5 (Aug/2026), the facts this adapter relies on:
 *   - the prompt goes in `-p` (NOT a positional argument);
 *   - `--rules` APPENDS to grok's own system prompt (the tool guidance the
 *     model was tuned on stays; the FIA role rides on top — same contract as
 *     `--append-system-prompt` on claude/pi, and the cacheable prefix stays);
 *   - `--reasoning-effort` takes low|medium|high|xhigh (no `max`);
 *   - headless grok executes tools (reads AND writes) without asking; project
 *     hooks (.claude/settings.json) still apply, but ONLY in a trusted folder
 *     (session.ensure grants trust before the first grok phase);
 *   - death signatures: "You are not authenticated" (login), "unknown model
 *     id" (config error, non-zero exit).
 *
 * Billing guard: XAI_API_KEY is removed from the child environment. With it
 * set, the CLI switches to API-key auth and bills every token outside the
 * subscription — the one thing the FIA promises never to do.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { armLimits } from './agent-limits.mjs';
import { claudeUsageOf } from './agent-claude.mjs';
import { GROK_EFFORTS, GROK_INSTALL_HINT, grokBinary, grokModels } from './engines.mjs';

/**
 * The reasoning level grok accepts for a roster level: its own ladder passes
 * through, Claude-only tiers clamp to the nearest grok tier (max/ultracode →
 * xhigh), Pi's `minimal` → low. When `model` is known to grok's models cache
 * the result is further clamped to the levels THAT model advertises (grok-4.5
 * has no xhigh, for instance) — an unknown level makes the CLI exit non-zero,
 * which would read as a crash. Null when nothing usable was given (the CLI
 * then applies the model's default).
 */
export function grokEffortOf(level, model = null, models = null) {
  const v = String(level || '')
    .trim()
    .toLowerCase();
  if (!v) return null;
  let effort = null;
  if (GROK_EFFORTS.includes(v)) effort = v;
  else if (v === 'minimal' || v === 'none') effort = 'low';
  else if (v === 'max' || v === 'ultracode') effort = 'xhigh';
  if (!effort || !model) return effort;
  let ladder = null;
  try {
    ladder = (models || grokModels()).find((m) => m.id === model)?.efforts || null;
  } catch {
    ladder = null;
  }
  if (!ladder?.length || ladder.includes(effort)) return effort;
  // Nearest advertised tier at or below the requested one, else the model's floor.
  const idx = GROK_EFFORTS.indexOf(effort);
  for (let i = idx; i >= 0; i--) if (ladder.includes(GROK_EFFORTS[i])) return GROK_EFFORTS[i];
  return GROK_EFFORTS.find((e) => ladder.includes(e)) || null;
}

export function buildGrokArgs(request) {
  // `-p` carries the prompt (a positional would open the interactive TUI).
  // bypassPermissions = grok's always-approve: no permission prompt can ever
  // hang a headless phase; deny rules and hooks still apply on top, and the
  // FIA's own permission gate (rollback of undeclared writes) is the real
  // guard either way.
  const args = ['-p', request.prompt, '--output-format', 'streaming-messages-json', '--permission-mode', 'bypassPermissions'];
  if (request.model) args.push('--model', request.model);
  const effort = grokEffortOf(request.effort || request.thinking, request.model, request.models);
  if (effort) args.push('--reasoning-effort', effort);
  // Agent role (rendered system.md) via APPEND (`--rules`) — never
  // --system-prompt-override: grok's default prefix (tools + context) is what
  // the model was tuned on and what the cache leverages. Sent on EVERY
  // invocation (including --resume): omitting it on a resume would change the
  // system prompt mid-session — invalidating the cache and changing behavior.
  if (request.systemPrompt) args.push('--rules', request.systemPrompt);
  if (request.sessionId) args.push('--resume', request.sessionId);
  return args;
}

/** The child env: the run's env minus the per-token API key. */
export function grokEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  delete env.XAI_API_KEY;
  return env;
}

/** Context window of `model` from grok's models cache (0 when unknown). */
function contextWindowOf(model) {
  try {
    const entry = grokModels().find((m) => m.id === model);
    return entry?.context_window || 0;
  } catch {
    return 0;
  }
}

/**
 * Run Grok Build headless (subscription billing via the official CLI).
 * `model` is a bare grok id (grok-4.6, grok-4.5 — `grok models` lists them);
 * `effort`/`thinking` maps to --reasoning-effort (low…xhigh).
 */
export async function runGrok(request, { onEvent, onSpawn, onExit } = {}) {
  const args = buildGrokArgs(request);
  const bin = grokBinary(request.env ? { ...process.env, ...request.env } : process.env) || 'grok';

  mkdirSync(dirname(request.rawOutputPath), { recursive: true });

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: request.cwd,
      env: grokEnv(process.env, request.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onSpawn?.(child.pid);
    const limiter = armLimits(child, request.limits);

    let text = '';
    let assistantText = '';
    let tokens = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    // Live context ≈ what the LAST model call processed (fresh input + the
    // cached prefix it re-read). grok reports usage per assistant message, so
    // this is exact per turn — not the invocation-accumulated sum.
    let lastContext = 0;
    let sawResultUsage = false;
    let cost = 0;
    let sessionId = request.sessionId || '';
    let apiKeySource = '';
    let buffer = '';
    let stdoutAll = '';
    let parsedLines = 0;

    const takeUsage = (usage, { cumulative }) => {
      const u = claudeUsageOf(usage);
      if (cumulative) {
        // The result event carries the invocation total: replace the
        // per-message sum with it (never add on top of it).
        tokens = u.total;
        input = u.input;
        output = u.output;
        cacheRead = u.cacheRead;
        cacheWrite = u.cacheWrite;
        sawResultUsage = true;
      } else if (!sawResultUsage) {
        tokens += u.total;
        input += u.input;
        output += u.output;
        cacheRead += u.cacheRead;
        cacheWrite += u.cacheWrite;
        lastContext = u.input + u.cacheRead + u.cacheWrite;
      }
      limiter.noteTokens(tokens);
    };

    const consume = (event) => {
      onEvent?.(event);
      if (event.type === 'system' && event.subtype === 'init') {
        if (event.session_id) sessionId = event.session_id;
        if (event.apiKeySource) apiKeySource = String(event.apiKeySource);
        return;
      }
      if (event.session_id) sessionId = event.session_id;
      if (event.type === 'assistant' && event.message) {
        for (const block of event.message.content || []) {
          if (block.type === 'text') assistantText += block.text || '';
        }
        if (event.message.usage) takeUsage(event.message.usage, { cumulative: false });
        return;
      }
      if (event.type === 'result') {
        if (typeof event.result === 'string') text = event.result;
        if (typeof event.total_cost_usd === 'number') cost = event.total_cost_usd;
        if (event.usage) takeUsage(event.usage, { cumulative: true });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutAll += chunk;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        appendFileSync(request.rawOutputPath, line + '\n');
        try {
          consume(JSON.parse(line));
          parsedLines += 1;
        } catch {
          /* a non-JSON line (pretty-printed object fragment, or plain text) — handled at close */
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => appendFileSync(request.rawOutputPath, `[stderr] ${d}`));

    const finish = (code) => {
      // Whole-stdout fallback: `--output-format json` (or a future default)
      // prints ONE pretty-printed object across many lines — parse it as a
      // whole when line-wise parsing saw nothing. Plain text is the last resort.
      if (!parsedLines) {
        if (buffer.trim()) appendFileSync(request.rawOutputPath, buffer + '\n');
        try {
          const whole = JSON.parse(stdoutAll);
          if (whole && typeof whole === 'object') {
            if (typeof whole.text === 'string') text = whole.text;
            if (whole.sessionId) sessionId = whole.sessionId;
            if (typeof whole.total_cost_usd === 'number') cost = whole.total_cost_usd;
            if (whole.usage) {
              takeUsage(whole.usage, { cumulative: true });
              lastContext = input + cacheRead + cacheWrite;
            }
          }
        } catch {
          text = text || stdoutAll;
        }
      }
      if (apiKeySource && apiKeySource !== 'oauth') {
        appendFileSync(
          request.rawOutputPath,
          `[stderr] FIA: grok reported apiKeySource=${apiKeySource} — per-token billing, outside the subscription\n`,
        );
      }
      onExit?.(child.pid);
      resolve({
        text: text || assistantText,
        returncode: code ?? 1,
        session_id: sessionId,
        tokens,
        cost,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        context_tokens: lastContext,
        context_window: contextWindowOf(request.model),
        api_key_source: apiKeySource || null,
        terminated: limiter.finish(),
      });
    };

    child.on('close', (code) => finish(code));

    child.on('error', (err) => {
      onExit?.(child.pid);
      const hint =
        err.code === 'ENOENT'
          ? `Grok Build CLI not found (${bin}). Install it: ${GROK_INSTALL_HINT} — then log in: grok login`
          : String(err.message || err);
      resolve({
        text: `Error: ${hint}`,
        returncode: 127,
        session_id: sessionId,
        tokens: 0,
        cost: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        context_tokens: 0,
        context_window: 0,
        terminated: limiter.finish(),
      });
    });
  });
}
