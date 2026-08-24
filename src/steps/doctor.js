// `imp doctor` — a read-only checkup of the machine and, when run inside a
// project, of the install. DETECTION ONLY by design: doctor never installs,
// never opens a login and never rewrites a file — every finding ends in the
// exact command the student runs to fix it. (The remediating siblings each
// keep their own consent flow: `imp init`, `imp update`, `npx impactus
// --update-runtime`, `npx impactus --verify`.)
//
// Sections:
//   1. Engines (subscriptions) — Claude Code on PATH, the Codex login inside
//      Pi (~/.pi/agent/auth.json) and the Cursor CLI. Informative, never an
//      error: which subscriptions to use is the professional's call. There is
//      deliberately no `claude` login probe (same rationale as the preflight:
//      no heuristic is reliable, and `claude` walks the user through login on
//      first run).
//   2. Core CLIs — node/git/npm (required) and gh/vercel (optional).
//   3. Pi & imp — Pi installed + the three pinned extension packages, plus
//      the same update probe `imp` prints after a session.
//   4. Project — only when the folder looks like an IAI project: FIA runtime
//      complete, the stamped runtime still current with the templates this
//      impactus ships, .mcp.json hygiene (npx without -y dies on a cold cache
//      — the "Connection closed" lesson) and a summary of the --verify audit.
//
// `--json` swaps the report for `{ ok, sections }` on stdout. Exit code:
// 0 = no error-level finding (warnings included), 1 otherwise.

import process from 'node:process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pc from 'picocolors';
import { has } from '../lib/proc.js';
import { osKind } from '../lib/platform.js';
import {
  hasPi,
  piCodexReady,
  piPackageStatus,
  piVersion,
  collectUpdateNotices,
  PI_PACKAGES,
} from '../lib/pi-auth.js';
import { CLAUDE_INSTALL_HINT } from './preflight.js';
import { grokStatusLine } from '../lib/grok-auth.js';
import { collectFindings } from './verify.js';
import { classifyHarnessState, readHarnessManifest } from '../lib/harness-manifest.js';
import { isRuntimeCode, missingRuntimeCode, runtimeHint } from '../lib/runtime-health.js';
import { planRuntimeUpdate, readRuntimeManifest } from './update-runtime.js';

const NODE_FLOOR = [22, 12];

// How long the network update probe may hold the report. Offline (or slow)
// just skips the section's update rows — doctor never blocks on the network.
const UPDATE_PROBE_MS = 4000;

// Cap on inline project-audit rows; the full list lives in --verify.
const MAX_AUDIT_ROWS = 8;

const ok = (msg) => ({ level: 'ok', msg });
const info = (msg) => ({ level: 'info', msg });
const warn = (msg) => ({ level: 'warn', msg });
const error = (msg) => ({ level: 'error', msg });

/**
 * `.mcp.json` hygiene: every npx-launched MCP server needs `-y` — on a cold
 * npx cache the "Ok to proceed?" prompt lands on the MCP stdio channel and
 * the server dies before the handshake ("Connection closed"; the classic
 * first-run-on-Windows report). Pure — unit-testable on a parsed JSON.
 * @returns {{level:string,msg:string}[]} one warn per offending server.
 */
export function mcpNpxFindings(mcpJson) {
  const servers = mcpJson?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const rows = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const args = Array.isArray(cfg?.args) ? cfg.args : [];
    if (cfg?.command !== 'npx') continue;
    if (args.includes('-y') || args.includes('--yes')) continue;
    rows.push(
      warn(
        `MCP "${name}": npx without -y in .mcp.json — with a cold npx cache the server dies before the handshake ` +
          '("Connection closed"). Add "-y" as the first item of its "args".',
      ),
    );
  }
  return rows;
}

