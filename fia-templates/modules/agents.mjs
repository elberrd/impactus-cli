import { existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as agentPi from './agent-pi.mjs';
import * as agentClaude from './agent-claude.mjs';
import * as agentCursor from './agent-cursor.mjs';
import * as prompts from './prompts.mjs';
import * as permissions from './permissions.mjs';
import * as continuation from './continuation.mjs';
import { checkEngines, engineIssue } from './engines.mjs';
import { runChangedPaths } from './git-helper.mjs';
import { makeStreamRecorder } from './stream-events.mjs';
import { extractJson, getOutputSchema } from './envelopes.mjs';
import { gateReport } from './gates.mjs';

const JSON_FIX_ATTEMPTS = 2;
const PHASE_OVERRIDE_FIELDS = new Set(['thinking', 'effort']);

export class GateFailure extends Error {}

/**
 * An engine-level death — spawn failure or a non-zero exit without a report.
 * The ONLY failures that may arm the relay: gate, parse and permission
 * failures mean the engine worked and must never switch engines.
 */
export class EngineFailure extends Error {
  constructor(message, { kind, coding_agent, model }) {
    super(message);
    this.kind = kind;
    this.coding_agent = coding_agent;
    this.model = model;
  }
}

// Engine dispatch table, exported as a test seam: tests replace entries with
// in-process fakes so relay behavior is testable without spawning any CLI.
export const engineAdapters = {
  claude_code: agentClaude.runClaude,
  cursor: agentCursor.runCursor,
  pi: agentPi.runPi,
};

export function loadConfig(path = 'imp/fia.config.yaml') {
  const raw = parseYaml(readFileSync(path, 'utf8')) || {};
  const defaults = raw.defaults || {};
  for (const agent of raw.agents || []) {
    for (const key of [
      'coding_agent',
      'model',
      'thinking',
      'effort',
      'tools',
      'writes',
      'harness_engineering',
      'fallbacks',
    ]) {
      if (defaults[key] !== undefined && agent[key] === undefined) agent[key] = defaults[key];
    }
    if (!agent.harness_engineering) agent.harness_engineering = defaults.harness_engineering || [];
  }
  return raw;
}

export function resolve(cfg, name) {
  const agent = (cfg.agents || []).find((a) => a.name === name);
  if (!agent) {
    const available = (cfg.agents || []).map((a) => a.name).join(', ');
    throw new Error(`agent "${name}" is not defined in the config — available: ${available}`);
  }
  return agent;
}

/**
 * Resolve an agent with phase_overrides applied. Entries in the agent's
 * `phase_overrides` map are matched by exact name or trailing wildcard
 * (e.g. `fix_*` matches `fix_1`, `fix_2`, `fix_checklist`). Matched
 * fields (`thinking` or `effort`) are shallow-merged on top of the base
 * agent — engine/model/permissions and the original object are never mutated.
 */
export function resolveForPhase(cfg, agentName, phaseName) {
  const base = resolve(cfg, agentName);
  const overrides = base.phase_overrides;
  if (!overrides || typeof overrides !== 'object') return base;
  let match = overrides[phaseName];
  if (!match) {
    for (const [pattern, value] of Object.entries(overrides)) {
      if (pattern.endsWith('*') && phaseName.startsWith(pattern.slice(0, -1))) {
        match = value;
        break;
      }
    }
  }
  if (!match || typeof match !== 'object') return base;
  const tuning = Object.fromEntries(Object.entries(match).filter(([key]) => PHASE_OVERRIDE_FIELDS.has(key)));
  return { ...base, ...tuning };
}

export function validate(cfg, required) {
  const problems = [];
  // Remember which agents this FDA actually uses — engine fallback resolution
  // (session.ensure) fails fast only for these, and merely warns for the rest.
  Object.defineProperty(cfg, '_required', { value: [...required], enumerable: false, configurable: true });
  for (const name of required) {
    try {
      const agent = resolve(cfg, name);
      if (!['pi', 'claude_code', 'cursor'].includes(agent.coding_agent)) {
        problems.push(`agent ${name}: coding_agent ${agent.coding_agent} not supported`);
      }
      for (const [i, fb] of (Array.isArray(agent.fallbacks) ? agent.fallbacks : []).entries()) {
        if (
          !fb ||
          !['pi', 'claude_code', 'cursor'].includes(fb.coding_agent) ||
          typeof fb.model !== 'string' ||
          !fb.model.trim()
        ) {
          problems.push(`agent ${name}: fallbacks[${i}] needs coding_agent (pi|claude_code|cursor) and a model`);
        }
      }
      if (agent.phase_overrides !== undefined) {
        if (!agent.phase_overrides || typeof agent.phase_overrides !== 'object' || Array.isArray(agent.phase_overrides)) {
          problems.push(`agent ${name}: phase_overrides must be a map of phase names to { thinking, effort }`);
        } else {
          for (const [pattern, override] of Object.entries(agent.phase_overrides)) {
            if (!/^[A-Za-z0-9_-]+\*?$/.test(pattern)) {
              problems.push(`agent ${name}: invalid phase_overrides pattern "${pattern}" (only a trailing * is supported)`);
            }
            if (!override || typeof override !== 'object' || Array.isArray(override)) {
              problems.push(`agent ${name}: phase_overrides.${pattern} must be an object`);
              continue;
            }
            const unsupported = Object.keys(override).filter((key) => !PHASE_OVERRIDE_FIELDS.has(key));
            if (unsupported.length) {
              problems.push(
                `agent ${name}: phase_overrides.${pattern} has unsupported field(s): ${unsupported.join(', ')} ` +
                  '(only thinking and effort may vary by phase)',
              );
            }
          }
        }
      }
      for (const [label, ref] of [
        ['system', agent.prompt_engineering?.system],
        ['user', agent.prompt_engineering?.user],
      ]) {
        try {
          readFileSync(ref);
        } catch {
          problems.push(`agent ${name}: ${label} prompt not found: ${ref}`);
        }
      }
    } catch (e) {
      problems.push(e.message);
    }
  }
  if (problems.length) {
    throw new Error('config validation failed:\n- ' + problems.join('\n- '));
  }
}

/**
 * Session to RESUME for engines that mint their own ids (claude, cursor):
 * only a session we actually saw before counts — passing an invented id to
 * `--resume` would fail. Pi keeps its session in a file, so it never resumes by id.
 */
function resumeSessionId(run, agent) {
  const entry = run.agentMap[agent.name];
  if (entry && entry.model === agent.model && entry.session_id) return entry.session_id;
  return null;
}

async function send(run, phase, agent, promptText, systemText, sessionMeta) {
  const agentDir = join(run.sessionDir, agent.name);
  mkdirSync(agentDir, { recursive: true });
  const rawOutputPath = join(agentDir, 'raw_output.jsonl');
  const sessionFile = join(agentDir, 'pi_session.jsonl');
  const onEvent = makeStreamRecorder(run, phase, agent);

  if (agent.coding_agent === 'claude_code') {
    return engineAdapters.claude_code(
      {
        prompt: promptText,
        systemPrompt: systemText,
        model: agent.model,
        effort: agent.effort,
        thinking: agent.thinking,
        sessionId: sessionMeta.sessionId,
        rawOutputPath,
        cwd: run.repoRoot,
        env: run.env,
      },
      {
        onEvent,
        onSpawn: (pid) => run.tracer.processStart(run.fdaId, 'agent', agent.name, pid, `claude ${agent.name}`),
        onExit: (pid) => run.tracer.processEnd(run.fdaId, pid),
      },
    );
  }

  if (agent.coding_agent === 'cursor') {
    return engineAdapters.cursor(
      {
        prompt: promptText,
        systemPrompt: systemText,
        model: agent.model,
        sessionId: sessionMeta.sessionId,
        rawOutputPath,
        cwd: run.repoRoot,
        env: run.env,
      },
      {
        onEvent,
        onSpawn: (pid) => run.tracer.processStart(run.fdaId, 'agent', agent.name, pid, `cursor ${agent.name}`),
        onExit: (pid) => run.tracer.processEnd(run.fdaId, pid),
      },
    );
  }

  return engineAdapters.pi(
    {
      prompt: promptText,
      systemPrompt: systemText,
      model: agent.model,
      thinking: agent.thinking || 'medium',
      sessionFile,
      rawOutputPath,
      tools: agent.tools,
      extensions: agent.harness_engineering || [],
      cwd: run.repoRoot,
      env: run.env,
    },
    {
      onEvent,
      onSpawn: (pid) => run.tracer.processStart(run.fdaId, 'agent', agent.name, pid, `pi ${agent.name}`),
      onExit: (pid) => run.tracer.processEnd(run.fdaId, pid),
    },
  );
}

/**
 * Does the raw engine output contain an actual Report envelope? ANY `{...}` is
 * not enough — CLI error payloads like `API Error: 429 {"type":"error",...}`
 * parse as JSON but must NOT suppress the fail-fast path (they would only die
 * later as a misleading "never produced valid JSON"). Every envelope schema
 * requires a string `status`, so that field is the discriminator.
 */
function containsEnvelope(text) {
  try {
    const payload = extractJson(text);
    return Boolean(payload) && typeof payload.status === 'string';
  } catch {
    return false;
  }
}

/** Last ~10 stderr lines recorded in raw_output.jsonl (fallback: output tail). */
function stderrTail(rawOutputPath, fallbackText) {
  let lines = [];
  try {
    lines = readFileSync(rawOutputPath, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('[stderr]'))
      .map((l) => l.slice('[stderr]'.length).trim())
      .filter(Boolean);
  } catch {
    /* no raw output captured */
  }
  if (!lines.length)
    lines = String(fallbackText || '')
      .split('\n')
      .filter((l) => l.trim());
  return lines.slice(-10);
}

/**
 * Recovery hint matched against the failure text — cause + exact command.
 * Routes through the shared classifier (continuation.mjs) so the hint shown
 * to the student and the relay's arming decision can never disagree.
 */
function engineHint(text, agent) {
  const kind = continuation.classifyEngineFailure(text);
  if (kind === 'login') {
    const cmd =
      { claude_code: '`claude`', pi: '`pi` and then /login', cursor: '`cursor-agent login`' }[agent.coding_agent] ||
      agent.coding_agent;
    return `This looks like a login problem. Open a terminal, run ${cmd}, sign in again, then re-run this FDA.`;
  }
  if (kind === 'limit') {
    return 'This looks like your subscription plan limit. Limits reset on their own — wait a while and re-run this FDA. No extra payment is needed.';
  }
  return `The ${agent.coding_agent} CLI exited with an error before answering. Re-run this FDA; if it persists, run the CLI by hand to see the problem.`;
}

async function parseWithRetries(run, phase, call, result, sendFn) {
  const schema = getOutputSchema(call.outputType);
  for (let attempt = 1; attempt <= JSON_FIX_ATTEMPTS + 1; attempt++) {
    try {
      const payload = extractJson(result.text);
      return { envelope: schema.parse(payload), attempt };
    } catch (error) {
      if (attempt > JSON_FIX_ATTEMPTS) {
        throw new Error(`${phase.params.owner} never produced valid ${call.outputType} JSON: ${error.message}`);
      }
      run.console.retry(phase.params.owner, attempt, JSON_FIX_ATTEMPTS, String(error.message));
      const fields = Object.keys(schema.shape || {}).join(', ');
      result = await sendFn(
        `Your response was not valid JSON (${error.message}). Respond again with ONLY a JSON object with fields: ${fields}. No prose.`,
      );
    }
  }
}

const engineKey = (e) => `${e.coding_agent}\0${e.model}`;

/**
 * First declared fallback that is installed/authenticated and not yet tried
 * in this phase — the same hard checks run-start resolution uses.
 */
function pickRelayFallback(agent, tried) {
  const engines = checkEngines();
  for (const fb of Array.isArray(agent.fallbacks) ? agent.fallbacks : []) {
    if (!fb || !fb.coding_agent || !fb.model) continue;
    if (tried.has(engineKey(fb))) continue;
    if (engineIssue(fb, engines)) continue;
    return fb;
  }
  return null;
}

/** The interrupted Pi session file of this agent, when it has content. */
function piSessionPathIfAny(agentDir) {
  const sessionFile = join(agentDir, 'pi_session.jsonl');
  try {
    if (statSync(sessionFile).size > 0) return sessionFile;
  } catch {
    /* absent */
  }
  return null;
}

function permissionRetryPreamble(retry) {
  const paths = (retry.paths || []).map((p) => `- ${p}`).join('\n');
  return [
    '## Permission retry (automatic, once)',
    '',
    'Your previous attempt wrote path(s) outside your allowlist; those writes were rolled back and are gone:',
    paths,
    '',
    'Re-do this phase. Do not touch those paths. Stay inside your allowed writes. Re-emit ONLY your Report JSON when done.',
    '',
    '',
  ].join('\n');
}

/**
 * The user prompt for one relay leg: the rendered template, preceded by a
 * continuation preamble when a previous attempt of this run died mid-work.
 * Pi resuming its own session skips the preamble — the session file passed
 * via --session already carries the interrupted conversation.
 * A permission-retry note is prepended when this is the automatic second
 * attempt after a fully-rolled-back allowlist breach.
 */
function composeUserText(run, phase, agent, agentDir, variables, extras = {}) {
  // A bounded continuation narrows EVERY agent phase of the run, not just the
  // one that died: the scope is what the reviewer found missing, and an agent
  // that cannot see it would happily re-open work that was already accepted.
  // Prepended to the USER prompt only — the system prefix must stay byte-stable
  // for prompt caching (same rule as the engine-continuation preamble).
  const scope = continuation.buildScopeBlock(run.verdict);
  const userText = scope + prompts.render(agent.prompt_engineering.user, variables);
  const marker = continuation.readEngineError(agentDir);
  let composed = userText;
  // Only the phase that actually died gets the handover: the marker outlives
  // the relay (so --resume keeps preferring the fallbacks), but a later,
  // never-attempted phase of the same agent must not be told it was
  // interrupted — its prompt stays clean.
  if (marker && marker.phase === phase.params.name) {
    const piSession = piSessionPathIfAny(agentDir);
    if (agent.coding_agent === 'pi' && marker.coding_agent === 'pi' && piSession) {
      run.console.note(`${agent.name}: continuing the interrupted Pi session natively (--session)`);
    } else {
      const transcriptPath = join(agentDir, 'raw_output.jsonl');
      try {
        run.tracer.event({
          fda_id: run.fdaId,
          phase_id: phase.phase_id,
          type: 'engine_continuation',
          name: agent.name,
          payload: {
            kind: marker.kind,
            from: { coding_agent: marker.coding_agent, model: marker.model },
            transcript: transcriptPath,
          },
        });
      } catch {
        /* tracing must never block the attempt */
      }
      run.console.engineContinuation(agent.name, transcriptPath);
      composed =
        continuation.buildContinuationPreamble({
          marker,
          transcriptPath,
          piSessionPath: marker.coding_agent === 'pi' ? piSession : null,
        }) + userText;
    }
  }
  // The rotation reseed rides the USER prompt for the same caching reason.
  // Mutually exclusive with the marker continuation by construction: a marker
  // targeting this phase stands the rotation down (planSessionRotation).
  if (extras.rotation) {
    composed =
      continuation.buildRotationPreamble({
        contextTokens: extras.rotation.contextTokens,
        cap: extras.rotation.cap,
        changedPaths: safeChangedPaths(run),
        archivedTranscripts: extras.rotation.archivedTranscripts,
      }) + composed;
  }
  if (extras.permissionRetry) composed = permissionRetryPreamble(extras.permissionRetry) + composed;
  return composed;
}

/** The run's changed paths, or [] when git is unavailable — never throws. */
function safeChangedPaths(run) {
  try {
    return runChangedPaths(run.repoRoot, run.baseline);
  } catch {
    return [];
  }
}

/**
 * Should this phase START A FRESH SESSION instead of resuming the agent's
 * accumulated one? Rotation fires when the session's live context passed the
 * cap (`defaults.session_rotation_context`): every turn of a resumed session
 * re-reads the whole prefix, so past the cap a fresh session with a compact
 * reseed is cheaper within a handful of turns. Skipped when an engine-death
 * marker targets this phase — the continuation preamble already reseeds, and
 * a Pi native resume needs the session file in place. Archives the Pi session
 * file aside (never deleted: it stays as a read-only reference) and clears
 * the agent-map entry so resumeSessionId naturally mints a new session.
 */
function planSessionRotation(run, phase, agent, agentDir) {
  const cap = continuation.sessionRotationCapOf(run.cfg);
  if (!(cap > 0)) return null;
  const entry = run.agentMap[agent.name];
  // No session, or a model change: the next send is fresh anyway.
  if (!entry || !entry.session_id || entry.model !== agent.model) return null;
  const contextTokens = Number(entry.context_tokens) || 0;
  if (contextTokens < cap) return null;
  const marker = continuation.readEngineError(agentDir);
  if (marker && marker.phase === phase.params.name) return null;

  const archivedTranscripts = [join(agentDir, 'raw_output.jsonl')];
  if (agent.coding_agent === 'pi') {
    const sessionFile = join(agentDir, 'pi_session.jsonl');
    if (existsSync(sessionFile)) {
      let n = 1;
      while (existsSync(join(agentDir, `pi_session.${n}.rotated.jsonl`))) n += 1;
      const archived = join(agentDir, `pi_session.${n}.rotated.jsonl`);
      try {
        renameSync(sessionFile, archived);
        archivedTranscripts.push(archived);
      } catch {
        // The rename failing means the old session would still be resumed —
        // rotating only the claude/cursor way (no --resume) is wrong for Pi,
        // so stand down and try again next phase.
        return null;
      }
    }
  }
  run.saveAgentMap(agent.name, { ...entry, session_id: '', context_tokens: 0 });
  run.console.note(
    `${agent.name}: session rotated at ${contextTokens} context tokens (cap ${cap}) — fresh session with a compact reseed`,
  );
  try {
    run.tracer.event({
      fda_id: run.fdaId,
      phase_id: phase.phase_id,
      type: 'log',
      name: 'session_rotation',
      payload: { agent: agent.name, context_tokens: contextTokens, cap },
    });
  } catch {
    /* tracing must never block the rotation */
  }
  return { contextTokens, cap, archivedTranscripts };
}

/** Persist the death (marker + engine_error event) — never masks the error. */
function recordEngineFailure(run, phase, agent, agentDir, error) {
  const marker = continuation.writeEngineError(agentDir, {
    agent: agent.name,
    fda_id: run.fdaId,
    coding_agent: agent.coding_agent,
    model: agent.model,
    kind: error.kind,
    message: error.message,
    phase: phase.params.name,
  });
  try {
    run.tracer.event({
      fda_id: run.fdaId,
      phase_id: phase.phase_id,
      type: 'engine_error',
      name: agent.name,
      payload: {
        kind: error.kind,
        coding_agent: agent.coding_agent,
        model: agent.model,
        phase: phase.params.name,
        count: marker.count,
        message: String(error.message || '').slice(0, 500),
      },
    });
  } catch {
    /* tracing must never mask the failure */
  }
  return marker;
}

// Verbatim failure output stays inline up to this budget; beyond it the
// builder is pointed at the on-disk command logs (already in artifacts).
const ENVELOPE_FAILURES_BUDGET = 8000;

/**
 * Trim a previous-phase envelope to the fields the next agent actually needs.
 * Full envelopes can carry verbose plan text; the builder only consumes the
 * summary, artifacts list, and notes — passing the rest inflates every turn.
 * Quality envelopes are the exception: `failures` IS the repair round's
 * feedback channel ("Fix every failure below" points at it), so it survives
 * the trim — capped, with the overflow redirected to the artifact logs.
 */
function trimEnvelope(envelope) {
  if (!envelope) return null;
  const { summary, artifacts, notes_for_next_agent, changed_files, status, failures } = envelope;
  const trimmed = { status, summary, artifacts, changed_files, notes_for_next_agent };
  if (Array.isArray(failures) && failures.length) {
    const kept = [];
    let used = 0;
    for (const failure of failures) {
      const text = String(failure);
      if (used + text.length > ENVELOPE_FAILURES_BUDGET && kept.length) {
        kept.push(`(+${failures.length - kept.length} more failure(s) — full output in the artifact logs above)`);
        break;
      }
      kept.push(used + text.length > ENVELOPE_FAILURES_BUDGET ? `${text.slice(0, ENVELOPE_FAILURES_BUDGET)}\n… (truncated — full output in the artifact logs above)` : text);
      used += text.length;
    }
    trimmed.failures = kept;
  }
  return trimmed;
}

export async function execute(run, phase, call) {
  const agent = resolveForPhase(run.cfg, phase.params.owner, phase.params.name);
  const trimmed = trimEnvelope(call.previous);
  const variables = {
    prompt: call.prompt,
    previous_envelope: trimmed ? JSON.stringify(trimmed, null, 2) : '(none)',
    context_handoff_dir: run.contextHandoffDir,
  };
  const systemText = prompts.render(agent.prompt_engineering.system, variables);
  const agentDir = join(run.sessionDir, agent.name);
  mkdirSync(join(agentDir, 'prompts'), { recursive: true });
  prompts.savePromptDir(join(agentDir, 'prompts'), 'system.md', systemText);

  // relay: 'auto' switches engines in-run on engine death; 'resume' arms the
  // fallbacks only on --resume; 'off' never auto-switches.
  const relayMode = continuation.relayModeOf(run.cfg);
  const tried = new Set([engineKey(agent)]);
  // Decided ONCE per phase, before the first send: a rotated session stays
  // rotated for every relay leg (relay legs start fresh sessions anyway).
  const rotation = planSessionRotation(run, phase, agent, agentDir);
  // One automatic retry after a fully-rolled-back allowlist breach. The
  // rollback IS the fix; the second attempt is told which paths to leave
  // alone. A second breach (or an unrecoverable one) surfaces to the engineer.
  let permissionRetry = null;

  for (;;) {
    // Composed and saved BEFORE the send so the audit copy under prompts/
    // shows what was actually sent — continuation preamble included.
    const userText = composeUserText(run, phase, agent, agentDir, variables, { permissionRetry, rotation });
    prompts.savePromptDir(join(agentDir, 'prompts'), 'user.md', userText);
    try {
      const envelope = await attemptPhase(run, phase, call, agent, agentDir, systemText, userText);
      continuation.clearEngineError(agentDir, agent);
      return envelope;
    } catch (error) {
      if (error instanceof permissions.PermissionBreach && !permissionRetry && permissions.canAutoRetryBreach(error)) {
        permissionRetry = { paths: error.violations };
        run.console.retry(
          agent.name,
          1,
          1,
          `unauthorized writes rolled back (${error.restored.length}/${error.violations.length}) — retrying the phase once`,
        );
        try {
          run.tracer.event({
            fda_id: run.fdaId,
            phase_id: phase.phase_id,
            type: 'log',
            name: 'permission_retry',
            payload: {
              agent: agent.name,
              restored: error.restored.length,
              violations: error.violations,
            },
          });
        } catch {
          /* tracing must never mask the retry */
        }
        continue;
      }
      if (!(error instanceof EngineFailure)) throw error;
      const marker = recordEngineFailure(run, phase, agent, agentDir, error);
      if (relayMode !== 'auto') throw error;
      if (!continuation.shouldArmFallback(marker)) {
        // A first crash retries the SAME engine once, cold, with the
        // continuation preamble — one transient CLI death must not demote
        // the engine the student chose.
        run.console.engineRetry(agent.name, 'first crash — retrying the same engine once');
        continue;
      }
      const next = pickRelayFallback(agent, tried);
      if (!next) throw error;
      const from = { coding_agent: agent.coding_agent, model: agent.model };
      // Mutate in place (same semantics as resolveEngines): later phases owned
      // by this agent stay on the substitute for the rest of the run.
      agent.coding_agent = next.coding_agent;
      agent.model = next.model;
      if (next.effort !== undefined) agent.effort = next.effort;
      if (next.thinking !== undefined) agent.thinking = next.thinking;
      // When phase_overrides produced a copy, the relay mutation above is
      // local to that copy and lost after execute() returns. Propagate the
      // switch back to the canonical config entry so future phases (which
      // re-resolve from cfg.agents[]) inherit the substitution.
      const base = (run.cfg.agents || []).find((a) => a.name === agent.name);
      if (base && base !== agent) {
        base.coding_agent = next.coding_agent;
        base.model = next.model;
        if (next.effort !== undefined) base.effort = next.effort;
        if (next.thinking !== undefined) base.thinking = next.thinking;
      }
      tried.add(engineKey(agent));
      run.console.engineRelay(agent.name, from, { coding_agent: agent.coding_agent, model: agent.model }, error.kind);
      try {
        run.tracer.event({
          fda_id: run.fdaId,
          phase_id: phase.phase_id,
          type: 'engine_relay',
          name: agent.name,
          payload: { from, to: { coding_agent: agent.coding_agent, model: agent.model }, kind: error.kind },
        });
      } catch {
        /* tracing must never mask the relay */
      }
    }
  }
}

/**
 * One full attempt of the phase on the agent's CURRENT engine: session
 * resolution, sends, gate loop, permission enforcement, envelope persistence
 * and usage stamping. One call per relay leg — each leg owns its own tree
 * snapshot, spend counters and enforced flag, so a dead leg's spend is
 * stamped on the engine that burned it and never re-attributed.
 */
async function attemptPhase(run, phase, call, agent, agentDir, systemText, userText) {
  // Resume only a session we've actually seen; engines mint the real id on the
  // first send and corrections MUST continue that same session.
  let sessionId = resumeSessionId(run, agent);
  run.tracer.event({
    fda_id: run.fdaId,
    phase_id: phase.phase_id,
    type: 'agent_start',
    name: agent.name,
    payload: { model: agent.model, coding_agent: agent.coding_agent, session_id: sessionId || '(new)' },
  });
  run.console.agentStarted(agent.name, agent.model, sessionId || '(new)');

  const treeBefore = permissions.snapshot(run);
  const rawOutputPath = join(agentDir, 'raw_output.jsonl');
  let spentTokens = 0;
  let spentCost = 0;
  let spentInput = 0;
  let spentOutput = 0;
  let spentCacheRead = 0;
  let spentCacheWrite = 0;
  // Set true the moment enforce STARTS on the happy path, so the error path
  // never runs it twice (a PermissionBreach from enforce itself included).
  let enforced = false;

  const doSend = async (promptText) => {
    const result = await send(run, phase, agent, promptText, systemText, { sessionId });
    // Account for the call BEFORE classifying its exit. Engines can return
    // real usage together with a non-zero code (limit, crash after generation,
    // invalid resumed session). Dropping that spend makes both the session
    // total and cost-report understate the exact failures relay is meant to
    // make visible.
    if (result.session_id) sessionId = result.session_id;
    const tokens = result.tokens || 0;
    const cost = result.cost || 0;
    run.addUsage(tokens, cost);
    spentTokens += tokens;
    spentCost += cost;
    spentInput += result.input_tokens || 0;
    spentOutput += result.output_tokens || 0;
    spentCacheRead += result.cache_read_tokens || 0;
    spentCacheWrite += result.cache_write_tokens || 0;
    if (result.returncode === 127) {
      throw new EngineFailure(`${agent.name} (${agent.coding_agent}): ${result.text}`, {
        kind: 'missing',
        coding_agent: agent.coding_agent,
        model: agent.model,
      });
    }
    // Any other non-zero exit without a parseable envelope (not logged in, plan
    // limit, invalid session…) fails IMMEDIATELY with the engine's own words —
    // burning JSON-fix attempts on it would only hide the real cause.
    if (result.returncode !== 0 && !containsEnvelope(result.text)) {
      const tail = stderrTail(rawOutputPath, result.text);
      const failureText = `${tail.join('\n')}\n${result.text}`;
      throw new EngineFailure(
        `${agent.name} (${agent.coding_agent}) exited with code ${result.returncode} without a report.\n` +
          (tail.length ? `Engine output (last lines):\n  ${tail.join('\n  ')}\n` : '') +
          engineHint(failureText, agent),
        {
          kind: continuation.classifyEngineFailure(failureText),
          coding_agent: agent.coding_agent,
          model: agent.model,
        },
      );
    }
    return result;
  };

  try {
    let result = await doSend(userText);
    let { envelope, attempt } = await parseWithRetries(run, phase, call, result, doSend);

    for (let gateAttempt = 1; gateAttempt <= Math.max(1, (phase.params.retries || 0) + 1); gateAttempt++) {
      const violations = [];
      for (const gate of call.gates || []) {
        const raw = gate(envelope, run);
        const report = raw.checks ? raw : gateReportFromList(raw);
        run.tracer.gateRow(phase, gate.name || 'gate', report, gateAttempt);
        run.tracer.event({
          fda_id: run.fdaId,
          phase_id: phase.phase_id,
          type: report.passed ? 'gate_pass' : 'gate_fail',
          name: gate.name || 'gate',
          payload: { attempt: gateAttempt, checks: report.checks.length, violations: report.violations },
        });
        run.console.gateResult(gate.name || 'gate', report);
        violations.push(...report.violations);
      }
      if (!violations.length) break;
      if (gateAttempt > (phase.params.retries || 0)) {
        throw new GateFailure(`${agent.name} failed gates:\n- ${violations.join('\n- ')}`);
      }
      const correction =
        'Your previous response failed validation:\n- ' +
        violations.join('\n- ') +
        '\n\nFix these problems, then re-emit ONLY your Report JSON.';
      result = await doSend(correction);
      ({ envelope, attempt } = await parseWithRetries(run, phase, call, result, doSend));
    }

    enforced = true;
    permissions.enforce(run, phase, agent, treeBefore);

    writeFileSync(
      join(agentDir, 'envelope.json'),
      JSON.stringify({ agent_name: agent.name, output_type: call.outputType, attempt, ...envelope }, null, 2),
    );
    run.tracer.envelopeRow(phase, agent.name, call.outputType, JSON.stringify(envelope), true, attempt);
    run.console.envelopeSummary(envelope);

    run.saveAgentMap(agent.name, {
      session_id: sessionId || result.session_id || '',
      model: agent.model,
      coding_agent: agent.coding_agent,
      // Live context of the session after this phase — the rotation cap
      // compares against this on the NEXT phase (planSessionRotation).
      context_tokens: result.context_tokens || 0,
    });
    run.tracer.agentSessionRow(
      run.fdaId,
      agent,
      sessionId || result.session_id || '',
      result.context_tokens || 0,
      result.context_window || 0,
    );
    run.tracer.event({
      fda_id: run.fdaId,
      phase_id: phase.phase_id,
      type: 'agent_end',
      name: agent.name,
      tokens: spentTokens,
      // cache_read/cache_write measure the phase's hit rate (cached reads cost
      // ~10% of input on both plans) — a sharp drop = unstable prefix.
      // model/coding_agent stamp the spend at the moment it happened: the
      // per-LLM usage ledger groups by THIS, so editing the roster later (or a
      // fallback on a future run) never re-attributes what this model spent.
      payload: {
        cost: spentCost,
        input: spentInput,
        output: spentOutput,
        cache_read: spentCacheRead,
        cache_write: spentCacheWrite,
        model: agent.model,
        coding_agent: agent.coding_agent,
      },
    });
    run.console.agentFinished(agent.name, spentTokens, spentCost);

    if (envelope.status !== 'success') {
      throw new Error(`${agent.name} reported status=${envelope.status}: ${envelope.summary}`);
    }
    return envelope;
  } catch (error) {
    // A failing run must not leave unauthorized writes behind: enforce (and
    // roll back) on the error path too — but a secondary breach never masks
    // the original failure, it is logged and appended as a note.
    if (!enforced) {
      try {
        permissions.enforce(run, phase, agent, treeBefore);
      } catch (breach) {
        run.tracer.event({
          fda_id: run.fdaId,
          phase_id: phase.phase_id,
          type: 'error',
          name: 'permission_breach_during_failure',
          payload: { agent: agent.name, error: String(breach.message || breach).slice(0, 1000) },
        });
        try {
          error.message += `\n(also: unauthorized changes were rolled back — ${String(breach.message || breach)})`;
        } catch {
          /* read-only message — the original error still propagates */
        }
      }
    }
    // The tokens this attempt burned are already in the session totals
    // (addUsage runs on every send) — stamp them for the per-LLM ledger too,
    // or every failed phase's spend silently vanishes from the Agents tab.
    // A distinct type keeps timeline consumers of `agent_end` unaffected.
    if (spentTokens > 0) {
      try {
        run.tracer.event({
          fda_id: run.fdaId,
          phase_id: phase.phase_id,
          type: 'agent_spend',
          name: agent.name,
          tokens: spentTokens,
          payload: {
            cost: spentCost,
            input: spentInput,
            output: spentOutput,
            cache_read: spentCacheRead,
            cache_write: spentCacheWrite,
            model: agent.model,
            coding_agent: agent.coding_agent,
            failed: true,
          },
        });
      } catch {
        /* tracing must never mask the original failure */
      }
    }
    throw error;
  }
}

function gateReportFromList(list) {
  const report = gateReport();
  for (const v of list || []) report.check(String(v), false, String(v));
  return report;
}
