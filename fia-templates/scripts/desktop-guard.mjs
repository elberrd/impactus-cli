#!/usr/bin/env node
/**
 * Desktop-control guard — refuses to let an agent drive the real machine.
 *
 * A coding agent in this project builds a web app; it has no business
 * operating the engineer's desktop, switching the real browser's tabs,
 * capturing the screen, or injecting keystrokes into other apps. When a
 * secret it needs (an R2 S3 token, a dashboard-only key) is missing, the
 * designed answer is to STOP and ask the engineer to paste it — never to go
 * hunting for it across open browser tabs, screenshots, or another app's UI.
 *
 * The incident this closes: a run reached for the Orca computer-use CLI
 * (`orca computer hotkey … --key Ctrl+Tab`) in a 40-iteration loop to cycle
 * the real Chrome looking for a Cloudflare R2 credentials page, then scanned
 * the accessibility tree for "Secret Access Key". Browser verification here is
 * Playwright only (`/qa`, isolated dev server on 127.0.0.1) — never the real
 * Chrome.
 *
 * Unlike fda-lock.mjs this guard is ALWAYS ON: it does not depend on an active
 * FDA lock and it is NOT exempted by FIA_FDA_RUN. Even an FDA's own agents must
 * never do computer-use — the QA FDA drives Playwright from code phases, not
 * from agent bash. Every path fails OPEN: an unreadable payload or an internal
 * error never blocks a tool and never breaks a session.
 *
 *   gate    PreToolUse hook: reads the hook JSON from stdin and exits 2
 *           (block) when the Bash command drives the desktop; exit 0 otherwise
 *
 * The Cursor hook (.cursor/hooks/desktop-guard-cursor.mjs) imports
 * cursorDecision from here; the Pi extension (fia-guard.ts) mirrors the same
 * rule shape inline (Pi compiles its own TypeScript — it cannot import this).
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * One rule per desktop-control primitive. `test` runs against the WHOLE
 * command string (the orca calls in the incident were nested inside a shell
 * loop, so a per-token scan would miss them). Each pattern is deliberately
 * narrow to keep false positives near zero for a web-dev agent:
 *
 * - `orca computer` blocks ONLY the computer-use subcommand — legitimate
 *   orca-cli usage (`orca worktree`, `orca terminal`) stays allowed.
 * - `osascript` blocks ONLY when paired with UI-scripting verbs, so
 *   `osascript -e 'display notification …'` still works.
 */
const RULES = [
  {
    id: 'orca-computer',
    label: 'Orca computer-use (`orca computer …`)',
    test: (c) => /\borca\s+computer\b/.test(c),
  },
  {
    id: 'input-injection',
    label: 'desktop input injection (cliclick / xdotool / ydotool / dotool)',
    test: (c) => /\bcliclick\b/.test(c) || /\b(?:xdotool|ydotool|dotool)\b/.test(c),
  },
  {
    id: 'screen-capture',
    label: 'screen capture (`screencapture`)',
    test: (c) => /\bscreencapture\b/.test(c),
  },
  {
    id: 'osascript-ui',
    label: 'AppleScript UI automation (`osascript` driving System Events)',
    test: (c) => /\bosascript\b/.test(c) && /(system events|keystroke|key code|key down|key up)/i.test(c),
  },
];

/**
 * Does `command` try to operate the real desktop/browser? Returns the matched
 * rule (`{ id, label }`) or null. Pure — exported for the Pi extension parity
 * tests and the hook shims.
 */
export function blockedDesktopControl(command) {
  const c = String(command || '');
  if (!c) return null;
  for (const rule of RULES) {
    if (rule.test(c)) return { id: rule.id, label: rule.label };
  }
  return null;
}

export function blockReason(hit) {
  return (
    `Blocked: ${hit.label}. Agents in this project must never drive the real machine — ` +
    'no computer-use, no switching the real browser\'s tabs, no screen capture, no keystroke injection. ' +
    'Verify the UI with Playwright instead (`/qa` runs an isolated dev server on 127.0.0.1, never your real Chrome). ' +
    'If you are missing a secret (an R2 S3 token, a dashboard-only key), STOP and ask the engineer to paste it ' +
    '(or `npx convex env set <KEY> <value>`) — never obtain it from browser tabs, screenshots, logs, or another app.'
  );
}

// Shell tool ids across the two hook dialects this guard serves: Claude Code
// (`Bash`, snake_case payload) and Grok Build, which reads .claude/settings.json
// for compatibility but sends camelCase (`toolName`/`toolInput`) with its own
// tool ids. Reading only one dialect makes the other engine's guard a silent
// no-op — and this guard is the one that must never be.
const SHELL_TOOLS = new Set(['Bash', 'run_terminal_command', 'run_terminal_cmd']);

/** PreToolUse verdict for a Claude Code or Grok Build hook payload → { block, reason? }. */
export function gateDecision(hook) {
  const tool = String(hook?.tool_name ?? hook?.toolName ?? '');
  if (!SHELL_TOOLS.has(tool)) return { block: false };
  const input = hook?.tool_input ?? hook?.toolInput ?? {};
  const hit = blockedDesktopControl(input?.command);
  return hit ? { block: true, reason: blockReason(hit) } : { block: false };
}

/**
 * Deny in BOTH dialects at once (same shape as fda-lock.mjs): exit 2 + reason
 * on stderr for Claude Code, plus a stdout JSON with grok's `decision`/`reason`
 * and Claude's `hookSpecificOutput`. Claude ignores stdout on exit 2; grok
 * honors the JSON deny regardless of exit code.
 */
export function denyOutput(reason) {
  console.error(reason);
  console.log(
    JSON.stringify({
      decision: 'deny',
      reason,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }),
  );
  return 2;
}

/** Cursor beforeShellExecution verdict → { permission, … }. */
export function cursorDecision(hook) {
  const hit = blockedDesktopControl(hook?.command);
  if (!hit) return { permission: 'allow' };
  return {
    permission: 'deny',
    userMessage: `Blocked ${hit.label}: agents must not operate the real desktop/browser.`,
    agentMessage: blockReason(hit),
  };
}

function readStdin() {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => done(data));
    process.stdin.on('error', () => done(''));
  });
}

/**
 * CLI body, exported so the harness shim (.claude/hooks/desktop-guard.mjs) can
 * call it without a nested process. Returns the process exit code.
 */
export async function runCli(argv, { input } = {}) {
  const cmd = argv.find((a) => !a.startsWith('--')) || 'gate';
  if (cmd !== 'gate') return 0;
  let hook;
  try {
    hook = JSON.parse(input ?? (await readStdin()));
  } catch {
    return 0; // unreadable hook payload → fail open
  }
  const verdict = gateDecision(hook);
  if (verdict.block) return denyOutput(verdict.reason);
  return 0;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

// realpath both sides: Node realpaths the ESM entry for import.meta.url, so a
// symlinked invocation path would otherwise make the CLI a silent no-op.
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  }
})();
if (isMain) {
  process.exit(await runCli(process.argv.slice(2)));
}
