import Database from 'better-sqlite3';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId, nowIso } from './utils.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  fda_id TEXT PRIMARY KEY,
  fda_name TEXT,
  request TEXT,
  status TEXT,
  engineer TEXT,
  started_at TEXT,
  ended_at TEXT,
  total_tokens INTEGER DEFAULT 0,
  total_cost REAL DEFAULT 0,
  outcome TEXT,
  outcome_reason TEXT
);
CREATE TABLE IF NOT EXISTS phases (
  phase_id TEXT PRIMARY KEY,
  fda_id TEXT,
  seq INTEGER,
  name TEXT,
  kind TEXT,
  owner TEXT,
  description TEXT,
  status TEXT DEFAULT 'fail',
  attempt INTEGER DEFAULT 0,
  error TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  fda_id TEXT,
  phase_id TEXT,
  parent_id TEXT,
  type TEXT,
  name TEXT,
  payload_json TEXT,
  tokens INTEGER,
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id TEXT PRIMARY KEY,
  fda_id TEXT,
  phase_id TEXT,
  agent TEXT,
  output_type TEXT,
  payload_json TEXT,
  valid INTEGER,
  attempt INTEGER,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fda_id TEXT,
  phase_id TEXT,
  attempt INTEGER,
  gate TEXT,
  passed INTEGER,
  violations_json TEXT,
  checks_json TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS processes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fda_id TEXT,
  kind TEXT,
  name TEXT,
  pid INTEGER,
  command TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  fda_id TEXT,
  agent TEXT,
  coding_agent TEXT,
  model TEXT,
  session_id TEXT,
  context_tokens INTEGER,
  context_window INTEGER,
  created_at TEXT,
  last_used_at TEXT,
  PRIMARY KEY (fda_id, agent)
);
`;

// Read-heavy diagnostics filter traces by FDA id or bounded time window. Keep
// these indexes in normal DB creation/migration; read-only collectors must
// never create them on demand.
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_evolution_window
     ON sessions (COALESCE(ended_at, started_at), started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_phases_evolution_fda
     ON phases (fda_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_events_evolution_fda
     ON events (fda_id)`,
  `CREATE INDEX IF NOT EXISTS idx_events_evolution_fda_type
     ON events (fda_id, type, name)`,
  `CREATE INDEX IF NOT EXISTS idx_envelopes_evolution_fda_created
     ON envelopes (fda_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_gate_results_evolution_fda
     ON gate_results (fda_id)`,
];

export class Tracer {
  constructor(dbPath, eventsJsonl) {
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(dirname(eventsJsonl), { recursive: true });
    this.dbPath = dbPath;
    this.eventsJsonl = eventsJsonl;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    this.#migrate();
    this.#ensureIndexes();
  }

  /**
   * The schema above is create-only (`IF NOT EXISTS`), so a project database
   * created by an older runtime never gains new columns from it. Probe and add
   * the ones the current runtime writes. Best-effort on purpose: a locked or
   * read-only database must degrade, never break the run.
   */
  #migrate() {
    try {
      const present = new Set(
        this.db
          .prepare('PRAGMA table_info(sessions)')
          .all()
          .map((c) => c.name),
      );
      for (const column of ['outcome', 'outcome_reason']) {
        if (!present.has(column)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
      }
    } catch {
      /* locked or read-only db — the run continues without the new columns */
    }
  }

