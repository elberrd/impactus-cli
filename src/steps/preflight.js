import process from 'node:process';
import { existsSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { has, run, runInherit } from '../lib/proc.js';
import { ensurePiReady, piCodexReady } from '../lib/pi-auth.js';
import { grokLoggedIn, hasGrok } from '../lib/grok-auth.js';
import { osKind, detectPackageManagers } from '../lib/platform.js';
import * as ui from '../lib/ui.js';

export const CLAUDE_INSTALL_HINT = {
  mac: 'curl -fsSL https://claude.ai/install.sh | bash   (or: brew install --cask claude-code)',
  linux: 'curl -fsSL https://claude.ai/install.sh | bash',
  windows: 'irm https://claude.ai/install.ps1 | iex   (or: winget install Anthropic.ClaudeCode)',
};

// ── Engines: Claude Code and Codex (status only — NEVER blocks) ─────────────
//
// The installer itself never runs an agent. `claude` is only used to register
// MCPs (`claude mcp add`, which degrades to a manual note when absent) and the
// Codex login has always been the user's last step, inside Pi, AFTER the
// install. The engines belong to the professional, not to the installer — a
// missing one produces guidance and moves on; the final summary (finish.js)
// shows the same roster with the exact commands. There is deliberately no
// login probe for `claude`: no heuristic is reliable, and the `claude` CLI
// walks the user through its own login on first run anyway.

export async function checkEngines(ctx = {}) {
  ui.step('Checking the engines (Claude Code, Codex and Grok Build)…');
  const claude = await has('claude');
  const codex = piCodexReady();
  const grokInstalled = await hasGrok();
  const grok = grokInstalled && grokLoggedIn();
  ctx.engines = { claude, codex, grok };

  if (claude) {
    ui.success('Claude Code found.');
  } else {
    ui.warn('Claude Code not found — optional: the install continues without it.');
    ui.info(`To install later:  ${CLAUDE_INSTALL_HINT[osKind()]}   (then run \`claude\` once to log in)`);
  }
  if (codex) {
    ui.success('Codex login found (Pi).');
  } else {
    ui.info('Codex login not done yet — normal: it is the last step, inside Pi (/login openai-codex).');
  }
  // Grok Build is a third subscription engine — purely optional, recognized
  // automatically when its login exists (never a warning when absent).
  if (grok) {
    ui.success('Grok Build login found (xAI subscription) — available as an engine.');
  } else if (grokInstalled) {
    ui.info('Grok Build installed but not logged in — `grok login` enables it as an engine (optional).');
  }

  if (!claude && !codex && !grok) {
    ui.note(
      [
        'Neither Claude Code nor a Codex login was found. Nothing stops here —',
        'the engines are used by the agents AFTER the install, never by the installer.',
        '',
        'You will get the best results with one of these subscriptions, but you can',
        'also log in to other providers/models later, inside Pi, with /login.',
        'The final summary shows the exact commands for every option.',
      ].join('\n'),
      'No engine yet — the install continues',
    );
  }
}

/**
 * Ensure the Pi CLI (install/update) when FIA will be installed. NO login
 * here: the Codex `/login` is the user's last step, AFTER the install
 * finishes — opening Pi mid-install invited a Ctrl+C that killed the stamp
 * halfway. Claude Code is probed separately in checkEngines (status only).
 */
export async function ensureFiaAuth(flags = {}) {
  if (flags.skipFia || flags.fia === false) {
    ui.info('FIA disabled — Pi/Codex is not required for this install.');
    return;
  }
  ui.step('Checking Pi (FIA)…');
  await ensurePiReady();
  if (piCodexReady()) {
    ui.success('Pi/Codex ready for FDAs.');
  } else {
    ui.info('Codex login not done yet — that is fine: the install finishes everything and the login is the last step.');
  }
}

// ── CLIs: Git, GitHub CLI, Vercel CLI ───────────────────────────────────────
//
// Contract since the "never block" rework: a CLI that cannot be installed or
// logged in NEVER aborts the install. The person (or --yes) chooses to skip,
// the item lands in ctx.pendingTools, the dependent steps degrade with the
// manual command, and the final summary + ai-docs/inbox.md carry the fix so
// the person — or the agent — finishes it later.

/** Record a tool the install will proceed WITHOUT (finish.js reports these). */
function notePending(ctx, id, pending) {
  if (!ctx || !pending) return;
  (ctx.pendingTools ??= []).push({ id, ...pending });
}

/** Was `id` (a tool or a login) skipped during preflight? Steps use this to degrade. */
export function toolPending(ctx, id) {
  return Boolean(ctx?.pendingTools?.some((t) => t.id === id));
}

/**
 * @param {object} opts
 * @param {boolean} [opts.vercel] - prepare the Vercel CLI (only if deploy is possible).
 * @param {boolean} [opts.gh] - install the gh binary at all. "Harness only"
 *   installs with a community token never touch GitHub — installing gh there
 *   is dead weight; it stays in as a dev fallback when there is no token.
 * @param {boolean} [opts.ghAuth] - require gh LOGIN. The binary is installed
 *   either way (used by `gh repo create` in the GitHub step), but the login
 *   only makes sense when a push to GitHub may still happen.
 * @param {object} [opts.ctx] - the install context (pending skips are recorded here).
 */
export async function ensureCliTools({ vercel = true, gh = true, ghAuth = true, flags = {}, ctx = {} } = {}) {
  const pms = await detectPackageManagers();
  await ensureGit(pms, flags, ctx);
  if (gh) await ensureGh(pms, flags, { requireAuth: ghAuth }, ctx);
  else ui.info('GitHub CLI (gh) not needed for this install — skipped.');
  // The Vercel CLI is only needed when the template (and the deploy) are in.
  // In "harness only" mode — and when the deploy was declined — it's optional.
  if (vercel) await ensureVercel(pms, flags, ctx);
}

/**
 * Per-OS install command for a given tool, or null if none is available.
 *
 * `gh` on apt is the special case: it does NOT exist in the Debian/Ubuntu
 * repositories, only in GitHub CLI's own signed repository. `apt-get install
 * -y gh` fails with "Unable to locate package gh" — hence the script that
 * registers the key and the source before installing (docs:
 * cli.github.com/packages).
 */
export function installPlan(tool, pms) {
  const os = osKind();
  if (tool === 'vercel') {
    // No first-party brew/winget/choco formula → npm global on every OS.
    return { bin: 'npm', args: ['install', '-g', 'vercel'] };
  }
  if (os === 'mac' && pms.brew) return { bin: 'brew', args: ['install', tool] };
  if (os === 'linux' && pms['apt-get'] && tool === 'gh') {
    return { bin: 'bash', args: ['-c', GH_APT_SCRIPT] };
  }
  if (os === 'linux' && pms['apt-get']) {
    // `apt-get update` first: on an image with a stale index the install fails.
    return { bin: 'bash', args: ['-c', `set -e; sudo apt-get update; sudo apt-get install -y ${tool}`] };
  }
  if (os === 'linux' && pms.dnf) return { bin: 'sudo', args: ['dnf', 'install', '-y', tool] };
  // Arch/Alpine name the GitHub CLI package `github-cli`; openSUSE only has
  // git in the default repos (gh falls through to the manual path there).
  if (os === 'linux' && pms.pacman) {
    return { bin: 'sudo', args: ['pacman', '-S', '--noconfirm', tool === 'gh' ? 'github-cli' : tool] };
  }
  if (os === 'linux' && pms.zypper && tool === 'git') {
    return { bin: 'sudo', args: ['zypper', 'install', '-y', 'git'] };
  }
  if (os === 'linux' && pms.apk) {
    return { bin: 'sudo', args: ['apk', 'add', tool === 'gh' ? 'github-cli' : tool] };
  }
  if (os === 'windows' && pms.winget) {
    const id = tool === 'gh' ? 'GitHub.cli' : 'Git.Git';
    return { bin: 'winget', args: ['install', '--id', id, '-e', '--source', 'winget'] };
  }
  if (os === 'windows' && pms.choco) return { bin: 'choco', args: ['install', tool, '-y'] };
  return null;
}

// Official GitHub CLI steps for Debian/Ubuntu.
const GH_APT_SCRIPT = [
  'set -e',
  'sudo mkdir -p -m 755 /etc/apt/keyrings',
  'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null',
  'sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
  'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
  'sudo apt-get update',
  'sudo apt-get install -y gh',
].join('\n');

// Where winget/choco put each tool on Windows. A fresh install updates the
// PATH in the registry, but NOT in this already-running process — so the
// post-install check would fail even after a successful install. Appending
// the known dir to process.env.PATH fixes this run (children inherit it).
const WINDOWS_INSTALL_DIRS = {
  git: ['C:\\Program Files\\Git\\cmd'],
  gh: ['C:\\Program Files\\GitHub CLI'],
};

async function refreshWindowsPath(tool) {
  if (osKind() !== 'windows') return;
  for (const dir of WINDOWS_INSTALL_DIRS[tool] || []) {
    if (existsSync(dir) && !(process.env.PATH || '').includes(dir)) {
      process.env.PATH = `${process.env.PATH};${dir}`;
    }
  }
}

/**
 * Pick the official Git for Windows installer from a GitHub release's assets.
 * `Git-<version>-64-bit.exe` / `Git-<version>-arm64.exe` — the `^Git-` anchor
 * deliberately excludes `PortableGit-*.7z.exe` (self-extracting archive, no
 * PATH setup) and the BusyBox/MinGit variants. Exported for tests.
 */
export function pickGitWindowsAsset(assets, arch = process.arch) {
  const re = arch === 'arm64' ? /^Git-.*-arm64\.exe$/ : /^Git-.*-64-bit\.exe$/;
  const hit = (Array.isArray(assets) ? assets : []).find((a) => re.test(a?.name || ''));
  return hit?.browser_download_url || null;
}

/**
 * Windows without winget OR choco (the screenshot case: an admin cmd on a
 * clean Windows Server / LTSC image): download the official Git for Windows
 * installer and run it silently — the CLI installs git itself instead of
 * sending the person to a website. Inno Setup flags: /VERYSILENT /NORESTART
 * (the installer elevates itself via UAC when needed). Best-effort: any
 * failure returns false and the manual path takes over.
 */
async function installGitWindowsDirect() {
  ui.info('No winget/choco — downloading the official Git for Windows installer…');
  const exePath = join(tmpdir(), `impactus-git-installer-${process.pid}.exe`);
  try {
    const rel = await fetch('https://api.github.com/repos/git-for-windows/git/releases/latest', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'impactus-cli' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!rel.ok) throw new Error(`GitHub API responded ${rel.status}`);
    const url = pickGitWindowsAsset((await rel.json()).assets);
    if (!url) throw new Error('no installer asset in the latest release');
    const dl = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!dl.ok) throw new Error(`download failed (${dl.status})`);
    await writeFile(exePath, Buffer.from(await dl.arrayBuffer()));
    ui.info('Running the Git installer (silent — Windows may ask for admin permission)…');
    const r = await runInherit(exePath, ['/VERYSILENT', '/NORESTART']);
    if (!r.ok) throw new Error(`installer exited with code ${r.exitCode}`);
    return true;
  } catch (err) {
    ui.warn(`Could not install Git directly: ${err?.message || err}`);
    return false;
  } finally {
    await rm(exePath, { force: true }).catch(() => {});
  }
}

