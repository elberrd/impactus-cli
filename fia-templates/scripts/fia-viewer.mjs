#!/usr/bin/env node
/**
 * FIA viewer — local observability app for FDA runs, backed by imp/data/fia.db.
 *
 * Serves a single-page app (see fia-viewer-page.mjs) with:
 *   - session list + Gantt timeline of phases
 *   - phase drill-down: agent config, compiled prompts, gates, typed envelope
 *   - live event stream (tool calls with real durations, gates, phases, logs)
 *   - "Interactive Pi" view: live pi sessions + subagent runs of this project,
 *     read from ~/.pi/agent/sessions (override with PI_SESSIONS_DIR)
 *   - "Plan" view: everything /map (or /start) created under ai-docs/ —
 *     screens/routes, task breakdown, design system, workflow progress
 *     (override the dir with FIA_AI_DOCS or --ai-docs)
 *
 * Read-only over WAL: watching a live run never blocks the writer.
 *
 * Usage (from the project root):
 *   node imp/scripts/fia-viewer.mjs [--port 4600] [--db imp/data/fia.db] [--no-open]
 *                                   [--view plan] [--ai-docs ai-docs] [--detach]
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { PAGE } from './fia-viewer-page.mjs';
import { piSessionsDirFor, listPiSessions, readPiSession, readPiRun } from './pi-sessions.mjs';
import { readPlanOverview, readPlanScreens, readPlanTasks, readPlanDesign, readPlanDoc } from './plan-docs.mjs';
import { checkEngines, grokModels, PI_ENV_KEYS, PI_OAUTH_PROVIDERS } from '../modules/engines.mjs';
import { saveRoster, validateRosterPatch } from './roster.mjs';

const DEFAULT_DB = process.env.FIA_DB || 'imp/data/fia.db';
const DEFAULT_CONFIG = process.env.FIA_CONFIG || 'imp/fia.config.yaml';
const DEFAULT_AI_DOCS = process.env.FIA_AI_DOCS || 'ai-docs';
const DEFAULT_PORT = 4600;
const PORT_WALK = 15;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Pin every path the viewer reads to an absolute location. A relative
 * `imp/data/fia.db` follows `process.cwd()` — after a folder move, or when
 * an old detached process is still bound to :4600, that silently becomes
 * "No runs yet" while the TUI (started in the new folder) still shows them.
 */
