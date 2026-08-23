import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMMUNITY } from '../config.js';
import { has, run, runInherit } from '../lib/proc.js';
import { piCodexReady } from '../lib/pi-auth.js';
import { osKind } from '../lib/platform.js';
import { CLAUDE_INSTALL_HINT } from './preflight.js';
import { STACK_CATEGORIES, STACK_LATER } from '../stack-catalog.js';
import { relToCwd, LEGACY_STATE_MARKER, STATE_MARKER } from './project.js';
import * as ui from '../lib/ui.js';

/**
 * Next steps for "harness only" mode in a NEW project, per stack path:
 *   discover → the conversation comes first (/idea extracts PRD + stack);
 *   custom   → decide/document what's missing (/stack) and then the PRD;
 *   fallback → the classic script (PRD → /start).
 */
// The command that opens the agent: `imp` when the global launcher was
// installed (see ensureImpGlobal), the plain `pi` binary otherwise.
const agentCmd = (ctx) => (ctx.impGlobal ? 'imp' : 'pi');

function greenfieldSteps(ctx, fiaNeedsLogin) {
  const pending = ctx.stackInfo?.pending?.length ?? 0;
  const loginHint = fiaNeedsLogin
    ? ', run /login openai-codex (only that one — Anthropic stays on the `claude` CLI)'
    : '';

  if (ctx.stackPath === 'discover') {
    return ctx.fiaInstalled
      ? [
          `1. Run \`${agentCmd(ctx)}\`${loginHint} and type /idea — the interview extracts the PRD and the BEST STACK for it (everything lands in ai-docs/).`,
          '2. /stack — generates the docs for each decided technology and installs CLIs, MCPs and skills.',
          '3. /grill (sharpen the PRD) → /map → /task or /goal. In Claude Code/Cursor: /start and /dev.',
          `Lost at any rung? /guide (inside \`${agentCmd(ctx)}\`) reads the state, confirms your goal and charts the route.`,
        ]
      : [
          '1. Open Claude Code (or Cursor) in this folder and run /stack — decide the stack in conversation and generate the docs for each technology.',
          '2. Fill in the PRD in ai-docs/PRD.md and run /start.',
          '3. Then iterate with /dev, /sv and /test-ui.',
        ];
  }

  if (ctx.stackPath === 'custom') {
    const where = ctx.fiaInstalled ? `in \`${agentCmd(ctx)}\` or in Claude Code` : 'in Claude Code or Cursor';
    return [
      pending
        ? `1. Your stack is in ai-docs/stack.md (${pending} layer(s) to decide). Run /stack ${where} — it decides what's missing, generates the docs for each technology and installs the tools.`
        : `1. Your stack is in ai-docs/stack.md. Run /stack ${where} — it generates the docs for each technology (recommended before implementing).`,
      ctx.fiaInstalled
        ? `2. PRD: fill in ai-docs/PRD.md — or run \`${agentCmd(ctx)}\`${loginHint} and use /idea to shape it in conversation.`
        : '2. Fill in the PRD in ai-docs/PRD.md (replace every {{placeholder}}).',
      ctx.fiaInstalled
        ? `3. /grill → /map → /task or /goal (in \`${agentCmd(ctx)}\`). In Claude Code/Cursor: /start and /dev.`
        : '3. Open Claude Code or Cursor in this folder and run /start; then iterate with /dev, /sv and /test-ui.',
      ctx.fiaInstalled
        ? `Lost at any rung? /guide (inside \`${agentCmd(ctx)}\`) reads the state, confirms your goal and charts the route.`
        : null,
    ];
  }

  return [
    '1. Fill in the PRD in ai-docs/PRD.md (replace every {{placeholder}}).',
    '2. Open Claude Code or Cursor in this folder and run /start.',
    '3. Then iterate with /dev, /sv and /test-ui.',
    ctx.fiaInstalled
      ? fiaNeedsLogin
        ? `4. FIA: run \`${agentCmd(ctx)}\`, type /login openai-codex (only that one — Anthropic stays on the \`claude\` CLI); then: no PRD (or, later, a big new module), use /idea; with a PRD, /grill → /map → /task or /goal. /map opens the result (screens, tasks, design system) in the browser — after that it's just \`npm run plan\`.`
        : `4. FIA: run \`${agentCmd(ctx)}\` — no PRD (or, later, a big new module), use /idea; with a PRD, /grill → /map → /task or /goal. /map opens the result (screens, tasks, design system) in the browser — after that it's just \`npm run plan\`.`
      : null,
    ctx.fiaInstalled
      ? `Lost at any rung? /guide (inside \`${agentCmd(ctx)}\`) reads the state, confirms your goal and charts the route.`
      : null,
  ];
}