/**
 * Make `tool` available: package-manager plan → direct fallback installer →
 * manual instructions with a DETECTION loop. We never treat "yes, I installed
 * it" as the source of truth — the machine is probed again every time. And a
 * tool that stays missing never aborts the install: the person chooses to
 * skip, the item is recorded in ctx.pendingTools and every dependent step
 * degrades (the final summary + ai-docs/inbox.md carry the manual fix).
 * @returns {Promise<boolean>} true when the tool works, false when skipped.
 * Exported for tests (the never-abort contract is asserted there).
 */
export async function installOrInstruct(tool, plan, { docsUrl, manualHint, verify, flags = {}, ctx, direct, pending } = {}) {
  const check = verify || (() => has(tool));
  if (plan) {
    ui.info(`Installing ${tool}: ${plan.bin} ${plan.args.join(' ')}`);
    const r = await runInherit(plan.bin, plan.args);
    if (r.ok) {
      await refreshWindowsPath(tool);
      if (await check()) {
        ui.success(`${tool} installed.`);
        return true;
      }
    }
    ui.warn(`I couldn't install ${tool} with ${plan.bin}.`);
  } else {
    ui.warn(`No known package manager to install ${tool} automatically.`);
  }

  // No plan, or the plan failed → direct fallback when one exists (the
  // official Git for Windows installer; `xcode-select --install` on a
  // brew-less Mac).
  if (direct) {
    await direct();
    await refreshWindowsPath(tool);
    if (await check()) {
      ui.success(`${tool} installed.`);
      return true;
    }
  }

  const hint = manualHint || `See: ${docsUrl}`;

  // `--yes` promises to ask NOTHING — and a missing tool must not kill the
  // install either. Skip it, record the fix, let the dependent steps degrade.
  if (flags.yes) {
    ui.warn(`${tool} is not available — continuing WITHOUT it (--yes). To install later:  ${hint}`);
    notePending(ctx, tool, pending);
    return false;
  }

  ui.note(
    [
      `Install ${tool} manually:`,
      `  ${hint}`,
      '',
      'When you are done, pick "Done — check again" below and I will',
      'verify it on this machine myself.',
    ].join('\n'),
    `Install ${tool}`,
  );
  for (;;) {
    const action = await ui.select({
      message: `${tool} is not available yet. What do you want to do?`,
      initialValue: 'check',
      options: [
        { value: 'check', label: 'Done — check again', hint: `I probe ${tool} on this machine` },
        {
          value: 'skip',
          label: `Skip for now — continue without ${tool}`,
          hint: 'the final summary lists how to finish this later',
        },
      ],
    });
    if (action === 'skip') {
      ui.warn(`Continuing WITHOUT ${tool}. ${pending?.why ?? ''}`.trim());
      notePending(ctx, tool, pending);
      return false;
    }
    await refreshWindowsPath(tool);
    if (await check()) {
      ui.success(`${tool} ready.`);
      return true;
    }
    ui.warn(`${tool} still not detected — finish its installer (or let it complete) and pick "check again".`);
  }
}