async function enginesSection() {
  const rows = [];
  const claude = await has('claude');
  rows.push(
    claude
      ? ok('Claude Code (Claude Pro/Max) — installed. Not logged in yet? Run `claude` once and finish in the browser.')
      : info(
          `Claude Code (Claude Pro/Max) — not installed.\n  Install:  ${CLAUDE_INSTALL_HINT[osKind()]}\n  Then run \`claude\` once to log in.`,
        ),
  );
  rows.push(
    piCodexReady()
      ? ok('Codex (ChatGPT Plus/Pro, via Pi) — logged in.')
      : info(
          'Codex (ChatGPT Plus/Pro, via Pi) — login pending.\n  Log in:  run `imp` and type /login openai-codex (only that one — Anthropic stays on the `claude` CLI).',
        ),
  );
  rows.push(
    (await has('cursor-agent'))
      ? ok('Cursor CLI (cursor-agent) — installed (Cursor subscription).')
      : info('Cursor CLI (cursor-agent) — not installed (optional; see https://cursor.com/cli).'),
  );
  const grokLine = await grokStatusLine({ okMark: '', pendingMark: '' });
  rows.push(grokLine.startsWith(' Grok Build (xAI subscription) — installed and logged in') ? ok(grokLine.trim()) : info(grokLine.trim()));
  rows.push(info('None is mandatory — doctor only reports; which subscriptions to use is your call.'));
  return { title: 'Engines (subscriptions)', rows };
}

async function clisSection() {
  const rows = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor >= NODE_FLOOR[1]);
  rows.push(
    nodeOk
      ? ok(`Node.js ${process.versions.node} (floor: ${NODE_FLOOR.join('.')})`)
      : error(`Node.js ${process.versions.node} is below the ${NODE_FLOOR.join('.')} floor — update at https://nodejs.org.`),
  );
  for (const cmd of ['git', 'npm']) {
    rows.push(
      (await has(cmd))
        ? ok(`${cmd} — installed.`)
        : warn(`${cmd} — not found. Run \`imp init\`: the installer sets it up for you (or records the pending step).`),
    );
  }
  for (const cmd of ['gh', 'vercel']) {
    rows.push(
      (await has(cmd))
        ? ok(`${cmd} — installed (optional).`)
        : info(`${cmd} — not installed (optional; the installer offers it when a step needs it).`),
    );
  }
  return { title: 'Core CLIs', rows };
}

async function piSection(impactusVersion) {
  const rows = [];
  if (await hasPi()) {
    const version = await piVersion();
    rows.push(ok(`Pi — installed${version ? ` (v${version})` : ''}.`));
    const status = piPackageStatus();
    const missing = PI_PACKAGES.filter((name) => status[name] === 'missing');
    const custom = PI_PACKAGES.filter((name) => status[name] === 'custom');
    const unpinned = PI_PACKAGES.filter((name) => status[name] === 'unpinned');
    if (missing.length === 0) {
      const notes = [
        custom.length ? `${custom.join(', ')} customized by you — left alone` : null,
        unpinned.length ? `${unpinned.join(', ')} unpinned — the next online \`imp update\` pins them` : null,
      ].filter(Boolean);
      rows.push(ok(`Pi extension packages — ${PI_PACKAGES.length} present${notes.length ? ` (${notes.join('; ')})` : ''}.`));
    } else {
      rows.push(warn(`Pi extension packages missing: ${missing.join(', ')} — run \`imp update\` to (re)install them.`));
    }
  } else {
    rows.push(warn('Pi — not installed. `imp` installs it on first launch (or run `imp update`).'));
  }

  // Same probe the launcher prints after a session — timeboxed so an offline
  // or slow registry never holds the report.
  const notices = await Promise.race([
    collectUpdateNotices(impactusVersion).catch(() => []),
    new Promise((res) => setTimeout(res, UPDATE_PROBE_MS, [])),
  ]);
  if (notices.length > 0) {
    for (const line of notices) rows.push(warn(`Update available: ${line}`));
    rows.push(warn('Run `imp update` to bring everything current.'));
  } else {
    rows.push(ok('No pending updates found (or the registry was unreachable — checked best-effort).'));
  }
  return { title: 'Pi & imp', rows };
}

/**
 * Is the stamped runtime still the one this impactus ships? The answer comes
 * from `planRuntimeUpdate` — the very planner `--update-runtime` uses — so
 * doctor and the updater can never disagree about what is behind. The plan is
 * pure: it reads the templates and the disk and returns entries, nothing here
 * writes. A failure degrades to one warn row (a reporter never throws).
 * @returns {Promise<{level:string,msg:string}[]>}
 */
