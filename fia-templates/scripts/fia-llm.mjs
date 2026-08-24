#!/usr/bin/env node
/**
 * fia-llm — the LLM switcher. Lists the FDA agents (the phase owners: planner,
 * builder, scout, reviewer, documenter) numbered, each with the engine + model
 * it currently runs on, and switches any of them by number or name — in the
 * terminal (`imp llm`, `npm run llm`) or through the `/llm` command inside Pi
 * (which calls this script; Pi never edits imp/fia.config.yaml itself).
 *
 *   imp llm                       numbered list; on a TTY it then asks which
 *                                 agent to change (number or name) and what to
 *                                 run it on — Enter finishes
 *   imp llm --json                machine-readable roster + engine status
 *   imp llm set 1 fable           switch by number (claude alias → claude_code)
 *   imp llm set builder openai-codex/gpt-5.6   provider/id → the pi engine
 *   imp llm set 2 sonnet-4.5-thinking --engine cursor
 *   Flags: --engine claude_code|pi|cursor · --effort <level> · --thinking <level>
 *
 * Writes go through roster.mjs (same path as the visual editor): comments
 * preserved, backup first, atomic rename, agents changed but never added or
 * removed. A live FDA run locks the switch — same rule as the Agents tab.
 */
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeFdaLock } from './fda-lock.mjs';
import { GROK_EFFORTS, apiKeyProvider, checkEngines, engineIssue, grokModels } from '../modules/engines.mjs';
import { levelField, resolveTarget } from '../modules/llm-target.mjs';
import { dataDirOf } from '../modules/utils.mjs';
import { CODING_AGENTS, EFFORTS, THINKING, loadRoster, saveRoster, validateRosterPatch } from './roster.mjs';

// The target grammar ("fable", "grok 4.6", "cursor sonnet-4.5", "provider/id")
// lives in modules/llm-target.mjs — shared with the run-scoped `--llm` flag of
// every FDA, so both spellings can never drift. Re-exported for callers/tests.
export { resolveTarget };

const DEFAULT_CONFIG = process.env.FIA_CONFIG || 'imp/fia.config.yaml';

// The run phases each roster agent owns (informational — phases are declared
// inline in the FDAs; this mirrors the viewer's FDA map for display).
export const AGENT_PHASES = {
  planner: 'plan',
  builder: 'build, fix_*, red_test, fix_checklist, fix_ui',
  scout: 'scout',
  reviewer: 'review, ui_check, ui_verify',
  documenter: 'document',
};

/** Numbered display roster: loadRoster + phases, or { available: false }. */
export function rosterView(configPath) {
  const roster = loadRoster(configPath);
  if (!roster.available) return roster;
  return {
    ...roster,
    agents: roster.agents.map((a, i) => ({ n: i + 1, phases: AGENT_PHASES[a.name] || '—', ...a })),
  };
}

/** The agent picked by 1-based number or name — throws naming the options. */
export function pickAgent(agents, ref) {
  const raw = String(ref ?? '').trim();
  const asNumber = /^\d+$/.test(raw) ? Number(raw) : null;
  const found = asNumber !== null ? agents[asNumber - 1] : agents.find((a) => a.name === raw.toLowerCase());
  if (!found) {
    const options = agents.map((a) => `${a.n} ${a.name}`).join(', ');
    throw new Error(`no agent "${raw}" — pick a number or name: ${options}`);
  }
  return found;
}

/**
 * Switch one agent's LLM. Refuses while an FDA run is live (the permission
 * gate would attribute the write to the running phase), writes through
 * roster.mjs, and returns { name, from, to, backup, warnings } — warnings
 * cover API-key billing and an engine that is not ready on this machine.
 */