/**
 * `which git` is not enough on macOS: a fresh Mac ships /usr/bin/git as a
 * shim for the Xcode Command Line Tools, so git looks "installed" while it
 * cannot actually run. `git --version` is the real probe — and when the CLT
 * are missing it also makes macOS open the "Install Command Line Developer
 * Tools?" dialog, which IS the native git installer there.
 */
async function gitWorks() {
  if (!(await has('git'))) return false;
  return (await run('git', ['--version'])).ok;
}

async function ensureGit(pms, flags = {}, ctx = {}) {
  ui.step('Checking Git…');
  if (await gitWorks()) {
    ui.success('Git installed.');
    return;
  }
  ui.warn('Git not found — installing…');
  const os = osKind();
  // The CLI installs git ITSELF on every OS, package manager or not:
  // Windows without winget/choco downloads the official installer; a Mac
  // without brew pops the native CLT dialog (macOS's own git installer) and
  // the detection loop waits for the person to finish it.
  const direct =
    os === 'windows' && !pms.winget && !pms.choco
      ? installGitWindowsDirect
      : os === 'mac' && !pms.brew
        ? async () => {
            ui.info('Opening the native macOS installer (Command Line Developer Tools)…');
            await run('xcode-select', ['--install']);
          }
        : null;
  await installOrInstruct('git', installPlan('git', pms), {
    docsUrl: 'https://git-scm.com/downloads',
    manualHint:
      os === 'mac'
        ? 'xcode-select --install   (accept the "Install Command Line Developer Tools" dialog — it may already be on screen)'
        : undefined,
    verify: gitWorks,
    flags,
    ctx,
    direct,
    pending: {
      title: 'Install Git and create the initial commit',
      fix: 'install Git (https://git-scm.com/downloads), then in the project folder: git init && git add -A && git commit -m "initial setup"',
      why: 'No git repository will be created in this install — no commits, no GitHub, no version history until Git exists.',
    },
  });
}