/**
 * Drop the preflight skips into ai-docs/inbox.md — the harness's idea inbox,
 * which /feature, /quick and /spec already scan and promote. One line per
 * item in the inbox format; idempotent by title so a re-run of the installer
 * doesn't duplicate entries. Best-effort (the caller swallows errors): the
 * panel above is the source the person sees either way.
 */
async function appendPendingToInbox(ctx) {
  const aiDocs = join(ctx.dir, 'ai-docs');
  if (!existsSync(aiDocs)) return; // no harness → nowhere the agents read
  const inbox = join(aiDocs, 'inbox.md');
  const existing = existsSync(inbox)
    ? await readFile(inbox, 'utf8')
    : [
        '# Inbox — Ideas Captured, Not Yet Promoted',
        '',
        '> Format: `- [ ] YYYY-MM-DD — <one-line idea> (context: <optional>)`',
        '',
      ].join('\n');
  const date = new Date().toISOString().slice(0, 10);
  const lines = ctx.pendingTools
    .filter((t) => !existing.includes(t.title))
    .map((t) => `- [ ] ${date} — ${t.title} (context: skipped during the install; fix: ${t.fix})`);
  if (!lines.length) return;
  await writeFile(inbox, `${existing.trimEnd()}\n${lines.join('\n')}\n`);
  ui.info('The skipped items were also noted in ai-docs/inbox.md (the agents pick pending work up from there).');
}

/** One-line stack summary for the final note (null without a manifest). */
function stackSummaryLine(ctx) {
  if (ctx.stackPath === 'template') return 'Stack:   IAI recommended — manifest in ai-docs/stack.md';
  const info = ctx.stackInfo;
  if (!info) return null;
  const pending = info.pending?.length ?? 0;
  if (pending === STACK_CATEGORIES.length) return 'Stack:   to decide — manifest in ai-docs/stack.md (everything pending)';
  const decided = STACK_CATEGORIES.filter(
    (c) => info.choices[c.id] !== STACK_LATER && info.choices[c.id] !== 'none',
  ).map((c) => info.choices[c.id]);
  return `Stack:   ${decided.join(' + ')}${pending ? ` (+${pending} layer(s) to decide)` : ''} — ai-docs/stack.md`;
}