async function runtimeStalenessRows(cwd, impactusVersion) {
  let manifest = null;
  let plan = [];
  try {
    manifest = await readRuntimeManifest(cwd);
    plan = await planRuntimeUpdate({ dir: cwd, manifest });
  } catch (err) {
    return [warn(`Runtime version check could not run here: ${err?.message || err}`)];
  }
  // 'update' = ours and untouched since the stamp; 'modified' = differs with no
  // stamp proving it was ours. Both mean the file on disk is not the one this
  // impactus ships. ('add' is absence, not skew — for runtime code the
  // completeness probe above already reports it.)
  const behind = plan.filter((e) => e.action === 'update' || e.action === 'modified');
  const code = behind.filter((e) => isRuntimeCode(e.rel));
  const prose = behind.filter((e) => !isRuntimeCode(e.rel));
  const names = (entries) =>
    `${entries.slice(0, 4).map((e) => e.rel).join(', ')}${entries.length > 4 ? ` (+${entries.length - 4})` : ''}`;

  const rows = [];
  if (code.length) {
    // An error, not a note: runtime code imports itself by relative path, so a
    // project holding old modules next to new ones fails at module resolution
    // (`does not provide an export named …`) on every FDA.
    rows.push(
      error(
        `${code.length} runtime code file(s) differ from the impactus ${impactusVersion} templates — the runtime imports ` +
          'itself, so a mixed-version imp/ dies on module resolution. Bring it current with `npx impactus --update-runtime`.' +
          `\n   behind: ${names(code)}`,
      ),
    );
  }
  if (prose.length) {
    rows.push(
      warn(
        `${prose.length} prompt/skill file(s) differ from the impactus ${impactusVersion} templates — newer prose, or your ` +
          'own edits. `npx impactus --update-runtime` brings them current and asks before replacing anything you changed.',
      ),
    );
  }
  if (!behind.length) rows.push(ok(`Runtime matches the impactus ${impactusVersion} templates.`));
  if (manifest?.impactus && manifest.impactus !== impactusVersion) {
    rows.push(
      info(
        `Runtime stamped by impactus ${manifest.impactus}; this CLI is ${impactusVersion} — \`npx impactus --update-runtime\` re-stamps it.`,
      ),
    );
  }
  return rows;
}