async function ensureGh(pms, flags = {}, { requireAuth = true } = {}, ctx = {}) {
  ui.step('Checking the GitHub CLI (gh)…');
  const publishCmd = `gh repo create ${ctx.slug || '<repo-name>'} --private --source=. --remote=origin --push`;
  if (!(await has('gh'))) {
    ui.warn('gh not found — installing…');
    const ready = await installOrInstruct('gh', installPlan('gh', pms), {
      docsUrl: 'https://cli.github.com',
      manualHint:
        osKind() === 'linux'
          ? 'Signed repository: https://github.com/cli/cli/blob/trunk/docs/install_linux.md'
          : undefined,
      flags,
      ctx,
      pending: {
        title: 'Install the GitHub CLI (gh) and publish the repository',
        fix: `install gh (https://cli.github.com), run \`gh auth login\`, then in the project folder: ${publishCmd}`,
        why: 'The GitHub repository will not be created or pushed in this install.',
      },
    });
    if (!ready) return; // skipped — no binary, so no login either
  } else {
    ui.success('gh installed.');
  }

  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
    ui.success('gh authenticated (environment token).');
    return;
  }
  if ((await run('gh', ['auth', 'status'])).ok) {
    ui.success('gh authenticated.');
    return;
  }
  // With no push planned, the gh login is pure friction: the template and the
  // harness ALWAYS come through the community gate — gh only exists to create
  // the repo and push.
  if (!requireAuth) {
    ui.info('gh not logged in — that is fine: nothing will be sent to GitHub in this install.');
    return;
  }
  // `gh auth login` is interactive (opens the browser and waits): under --yes
  // it would hang the process. Skip the publish instead of killing the run.
  const ghAuthPending = {
    title: 'Log in to the GitHub CLI and publish the repository',
    fix: `run \`gh auth login\` (or set GH_TOKEN), then in the project folder: ${publishCmd}`,
    why: 'The GitHub repository will not be created or pushed in this install.',
  };
  if (flags.yes) {
    ui.warn('gh is not authenticated and --yes cannot open the interactive login — the GitHub publish will be skipped.');
    notePending(ctx, 'gh-auth', ghAuthPending);
    return;
  }
  ui.warn('You need to log in to the GitHub CLI.');
  ui.info('Opening `gh auth login` — recommended: GitHub.com › HTTPS › login via browser.');
  await runInherit('gh', ['auth', 'login']);
  if (!(await run('gh', ['auth', 'status'])).ok) {
    ui.warn('gh login not confirmed — continuing WITHOUT the GitHub publish (you can do it later).');
    notePending(ctx, 'gh-auth', ghAuthPending);
    return;
  }
  ui.success('gh authenticated.');
}