export function applyChange({ root = process.cwd(), configPath, backupDir } = {}, { agent, target, engine, effort, thinking } = {}) {
  configPath = resolve(root, configPath || DEFAULT_CONFIG);
  backupDir = backupDir || join(dataDirOf(root), 'backups');
  const view = rosterView(configPath);
  if (!view.available) throw new Error(`no FIA roster at ${configPath} — run \`imp init\` in your project folder first`);
  const entry = pickAgent(view.agents, agent);
  const lock = activeFdaLock(root);
  if (lock) {
    throw new Error(
      `an FDA run is active (fda_id ${lock.fda_id || 'unknown'}, pid ${lock.pid}) — the roster is locked mid-run. ` +
        'Wait for it to finish (npm run fda:sessions) or stop it (`imp stop`), then retry; the change applies from the next run.',
    );
  }
  const to = resolveTarget(target, { engine });
  const patch = {
    agents: [
      {
        name: entry.name,
        coding_agent: to.coding_agent,
        model: to.model,
        ...(effort !== undefined ? { effort } : {}),
        ...(thinking !== undefined ? { thinking } : {}),
      },
    ],
  };
  const invalid = validateRosterPatch(patch);
  if (invalid) throw new Error(invalid);
  const { backup } = saveRoster({ configPath, backupDir }, patch);
  const warnings = [];
  const provider = apiKeyProvider(to);
  if (provider) {
    warnings.push(
      `"${to.model}" runs through the ${provider} API key — every token bills to that key, OUTSIDE your Claude/Codex subscription.`,
    );
  }
  const engines = checkEngines(process.env, { root });
  const issue = engineIssue(to, engines);
  if (issue) warnings.push(`engine not ready on this machine: ${issue} — fix it before the next run (declared fallbacks still apply).`);
  if (to.coding_agent === 'grok' && !issue && !engines.grok.trusted) {
    warnings.push(
      'grok has not trusted this project folder yet — it would skip the FIA hooks in silence. ' +
        'The first run grants it automatically (or do it now: `grok --trust -p ok` in the project root).',
    );
  }
  if (to.coding_agent === 'grok' && engines.grok.api_key_env) {
    warnings.push('XAI_API_KEY is set in this shell — the FIA removes it from grok runs so they stay on the subscription; unset it to avoid surprises elsewhere.');
  }
  return { name: entry.name, from: { coding_agent: entry.coding_agent, model: entry.model }, to, backup, warnings };
}

// ── rendering ────────────────────────────────────────────────────────────────

const tty = () => process.stdout.isTTY;
const dim = (s) => (tty() ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s) => (tty() ? `\x1b[1m${s}\x1b[22m` : s);

// claude_code and grok expose `effort`, pi exposes `thinking`; cursor's level
// lives in the model id itself (…-thinking), so a stale field is never shown.
const levelOf = (a) => {
  const field = levelField(a.coding_agent);
  return field && a[field] ? `${field} ${a[field]}` : '';
};

export function renderList(view, engines) {
  const lines = ['The FDA agents and the LLM each one runs on:', ''];
  const nameWidth = Math.max(...view.agents.map((a) => a.name.length));
  for (const a of view.agents) {
    const llm = [`${a.coding_agent} · ${a.model}`, levelOf(a)].filter(Boolean).join(' · ');
    const inherited = a.explicit.model ? '' : dim(' (from defaults)');
    const issue = engineIssue(a, engines);
    const flag = issue ? `  ⚠ ${issue}` : '';
    lines.push(`  ${a.n}. ${bold(a.name.padEnd(nameWidth))}  ${llm}${inherited}${flag}`);
    lines.push(`     ${dim(`phases: ${a.phases}`)}`);
  }
  lines.push('');
  lines.push(dim(`Defaults (inherited when an agent omits a field): ${view.defaults.coding_agent} · ${view.defaults.model}`));
  lines.push(dim('Change one: imp llm set <number|name> <model>   e.g. `imp llm set 1 fable` · `imp llm set builder grok-4.6 --effort high`'));
  lines.push(dim('Models: claude aliases sonnet|opus|haiku|fable · grok-4.6|grok-4.5 (Grok Build) · pi = provider/id · cursor ids need --engine cursor. Fallbacks/chains: /agents.'));
  lines.push(dim('One run only (roster untouched): node imp/fda_*.mjs … --llm "grok-4.6 high"  ·  --llm "builder=opus xhigh"'));
  return lines.join('\n');
}