async function projectSection(cwd, impactusVersion) {
  const rows = [];
  const inProject =
    existsSync(join(cwd, 'imp')) || existsSync(join(cwd, 'ai-docs')) || existsSync(join(cwd, '.agents'));
  if (!inProject) {
    rows.push(info('No IAI project detected in this folder — run `imp doctor` inside a project for the install audit (create one with `imp init`).'));
    return { title: 'Project', rows };
  }

  if (existsSync(join(cwd, 'imp'))) {
    const runtimeOk = existsSync(join(cwd, 'imp', 'scripts', 'fia-tui.mjs'));
    const rosterOk = existsSync(join(cwd, 'imp', 'fia.config.yaml'));
    // Presence of two paths is not completeness. The runtime imports itself, so
    // a project missing part of imp/modules/ or imp/scripts/ dies on module
    // resolution while these two probes still say "present" — the exact green
    // light that used to send students in circles.
    const missingRuntime = await missingRuntimeCode(cwd);
    if (missingRuntime.length) {
      rows.push(error(`${runtimeHint(missingRuntime)}\n   missing: ${missingRuntime.slice(0, 4).join(', ')}${missingRuntime.length > 4 ? ` (+${missingRuntime.length - 4})` : ''}`));
    }
    rows.push(
      // Not "present" while it is incomplete: printing the green row under the
      // ✖ was the contradiction students had to resolve for themselves.
      runtimeOk && rosterOk && !missingRuntime.length
        ? ok('FIA runtime present (imp/scripts + imp/fia.config.yaml).')
        : warn('FIA runtime incomplete (imp/ exists but scripts or fia.config.yaml are missing) — run `npx impactus --update-runtime`.'),
    );
    // Complete is not the same as current: nothing else in the CLI ever tells a
    // student their runtime is behind, so a project stays on the release it was
    // stamped with until someone happens to run `--update-runtime`.
    rows.push(...(await runtimeStalenessRows(cwd, impactusVersion)));
  } else {
    rows.push(info('FIA not installed here (harness-only install) — `imp init` adds it.'));
  }

  const mcpPath = join(cwd, '.mcp.json');
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
      const hygiene = mcpNpxFindings(mcp);
      const count = Object.keys(mcp?.mcpServers || {}).length;
      rows.push(...(hygiene.length ? hygiene : [ok(`.mcp.json — ${count} server(s), npx entries all carry -y.`)]));
    } catch {
      rows.push(error('.mcp.json is not valid JSON — no MCP server will load until it parses again.'));
    }
  } else {
    rows.push(info('.mcp.json not found — no MCP servers registered for this project.'));
  }

  // Harness stamp: classify against imp/.harness-manifest.json when the
  // install recorded one. Missing files are fixable (`imp fix` restores
  // them); files that differ are the student's (or template-owned) and are
  // only reported — never an error.
  const harnessManifest = await readHarnessManifest(cwd);
  if (harnessManifest) {
    const state = await classifyHarnessState(harnessManifest, cwd);
    if (state.missing.length) {
      rows.push(
        warn(
          `${state.missing.length} harness file(s) missing (deleted?) — e.g. ${state.missing.slice(0, 4).join(', ')}${state.missing.length > 4 ? ', …' : ''}. Restore with \`imp fix\`.`,
        ),
      );
    }
    if (state.modified.length) {
      rows.push(info(`${state.modified.length} harness file(s) differ from the stamp — your edits or template-owned variants (left alone).`));
    }
    if (!state.missing.length && !state.modified.length) {
      rows.push(ok(`Harness stamp intact (${state.pristine} file(s) match imp/.harness-manifest.json).`));
    }
  } else if (existsSync(join(cwd, 'imp', 'HARNESS.md'))) {
    rows.push(info('No harness stamp manifest (project from an older CLI) — the next `npx impactus --harness-only --dir .` run records one.'));
  }

  // Full install audit, summarized: the detailed report stays in --verify.
  try {
    const findings = await collectFindings(cwd);
    const errors = findings.filter((f) => f.level === 'error');
    const warns = findings.filter((f) => f.level === 'warn');
    const shown = [...errors, ...warns].slice(0, MAX_AUDIT_ROWS);
    for (const f of shown) rows.push(f.level === 'error' ? error(f.msg) : warn(f.msg));
    const hidden = errors.length + warns.length - shown.length;
    if (hidden > 0) rows.push(info(`… and ${hidden} more — full report: npx impactus --verify`));
    if (errors.length === 0 && warns.length === 0) {
      rows.push(ok(`Install audit — ${findings.length} check(s), all good (same audit as \`npx impactus --verify\`).`));
    }
  } catch (err) {
    rows.push(warn(`Install audit could not run here: ${err?.message || err}`));
  }
  return { title: 'Project', rows };
}

/**
 * `--gates`: run the stamped gate probes (imp/scripts/gate-probes.mjs) — the
 * only check that measures the HARNESS rather than the machine or the code.
 * Each probe injects a deliberate defect against a throwaway fixture in OS
 * temp and asserts the matching gate goes red; a MISSED probe means a class
 * of defect can currently slip through this project's gates unseen. Spawned
 * (not imported) so the probes run the PROJECT's stamped runtime, not this
 * package's templates — version drift is exactly what this section detects.
 */