function realPath(p) {
  const abs = resolve(p);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

export function resolveViewerPaths({
  dbPath = DEFAULT_DB,
  configPath = DEFAULT_CONFIG,
  aiDocsDir = DEFAULT_AI_DOCS,
  projectRoot = process.env.FIA_PROJECT_ROOT || process.cwd(),
} = {}) {
  const root = realPath(projectRoot);
  return {
    projectRoot: root,
    dbPath: realPath(resolve(root, dbPath)),
    configPath: realPath(resolve(root, configPath)),
    aiDocsDir: realPath(resolve(root, aiDocsDir)),
  };
}

/**
 * Reuse the occupant only when it is THIS project. A relative dbPath from
 * another process is that process's cwd, which we cannot see — never treat
 * `imp/data/fia.db` as a match. The leftover after a folder move reports
 * `db: false` and a relative path; walking to the next port is the fix.
 */
export function shouldReuseViewer(existing, ours) {
  if (!existing || typeof existing !== 'object' || !ours) return false;
  if (existing.projectRoot && existing.projectRoot === ours.projectRoot) return true;
  if (existing.dbPath && isAbsolute(existing.dbPath) && existing.dbPath === ours.dbPath) return true;
  return false;
}

export async function probeViewer(port, host = '127.0.0.1') {
  try {
    const res = await fetch(`http://${host}:${port}/api/sessions`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function startViewer({
  dbPath = DEFAULT_DB,
  configPath = DEFAULT_CONFIG,
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  piDir = process.env.PI_SESSIONS_DIR || piSessionsDirFor(),
  aiDocsDir = DEFAULT_AI_DOCS,
  projectRoot = process.env.FIA_PROJECT_ROOT || process.cwd(),
} = {}) {
  ({ dbPath, configPath, aiDocsDir, projectRoot } = resolveViewerPaths({
    dbPath,
    configPath,
    aiDocsDir,
    projectRoot,
  }));
  let db = null;
  const getDb = () => {
    if (db) return db;
    if (!existsSync(dbPath)) return null;
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 2000');
    return db;
  };

  const readConfig = () => {
    try {
      return parseYaml(readFileSync(configPath, 'utf8')) || {};
    } catch {
      return {};
    }
  };

  /** Roster for display: defaults merged into each agent (color, model, tools…). */
  const rosterInfo = () => {
    const cfg = readConfig();
    const defaults = cfg.defaults || {};
    const agents = {};
    for (const a of cfg.agents || []) {
      agents[a.name] = {
        name: a.name,
        color: a.color || null,
        coding_agent: a.coding_agent ?? defaults.coding_agent ?? 'pi',
        model: a.model ?? defaults.model ?? '',
        thinking: a.thinking ?? defaults.thinking ?? '',
        effort: a.effort ?? defaults.effort ?? '',
        purpose: a.purpose || '',
        tools: a.tools ?? defaults.tools ?? [],
        writes: a.writes === undefined ? null : a.writes,
      };
    }
    return agents;
  };

  const sessionsDir = () => join(dirname(dbPath), 'sessions');

  // ── Agents tab: engine status + roster read/save ───────────────────────────

  /** Roster as STORED (no defaults merged) — what the editor writes back. */
  const storedRoster = () => {
    const cfg = readConfig();
    return {
      defaults: cfg.defaults || {},
      agents: (cfg.agents || []).map((a) => ({
        name: a.name,
        color: a.color || null,
        purpose: a.purpose || '',
        coding_agent: a.coding_agent,
        model: a.model,
        effort: a.effort,
        thinking: a.thinking,
        fallbacks: Array.isArray(a.fallbacks) ? a.fallbacks : [],
      })),
    };
  };

  // `cursor-agent --list-models` is a live call — cache it for a minute.
  let cursorModelsCache = { at: 0, models: null };
  const cursorModels = () =>
    new Promise((resolve) => {
      if (Date.now() - cursorModelsCache.at < 60_000) return resolve(cursorModelsCache.models);
      execFile('cursor-agent', ['--list-models'], { timeout: 4000 }, (err, stdout) => {
        const models = err
          ? null
          : String(stdout || '')
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => l && !l.includes(' '))
              .slice(0, 60);
        cursorModelsCache = { at: Date.now(), models };
        resolve(models);
      });
    });

  // A crash or Ctrl-C can leave a session stuck on status='running' forever;
  // after this much silence we treat it as abandoned instead of live.
  const STALE_MS = 10 * 60_000;

  const pidAlive = (pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Sessions still marked 'running', each tagged `stale` when orphaned:
   * newest event older than STALE_MS and no live pid in `processes`.
   * Stale orphans must never lock the roster save or animate forever.
   */
  const runningSessions = () => {
    const d = getDb();
    if (!d) return [];
    try {
      return d.prepare("SELECT fda_id, started_at FROM sessions WHERE status='running'").all().map((s) => {
        let last = s.started_at;
        try {
          const row = d.prepare('SELECT MAX(COALESCE(ended_at, started_at)) AS t FROM events WHERE fda_id=?').get(s.fda_id);
          if (row?.t) last = row.t;
        } catch { /* no events yet — fall back to session start */ }
        const ageMs = last ? Math.max(0, Date.now() - Date.parse(last)) : Number.POSITIVE_INFINITY;
        let alive = false;
        if (!(ageMs < STALE_MS)) {
          // Quiet for a while — a live recorded pid still counts as running
          // (e.g. one long tool call with no events in between).
          try {
            const proc = d
              .prepare('SELECT pid FROM processes WHERE fda_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
              .get(s.fda_id);
            alive = pidAlive(proc?.pid);
          } catch { /* no processes table — stay stale */ }
        }
        return {
          fda_id: s.fda_id,
          last_activity: last || null,
          age_s: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
          stale: !(ageMs < STALE_MS) && !alive,
        };
      });
    } catch {
      return [];
    }
  };

  const runningCount = () => runningSessions().filter((s) => !s.stale).length;

  // Validation enums and the comment-preserving YAML writer live in
  // roster.mjs, shared with the terminal switcher (fia-llm.mjs).
  const saveRosterPatch = (patch) => saveRoster({ configPath, backupDir: join(dirname(dbPath), 'backups') }, patch);

  /**
   * The viewer gained a WRITE endpoint, so every request must prove it is
   * local: a malicious site could otherwise hit us via DNS rebinding.
   */
  const isLocalRequest = (req) => {
    const hostHeader = String(req.headers.host || '');
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(hostHeader)) return false;
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(origin))) return false;
    return true;
  };

  const readBody = (req) =>
    new Promise((resolvePromise, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1e6) reject(new Error('body too large'));
      });
      req.on('end', () => resolvePromise(data));
      req.on('error', reject);
    });

  const server = createServer(async (req, res) => {
    try {
      if (!isLocalRequest(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('Forbidden');
      }
      // A malformed request line must answer 400, never crash the server.
      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        return res.end('bad request: malformed URL');
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      } else if (url.pathname === '/api/sessions') {
        const d = getDb();
        // `outcome`/`outcome_reason` are probed, not named blindly: the trace
        // schema is create-only, so they exist only in a db a new Tracer has
        // opened, and naming a missing column would 500 the whole list.
        const outcomeCols =
          d && d.pragma('table_info(sessions)').some((c) => c.name === 'outcome') ? ', outcome, outcome_reason' : '';
        const rows = d
          ? d
              .prepare(
                `SELECT fda_id, fda_name, status, engineer, substr(request,1,120) AS request,
                        started_at, ended_at, total_tokens, total_cost${outcomeCols}
                 FROM sessions ORDER BY started_at DESC LIMIT 80`,
              )
              .all()
          : [];
        const staleMap = new Map(runningSessions().map((s) => [s.fda_id, s]));
        const sessions = rows.map((s) => {
          const live = s.status === 'running' ? staleMap.get(s.fda_id) : null;
          return live ? { ...s, stale: live.stale, last_activity: live.last_activity } : s;
        });
        json(res, { db: Boolean(d), dbPath, projectRoot, sessions });
      } else if (url.pathname === '/api/session') {
        const d = getDb();
        const id = url.searchParams.get('fda_id') || '';
        if (!d || !SAFE_ID.test(id)) return json(res, { error: 'unknown session' }, 404);
        const session = d.prepare('SELECT * FROM sessions WHERE fda_id=?').get(id);
        if (!session) return json(res, { error: 'unknown session' }, 404);
        if (session.status === 'running') {
          const live = runningSessions().find((s) => s.fda_id === id);
          if (live) {
            session.stale = live.stale;
            session.last_activity = live.last_activity;
          }
        }
        const phases = d
          .prepare(
            `SELECT phase_id, seq, name, kind, owner, description, status, attempt, error, started_at, ended_at
             FROM phases WHERE fda_id=? ORDER BY seq`,
          )
          .all(id);
        const gates = d
          .prepare(
            `SELECT phase_id, attempt, gate, passed, violations_json, checks_json, created_at
             FROM gate_results WHERE fda_id=? ORDER BY id`,
          )
          .all(id);
        const envelopes = d
          .prepare(
            `SELECT phase_id, agent, output_type, payload_json, valid, attempt, created_at
             FROM envelopes WHERE fda_id=? ORDER BY created_at`,
          )
          .all(id);
        const agentSessions = d
          .prepare('SELECT agent, coding_agent, model, session_id, context_tokens, context_window FROM agent_sessions WHERE fda_id=?')
          .all(id);
        const phaseTokens = d
          .prepare('SELECT phase_id, SUM(tokens) AS tokens FROM events WHERE fda_id=? AND tokens > 0 GROUP BY phase_id')
          .all(id);
        json(res, { session, phases, gates, envelopes, agentSessions, phaseTokens, roster: rosterInfo(), now: new Date().toISOString() });
      } else if (url.pathname === '/api/events') {
        const d = getDb();
        const id = url.searchParams.get('fda_id') || '';
        const after = Number(url.searchParams.get('after') || 0);
        if (!d || !SAFE_ID.test(id)) return json(res, { events: [], last: after });
        const events = d
          .prepare(
            `SELECT rowid AS rid, type, name, payload_json, tokens, started_at, ended_at
             FROM events WHERE fda_id=? AND rowid > ? ORDER BY rowid LIMIT 500`,
          )
          .all(id, after);
        json(res, { events, last: events.length ? events.at(-1).rid : after, now: new Date().toISOString() });
      } else if (url.pathname === '/api/prompts') {
        const id = url.searchParams.get('fda_id') || '';
        const agent = url.searchParams.get('agent') || '';
        if (!SAFE_ID.test(id) || !SAFE_ID.test(agent)) return json(res, { error: 'bad request' }, 400);
        const dir = join(sessionsDir(), id, agent, 'prompts');
        const read = (name) => {
          const p = join(dir, name);
          return existsSync(p) ? readFileSync(p, 'utf8') : null;
        };
        json(res, { system: read('system.md'), user: read('user.md') });
      } else if (url.pathname === '/api/pi-sessions') {
        json(res, { dir: piDir, available: existsSync(piDir), sessions: listPiSessions(piDir), now: new Date().toISOString() });
      } else if (url.pathname === '/api/pi-session') {
        const id = url.searchParams.get('id') || '';
        const detail = readPiSession(piDir, id);
        if (!detail) return json(res, { error: 'unknown pi session' }, 404);
        json(res, { ...detail, now: new Date().toISOString() });
      } else if (url.pathname === '/api/pi-run') {
        const id = url.searchParams.get('id') || '';
        const runPath = url.searchParams.get('path') || '';
        const detail = readPiRun(piDir, id, runPath);
        if (!detail) return json(res, { error: 'unknown pi run' }, 404);
        json(res, { ...detail, now: new Date().toISOString() });
      } else if (url.pathname === '/api/plan') {
        json(res, { ...readPlanOverview(aiDocsDir, projectRoot), now: new Date().toISOString() });
      } else if (url.pathname === '/api/plan-screens') {
        json(res, readPlanScreens(aiDocsDir));
      } else if (url.pathname === '/api/plan-tasks') {
        json(res, readPlanTasks(aiDocsDir));
      } else if (url.pathname === '/api/plan-design') {
        json(res, readPlanDesign(aiDocsDir, projectRoot));
      } else if (url.pathname === '/api/plan-doc') {
        const doc = readPlanDoc(aiDocsDir, url.searchParams.get('path') || '');
        if (!doc) return json(res, { error: 'bad path' }, 400);
        json(res, doc);
      } else if (url.pathname === '/api/engines') {
        const engines = checkEngines(process.env, { root: projectRoot });
        json(res, {
          engines,
          piEnvKeys: PI_ENV_KEYS,
          piOauthProviders: PI_OAUTH_PROVIDERS,
          cursorModels: engines.cursor.installed ? await cursorModels() : null,
          // grok's own models cache (ids + advertised reasoning levels).
          grokModels: engines.grok?.installed ? grokModels() : null,
          running: runningCount(),
          now: new Date().toISOString(),
        });
      } else if (url.pathname === '/api/roster' && req.method === 'GET') {
        json(res, {
          configPath,
          roster: storedRoster(),
          merged: rosterInfo(),
          running: runningCount(),
          now: new Date().toISOString(),
        });
      } else if (url.pathname === '/api/roster' && req.method === 'POST') {
        let patch = {};
        try {
          patch = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return json(res, { error: 'invalid JSON body' }, 400);
        }
        const invalid = validateRosterPatch(patch);
        if (invalid) return json(res, { error: invalid }, 400);
        // Only sessions that are REALLY alive lock the save — an orphan left
        // 'running' by a crash/Ctrl-C must not brick the roster editor.
        const live = runningSessions().filter((s) => !s.stale);
        if (live.length > 0) {
          // The permission gate attributes any external change during a phase
          // to that phase's agent and reverts it — never write mid-run.
          return json(res, { error: 'fda-running', running: live.length, fda_id: live[0].fda_id, age_s: live[0].age_s, sessions: live }, 409);
        }
        json(res, { ok: true, ...saveRosterPatch(patch) });
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    } catch (err) {
      json(res, { error: String(err?.message || err) }, 500);
    }
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolvePromise(server);
    });
  });
}