  #ensureIndexes() {
    for (const statement of INDEXES) {
      try {
        this.db.exec(statement);
      } catch {
        /* partial legacy schema or locked DB — runtime writes still proceed */
      }
    }
  }

  event(record) {
    const eventId = `evt_${newId(12)}`;
    const ts = nowIso();
    appendFileSync(this.eventsJsonl, JSON.stringify({ event_id: eventId, ts, ...record }) + '\n');
    this.db
      .prepare(
        `INSERT INTO events (event_id, fda_id, phase_id, parent_id, type, name, payload_json, tokens, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        record.fda_id,
        record.phase_id || '',
        record.parent_id || '',
        record.type,
        record.name || '',
        JSON.stringify(record.payload || {}),
        record.tokens ?? null,
        record.started_at || ts,
        record.ended_at || null,
      );
    return eventId;
  }

  sessionStart(fdaId, engineer, fdaName = null) {
    this.db
      .prepare(
        `INSERT INTO sessions (fda_id, status, engineer, started_at) VALUES (?, 'running', ?, ?)
         ON CONFLICT(fda_id) DO UPDATE SET status='running', ended_at=NULL`,
      )
      .run(fdaId, engineer, nowIso());
    // A resumed run reuses its fda_id, so the row still carries the PREVIOUS
    // attempt's terminal outcome — and every reader prefers `outcome` over
    // `status`, which would label a live run "attempt cap reached" for its whole
    // duration. Clear it here, in its own guarded statement: naming these
    // columns inside the upsert above would throw on a database whose
    // best-effort ALTER never ran.
    try {
      this.db.prepare('UPDATE sessions SET outcome=NULL, outcome_reason=NULL WHERE fda_id=?').run(fdaId);
    } catch {
      /* pre-migration db without the columns — nothing to clear */
    }
    if (fdaName) {
      const row = this.db.prepare('SELECT fda_name FROM sessions WHERE fda_id=?').get(fdaId);
      const names = row?.fda_name ? row.fda_name.split(' + ') : [];
      if (!names.includes(fdaName)) names.push(fdaName);
      this.db.prepare('UPDATE sessions SET fda_name=? WHERE fda_id=?').run(names.join(' + '), fdaId);
    }
  }

  sessionRequest(fdaId, request) {
    this.db.prepare('UPDATE sessions SET request=? WHERE fda_id=?').run(request, fdaId);
  }

  sessionAddUsage(fdaId, tokens, cost) {
    this.db
      .prepare('UPDATE sessions SET total_tokens=total_tokens+?, total_cost=total_cost+? WHERE fda_id=?')
      .run(tokens, cost, fdaId);
  }

  /**
   * Lifetime tokens already recorded for this session across every attempt —
   * the baseline the run-level token budget counts from on --resume. Fails
   * OPEN (0): an unreadable row must degrade the guard, never block a run.
   */
  sessionTokens(fdaId) {
    try {
      const row = this.db.prepare('SELECT total_tokens FROM sessions WHERE fda_id=?').get(fdaId);
      return Number(row?.total_tokens) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Close the session. `outcome` is the NAMED terminal reason (see
   * modules/outcome.mjs); it is written only when non-empty, so a later, more
   * precise settle is never overwritten by a vaguer one — and every existing
   * two-argument caller keeps working unchanged.
   */
  sessionFinish(fdaId, ok, { outcome = null, reason = '' } = {}) {
    this.db
      .prepare('UPDATE sessions SET status=?, ended_at=? WHERE fda_id=?')
      .run(ok ? 'success' : 'fail', nowIso(), fdaId);
    if (typeof outcome === 'string' && outcome) {
      try {
        this.db
          .prepare('UPDATE sessions SET outcome=?, outcome_reason=? WHERE fda_id=?')
          .run(outcome, String(reason || ''), fdaId);
      } catch {
        /* pre-migration db without the columns — status still tells the story */
      }
    }
    this.db.prepare('UPDATE processes SET ended_at=? WHERE fda_id=? AND ended_at IS NULL').run(nowIso(), fdaId);
  }

  phaseUpsert(phase) {
    const p = phase.params;
    this.db
      .prepare(
        `INSERT INTO phases (phase_id, fda_id, seq, name, kind, owner, description, status, attempt, error, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(phase_id) DO UPDATE SET status=excluded.status, attempt=excluded.attempt, error=excluded.error, ended_at=excluded.ended_at`,
      )
      .run(
        phase.phase_id,
        phase.fda_id,
        phase.seq,
        p.name,
        p.kind,
        p.owner,
        p.description,
        phase.status,
        phase.attempt,
        phase.error,
        phase.started_at,
        phase.ended_at,
      );
  }

  maxPhaseSeq(fdaId) {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM phases WHERE fda_id=?').get(fdaId);
    return row?.m || 0;
  }

  envelopeRow(phase, agent, outputType, payloadJson, valid, attempt) {
    this.db
      .prepare(
        `INSERT INTO envelopes (envelope_id, fda_id, phase_id, agent, output_type, payload_json, valid, attempt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `env_${newId(10)}`,
        phase.fda_id,
        phase.phase_id,
        agent,
        outputType,
        payloadJson,
        valid ? 1 : 0,
        attempt,
        nowIso(),
      );
  }

  gateRow(phase, gateName, report, attempt) {
    this.db
      .prepare(
        `INSERT INTO gate_results (fda_id, phase_id, attempt, gate, passed, violations_json, checks_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        phase.fda_id,
        phase.phase_id,
        attempt,
        gateName,
        report.passed ? 1 : 0,
        JSON.stringify(report.violations),
        JSON.stringify(report.checks),
        nowIso(),
      );
  }

  agentSessionRow(fdaId, agent, sessionId, contextTokens = 0, contextWindow = 0) {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO agent_sessions (fda_id, agent, coding_agent, model, session_id, context_tokens, context_window, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(fda_id, agent) DO UPDATE SET coding_agent=excluded.coding_agent, model=excluded.model,
           session_id=excluded.session_id, context_tokens=excluded.context_tokens,
           context_window=excluded.context_window, last_used_at=excluded.last_used_at`,
      )
      .run(fdaId, agent.name, agent.coding_agent, agent.model, sessionId, contextTokens, contextWindow, ts, ts);
  }

  processStart(fdaId, kind, name, pid, command) {
    this.db
      .prepare('INSERT INTO processes (fda_id, kind, name, pid, command, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(fdaId, kind, name, pid, command, nowIso());
  }

  processEnd(fdaId, pid) {
    this.db
      .prepare('UPDATE processes SET ended_at=? WHERE fda_id=? AND pid=? AND ended_at IS NULL')
      .run(nowIso(), fdaId, pid);
  }
}
