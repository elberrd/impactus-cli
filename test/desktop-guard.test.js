import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  blockedDesktopControl,
  gateDecision,
  cursorDecision,
} from '../fia-templates/scripts/desktop-guard.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'fia-templates', 'scripts', 'desktop-guard.mjs');
const SHIM = join(import.meta.dirname, '..', 'harness', '.claude', 'hooks', 'desktop-guard.mjs');
const CURSOR_SHIM = join(import.meta.dirname, '..', 'harness', '.cursor', 'hooks', 'desktop-guard-cursor.mjs');
// The shims live in the harness — a SEPARATE repo checked out here only in dev
// (gitignored, absent on a fresh clone/CI). Skip, never fail, when missing.
const NO_HARNESS = 'harness/ not present (nested repo, absent on fresh checkout)';

// The real incident: a 40-iteration loop cycling the real Chrome with orca
// computer-use to find a Cloudflare R2 credentials page. The guard sees the
// WHOLE command string, so a nested orca call must still be caught.
const INCIDENT = `found=0
for i in $(seq 1 40); do
  orca computer hotkey --app com.google.Chrome --window-id 515347 --key Ctrl+Tab --json >/tmp/x.json 2>&1 || true
done`;

test('blockedDesktopControl: flags the desktop-control class', () => {
  assert.ok(blockedDesktopControl(INCIDENT));
  assert.equal(blockedDesktopControl('orca computer list-windows --json').id, 'orca-computer');
  assert.equal(blockedDesktopControl('cliclick c:100,200').id, 'input-injection');
  assert.equal(blockedDesktopControl('xdotool key ctrl+Tab').id, 'input-injection');
  assert.equal(blockedDesktopControl('screencapture -x /tmp/shot.png').id, 'screen-capture');
  assert.equal(
    blockedDesktopControl(`osascript -e 'tell application "System Events" to keystroke "t"'`).id,
    'osascript-ui',
  );
});

test('blockedDesktopControl: leaves legitimate commands alone', () => {
  for (const ok of [
    'git status',
    'npm run test:e2e',
    'npx playwright test',
    'orca worktree list', // orca-cli, NOT computer-use
    'orca terminal send --id 3 "hi"',
    `osascript -e 'display notification "done"'`, // notification, not UI scripting
    'grep -r orca src/',
    '',
  ]) {
    assert.equal(blockedDesktopControl(ok), null, ok);
  }
});

test('gateDecision: blocks Bash desktop-control, ignores other tools', () => {
  assert.equal(gateDecision({ tool_name: 'Bash', tool_input: { command: INCIDENT } }).block, true);
  assert.equal(gateDecision({ tool_name: 'Bash', tool_input: { command: 'npm test' } }).block, false);
  // Non-Bash tools are out of scope for this guard (fda-lock covers writes).
  assert.equal(gateDecision({ tool_name: 'Write', tool_input: { file_path: 'x' } }).block, false);
  const verdict = gateDecision({ tool_name: 'Bash', tool_input: { command: 'orca computer get-app-state' } });
  assert.match(verdict.reason, /Playwright/);
  assert.match(verdict.reason, /never obtain it from browser tabs/);
});

test('cursorDecision: deny with messages on control, allow otherwise', () => {
  const deny = cursorDecision({ command: 'orca computer hotkey --key Ctrl+Tab' });
  assert.equal(deny.permission, 'deny');
  assert.match(deny.agentMessage, /Playwright/);
  assert.match(deny.userMessage, /real desktop/);
  assert.deepEqual(cursorDecision({ command: 'git status' }), { permission: 'allow' });
});

function runScript(args, { input } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: tmpdir(),
    input: input ?? '',
    encoding: 'utf8',
  });
}

test('gate CLI: exit 2 on desktop-control, 0 otherwise, fails open on bad input', () => {
  const blocked = runScript(['gate'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: INCIDENT } }),
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Blocked/);

  const allowed = runScript(['gate'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
  });
  assert.equal(allowed.status, 0);

  assert.equal(runScript(['gate'], { input: 'not json' }).status, 0); // fail open
});