function printResult(result) {
  console.log(
    `✔ ${result.name}: ${result.from.coding_agent} · ${result.from.model}  →  ${result.to.coding_agent} · ${result.to.model}`,
  );
  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  console.log(dim(`  Applies from the next run. Backup: ${result.backup}`));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  imp llm                      list the agents (interactive on a TTY)
  imp llm --json               machine-readable roster + engine status
  imp llm set <n|name> <model> [--engine ${CODING_AGENTS.join('|')}]
                               [--effort ${EFFORTS.join('|')}]   (grok: ${GROK_EFFORTS.join('|')})
                               [--thinking ${THINKING.join('|')}]
Models: sonnet|opus|haiku|fable (claude) · grok-4.6|grok-4.5 (grok) · provider/id (pi) · picker id + --engine cursor
One run only, roster untouched:  node imp/fda_*.mjs "<prompt>" --llm "grok-4.6 high"   ·   --llm "builder=opus xhigh"
Also: npm run llm · /llm inside Pi · visual editor with fallbacks: /agents`;

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--no-input') flags.noInput = true;
    else if (arg === '--engine' || arg === '--effort' || arg === '--thinking' || arg === '--config') flags[arg.slice(2)] = argv[++i];
    else positional.push(arg);
  }
  return { flags, positional };
}

export async function runCli(argv, { root = process.cwd() } = {}) {
  const { flags, positional } = parseArgv(argv);
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const configPath = resolve(root, flags.config || DEFAULT_CONFIG);

  if (positional[0] === 'set') {
    try {
      const result = applyChange(
        { root, configPath },
        { agent: positional[1], target: positional.slice(2).join(' '), engine: flags.engine, effort: flags.effort, thinking: flags.thinking },
      );
      printResult(result);
      return 0;
    } catch (err) {
      console.error(`✖ ${err?.message || err}`);
      return 1;
    }
  }

  const view = rosterView(configPath);
  if (!view.available) {
    if (flags.json) {
      console.log(JSON.stringify({ available: false, config: configPath }));
      return 0;
    }
    console.error(`No FIA roster here (${configPath} not found or empty).`);
    console.error('Run `imp init` in your project folder first — or `npx impactus --update-runtime` on an older install.');
    return 1;
  }
  const engines = checkEngines();
  if (flags.json) {
    console.log(
      JSON.stringify({
        available: true,
        config: configPath,
        defaults: view.defaults,
        agents: view.agents.map((a) => ({ ...a, engine_issue: engineIssue(a, engines) })),
        engines,
        efforts: EFFORTS,
        grok_efforts: GROK_EFFORTS,
        grok_models: engines.grok?.installed ? grokModels() : null,
        thinking_levels: THINKING,
        coding_agents: CODING_AGENTS,
      }),
    );
    return 0;
  }
  console.log(renderList(view, engines));

  // Interactive loop — TTY only: pick by number/name, type the new model,
  // Enter on an empty answer finishes. Non-TTY (pipes, agents) never blocks.
  if (flags.noInput || positional.length > 0 || !process.stdin.isTTY || !process.stdout.isTTY) return 0;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      console.log('');
      const who = (await rl.question('Change which agent? (number or name — Enter to finish) ')).trim();
      if (!who) return 0;
      let entry;
      try {
        entry = pickAgent(rosterView(configPath).agents, who);
      } catch (err) {
        console.error(`✖ ${err.message}`);
        continue;
      }
      const target = (
        await rl.question(
          `New LLM for ${entry.name} (current: ${entry.coding_agent} · ${entry.model}) — e.g. fable, opus, grok-4.6, openai-codex/gpt-5.6-sol, "cursor <id>": `,
        )
      ).trim();
      if (!target) continue;
      try {
        printResult(applyChange({ root, configPath }, { agent: entry.name, target }));
      } catch (err) {
        console.error(`✖ ${err?.message || err}`);
      }
    }
  } finally {
    rl.close();
  }
}

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
