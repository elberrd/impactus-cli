/**
 * Unchanged-tree guard — the shared machinery behind every "this exact tree
 * already failed, re-running cannot pass" refusal. Born in the /qa e2e phase
 * after a real run burned 8 identical rounds (10.5M tokens); generalized here
 * so the OTHER expensive re-executing surfaces (the /qa audit, ui_verify, a
 * bare --resume of a failed run) share one fingerprint and one marker format
 * instead of growing parallel copies.
 *
 * Everything FAILS OPEN: no git → no stamp → no refusal. A guard that can
 * block a legitimate run is worse than the waste it prevents.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './utils.mjs';

// Build/test side effects a run itself produces. They must not move the
// stamp — otherwise every failed round "changes" the tree and the guard never
// fires. Mirrors the benign defaults of the permission gate (permissions.mjs)
// plus Playwright's own output dirs; none of these paths hold app code, so
// over-matching can only weaken the guard, never block a real fix.
export const STAMP_NOISE = [
  /^imp\/data\//,
  /^imp\/reports\//,
  /^playwright-report\//,
  /^test-results\//,
  /^node_modules\//,
  /^\.next\//,
  /^\.turbo\//,
  /^coverage\//,
  /\.tsbuildinfo$/,
  /^next-env\.d\.ts$/,
  /^AGENTS\.md$/,
  /^\.eslintcache$/,
  /^\.DS_Store$/,
  /^Thumbs\.db$/,
  /^desktop\.ini$/,
];

/**
 * Content fingerprint of the working tree (HEAD + status + uncommitted diff,
 * with the run's own side-effect paths filtered out), or null when it cannot
 * be computed (not a git repo, git missing) — the guard FAILS OPEN: no stamp
 * means no refusal, never a blocked run.
 */
export function repoStamp(repoRoot) {
  try {
    const git = (args, opts = {}) =>
      execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
    const head = git(['rev-parse', 'HEAD']).trim();
    // -uall lists changed/untracked files by name; `diff HEAD` carries every
    // tracked content change (staged or not). Together they move on any real fix.
    const status = git(['status', '--porcelain=v1', '-uall'])
      .split('\n')
      .filter((line) => {
        const path = line.slice(3).replace(/^"|"$/g, '');
        return path && !STAMP_NOISE.some((re) => re.test(path));
      })
      .join('\n');
    const diff = execFileSync('git', ['diff', 'HEAD'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    return createHash('sha1').update(head).update('\0').update(status).update('\0').update(diff).digest('hex');
  } catch {
    return null;
  }
}

const attemptPath = (dir, name) => join(dir, `${name}-attempts.json`);

/** The recorded last failure of `name` — { stamp, count, at } — or null. */
export function readAttempt(dir, name) {
  try {
    const data = JSON.parse(readFileSync(attemptPath(dir, name), 'utf8'));
    return data && typeof data.stamp === 'string' ? data : null;
  } catch {
    return null;
  }
}

/** Record a failure under this stamp; a NEW stamp restarts the count at 1. */
export function recordAttemptFailure(dir, name, stamp) {
  if (!stamp) return null; // no fingerprint → nothing to compare next time
  const prior = readAttempt(dir, name);
  const entry = { stamp, count: prior?.stamp === stamp ? (prior.count || 1) + 1 : 1, at: nowIso() };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(attemptPath(dir, name), JSON.stringify(entry, null, 2));
  } catch {
    /* the marker is a guard, never a blocker */
  }
  return entry;
}

export function clearAttempt(dir, name) {
  try {
    rmSync(attemptPath(dir, name), { force: true });
  } catch {
    /* absent is fine */
  }
}

/** Is a retry of `name` provably futile? (Identical stamp, no override.) */
export function unchangedSinceFailure({ prior, stamp, override = false }) {
  return Boolean(!override && stamp && prior && prior.stamp === stamp);
}

// ── run-level failure stamp ──────────────────────────────────────────────────
// Written by Run.settle() on a failure outcome, cleared on success; read by
// session.ensure() so a bare --resume over a provably identical tree is
// refused BEFORE any phase (or token) is spent — the loop that burned a real
// run 16 build cycles was exactly this resume, uncounted and unguarded.

export const FAILURE_STAMP_FILE = 'last_failure_stamp.json';

export function readFailureStamp(sessionDir) {
  try {
    const data = JSON.parse(readFileSync(join(sessionDir, FAILURE_STAMP_FILE), 'utf8'));
    return data && typeof data.stamp === 'string' ? data : null;
  } catch {
    return null;
  }
}

export function writeFailureStamp(sessionDir, { stamp, outcome }) {
  if (!stamp) return;
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, FAILURE_STAMP_FILE), JSON.stringify({ stamp, outcome, at: nowIso() }, null, 2));
  } catch {
    /* best effort — never mask the failure being recorded */
  }
}

export function clearFailureStamp(sessionDir) {
  try {
    rmSync(join(sessionDir, FAILURE_STAMP_FILE), { force: true });
  } catch {
    /* absent is fine */
  }
}