function json(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * Bind this project's viewer. Same project already on the port → reuse.
 * A leftover from another folder (or a moved one) → walk forward so the
 * browser never lands on someone else's empty "No runs yet".
 */
export async function bindViewer(opts) {
  const requested = Number(opts.port) || DEFAULT_PORT;
  const ours = resolveViewerPaths(opts);
  try {
    const server = await startViewer({ ...opts, port: requested });
    return { server, port: server.address().port, reused: false };
  } catch (err) {
    if (err?.code !== 'EADDRINUSE') throw err;
  }
  const existing = await probeViewer(requested);
  if (shouldReuseViewer(existing, ours)) {
    return { server: null, port: requested, reused: true };
  }
  for (let p = requested + 1; p <= requested + PORT_WALK; p++) {
    try {
      const server = await startViewer({ ...opts, port: p });
      return { server, port: server.address().port, reused: false };
    } catch (err) {
      if (err?.code !== 'EADDRINUSE') throw err;
      const other = await probeViewer(p);
      if (shouldReuseViewer(other, ours)) {
        return { server: null, port: p, reused: true };
      }
    }
  }
  const err = new Error(`No free FIA viewer port in ${requested}–${requested + PORT_WALK}`);
  err.code = 'EADDRINUSE';
  throw err;
}

// ── CLI entry ────────────────────────────────────────────────────────────────

const VIEWER_URL_RE = /https?:\/\/127\.0\.0\.1:\d+\S*/;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
  };
  const port = Number(flag('--port')) || DEFAULT_PORT;
  const dbPath = flag('--db') || DEFAULT_DB;
  const aiDocsDir = flag('--ai-docs') || DEFAULT_AI_DOCS;
  const view = (flag('--view') || '').toLowerCase();
  const hash = view === 'plan' ? '#plan' : view === 'agents' ? '#agents' : view === 'pi' ? '#pi' : '';

  const openBrowser = (target) => {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [target], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).on('error', () => {});
  };

  if (args.includes('--detach')) {
    // Re-spawn without --detach: the server outlives the caller (e.g. /map
    // inside pi) and this process returns immediately. The child prints the
    // URL it actually bound (which may have walked off :4600) — the parent
    // relays that, never the requested port.
    const childArgs = [process.argv[1], ...args.filter((a) => a !== '--detach')];
    const child = spawn(process.execPath, childArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let childOut = '';
    let childErr = '';
    child.stdout.on('data', (chunk) => { childOut += chunk; });
    child.stderr.on('data', (chunk) => { childErr += chunk; });
    const outcome = await new Promise((resolveWait) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolveWait(result);
      };
      const timer = setTimeout(() => finish({ kind: 'timeout' }), 2000);
      const consider = () => {
        const m = childOut.match(VIEWER_URL_RE);
        if (m) finish({ kind: 'url', url: m[0] });
      };
      child.stdout.on('data', consider);
      child.once('exit', (code) => {
        const m = childOut.match(VIEWER_URL_RE);
        if (m) finish({ kind: 'url', url: m[0] });
        else finish({ kind: 'exit', code: code ?? 1 });
      });
      consider();
    });
    if (outcome.kind === 'url') {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      console.log(`FIA viewer in the background: ${outcome.url}`);
    } else {
      console.error(childErr.trim() || 'The FIA viewer failed to start in the background.');
      console.error(`To see the full error, run it in the foreground: node imp/scripts/fia-viewer.mjs --port ${port}`);
      process.exit(1);
    }
  } else {
    try {
      const bound = await bindViewer({ dbPath, port, aiDocsDir });
      const url = `http://127.0.0.1:${bound.port}${hash}`;
      if (bound.reused) {
        console.log(`FIA viewer is already running: ${url}`);
      } else {
        const resolved = resolveViewerPaths({ dbPath, aiDocsDir });
        console.log(
          hash === '#plan'
            ? `Project plan: ${url}  (docs: ${resolved.aiDocsDir} — Ctrl+C to quit)`
            : hash === '#agents'
              ? `Agent roster: ${url}  (config: imp/fia.config.yaml — Ctrl+C to quit)`
              : `FIA viewer: ${url}  (db: ${resolved.dbPath} — Ctrl+C to quit)`,
        );
      }
      if (!args.includes('--no-open')) openBrowser(url);
    } catch (err) {
      console.error(String(err?.message || err));
      process.exit(1);
    }
  }
}
