import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  activeFdaLock,
  bashWritesInRepo,
  gateDecision,
  renderWarn,
} from '../fia-templates/scripts/fda-lock.mjs';
import { acquireLock } from '../fia-templates/modules/session.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'fda-lock.mjs');
const SHIM = join(import.meta.dirname, '..', 'harness', '.claude', 'hooks', 'fda-lock.mjs');
// The shims live in the harness — a SEPARATE repo checked out here only in
// dev (gitignored, absent on a fresh clone/CI). Same pattern as
// consistency.test.js: skip, never fail, when the checkout is missing.
const NO_HARNESS = 'harness/ not present (nested repo, absent on fresh checkout)';

/** A temp project root, optionally holding imp/data/.fda.lock with `lock`. */
function projectWith(lock) {
  const root = mkdtempSync(join(tmpdir(), 'fda-lock-'));
  if (lock) {
    mkdirSync(join(root, 'imp', 'data'), { recursive: true });
    writeFileSync(join(root, 'imp', 'data', '.fda.lock'), JSON.stringify(lock));
  }
  return root;
}

// process.ppid is a pid that is definitely alive and differs both from this
// test process and from any spawned child (a lock held by one's OWN pid is
// ignored by design); 999999999 always throws on kill() → treated as dead.
const LIVE = { pid: process.ppid, fda_id: 'run1234', runner: 'fda_build', started_at: '2026-08-13T12:00:00Z' };
const DEAD = { pid: 999999999, fda_id: 'gone', runner: 'fda_build', started_at: '2026-08-13T12:00:00Z' };

function runScript(args, { root, env = {}, input } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    env: { ...process.env, FIA_FDA_RUN: '', ...env },
    input: input ?? '',
    encoding: 'utf8',
  });
}

test('activeFdaLock: live pid → lock, dead pid → null, no file → null', () => {
  assert.equal(activeFdaLock(projectWith(LIVE)).fda_id, 'run1234');
  assert.equal(activeFdaLock(projectWith(DEAD)), null);
  assert.equal(activeFdaLock(projectWith(null)), null);
});

test('warn: prints the read-only notice only for a live lock', () => {
  const active = runScript(['warn'], { root: projectWith(LIVE) });
  assert.equal(active.status, 0);
  assert.match(active.stdout, /READ-ONLY/);
  assert.match(active.stdout, /run1234/);

  for (const root of [projectWith(DEAD), projectWith(null)]) {
    const quiet = runScript(['warn'], { root });
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, '');
  }
});

