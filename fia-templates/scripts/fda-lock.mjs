#!/usr/bin/env node
/**
 * FDA lock probe — the reader side of the FIA single-run lock.
 *
 * The runner (imp/modules/session.mjs) writes imp/data/.fda.lock while an FDA
 * is active and removes it on exit. A live lock means a deterministic run is
 * writing to this tree: its permission gate attributes every change to the
 * current phase agent and rolls back what the phase did not declare, so
 * anything an OUTSIDE session writes mid-run gets reverted or swept into the
 * run's commit. This script lets everything outside the run discover that
 * state:
 *
 *   status  one human line (--json for the raw lock) — `npm run fda:status`
 *   warn    SessionStart hook: prints a read-only notice when a run is
 *           active, stays silent otherwise — new sessions start informed
 *   gate    PreToolUse hook: reads the hook JSON from stdin and exits 2
 *           (block) when the tool call would write inside this repository
 *           while a run is active; silent exit 0 otherwise
 *
 * The Cursor hook (.cursor/hooks/fda-lock-cursor.mjs) imports activeFdaLock
 * and gateDecision from here and answers Cursor's beforeShellExecution
 * protocol with the same verdicts.
 *
 * The FDA's own child agents are exempt: the runner exports FIA_FDA_RUN into
 * their environment (see session.mjs) and both hooks stay silent when it is
 * present. Every path here fails OPEN — a missing lock, unreadable stdin or
 * an internal error never blocks a tool and never breaks a session.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The FIA single-run lock, when a LIVE process holds it → { pid, fda_id, … }. */
/**
 * `defaults.data_dir` from the student's roster, resolved against `root`.
 *
 * DUPLICATED from imp/modules/utils.mjs ON PURPOSE — do not "DRY" it away.
 * This file is copied ALONE into hook contexts (.claude/hooks/fda-lock.mjs
 * and .cursor/hooks/fda-lock-cursor.mjs import it, and a project may have
 * imp/scripts/ without imp/modules/ reachable from where the hook runs), so
 * any cross-directory import turns the write guard into a silent no-op. The
 * narrow regex keeps it dependency-free; anything unexpected degrades to the
 * shipped default.
 */