async function gatesSection(cwd) {
  const rows = [];
  const script = join(cwd, 'imp', 'scripts', 'gate-probes.mjs');
  if (!existsSync(script)) {
    // Two different situations, two different repairs: a folder with no FIA
    // runtime at all needs an install, not an update — pointing everyone at
    // `--update-runtime` sends people to a command that refuses to run there.
    rows.push(
      existsSync(join(cwd, 'imp'))
        ? warn('No gate probes in this project (imp/scripts/gate-probes.mjs missing) — stamp them:  npx impactus --update-runtime')
        : info('No FIA runtime in this folder, so there are no gates to self-test. Install one with `imp init` (or `npx impactus`).'),
    );
    return { title: 'Gates (self-test)', rows };
  }
  let child = null;
  try {
    const { run } = await import('../lib/proc.js');
    child = await run(process.execPath, [script, '--json'], { cwd });
    const report = JSON.parse(child.stdout || 'null');
    if (!report || typeof report.healthy !== 'boolean') throw new Error('unreadable probe report');
    if (report.healthy) {
      rows.push(ok(`Gate probes: ${report.caught}/${report.red} defects caught, ${report.controls_ok}/${report.controls} clean controls pass.`));
    } else {
      for (const p of report.results.filter((x) => !x.ok)) {
        rows.push(
          error(
            `Gate probe ${p.kind === 'red' ? 'MISSED' : 'control BROKEN'}: ${p.id} — ${p.what}` +
              (p.error ? `\nProbe error: ${p.error}` : '') +
              '\nRestore the runtime:  npx impactus --update-runtime',
          ),
        );
      }
    }
  } catch (err) {
    // An unrunnable self-test is a finding, never a silent skip — a check
    // that cannot run has to be loud, not absent. The child's own stderr is
    // what actually names the cause (a missing imp/node_modules is the common
    // one), so it must reach the student instead of a generic parse error.
    const detail = String(child?.stderr || '')
      .split('\n')
      .filter((l) => l.trim())
      .slice(-3)
      .join('\n');
    rows.push(
      error(
        `Gate probes could not run${child ? ` (exit ${child.exitCode})` : ''}: ${err?.message || err}` +
          (detail ? `\n${detail}` : '') +
          '\nTry them directly:  npm run gates:probe',
      ),
    );
  }
  return { title: 'Gates (self-test)', rows };
}

/**
 * Probe everything and return the report (no printing — unit-testable).
 * @returns {Promise<{ok: boolean, sections: {title: string, rows: {level:string,msg:string}[]}[]}>}
 */
export async function collectDoctorReport({ cwd = process.cwd(), impactusVersion = '0.0.0', gates = false } = {}) {
  const sections = [
    await enginesSection(),
    await clisSection(),
    await piSection(impactusVersion),
    await projectSection(resolve(cwd), impactusVersion),
  ];
  if (gates) sections.push(await gatesSection(resolve(cwd)));
  return { ok: !sections.some((s) => s.rows.some((r) => r.level === 'error')), sections };
}

const ICONS = { ok: '✅', info: '○', warn: '⚠', error: '✖' };
const PAINT = { ok: (s) => s, info: pc.dim, warn: pc.yellow, error: pc.red };

/** Entry point of `imp doctor`. @returns {Promise<boolean>} true = no errors. */
export async function runDoctor(flags = {}, impactusVersion = '0.0.0') {
  const report = await collectDoctorReport({ impactusVersion, gates: Boolean(flags.gates) });
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok;
  }
  console.log(pc.bold('imp doctor — read-only checkup (nothing is installed or changed)'));
  for (const section of report.sections) {
    console.log('');
    console.log(pc.bold(pc.cyan(section.title)));
    for (const row of section.rows) {
      const paint = PAINT[row.level] || ((s) => s);
      const [first, ...cont] = row.msg.split('\n');
      console.log(paint(`  ${ICONS[row.level] || ' '} ${first}`));
      for (const line of cont) console.log(paint(`   ${line}`));
    }
  }
  console.log('');
  console.log(
    report.ok
      ? 'Everything the system needs is in place (○/⚠ items are optional or have their command above).'
      : pc.red('Problems found — each ✖ above ends with the command that fixes it.'),
  );
  if (report.sections.some((s) => s.rows.some((r) => r.level === 'warn' || r.level === 'error'))) {
    console.log(pc.dim('Repairable findings can be applied with `imp fix` — it shows the plan and asks before touching anything.'));
  }
  return report.ok;
}
