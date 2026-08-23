/**
 * Deterministic, zero-token stop conditions for an FDA run.
 *
 * A run that keeps re-trying the same failing thing burns the student's
 * subscription for nothing. These limits cost no tokens to evaluate: an
 * attempt cap, a no-progress detector (the same failures over the same files,
 * round after round), a wall-clock budget and a change-breadth ceiling.
 *
 * The policy lives under `stop:` in the STUDENT-OWNED imp/fia.config.yaml,
 * which `--update-runtime` never rewrites — so every key has a code default
 * here and an absent block must behave exactly like the defaults.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { treeFingerprints } from './git-helper.mjs';

export const STOP_DEFAULTS = Object.freeze({
  attempt_cap: 3,
  no_progress_window: 2,
  budget_minutes: 0,
  breadth_ceiling: 0,
  // Token ceilings ship ON with generous room: a healthy run today spends
  // well under these, and the catastrophic runs they exist to stop (a real
  // project recorded a 112M-token run and a single 36M-token phase) sail past
  // them. Tokens count the RUN LIFETIME — every resume of the same fda_id.
  token_budget: 30000000,
  phase_token_budget: 8000000,
  // Wall-clock ceiling for ONE agent send (code phases have their own
  // timeouts in quality.mjs). A hung CLI is killed and handled like a crash;
  // a long genuine phase is stopped cleanly as budget_exhausted.
  phase_timeout_minutes: 50,
});

/** Numeric keys where 0 is a legal value meaning "this limit is OFF". */
const ZERO_MEANS_OFF = new Set([
  'no_progress_window',
  'budget_minutes',
  'breadth_ceiling',
  'token_budget',
  'phase_token_budget',
  'phase_timeout_minutes',
]);

/** What each key counts, so a warning can name the unit in plain English. */
const UNITS = Object.freeze({
  attempt_cap: 'repair attempts',
  no_progress_window: 'identical rounds (0 turns the check off)',
  budget_minutes: 'minutes (0 turns the budget off)',
  breadth_ceiling: 'changed files (0 turns the ceiling off)',
  token_budget: 'tokens for the whole run, resumes included (0 turns the budget off)',
  phase_token_budget: 'tokens for one phase (0 turns the budget off)',
  phase_timeout_minutes: 'minutes for one agent send (0 turns the timeout off)',
});

/**
 * The stop policy from the student's config, normalized. Tolerant by design:
 * a missing block, a missing key, a typo'd value or a negative number all
 * degrade to the default and are reported through `warnings` — never thrown.
 */
export function stopPolicyOf(cfg) {
  const raw = cfg?.stop && typeof cfg.stop === 'object' ? cfg.stop : {};
  const policy = { ...STOP_DEFAULTS, warnings: [] };
  for (const key of Object.keys(STOP_DEFAULTS)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const value = typeof raw[key] === 'number' ? raw[key] : Number(raw[key]);
    if (!Number.isFinite(value) || value < 0) {
      policy.warnings.push(
        `stop.${key}: ${JSON.stringify(raw[key])} is not a valid number of ${UNITS[key]} — ` +
          `keeping the default ${STOP_DEFAULTS[key]}.`,
      );
      continue;
    }
    policy[key] = ZERO_MEANS_OFF.has(key) ? Math.floor(value) : Math.max(1, Math.floor(value));
  }
  return policy;
}

/**
 * A run stopped by a policy limit rather than by a failure of the work itself.
 * It carries the terminal outcome so `classifyFailure` can report it verbatim.
 */
export class StopCondition extends Error {
  constructor(outcome, message) {
    super(message);
    this.name = 'StopCondition';
    this.outcome = outcome;
  }
}

/** The manual stop button: `imp stop` writes this file, `imp stop --clear` removes it. */
export const MANUAL_STOP_FILE = 'fia-stop';

export function manualStopPath(dataDir) {
  return join(dataDir || 'imp/data', MANUAL_STOP_FILE);
}

/** One candidate location → { stopped, path, reason }. */
function readStopFile(path) {
  let raw = null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { stopped: false, path };
    return {
      stopped: true,
      path,
      reason: `the stop file exists but could not be read (${err?.code || 'error'}) — failing closed`,
    };
  }
  let reason = '';
  try {
    const parsed = JSON.parse(raw);
    reason = String(parsed?.reason || '').trim();
  } catch {
    reason = String(raw || '').trim().slice(0, 200); // a hand-written `touch`+echo still counts
  }
  return { stopped: true, path, reason };
}

/**
 * Has a human armed the stop button? FAIL CLOSED: only a clean "the file does
 * not exist" (ENOENT) means "keep running" — a stop file that EXISTS but cannot
 * be read (permissions, a directory in its place, I/O error) still stops the
 * run. The obvious polarity ("run unless a readable stop request is found")
 * would make the button work only while the filesystem does.
 *
 * With `repoRoot` the CANONICAL `imp/data/fia-stop` is checked as well as the
 * configured `data_dir`. That is what lets `imp stop` stay a dependency-free
 * script: it always writes the canonical path, so a project that moved
 * `defaults.data_dir` cannot end up with a button that reports ARMED while the
 * runner reads a different file and keeps going — a stop button that fails
 * OPEN is worse than none.
 */
