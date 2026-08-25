import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function newId(length = 8) {
  return randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

export function resolvePrompt(arg) {
  try {
    const p = resolve(arg);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  } catch {
    /* inline text */
  }
  return arg;
}

/**
 * Session ledger of every agent envelope's DECLARATION (`changed_files` +
 * `artifacts`), appended by agents.execute on every round — rounds that ended
 * `status=fail` or failed their gates included. phase_results only hold
 * SUCCEEDED phases, and a builder that applied its work and then reported
 * `status=fail` (a real run: "implemented all repairs, but 5 unrelated E2E
 * failures remain") leaves those files in the tree with no persisted
 * declaration — the next round declares only what IT touched, and the final
 * commit silently leaves the earlier round's work behind as permanent dirt.
 * The ledger is what the commit phase reads back (builderDeclaredFiles).
 */
export const DECLARED_FILES_FILE = 'declared_files.json';

function sessionDirOf(run) {
  if (run?.sessionDir) return run.sessionDir;
  return run?.phaseResultsDir ? dirname(run.phaseResultsDir) : null;
}

/** Every declaration recorded for the session, oldest first; [] when none. */
export function readDeclaredFiles(sessionDir) {
  try {
    const entries = JSON.parse(readFileSync(join(sessionDir, DECLARED_FILES_FILE), 'utf8'));
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

const declaredList = (list) =>
  [...new Set((Array.isArray(list) ? list : []).filter((f) => typeof f === 'string' && f.trim()))];

/**
 * Append one envelope's declaration. Best effort: a ledger that cannot be
 * written must never fail the phase that produced the envelope.
 */
export function recordDeclaredFiles(run, { phase, phase_id = '', agent = '', status = '', changed_files, artifacts } = {}) {
  const sessionDir = sessionDirOf(run);
  if (!sessionDir || !phase) return null;
  const entry = {
    phase: String(phase),
    phase_id: String(phase_id || ''),
    agent: String(agent || ''),
    status: String(status || ''),
    changed_files: declaredList(changed_files),
    artifacts: declaredList(artifacts),
    at: nowIso(),
  };
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, DECLARED_FILES_FILE), JSON.stringify([...readDeclaredFiles(sessionDir), entry], null, 2));
  } catch {
    /* unwritable session dir — a succeeded round's phase result still carries its declaration */
  }
  return entry;
}

/** Result files every tested FDA's builder rounds persist (build + repairs). */
export const BUILDER_RESULT_FILES = /^(build|fix_\d+|fix_checklist|fix_ui)\.json$/;

/**
 * Files declared by EVERY builder envelope of a run: the persisted phase
 * results (succeeded rounds) unioned with the session's declaration ledger
 * (every round, failed ones included). On resume the in-memory `previous` can
 * be just the replayed build envelope (the code test phases re-run and pass
 * because the fix is already on disk, so the fix loop never executes) — files
 * touched by earlier repair rounds live only on disk, so the commit set must
 * be collected from there. A round that ended `status=fail` after applying
 * its work never reaches phase_results at all; only the ledger remembers what
 * it changed. FDAs whose builder phases differ (red_test in /bug, the single
 * `fix` of /quick and /prototype) pass their own pattern — matched against
 * the phase NAME as `<name>.json` for both sources.
 */
export function builderDeclaredFiles(run, filePattern = BUILDER_RESULT_FILES) {
  const files = [];
  let names = [];
  try {
    names = readdirSync(run.phaseResultsDir);
  } catch {
    /* no phase results dir — nothing persisted */
  }
  for (const name of names) {
    if (!filePattern.test(name)) continue;
    try {
      const saved = JSON.parse(readFileSync(join(run.phaseResultsDir, name), 'utf8'));
      files.push(...(saved.result?.changed_files || []), ...(saved.result?.artifacts || []));
    } catch {
      /* unreadable phase result — the in-memory envelopes still cover the rest */
    }
  }
  const sessionDir = sessionDirOf(run);
  for (const entry of sessionDir ? readDeclaredFiles(sessionDir) : []) {
    if (!filePattern.test(`${entry?.phase}.json`)) continue;
    files.push(...declaredList(entry.changed_files), ...declaredList(entry.artifacts));
  }
  return files;
}

/**
 * Identity of a phase's persisted result — the bytes of `<name>.json`, hashed —
 * or null when nothing is saved. A resume replays that file verbatim, so the
 * key is stable across replays and changes exactly when the phase executes
 * again (fda_bug binds its RED proof to the reproduction it was proven with).
 */
export function savedPhaseKey(run, name) {
  try {
    return createHash('sha1').update(readFileSync(join(run.phaseResultsDir, `${name}.json`))).digest('hex');
  } catch {
    return null;
  }
}

export function engineerName() {
  const fromEnv = process.env.ENGINEER_NAME?.trim();
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (out) return out;
  } catch {
    /* ignore */
  }
  return process.env.USER || process.env.USERNAME || 'engineer';
}

export function operatorEnv() {
  return { ...process.env };
}

/**
 * Was this module the process entry point (`node <this file>`)?
 *
 * `import.meta.url` is the RESOLVED path — Node follows symlinks when it loads
 * a module — while `process.argv[1]` is whatever the caller typed. Comparing
 * the two directly makes a script silently do nothing (exit 0, no output)
 * whenever the project lives under a symlinked directory: `/tmp` on macOS,
 * a symlinked work folder, `/home` → `/usr/home` on some systems. Silence is
 * the worst failure mode a self-test can have, so both sides are realpath'd
 * here, with the plain resolve as a fallback for a path that no longer exists.
 */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry || !importMetaUrl) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return importMetaUrl === pathToFileURL(resolve(entry)).href;
  }
}

/**
 * `defaults.data_dir` from the student's roster, resolved against `root`.
 *
 * Read with a narrow regex rather than a YAML parser ON PURPOSE: the callers
 * are the dependency-free CLIs (`imp stop`, `npm run holdout`, the gate
 * self-test), which must keep working in a project whose imp/node_modules was
 * never installed — that is exactly the state those commands exist to
 * diagnose. Anything unexpected degrades to the shipped default, and the
 * runtime readers cross-check the canonical path anyway.
 */
export function dataDirOf(root, configPath = 'imp/fia.config.yaml') {
  try {
    const raw = readFileSync(resolve(root, configPath), 'utf8');
    // Only a real key: a commented `# data_dir:` line never matches, because
    // the `#` sits where the `d` would have to be.
    const m = /^[ \t]*data_dir:[ \t]*(.+?)[ \t]*(?:#.*)?$/m.exec(raw);
    const declared = m?.[1]?.replace(/^['"]|['"]$/g, '').trim();
    if (declared) return resolve(root, declared);
  } catch {
    /* no roster, or unreadable — the shipped default below is correct anyway */
  }
  return resolve(root, 'imp', 'data');
}