export async function finish(ctx) {
  const rel = relToCwd(ctx.dir);
  const harnessOnly = ctx.mode === 'harness';
  const fiaNeedsLogin = ctx.fiaInstalled && !piCodexReady();

  // The install made it to the end: drop the crash-recovery marker (written at
  // the start of installTemplate) BEFORE the final commit, so a future run
  // doesn't mistake this folder for a half-finished installation.
  await rm(join(ctx.dir, STATE_MARKER), { force: true }).catch(() => {});
  await rm(join(ctx.dir, LEGACY_STATE_MARKER), { force: true }).catch(() => {});

  // Preflight skips go into ai-docs/inbox.md BEFORE the final commit below —
  // writing them later would leave the tree dirty right after the install.
  if (ctx.pendingTools?.length) await appendPendingToInbox(ctx).catch(() => {});

  // Final commit (best-effort): FIA, stack manifest and Impeccable land
  // AFTER the harness commit — without this the installation would end with a
  // dirty tree (and launch:check would flag a blocker right away).
  if (existsSync(join(ctx.dir, '.git')) && (ctx.harnessInstalled || ctx.fiaInstalled || ctx.stackInfo)) {
    const dirty = await run('git', ['status', '--porcelain'], { cwd: ctx.dir });
    if (dirty.ok && dirty.stdout.trim()) {
      await run('git', ['add', '-A'], { cwd: ctx.dir });
      const commit = await run(
        'git',
        ['commit', '-q', '-m', 'chore: stack, FIA and tooling (impactus)'],
        { cwd: ctx.dir },
      );
      if (commit.ok) {
        ui.info('Final commit created (stack, FIA and tooling).');
        if (ctx.repoUrl) {
          const push = await run('git', ['push'], { cwd: ctx.dir });
          if (!push.ok) ui.warn('Could not push the final commit — run `git push` in the project folder.');
        }
      }
    }
  }

  ui.note(
    [
      `Project: ${ctx.name}`,
      `Folder:  ${ctx.dir}`,
      ctx.convexUrl ? `Convex:  ${ctx.convexUrl}` : null,
      ctx.clerkApp ? `Clerk:   ${ctx.clerkApp}` : null,
      ctx.issuer ? `Issuer:  ${ctx.issuer}` : null,
      ctx.shadcnPreset ? `Preset:  ${ctx.shadcnPreset} (shadcn/ui)` : null,
      ctx.shadcnBlocks?.length ? `Blocks:  ${ctx.shadcnBlocks.join(', ')} (shadcn/ui)` : null,
      ctx.repoUrl ? `GitHub:  ${ctx.repoUrl}` : null,
      ctx.deployUrl ? `Deploy:  ${ctx.deployUrl}` : null,
      stackSummaryLine(ctx),
      // In "harness only" mode there is no template (storage/addons) — omit.
      harnessOnly
        ? null
        : `Files:   ${ctx.storageBackend === 'r2' ? 'Cloudflare R2' : 'Convex Storage'} (Documents page)`,
      ctx.addons ? `Addons:  ${ctx.addons.length ? ctx.addons.join(', ') : 'none'}` : null,
      ctx.harnessInstalled ? 'Harness: installed — fill in ai-docs/PRD.md and run /start' : null,
      ctx.fiaInstalled
        ? fiaNeedsLogin
          ? `FIA: installed — last step: run \`${agentCmd(ctx)}\` and type /login openai-codex (only that login)`
          : `FIA: installed — run \`${agentCmd(ctx)}\` and use /fia, /map, /task, /goal, /qa, /ui-contract, /evolve (plan: npm run plan · agents: npm run agents · viewer: npm run fda:viewer · terminal dashboard: npm run tui)`
        : null,
      ctx.fiaInstalled
        ? 'Switch a model anytime: `imp llm` (or /llm inside Pi) — numbered agent list, "1 → fable" changes it.'
        : null,
      ctx.fiaInstalled
        ? 'Task blocked on API keys or a decision? `imp defer <n>` (or /defer) postpones it with its sealed probes — `imp defer resume <n>` brings it back.'
        : null,
      ctx.fiaInstalled
        ? 'Codex outage? `imp handoff` continues your newest Pi conversation in the `claude` CLI.'
        : null,
      // The reporters that answer "is this project healthy?" and "undo that run".
      // Named here because nothing else in the install surfaces them.
      ctx.fiaInstalled
        ? 'Checkups: `imp health` (how well the agent loop is working) · `imp rewind` (undo an FDA run, preview first) · `imp stop` (stop button: halts FDA runs cleanly, `--clear` to disarm) · `imp settings` (where every setting comes from) · `npm run security:scan` · `npm run launch:check` · `npm run gates:probe` (self-test: every gate must go red on an injected defect) · `npm run holdout` (acceptance probes sealed when a brief is written — agents cannot edit them)'
        : null,
      ctx.fiaInstalled
        ? 'Long run? `imp notify` sends a Slack/Discord/Telegram ping when it ends (off until you turn it on).'
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
    'All set ✅',
  );

  // Engines roster: ONE panel, at the end, with the state of each engine and
  // the exact command for whatever is missing. Presence is probed NOW — not
  // reused from the preflight snapshot — because the user may have installed
  // Claude Code in another terminal while this run was going. Nothing here is
  // required: the professional decides which subscriptions to use.
  const claudeReady = await has('claude');
  const codexReady = piCodexReady();
  ui.note(
    [
      claudeReady
        ? '✅ Claude Code (Claude Pro/Max) — installed. Not logged in yet? Run `claude` once and finish in the browser.'
        : `○ Claude Code (Claude Pro/Max) — not installed.\n   Install:  ${CLAUDE_INSTALL_HINT[osKind()]}\n   Then run \`claude\` once to log in.`,
      ctx.fiaInstalled
        ? codexReady
          ? '✅ Codex (ChatGPT Plus/Pro, via Pi) — logged in.'
          : `○ Codex (ChatGPT Plus/Pro, via Pi) — login pending.\n   Log in:  run \`${agentCmd(ctx)}\` and type /login openai-codex.`
        : null,
      '',
      'Neither is mandatory. Agents give the best results with Claude and/or Codex,',
      ctx.fiaInstalled
        ? 'but Pi also accepts other providers/models — type /login inside Pi to see them.'
        : 'but you can also work through Cursor or add engines later at any time.',
      'Re-check this roster (and the whole setup) anytime with `imp doctor`.',
      'Every model is YOUR choice, on YOUR plan: `imp llm` swaps any agent in',
      'seconds, and `npm run fda:cost-report` shows what each one actually spends.',
    ]
      .filter(Boolean)
      .join('\n'),
    'Engines — who runs your agents',
  );

  // Integrations report: what the keys step left ACTIVE and what is still
  // pending (with the keys — webhooks included — created via API).
  if (ctx.serviceReport?.length) {
    ui.note(
      ctx.serviceReport
        .map((s) => `${s.ok ? '✅' : '○'} ${s.label} — ${s.detail}`)
        .join('\n'),
      'Integrations — status',
    );
  }

  // "How to activate later" notes only for what did NOT get ready above.
  const configured = new Set((ctx.serviceReport ?? []).filter((s) => s.ok).map((s) => s.id));
  const pendingNotes = (ctx.addonNotes ?? []).filter((n) => !configured.has(n.id));
  if (pendingNotes.length) {
    ui.note(
      pendingNotes.map((n) => `• ${n.text}`).join('\n'),
      'Addons — what is left to activate (each one works/degrades gracefully until then)',
    );
  }

  // Tools skipped in the preflight (git/gh/vercel or their logins): one panel
  // with the exact fix for each — and the same items dropped into
  // ai-docs/inbox.md, where the agents already look for pending work.
  if (ctx.pendingTools?.length) {
    ui.note(
      ctx.pendingTools.map((t) => `• ${t.title}\n  ${t.fix}`).join('\n'),
      'Skipped during the install — finish later (you, or hand it to the agent)',
    );
  }

  // UI keys file: only offer to delete it when it was ACTUALLY consumed in
  // this run (ctx.keysApplied). In harness mode (or if nothing was applied)
  // the keys don't exist anywhere yet — keep it.
  if (ctx.keysFilePath && existsSync(ctx.keysFilePath)) {
    if (!ctx.keysApplied) {
      ui.info(`Keys file was NOT used in this run — kept: ${ctx.keysFilePath}`);
    } else if (ctx.flags?.yes) {
      ui.info(`Keys file kept: ${ctx.keysFilePath} (delete it whenever you want).`);
    } else {
      const wipe = await ui.confirm({
        message: `Delete the keys file ${ctx.keysFilePath}? (it has already been applied to the project)`,
        initialValue: true,
      });
      if (wipe) {
        await rm(ctx.keysFilePath, { force: true });
        ui.success('Keys file deleted.');
      }
    }
  }

  // Account-less Neon database: highlighted reminder — without the claim it expires.
  if (ctx.neonProvision?.claimUrl) {
    ui.note(
      [
        'The DEV Postgres database was created on the spot, no account needed (Neon Launchpad).',
        'CLAIM IT into your Neon account — otherwise it expires in ~72h:',
        `  ${ctx.neonProvision.claimUrl}`,
        '(The link is also in .env.local and in ai-docs/stack.md.)',
      ].join('\n'),
      'Neon — claim your database',
    );
  }

  // In "harness only" mode there is no project ready to run — the next steps
  // depend on the stack path (discover, custom or brownfield).
  if (harnessOnly) {
    const brownfield = Boolean(ctx.existingProject);
    ui.note(
      [
        `cd ${rel}`,
        '',
        ...(brownfield
          ? [
              'EXISTING project — the path is having the system understand your code before touching it:',
              '',
              ctx.fiaInstalled
                ? `1. Run \`${agentCmd(ctx)}\`${fiaNeedsLogin ? ', run /login openai-codex (only that one — Anthropic stays on the `claude` CLI)' : ''} and type /onboarding — one guided pass through /absorb (as-built PRD, map, conventions, stack manifest), /stack (per-tech docs + tooling) and /kit (design-system audit).`
                : '1. Open Claude Code in this folder and run /onboarding — one guided pass through /absorb (as-built PRD, map, conventions, stack manifest), /stack (per-tech docs + tooling) and /kit (design-system audit).',
              '2. New feature: /feature "what you want". Defect: /bug "the symptom".',
              // /task and /goal are Pi prompts (not Claude Code commands) —
              // say WHERE they run, or people type them in the wrong tool.
              ctx.fiaInstalled
                ? `3. Execute: inside \`${agentCmd(ctx)}\`, run /task (one task) or /goal (all of them).`
                : '3. Implement with /dev in Claude Code, as always.',
              ctx.fiaInstalled
                ? `Lost at any rung? /guide (inside \`${agentCmd(ctx)}\`) reads the state, confirms your goal and charts the route.`
                : null,
            ]
          : greenfieldSteps(ctx, fiaNeedsLogin)),
        ctx.agentFilesBackup
          ? `\nYour previous agent files are in ${ctx.agentFilesBackup} (nothing was deleted).`
          : null,
        '',
        'Full guide: imp/HARNESS.md.',
      ]
        .filter(Boolean)
        .join('\n'),
      'Next steps',
    );
    // Guest run (no sign-in): remind what stayed locked and how to unlock it.
    if (ctx.guest) {
      ui.note(
        [
          'This install ran WITHOUT the community sign-in: harness + agent only.',
          'Signing in as a student unlocks the ready-made templates and the fully',
          'automated pipeline (Convex, Clerk, keys, webhooks, GitHub, deploy).',
          '',
          `Subscribe or renew: ${COMMUNITY.checkoutUrl}`,
          'Already a student? npx impactus --login  (then run the installer again)',
        ].join('\n'),
        'Unlock the full installer',
      );
    }
    ui.outro(ui.color.green('Done! Happy coding. 🚀'));
    return;
  }

  ui.note(
    [
      `cd ${rel}`,
      '',
      '# Terminal 1 — Convex backend (watch + codegen):',
      'npm run dev:convex',
      '',
      '# Terminal 2 — Next.js:',
      'npm run dev        →  http://localhost:3000',
      '',
      '# (optional) sample data:',
      'npm run seed',
    ].join('\n'),
    'Next steps',
  );

  ui.info('Use http://localhost:3000 for local Clerk development (not the network IP).');

  const start = ctx.flags?.yes
    ? false
    : await ui.confirm({ message: 'Start Next.js now (npm run dev)?', initialValue: false });
  if (start) {
    ui.info('Tip: run `npm run dev:convex` in another terminal for backend hot-reload. Ctrl+C stops it.');
    ui.info('If login later shows 431/instance mismatch, clear localhost cookies or use an incognito window.');
    await runInherit('npm', ['run', 'dev'], { cwd: ctx.dir });
  }

  ui.outro(ui.color.green('Done! Happy coding. 🚀'));
}