test('warn: silent inside the run own process tree (FIA_FDA_RUN)', () => {
  const r = runScript(['warn'], { root: projectWith(LIVE), env: { FIA_FDA_RUN: 'run1234' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('gate: blocks Write inside the repo, allows outside and exempts the run', () => {
  const root = projectWith(LIVE);
  const hook = (file) =>
    JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file }, cwd: root });

  const inside = runScript(['gate'], { root, input: hook(join(root, 'src', 'a.ts')) });
  assert.equal(inside.status, 2);
  assert.match(inside.stderr, /FIA run active/);

  const outside = runScript(['gate'], { root, input: hook(join(tmpdir(), 'scratch.txt')) });
  assert.equal(outside.status, 0);

  const own = runScript(['gate'], {
    root,
    env: { FIA_FDA_RUN: 'run1234' },
    input: hook(join(root, 'src', 'a.ts')),
  });
  assert.equal(own.status, 0);

  const noRun = runScript(['gate'], { root: projectWith(DEAD), input: hook('src/a.ts') });
  assert.equal(noRun.status, 0);
});

test('gate: bad stdin fails open', () => {
  const r = runScript(['gate'], { root: projectWith(LIVE), input: 'not json' });
  assert.equal(r.status, 0);
});

test('gateDecision: bash verdicts follow the write heuristics', () => {
  const root = '/repo';
  const ctx = { root, lock: LIVE };
  const bash = (command) => gateDecision({ tool_name: 'Bash', tool_input: { command } }, ctx);

  assert.equal(bash('git commit -m "stamp"').block, true);
  assert.equal(bash('rm src/old.ts').block, true);
  assert.equal(bash('echo hi > notes.md').block, true);
  assert.equal(bash('git status').block, false);
  assert.equal(bash('npm test').block, false);
  assert.equal(bash('rm /tmp/scratch.txt').block, false);
  assert.equal(bash('cat src/a.ts').block, false);
});

test('bashWritesInRepo: sed -i and path-less write binaries', () => {
  assert.equal(bashWritesInRepo('/repo', "sed -i '' src/a.ts"), true);
  assert.equal(bashWritesInRepo('/repo', 'npm install'), false);
  assert.equal(bashWritesInRepo('/repo', 'echo hi >> /tmp/log.txt'), false);
});

test('status: one line either way, --json returns the raw lock', () => {
  const active = runScript(['status'], { root: projectWith(LIVE) });
  assert.match(active.stdout, /FIA run active — fda_id run1234/);

  const idle = runScript(['status'], { root: projectWith(null) });
  assert.match(idle.stdout, /no active FIA run/);

  const json = runScript(['status', '--json'], { root: projectWith(LIVE) });
  assert.equal(JSON.parse(json.stdout).fda_id, 'run1234');
});

test('renderWarn shows fda_id, runner and start time', () => {
  const text = renderWarn(LIVE);
  assert.match(text, /run1234/);
  assert.match(text, /fda_build/);
  assert.match(text, /2026-08-13T12:00:00Z/);
});

test('harness shim: silent without FIA, delegates when imp/ exists', { skip: !existsSync(SHIM) && NO_HARNESS }, () => {
  // No imp/scripts → import fails → exit 0, no output, nothing blocked.
  const bare = projectWith(LIVE);
  mkdirSync(join(bare, '.claude', 'hooks'), { recursive: true });
  cpSync(SHIM, join(bare, '.claude', 'hooks', 'fda-lock.mjs'));
  const silent = spawnSync(process.execPath, ['.claude/hooks/fda-lock.mjs', 'warn'], {
    cwd: bare,
    env: { ...process.env, FIA_FDA_RUN: '' },
    encoding: 'utf8',
  });
  assert.equal(silent.status, 0);
  assert.equal(silent.stdout, '');

  // With the runtime installed the shim relays warn (and its exit code).
  const full = projectWith(LIVE);
  mkdirSync(join(full, '.claude', 'hooks'), { recursive: true });
  cpSync(SHIM, join(full, '.claude', 'hooks', 'fda-lock.mjs'));
  mkdirSync(join(full, 'imp', 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(full, 'imp', 'scripts', 'fda-lock.mjs'));
  const relayed = spawnSync(process.execPath, ['.claude/hooks/fda-lock.mjs', 'warn'], {
    cwd: full,
    env: { ...process.env, FIA_FDA_RUN: '' },
    encoding: 'utf8',
  });
  assert.equal(relayed.status, 0);
  assert.match(relayed.stdout, /READ-ONLY/);
});

// ── Cursor hook (harness/.cursor/hooks/fda-lock-cursor.mjs) ──────────────────

const CURSOR_SHIM = join(import.meta.dirname, '..', 'harness', '.cursor', 'hooks', 'fda-lock-cursor.mjs');

/** A temp project with the FIA runtime and the Cursor shim installed. */
function cursorProject(lock, { runtime = true } = {}) {
  const root = projectWith(lock);
  mkdirSync(join(root, '.cursor', 'hooks'), { recursive: true });
  cpSync(CURSOR_SHIM, join(root, '.cursor', 'hooks', 'fda-lock-cursor.mjs'));
  if (runtime) {
    mkdirSync(join(root, 'imp', 'scripts'), { recursive: true });
    cpSync(SCRIPT, join(root, 'imp', 'scripts', 'fda-lock.mjs'));
  }
  return root;
}

function runCursorShim(root, payload, env = {}) {
  const r = spawnSync(process.execPath, ['.cursor/hooks/fda-lock-cursor.mjs'], {
    cwd: root,
    env: { ...process.env, FIA_FDA_RUN: '', ...env },
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('cursor hook: denies a repo write while a run is live, allows reads', { skip: !existsSync(CURSOR_SHIM) && NO_HARNESS }, () => {
  const root = cursorProject(LIVE);
  const deny = runCursorShim(root, { command: 'rm src/app.ts', workspace_roots: [root], cwd: root });
  assert.equal(deny.permission, 'deny');
  assert.match(deny.agentMessage, /FIA run active/);
  assert.match(deny.userMessage, /run1234/);

  const read = runCursorShim(root, { command: 'git status', workspace_roots: [root], cwd: root });
  assert.deepEqual(read, { permission: 'allow' });
});

test('cursor hook: dead lock, missing runtime, own run tree and bad stdin all allow', { skip: !existsSync(CURSOR_SHIM) && NO_HARNESS }, () => {
  const dead = cursorProject(DEAD);
  assert.deepEqual(runCursorShim(dead, { command: 'rm src/x.ts', workspace_roots: [dead] }), {
    permission: 'allow',
  });

  // Harness-only project (no imp/ runtime) → the import fails → allow.
  const bare = cursorProject(LIVE, { runtime: false });
  assert.deepEqual(runCursorShim(bare, { command: 'rm src/x.ts', workspace_roots: [bare] }), {
    permission: 'allow',
  });

  const live = cursorProject(LIVE);
  // Inside the run's own process tree (FIA_FDA_RUN) the hook stays silent.
  assert.deepEqual(
    runCursorShim(live, { command: 'rm src/x.ts', workspace_roots: [live] }, { FIA_FDA_RUN: 'run1234' }),
    { permission: 'allow' },
  );
  // Unreadable payload → fail open.
  assert.deepEqual(runCursorShim(live, 'not json'), { permission: 'allow' });
});

// ── acquireLock (imp/modules/session.mjs — the writer side) ──────────────────

test('acquireLock: refuses a live holder, replaces a dead one, atomic create', () => {
  // Live holder (the parent test process) → throws with the recovery command.
  const liveRoot = projectWith(LIVE);
  assert.throws(
    () => acquireLock(join(liveRoot, 'imp', 'data'), 'newrun'),
    /another FIA run is already active/,
  );

  // Dead holder → replaced by this process's lock.
  const deadRoot = projectWith(DEAD);
  acquireLock(join(deadRoot, 'imp', 'data'), 'newrun');
  const lock = JSON.parse(readFileSync(join(deadRoot, 'imp', 'data', '.fda.lock'), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.fda_id, 'newrun');

  // Fresh dir → acquires via exclusive create (no pre-existing file needed).
  const fresh = projectWith(null);
  acquireLock(join(fresh, 'imp', 'data'), 'first');
  assert.equal(JSON.parse(readFileSync(join(fresh, 'imp', 'data', '.fda.lock'), 'utf8')).fda_id, 'first');

  // Unreadable lock (crashed foreign writer) with no live holder → stolen.
  const garbage = projectWith(null);
  mkdirSync(join(garbage, 'imp', 'data'), { recursive: true });
  writeFileSync(join(garbage, 'imp', 'data', '.fda.lock'), 'not json{{');
  acquireLock(join(garbage, 'imp', 'data'), 'stolen');
  assert.equal(JSON.parse(readFileSync(join(garbage, 'imp', 'data', '.fda.lock'), 'utf8')).fda_id, 'stolen');
});

test(
  'acquireLock: EPERM means ALIVE — a lock held by another user is never stolen',
  // kill(1, 0) → EPERM is POSIX (pid 1 = launchd/init, owned by root). On
  // Windows there is no deterministic pid that raises EPERM for a test.
  { skip: process.platform === 'win32' && 'POSIX-only: no deterministic EPERM pid on Windows' },
  () => {
    // pid 1 (launchd/init) exists and belongs to root: kill(1, 0) from an
    // unprivileged test process raises EPERM. The writer must treat that as a
    // live run — exactly like the reader (activeFdaLock) — and refuse.
    const root = projectWith({ pid: 1, fda_id: 'rooted', runner: 'fda_build', started_at: '2026-08-13T12:00:00Z' });
    assert.throws(() => acquireLock(join(root, 'imp', 'data'), 'newrun'), /already active/);
  },
);

// ── Grok Build dialect: camelCase payload, grok tool ids, bilingual deny ─────

test('gateDecision: reads the grok payload (toolName/toolInput, search_replace/run_terminal_command)', () => {
  const root = projectWith(LIVE);
  const ctx = { root, lock: LIVE };
  assert.equal(
    gateDecision({ toolName: 'search_replace', toolInput: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } }, ctx).block,
    true,
    'grok edits arrive as search_replace + file_path',
  );
  assert.equal(gateDecision({ toolName: 'run_terminal_command', toolInput: { command: 'rm src/a.ts' } }, ctx).block, true);
  assert.equal(gateDecision({ toolName: 'run_terminal_command', toolInput: { command: 'npm test' } }, ctx).block, false);
  assert.equal(gateDecision({ toolName: 'read_file', toolInput: { target_file: 'src/a.ts' } }, ctx).block, false, 'reads stay allowed');
  assert.equal(gateDecision({ toolName: 'search_replace', toolInput: { file_path: join(tmpdir(), 'x.txt') } }, ctx).block, false);
});

test('gate CLI: a grok-dialect block answers in BOTH dialects (exit 2 + stderr + stdout JSON deny)', () => {
  const root = projectWith(LIVE);
  const r = runScript(['gate'], {
    root,
    input: JSON.stringify({ hookEventName: 'pre_tool_use', cwd: root, toolName: 'search_replace', toolInput: { file_path: join(root, 'src', 'a.ts') } }),
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /FIA run active/);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.decision, 'deny', 'grok reads decision/reason');
  assert.match(out.reason, /FIA run active/);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', 'Claude Code reads hookSpecificOutput');
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  // Allowed calls print nothing at all on stdout (no stray JSON for either host).
  const ok = runScript(['gate'], { root, input: JSON.stringify({ toolName: 'read_file', toolInput: { target_file: 'x' } }) });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), '');
});
