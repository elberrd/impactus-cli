#!/usr/bin/env node
// imp — the IMPACTUS Academy launcher. A thin brand wrapper, NOT a Pi fork:
//   imp init …  → runs the impactus installer (bin/create-iai.js) in-place
//   imp update  → updates impactus + Pi + the Pi extension packages
//   imp [args]  → hands everything else to the real `pi` binary (stdio
//                 inherited), installing Pi first if it is missing.
// Keeping Pi as the actual agent means `pi update`, Codex login and the
// project-level .pi/ config all keep working unchanged. The only Pi behavior
// imp touches is the startup update notice: it is pi-branded ("Run pi
// update"), so imp suppresses it (PI_SKIP_VERSION_CHECK) and prints its own
// imp-branded one after the session ends — see collectUpdateNotices.

// Node version gate — the `engines` field doesn't block `npx` execution, so
// enforce it here with a clear message (before importing anything modern).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`imp requires Node.js >= 22.12 (you are on ${process.versions.node}).`);
  console.error('Update at https://nodejs.org (current LTS) and try again.');
  process.exit(1);
}

const { readFile } = await import('node:fs/promises');
const { fileURLToPath } = await import('node:url');
const pc = (await import('picocolors')).default;

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const INSTALLER = fileURLToPath(new URL('./create-iai.js', import.meta.url));

// ANSI Shadow "IMPACTUS" — 64 columns wide.
const ART = [
  '██╗███╗   ███╗██████╗  █████╗  ██████╗████████╗██╗   ██╗███████╗',
  '██║████╗ ████║██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██║   ██║██╔════╝',
  '██║██╔████╔██║██████╔╝███████║██║        ██║   ██║   ██║███████╗',
  '██║██║╚██╔╝██║██╔═══╝ ██╔══██║██║        ██║   ██║   ██║╚════██║',
  '██║██║ ╚═╝ ██║██║     ██║  ██║╚██████╗   ██║   ╚██████╔╝███████║',
  '╚═╝╚═╝     ╚═╝╚═╝     ╚═╝  ╚═╝ ╚═════╝   ╚═╝    ╚═════╝ ╚══════╝',
];
const ART_WIDTH = 64;

function banner() {
  const columns = process.stdout.columns ?? 80;
  if (process.stdout.isTTY && columns >= ART_WIDTH + 2) {
    console.log('');
    for (const line of ART) console.log(pc.cyan(line));
    const sub = 'A  C  A  D  E  M  Y';
    console.log(pc.bold(pc.cyan(' '.repeat(Math.floor((ART_WIDTH - sub.length) / 2)) + sub)));
    console.log(pc.dim(`imp v${pkg.version} — Pi + the IAI harness, one command`));
    console.log('');
  } else {
    console.log(`IMPACTUS Academy — imp v${pkg.version}`);
  }
}

function helpText() {
  return `
imp — the IMPACTUS CLI launcher (Pi + the IAI harness)

Usage:
  imp                    Start Pi in the current folder (installs Pi if missing)
  imp init [options]     Install the harness/FIA here (same as npx impactus;
                         all impactus flags work — see \`imp init --help\`)
  imp update             Update impactus, Pi and the Pi extension packages
  imp tui                Terminal dashboard — tasks, specs and runs (same as npm run tui)
  imp doctor             Read-only checkup: subscriptions (Claude/Codex/Cursor/Grok),
                         CLIs, Pi and this project (--json for machine output).
                         --gates additionally self-tests the FIA gates: injects
                         deliberate defects against throwaway fixtures and
                         asserts every gate goes red (writes nothing here)
  imp stop               The stop button: no new FDA run starts and an in-flight
                         run stops cleanly before its next phase (resume later
                         with --resume). Fails closed — even an unreadable stop
                         file stops runs. Flags: --status, --clear, --reason "…"
  imp fix                Repair what doctor found: shows the plan, asks first,
                         restores only what is MISSING (never overwrites edits).
                         Flags: --dry-run, --yes, --json (plan only), --commit
                         (one git commit per fix), --allow-dirty
  imp handoff            Continue the newest Pi conversation in the \`claude\` CLI
                         (works while Codex is down; --list picks a session)
  imp llm                List the FDA agents (phase owners) numbered, each with
                         the LLM it runs on, and switch any by number or name:
                         \`imp llm set 1 fable\`, \`imp llm set builder grok-4.6
                         --effort high\`. Interactive on a TTY; --json for
                         machines; same rules as /agents (comments kept, backup
                         first, locked while a run is live). One run only:
                         node imp/fda_*.mjs "<prompt>" --llm "grok-4.6 high"
  imp defer              Postpone a task that cannot proceed now (missing API
                         keys, a pending decision): \`imp defer <n>\` quarantines
                         its sealed holdout probes (rename only — reversible),
                         marks it deferred and ledgers it; \`imp defer resume <n>\`
                         brings everything back. The launch check warns about
                         every open deferral. Flags: --reason "…", --yes, --json
  imp health             Loop-health report: scores the five dimensions of this
                         project's agent work loop from real evidence and names
                         the command that repairs each finding.
                         Flags: --json, --html [path], --strict
  imp rewind             Undo an FDA run. Lists checkpoints (--list), previews the
                         exact file impact, and restores only with --yes.
                         Restore-only: never resets, never rewrites history.
                         Flags: --list, --run <id>, --to <sha>, --dry-run, --yes,
                         --allow-dirty, --json
  imp notify             Show (or --test) the run notifications: webhook, Slack,
                         Discord or Telegram when a run ends. Off by default.
                         Flags: --test, --event <name>, --json
  imp settings           Show where every setting comes from — machine config,
                         project roster, env — read-only, secrets redacted.
                         Flags: --json, --path
  imp help               Show this help
  imp --version          Print the impactus version

Anything else is passed straight to Pi, e.g.:
  imp -p "prompt"        One-shot prompt (headless)
  imp --continue         Resume the last session

First time? In your project folder run \`imp init\`, then \`imp\` and type
/login openai-codex to connect your ChatGPT subscription. Never log in to
Anthropic inside Pi — Claude runs through the official \`claude\` CLI.
`.trimStart();
}