async function ensureVercel(pms, flags = {}, ctx = {}) {
  ui.step('Checking the Vercel CLI…');
  if (!(await has('vercel'))) {
    ui.warn('vercel not found — installing…');
    const ready = await installOrInstruct('vercel', installPlan('vercel', pms), {
      docsUrl: 'https://vercel.com/docs/cli',
      flags,
      ctx,
      pending: {
        title: 'Install the Vercel CLI and deploy',
        fix: 'npm install -g vercel && vercel login, then in the project folder: vercel link --yes && vercel deploy --yes (Preview; use /launch for Production)',
        why: 'The quick deploy will be skipped in this install.',
      },
    });
    if (!ready) return; // skipped — no binary, so no login either
  } else {
    ui.success('vercel installed.');
  }

  if (process.env.VERCEL_TOKEN) {
    ui.success('vercel authenticated (VERCEL_TOKEN).');
    return;
  }
  const who = await run('vercel', ['whoami']);
  if (who.ok) {
    ui.success(`vercel authenticated (${who.stdout.trim()}).`);
    return;
  }
  // `vercel login` opens a device flow in the browser and waits —
  // impossible under --yes. Skip the deploy instead of killing the run.
  const vercelAuthPending = {
    title: 'Log in to the Vercel CLI and deploy',
    fix: 'run `vercel login` (or set VERCEL_TOKEN), then in the project folder: vercel link --yes && vercel deploy --yes (Preview; use /launch for Production)',
    why: 'The quick deploy will be skipped in this install.',
  };
  if (flags.yes) {
    ui.warn('vercel is not authenticated and --yes cannot open the interactive login — the deploy will be skipped.');
    notePending(ctx, 'vercel-auth', vercelAuthPending);
    return;
  }
  ui.warn('You need to log in to the Vercel CLI.');
  ui.info('Opening `vercel login` — follow the instructions.');
  await runInherit('vercel', ['login']);
  if (!(await run('vercel', ['whoami'])).ok) {
    ui.warn('vercel login not confirmed — continuing WITHOUT the deploy (you can do it later).');
    notePending(ctx, 'vercel-auth', vercelAuthPending);
    return;
  }
  ui.success('vercel authenticated.');
}