export function manualStopState(dataDir, repoRoot = null) {
  const paths = [manualStopPath(dataDir)];
  if (repoRoot) {
    const canonical = manualStopPath(join(repoRoot, 'imp', 'data'));
    if (!paths.includes(canonical)) paths.push(canonical);
  }
  let last = null;
  for (const path of paths) {
    const state = readStopFile(path);
    if (state.stopped) return state;
    last = state;
  }
  return last;
}

/** De-duplicated, sorted, stringified — the order-insensitive half of a signature. */
function normalizeList(list) {
  const values = (Array.isArray(list) ? list : []).map((value) => String(value));
  return [...new Set(values)].sort();
}

/**
 * A stable fingerprint of "where the run is stuck": which checks are failing
 * and what the tree CONTAINS. Order-insensitive — the same set in a different
 * order must hash the same, or a shuffled report would read as progress.
 *
 * `changed` must carry CONTENT, not just paths. The failing-check names alone
 * cannot see progress (a normal brief always reports the single check `test`,
 * whether 12 assertions fail or 1), and a bare path list cannot either (a
 * repair usually edits files the build phase already touched, so the path set
 * repeats). `changedContentSignature` below produces the right input.
 *
 * Hashed as JSON rather than as a joined string: a check name that happens to
 * contain the separator must never collide with two separate names.
 */
export function progressSignature({ failures = [], changed = [] } = {}) {
  const canonical = JSON.stringify({ failures: normalizeList(failures), changed: normalizeList(changed) });
  return createHash('sha1').update(canonical).digest('hex');
}

/**
 * `path:contentFingerprint` for every path this run has changed since its
 * baseline. The twin of git-helper's `runChangedPaths`, except it KEEPS the
 * fingerprint: an edit to a file the run already touched has to read as
 * progress, and a path list cannot express that.
 */
export function changedContentSignature(repoRoot, baseline = {}) {
  const current = treeFingerprints(repoRoot);
  return Object.keys(current)
    .filter((path) => baseline[path] !== current[path])
    .sort()
    .map((path) => `${path}:${current[path]}`);
}

/**
 * Counts CONSECUTIVE identical signatures. `note(sig)` returns
 * `{ repeats, exhausted }`; a different signature resets the streak to 1.
 * `reset(sig)` records a signature WITHOUT counting it as a repeat — for a
 * round that cannot prove anything (see createRepairTracker).
 * `window === 0` turns the detector off — `exhausted` is then always false.
 */
export function createProgressTracker(window) {
  const size = Number.isFinite(window) && window > 0 ? Math.floor(window) : 0;
  let last = null;
  let repeats = 0;
  return {
    note(signature) {
      repeats = signature === last ? repeats + 1 : 1;
      last = signature;
      return { repeats, exhausted: size > 0 && repeats >= size };
    },
    reset(signature = null) {
      last = signature;
      repeats = signature == null ? 0 : 1;
      return { repeats, exhausted: false };
    },
    get repeats() {
      return repeats;
    },
    get last() {
      return last;
    },
  };
}

/**
 * The whole round accounting of a repair loop, in one testable place — the two
 * brief-driven FDAs (/feature-style and /bug) both drive it, so the rules
 * cannot drift between them.
 *
 * Two rules exist because getting either wrong costs the student real work:
 *
 *  1. A round only counts toward the stall streak when the repair before it
 *     ACTUALLY RAN. The first test round has no repair behind it, and on
 *     `--resume` every `fix_i` phase is replayed from disk as a no-op while the
 *     `code`-kind test phases re-execute — counting those as stalled rounds
 *     would dead-end the documented recovery path before a single repair.
 *  2. The signature is content-addressed (see progressSignature), so "the
 *     builder edited the same file again" is progress, not a stall.
 *
 * A green round clears the streak: a suite that passes is never a stall.
 */
export function createRepairTracker(policy = {}) {
  // `?? default` then clamp, never `|| default`: a literal 0 must clamp to one
  // round (a repair loop with no rounds is pointless), not silently become 3.
  const declaredCap = Number(policy.attempt_cap);
  const cap = Math.max(1, Math.floor(Number.isFinite(declaredCap) ? declaredCap : STOP_DEFAULTS.attempt_cap));
  const window = Number.isFinite(policy.no_progress_window)
    ? Math.max(0, Math.floor(policy.no_progress_window))
    : STOP_DEFAULTS.no_progress_window;
  const progress = createProgressTracker(window);
  let repeats = 0;
  let stalled = false;
  return {
    get cap() {
      return cap;
    },
    get window() {
      return window;
    },
    get repeats() {
      return repeats;
    },
    get stalled() {
      return stalled;
    },
    /**
     * Record one test round. `repairExecuted` must be false for the first round
     * and for any round whose repair phase was replayed instead of executed.
     * Returns `{ repeats, stalled, counted }`.
     */
    noteRound({ passed = false, failures = [], changed = [], repairExecuted = false } = {}) {
      if (passed) {
        progress.reset(null);
        repeats = 0;
        stalled = false;
        return { repeats, stalled, counted: false };
      }
      const signature = progressSignature({ failures, changed });
      const result = repairExecuted ? progress.note(signature) : progress.reset(signature);
      repeats = result.repeats;
      stalled = result.exhausted;
      return { repeats, stalled, counted: repairExecuted };
    },
  };
}