const [cmd, ...rest] = process.argv.slice(2);

// --version stays banner-free and machine-readable, same as the installer.
if (cmd === '--version' || cmd === '-v') {
  console.log(pkg.version);
  process.exit(0);
}

if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  banner();
  console.log(helpText());
  process.exit(0);
}

if (cmd === 'init') {
  banner();
  const { runInherit } = await import('../src/lib/proc.js');
  const r = await runInherit(process.execPath, [INSTALLER, ...rest]);
  process.exit(r.exitCode);
}

if (cmd === 'update') {
  banner();
  const { runInherit } = await import('../src/lib/proc.js');
  const { hasPi, ensurePiReady, installPiPackages } = await import('../src/lib/pi-auth.js');

  console.log(`Updating impactus (npm install -g ${pkg.name}@latest)…`);
  const up = await runInherit('npm', ['install', '-g', `${pkg.name}@latest`]);
  if (!up.ok) {
    console.error(`Could not update impactus. Run it manually:  npm install -g ${pkg.name}@latest`);
    console.error('If npm printed EACCES, reinstall Node.js in your user account (https://nodejs.org) — never use sudo.');
  }

  try {
    if (await hasPi()) {
      console.log('Updating Pi (pi update)…');
      await runInherit('pi', ['update']);
    } else {
      await ensurePiReady(); // installs Pi with the friendly EACCES guidance
    }
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }

  // The Pi extension packages are exact-pinned (that pin is what keeps Pi's
  // pi-branded "Package Updates Available" panel away) — move the pins here.
  // Best-effort: an offline refresh must not fail the whole update.
  try {
    console.log('Updating the Pi extension packages (subagents + MCP + web access)…');
    const piPkgs = await installPiPackages(process.cwd());
    if (piPkgs?.skipped?.length) {
      console.log(`Left untouched (customized in your Pi settings): ${piPkgs.skipped.join(', ')}`);
      console.log('Refresh manually if you want: pi install npm:<name>@latest');
    }
  } catch (err) {
    console.error(`Could not refresh the Pi extension packages: ${err?.message || String(err)}`);
    console.error('Run `imp update` again when back online.');
  }
  console.log('Done.');
  process.exit(up.ok ? 0 : 1);
}

if (cmd === 'doctor') {
  // Read-only by contract — see src/steps/doctor.js. `--json` keeps stdout
  // machine-readable (no banner), same convention as `--version`. `--gates`
  // additionally runs the stamped gate probes (they write only to OS temp —
  // the project tree stays untouched, so the contract holds).
  const json = rest.includes('--json');
  if (!json) banner();
  const { runDoctor } = await import('../src/steps/doctor.js');
  const healthy = await runDoctor({ json, gates: rest.includes('--gates') }, pkg.version);
  process.exit(healthy ? 0 : 1);
}

if (cmd === 'fix') {
  // Restore-only remediation with a consent gate — see src/steps/fix.js.
  // `--json` prints the plan only (machine-readable output never mutates).
  const json = rest.includes('--json');
  if (!json) banner();
  const { runFix } = await import('../src/steps/fix.js');
  const healthy = await runFix({
    json,
    dryRun: rest.includes('--dry-run'),
    yes: rest.includes('--yes') || rest.includes('-y'),
    allowDirty: rest.includes('--allow-dirty'),
    commit: rest.includes('--commit'),
  });
  process.exit(healthy ? 0 : 1);
}

if (cmd === 'settings') {
  // Read-only by contract — see src/steps/settings.js. The verb is `settings`,
  // never `config`: unknown verbs fall through to Pi and `pi config` is a real
  // Pi command that must keep working.
  const json = rest.includes('--json');
  const pathOnly = rest.includes('--path');
  if (!json && !pathOnly) banner();
  const { runSettings } = await import('../src/steps/settings.js');
  const healthy = await runSettings({ json, path: pathOnly });
  process.exit(healthy ? 0 : 1);
}