function dataDirOf(root) {
  try {
    const raw = readFileSync(resolve(root, 'imp', 'fia.config.yaml'), 'utf8');
    const m = /^[ \t]*data_dir:[ \t]*(.+?)[ \t]*(?:#.*)?$/m.exec(raw);
    const declared = m?.[1]?.replace(/^['"]|['"]$/g, '').trim();
    if (declared) return resolve(root, declared);
  } catch {
    /* no roster, or unreadable — the shipped default below is correct anyway */
  }
  return resolve(root, 'imp', 'data');
}

export function activeFdaLock(root, dataDir = null) {
  let lock = null;
  // Resolve `defaults.data_dir` when the caller did not name one: a project
  // that moved it would otherwise get "no active run" from every reader — and
  // `imp stop` reporting "No run is active" while a run IS active is exactly
  // the lie a stop button must never tell. `resolve` also accepts an absolute
  // argument, so existing callers keep working unchanged.
  const dir = dataDir ? resolve(root, dataDir) : dataDirOf(root);
  try {
    lock = JSON.parse(readFileSync(join(dir, '.fda.lock'), 'utf8'));
  } catch {
    return null; /* no lock or unreadable — no active run */
  }
  if (!lock?.pid || lock.pid === process.pid) return null;
  try {
    process.kill(lock.pid, 0); // ESRCH when the pid is dead → stale lock
    return lock;
  } catch (err) {
    // EPERM = the pid EXISTS but belongs to another user — the run is alive
    // and the lock must hold; anything else means stale.
    return err?.code === 'EPERM' ? lock : null;
  }
}

// Tool names across the two hook dialects this gate serves: Claude Code
// (Write/Edit/…/Bash) and Grok Build, which reads .claude/settings.json for
// compatibility but sends its OWN tool ids (search_replace, run_terminal_command).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'search_replace', 'write_file', 'write', 'edit']);
const SHELL_TOOLS = new Set(['Bash', 'run_terminal_command', 'run_terminal_cmd']);

/**
 * `{ name, input }` of the tool call in a PreToolUse payload, whichever dialect
 * sent it: Claude Code uses snake_case (`tool_name`/`tool_input`), Grok Build
 * camelCase (`toolName`/`toolInput`). Reading only one of them makes the
 * other engine's hook a silent no-op — the failure mode a guard must never have.
 */
export function hookTool(hook) {
  return {
    name: String(hook?.tool_name ?? hook?.toolName ?? ''),
    input: hook?.tool_input ?? hook?.toolInput ?? {},
  };
}

/**
 * Deny in BOTH dialects at once: exit 2 + the reason on stderr (Claude Code
 * feeds stderr back to the model on exit 2; grok takes exit 2 as deny too)
 * AND a stdout JSON carrying grok's `decision`/`reason` plus Claude's
 * `hookSpecificOutput` block. Claude Code ignores stdout on exit 2, grok
 * honors the JSON deny regardless of exit code — so one object serves both.
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

// Bash write-context heuristics, shared shape with the Pi fia-guard extension:
// a command only blocks when it plausibly mutates files inside the repo.
const WRITE_BINARY = /(^|[\s;&|(])(rm|mv|cp|tee|chmod|chown|truncate|dd|ln|rsync|install)(\s|$)/;
const SED_IN_PLACE = /(^|[\s;&|(])sed\s+(-\S*i|--in-place)/;
// Git verbs that move the tree/index/history — a mid-run commit or checkout
// is exactly the incident this lock exists to prevent.
const GIT_WRITE =
  /(^|[\s;&|(])git\s+(add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|revert|rm|stash|switch)\b/;

/** Does `raw` resolve to the project root or below it? */
function insideRoot(root, raw) {
  if (!raw) return false;
  const rel = relative(resolve(root), resolve(root, raw));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Targets of >/>> redirections (writes even without a write binary). */
function redirectTargets(command) {
  const out = [];
  const re = />{1,2}\s*([^\s;|&<>]+)/g;
  let m;
  while ((m = re.exec(command))) out.push(m[1].replace(/^["']+|["']+$/g, ''));
  return out;
}

/** Would this bash command write inside the repository at `root`? */
export function bashWritesInRepo(root, command) {
  if (GIT_WRITE.test(command)) return true;
  if (redirectTargets(command).some((t) => insideRoot(root, t))) return true;
  if (!WRITE_BINARY.test(command) && !SED_IN_PLACE.test(command)) return false;
  const tokens = command
    .split(/[\s;|&()<>]+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter(Boolean);
  // Only path-looking tokens count: `npm install` alone stays allowed, while
  // `rm src/x.js` or `sed -i '' file.ts` block. /tmp and other outside paths
  // never block — the run only guards its own tree.
  return tokens.some((t) => /[/.]/.test(t) && insideRoot(root, t));
}

/** PreToolUse verdict for a Claude Code or Grok Build hook payload → { block, reason? }. */
export function gateDecision(hook, { root, lock }) {
  const { name: tool, input } = hookTool(hook);
  if (WRITE_TOOLS.has(tool)) {
    const target = input.file_path || input.notebook_path || input.target_file || input.path || '';
    if (insideRoot(root, target)) return { block: true, reason: gateReason(lock, target) };
    return { block: false };
  }
  if (SHELL_TOOLS.has(tool) && bashWritesInRepo(root, String(input.command || ''))) {
    return { block: true, reason: gateReason(lock, 'this command') };
  }
  return { block: false };
}

function gateReason(lock, target) {
  return (
    `FIA run active (fda_id ${lock?.fda_id || 'unknown'}, pid ${lock?.pid || '?'}): ${target} touches this repository, ` +
    'and repo writes are blocked while the FDA runs — its permission gate would attribute the change to the ' +
    'current phase agent and roll it back. Reading and inspecting are fine. Wait for the run to finish ' +
    '(npm run fda:sessions); the lock lifts automatically. If the run is truly gone, remove imp/data/.fda.lock and retry.'
  );
}

export function renderWarn(lock) {
  const lines = [
    '⚠ FIA run ACTIVE in this repository — treat this session as READ-ONLY for repo files.',
    `  fda_id: ${lock?.fda_id || 'unknown'}   runner: ${lock?.runner || '?'}   pid: ${lock?.pid || '?'}   started: ${lock?.started_at || '?'}`,
    '  A deterministic FDA is writing to this tree. Its permission gate attributes every change',
    '  to the current phase agent and rolls back what the phase did not declare — anything',
    '  written here now gets reverted or swept into that run\'s commit. A hook blocks repo',
    '  writes until the run ends; the lock lifts automatically.',
    '  Watch progress: npm run fda:sessions   ·   live viewer: npm run fda:viewer',
  ];
  return lines.join('\n');
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
 * CLI body, exported so the harness shim (.claude/hooks/fda-lock.mjs) can
 * call it without a nested process. Returns the process exit code.
 */
export async function runCli(argv, { root = process.cwd(), env = process.env, input } = {}) {
  const cmd = argv.find((a) => !a.startsWith('--')) || 'status';
  const lock = activeFdaLock(root);
  if (cmd === 'status') {
    if (argv.includes('--json')) console.log(JSON.stringify(lock));
    else if (lock) {
      console.log(
        `FIA run active — fda_id ${lock.fda_id || 'unknown'} (${lock.runner || '?'}, pid ${lock.pid}, started ${lock.started_at || '?'})`,
      );
    } else console.log('no active FIA run in this repository');
    return 0;
  }
  // Inside the run's own process tree (FIA_FDA_RUN exported by the runner)
  // the hooks must stay silent — the FDA's builder MUST be able to write.
  if (!lock || env.FIA_FDA_RUN) return 0;
  if (cmd === 'warn') {
    console.log(renderWarn(lock));
    return 0;
  }
  if (cmd === 'gate') {
    let hook;
    try {
      hook = JSON.parse(input ?? (await readStdin()));
    } catch {
      return 0; // unreadable hook payload → fail open
    }
    const verdict = gateDecision(hook, { root: hook?.cwd || root, lock });
    if (verdict.block) return denyOutput(verdict.reason);
    return 0;
  }
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