test('harness Claude shim: silent without FIA, blocks when imp/ exists', { skip: !existsSync(SHIM) && NO_HARNESS }, () => {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'orca computer list-windows' } });

  // No imp/scripts → import fails → exit 0, nothing blocked.
  const bare = mkdtempSync(join(tmpdir(), 'desktop-guard-bare-'));
  mkdirSync(join(bare, '.claude', 'hooks'), { recursive: true });
  cpSync(SHIM, join(bare, '.claude', 'hooks', 'desktop-guard.mjs'));
  const silent = spawnSync(process.execPath, ['.claude/hooks/desktop-guard.mjs', 'gate'], {
    cwd: bare,
    input: payload,
    encoding: 'utf8',
  });
  assert.equal(silent.status, 0);

  // With the runtime installed the shim relays the block (exit 2).
  const full = mkdtempSync(join(tmpdir(), 'desktop-guard-full-'));
  mkdirSync(join(full, '.claude', 'hooks'), { recursive: true });
  cpSync(SHIM, join(full, '.claude', 'hooks', 'desktop-guard.mjs'));
  mkdirSync(join(full, 'imp', 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(full, 'imp', 'scripts', 'desktop-guard.mjs'));
  const relayed = spawnSync(process.execPath, ['.claude/hooks/desktop-guard.mjs', 'gate'], {
    cwd: full,
    input: payload,
    encoding: 'utf8',
  });
  assert.equal(relayed.status, 2);
  assert.match(relayed.stderr, /Blocked/);
});

test('harness Cursor shim: deny on control, allow-open without the runtime', { skip: !existsSync(CURSOR_SHIM) && NO_HARNESS }, () => {
  const run = (root, payload) =>
    JSON.parse(
      spawnSync(process.execPath, ['.cursor/hooks/desktop-guard-cursor.mjs'], {
        cwd: root,
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
      }).stdout,
    );

  const full = mkdtempSync(join(tmpdir(), 'desktop-guard-cursor-'));
  mkdirSync(join(full, '.cursor', 'hooks'), { recursive: true });
  cpSync(CURSOR_SHIM, join(full, '.cursor', 'hooks', 'desktop-guard-cursor.mjs'));
  mkdirSync(join(full, 'imp', 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(full, 'imp', 'scripts', 'desktop-guard.mjs'));

  const deny = run(full, { command: 'orca computer hotkey --key Ctrl+Tab' });
  assert.equal(deny.permission, 'deny');
  assert.deepEqual(run(full, { command: 'git status' }), { permission: 'allow' });
  assert.deepEqual(run(full, 'not json'), { permission: 'allow' }); // fail open

  // Harness-only project (no imp/ runtime) → import throws → allow.
  const bare = mkdtempSync(join(tmpdir(), 'desktop-guard-cursor-bare-'));
  mkdirSync(join(bare, '.cursor', 'hooks'), { recursive: true });
  cpSync(CURSOR_SHIM, join(bare, '.cursor', 'hooks', 'desktop-guard-cursor.mjs'));
  assert.deepEqual(run(bare, { command: 'orca computer list-windows' }), { permission: 'allow' });
});

// ── Grok Build dialect: camelCase payload + grok shell tool id, bilingual deny ─

test('gateDecision: grok payload (toolName run_terminal_command / toolInput.command) is guarded too', () => {
  assert.equal(gateDecision({ toolName: 'run_terminal_command', toolInput: { command: INCIDENT } }).block, true);
  assert.equal(gateDecision({ toolName: 'run_terminal_command', toolInput: { command: 'npm test' } }).block, false);
  assert.equal(gateDecision({ toolName: 'search_replace', toolInput: { file_path: 'x' } }).block, false);
});

test('gate CLI: the deny is bilingual — exit 2 + stderr for Claude Code, stdout JSON decision for grok', () => {
  const blocked = runScript(['gate'], {
    input: JSON.stringify({ hookEventName: 'pre_tool_use', toolName: 'run_terminal_command', toolInput: { command: INCIDENT } }),
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Blocked/);
  const out = JSON.parse(blocked.stdout.trim());
  assert.equal(out.decision, 'deny');
  assert.match(out.reason, /Playwright/);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const allowed = runScript(['gate'], { input: JSON.stringify({ toolName: 'run_terminal_command', toolInput: { command: 'git status' } }) });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), '');
});