// Every project-stamped verb. The script lives in imp/scripts/ so it
// version-matches the runtime readers it imports, and every argument is passed
// through untouched. `tui` and `handoff` are in here rather than in blocks of
// their own precisely so they get the same incomplete-runtime diagnosis below —
// they used to die on a raw ERR_MODULE_NOT_FOUND like everything else.
const STAMPED = {
  tui: {
    script: 'imp/scripts/fia-tui.mjs',
    missing: 'Run `imp init` in your project folder first — then `imp tui` opens the dashboard.',
  },
  handoff: {
    script: 'imp/scripts/handoff.mjs',
    missing: 'Run `imp init` in your project folder first — or `npx impactus --update-runtime` on an older install.',
  },
  llm: {
    script: 'imp/scripts/fia-llm.mjs',
    missing: 'Run `imp init` in your project folder first — or `npx impactus --update-runtime` on an older install.',
  },
  defer: {
    script: 'imp/scripts/task-defer.mjs',
    missing: 'Run `imp init` in your project folder first — or `npx impactus --update-runtime` on an older install.',
  },
  health: {
    script: 'imp/scripts/loop-health.mjs',
    missing: 'Run `imp init` in your project folder first — or `npx impactus --update-runtime` on an older install.',
  },
  notify: {
    script: 'imp/scripts/notify.mjs',
    missing: 'Run `imp init` in your project folder first — or `npx impactus --update-runtime` on an older install.',
  },
  rewind: {
    script: 'imp/scripts/rewind.mjs',
    missing: 'Run `imp init` in your project folder first — or `npx impactus --update-runtime` on an older install.',
  },
  stop: {
    script: 'imp/scripts/fia-stop.mjs',
    missing: 'Run `imp init` in your project folder first — or `npx impactus --update-runtime` on an older install.',
  },
};
if (Object.hasOwn(STAMPED, cmd)) {
  const { script, missing } = STAMPED[cmd];
  const { existsSync } = await import('node:fs');
  if (!existsSync(script)) {
    console.error(`No FIA runtime in this folder (${script} not found).`);
    console.error(missing);
    process.exit(1);
  }
  const { runInherit } = await import('../src/lib/proc.js');
  const r = await runInherit(process.execPath, [script, ...rest]);
  // The script exists, but the runtime imports itself: with a sibling missing
  // (a `No` answer during --update-runtime, a deleted file) the child dies on
  // module resolution and the student gets a raw ERR_MODULE_NOT_FOUND stack.
  // Diagnose it only AFTER a failure, and only when files really are missing —
  // a legitimate `--strict` exit 1 on a complete runtime must stay silent.
  if (r.exitCode !== 0) {
    try {
      const { missingRuntimeCode, runtimeHint } = await import('../src/lib/runtime-health.js');
      const missing = await missingRuntimeCode(process.cwd());
      if (missing.length) console.error(`\n${runtimeHint(missing)}`);
    } catch {
      /* the hint is a courtesy — never let it change the child's exit code */
    }
  }
  process.exit(r.exitCode);
}

// Default: launch Pi with every argument passed through untouched.
// Banner only when a human is watching: with stdout piped/captured
// (`imp -p … > file`, scripts, another process driving imp) Pi's output
// must arrive exactly as `pi` would produce it.
if (process.stdout.isTTY) banner();
const { runInherit } = await import('../src/lib/proc.js');
const { hasPi, ensurePiReady, collectUpdateNotices } = await import('../src/lib/pi-auth.js');

// Only install when missing — the launch itself never blocks on the network
// (`imp update` and the installer already keep Pi fresh).
if (!(await hasPi())) {
  try {
    await ensurePiReady();
  } catch (err) {
    console.error(err?.message || String(err));
    process.exit(1);
  }
  console.log(pc.dim('Tip: inside Pi, type /login openai-codex to connect your ChatGPT subscription.'));
}

// The update probe runs in the background WHILE the session is open and is
// only printed after Pi exits — zero launch latency, and nothing for piped
// runs (`imp -p … > file` must carry exactly Pi's output).
const notices = process.stdout.isTTY ? collectUpdateNotices(pkg.version).catch(() => []) : null;

const args = cmd === undefined ? [] : [cmd, ...rest];
const r = await runInherit('pi', args, { env: { PI_SKIP_VERSION_CHECK: '1' } });

if (notices) {
  // Race, don't wait: if the probe is still mid-flight after a short
  // one-shot session, skip it rather than hold the student's terminal.
  const lines = await Promise.race([notices, new Promise((res) => setTimeout(res, 400, []))]);
  if (lines.length > 0) {
    console.log('');
    console.log(pc.bold(pc.yellow('Updates available')));
    for (const line of lines) console.log(pc.yellow(`  - ${line}`));
    console.log(pc.yellow('Run `imp update` to bring everything current.'));
  }
}
process.exit(r.exitCode);
