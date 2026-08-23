#!/usr/bin/env node
/**
 * Run verdicts — turn "it did not work, run it again" into a BOUNDED continuation.
 *
 * A run that closes without meeting its goal leaves everything it DID achieve on
 * disk: `--resume` already replays the phases that succeeded. What it cannot know
 * is what a human (or a reviewing agent) considers still missing — so a blind
 * resume either repeats accepted work or stops at the same wall. A verdict is
 * that judgement, written down:
 *
 *   node imp/scripts/verdict.mjs set r_9f3a1c --missing "the empty state is not handled" \
 *                                             --missing "no test covers the 403 path" --redo review
 *   node imp/scripts/fda_sdlc.mjs --fda-id r_9f3a1c --resume
 *
 * The resumed run then (a) re-executes the phases the verdict named, by removing
 * their saved results, and (b) hands EVERY agent phase the scope in writing, with
 * instructions not to re-open anything else. The verdict is consumed by that run:
 * a scope is a one-shot instruction, never a standing restriction.
 *
 * `--redo` names a PHASE OF THAT RUN, and the phase vocabulary is not shared
 * between FDAs (`review` exists in fda_sdlc, not in fda_plan_build_test) and is
 * counter-suffixed where a phase repeats (`test_1`, `fix_1`). `set` therefore
 * checks every name against the phases the run actually saved and refuses an
 * unknown one, printing the list — a name outside it drops nothing, so the
 * resume would replay the phase from disk while reporting success.
 *
 * Read-only except for `set` and `clear`, and both refuse while THAT run holds
 * the FDA lock — a verdict about a run still in progress is a guess.
 *
 * `set` also enforces the per-run RECOVERY BUDGET (VERDICT_SET_CAP): each run
 * gets that many verdicts ever, counted in a durable ledger that `clear` never
 * resets. The refusal is the STOP a goal-mode recovery loop cannot talk its
 * way past; granting more is a human act (delete the ledger file by hand).
 *
 * Usage:
 *   node imp/scripts/verdict.mjs set <fda_id> --missing "…" [--missing "…"]…
 *                                             [--redo <phase>]… [--note "…"] [--json]
 *   node imp/scripts/verdict.mjs show <fda_id> [--json]
 *   node imp/scripts/verdict.mjs clear <fda_id>
 *   (every subcommand also takes --dir <project root>, default the cwd)
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';
import {
  VERDICT_HISTORY_FILE,
  appendVerdictHistory,
  clearRunVerdict,
  readRunVerdict,
  readVerdictHistory,
  writeRunVerdict,
} from '../modules/continuation.mjs';
import { activeFdaLock } from './fda-lock.mjs';

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * Recovery budget: how many verdicts may ever be SET for one run. This is the
 * code-enforced ceiling behind goal mode's "recover while making progress"
 * rule — an agent that keeps naming new gaps gets this many bounded resumes,
 * then the run needs a human. The count lives in the run's verdict history
 * ledger, which `clear` never resets; granting more recoveries is a deliberate
 * human act (delete the ledger file), not a flag an agent can pass.
 */
export const VERDICT_SET_CAP = 4;

/** `defaults.data_dir` from the student's roster, or the shipped default. */
export function dataDirOf(root, configPath = 'imp/fia.config.yaml') {
  try {
    const cfg = parseYaml(readFileSync(join(root, configPath), 'utf8'));
    const declared = cfg?.defaults?.data_dir;
    if (typeof declared === 'string' && declared.trim()) return join(root, declared.trim());
  } catch {
    /* no roster, or an unreadable one — the default below is correct anyway */
  }
  return join(root, 'imp', 'data');
}

/** The run's recorded terminal outcome, or null (older db, or still running). */
export function outcomeOf(root, fdaId, dataDir = dataDirOf(root)) {
  const dbPath = process.env.FIA_DB ? resolve(process.env.FIA_DB) : join(dataDir, 'fia.db');
  if (!existsSync(dbPath)) return null;
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 2000');
    // The column only exists once a new Tracer has opened this db — probe, never
    // name it blindly, or an older project throws instead of answering "unknown".
    if (!db.pragma('table_info(sessions)').some((c) => c.name === 'outcome')) return null;
    return db.prepare('SELECT outcome FROM sessions WHERE fda_id=?').get(fdaId)?.outcome ?? null;
  } catch {
    return null; /* schema-less or locked db — an unknown outcome is not an error */
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing to close */
    }
  }
}

/**
 * The phases a `--redo` can actually re-run: one `<phase>.json` per phase whose
 * result the previous attempt saved. That file is EXACTLY what a resume deletes
 * (session.mjs), so a name outside this list drops nothing — the phase is
 * replayed from disk and the run closes at the same wall it closed at before.
 *
 * Returns [] when the run saved nothing (an early crash) — there is then no
 * name that would take effect, which is a different thing to say than "you
 * misspelled it". Never throws: a vanished session reads as [].
 */
export function savedPhases(sessionDir) {
  let entries = [];
  try {
    entries = readdirSync(join(sessionDir, 'phase_results'));
  } catch {
    /* no phase_results/ — nothing was saved, so nothing can be dropped */
  }
  return entries
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

function flagValues(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]);
  return out;
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 ? argv[i + 1] : undefined;
}

/**
 * @param {object|null} verdict
 * @param {string} fdaId
 * @param {{saved?: string[]|null}} opts `saved` = savedPhases() for this run, so
 *   the rendering can stop promising that a named phase "will be dropped" when
 *   no such saved result exists. Omitted → the promise is left unqualified.
 */
export function renderVerdict(verdict, fdaId, opts = {}) {
  const saved = Array.isArray(opts.saved) ? opts.saved : null;
  const drops = (phase) => !saved || saved.includes(phase);
  if (!verdict) {
    return [
      `No verdict recorded for run ${fdaId}.`,
      '',
      'A verdict narrows the next resume to the work that is actually missing:',
      `  node imp/scripts/verdict.mjs set ${fdaId} --missing "<what is still missing>"`,
    ].join('\n');
  }
  const lines = [
    `Verdict for run ${verdict.fda_id}`,
    `Recorded: ${verdict.at}${verdict.outcome ? `   ·   run ended as: ${verdict.outcome}` : ''}`,
    '',
    'Missing work:',
    ...verdict.missing.map((item, i) => `  ${i + 1}. ${item}`),
  ];
  if (verdict.note) lines.push('', `Note: ${verdict.note}`);
  lines.push('');
  if (!verdict.redo.length) {
    lines.push('No phase named — every phase that succeeded still replays.');
  } else {
    // Naming a phase whose result was never saved is a no-op. Rendering it as a
    // promise ("dropped on the next resume") is how a reviewer ends up believing
    // the work was re-executed when it was replayed from disk.
    lines.push(
      `Phases to re-run: ${verdict.redo.map((p) => (drops(p) ? p : `${p} (no saved result — nothing to drop)`)).join(', ')}`,
    );
    if (!verdict.redo.some(drops)) {
      lines.push(
        saved.length
          ? `None of those phases has a saved result, so the resume drops nothing. This run saved: ${saved.join(', ')}.`
          : 'This run saved no phase result at all — the resume drops nothing and every phase executes again.',
      );
    } else {
      lines.push('(the saved result of a named phase is dropped on the next resume, so it executes again)');
    }
  }
  lines.push(
    '',
    'Apply it:  node imp/<the same fda_*.mjs> --fda-id ' + verdict.fda_id + ' --resume',
    '(the verdict is consumed by that run — record a new one if it is still not done)',
  );
  return lines.join('\n');
}

export function main(argv) {
  const cmd = argv[0];
  const fdaId = argv[1];
  const json = argv.includes('--json');
  const root = resolve(flagValue(argv, '--dir') || process.cwd());

  if (!['set', 'show', 'clear'].includes(cmd) || !fdaId || fdaId.startsWith('--')) {
    console.error('Usage: node imp/scripts/verdict.mjs set|show|clear <fda_id> [--missing "…"]… [--redo <phase>]…');
    console.error('       [--note "…"] [--dir <project root>] [--json]');
    return 1;
  }
  if (!SAFE_ID.test(fdaId)) {
    console.error(`Invalid run id "${fdaId}" — letters, digits, - and _ only.`);
    return 1;
  }

  const dataDir = dataDirOf(root);
  const sessionDir = join(dataDir, 'sessions', fdaId);

  if (cmd === 'show') {
    const verdict = readRunVerdict(sessionDir);
    if (json) console.log(JSON.stringify(verdict, null, 2));
    else console.log(renderVerdict(verdict, fdaId, { saved: savedPhases(sessionDir) }));
    return 0;
  }

  // Writing about a run that is still going is a guess, not a verdict.
  const lock = activeFdaLock(root);
  if (lock && lock.fda_id === fdaId) {
    console.error(`Run ${fdaId} is still in progress (pid ${lock.pid}) — record the verdict once it has closed.`);
    return 1;
  }

  if (cmd === 'clear') {
    clearRunVerdict(sessionDir);
    if (json) console.log(JSON.stringify({ ok: true, cleared: fdaId }, null, 2));
    else console.log(`Verdict cleared for run ${fdaId} — the next resume is unrestricted again.`);
    return 0;
  }

  const missing = flagValues(argv, '--missing');
  if (!missing.length) {
    console.error('set requires at least one --missing "<what is still missing>" — that IS the scope.');
    return 1;
  }
  if (!existsSync(sessionDir)) {
    // Recording a verdict for a run whose session dir is gone would be written
    // where nothing reads it. Say so instead of silently succeeding.
    console.error(`No session on disk for run ${fdaId} (${join(dataDir, 'sessions', fdaId)}).`);
    console.error('Check the id with `npm run fda:sessions`.');
    return 1;
  }
  // A `--redo` name only does something when the previous attempt SAVED that
  // phase's result — that file is what the resume deletes. Phase ids are also
  // counter-suffixed (`test_1`, `fix_1`), and the FDAs do not share a phase
  // vocabulary, so an unchecked name is the normal outcome of copying an
  // example. Recording it would echo the name back, drop nothing, and let the
  // run repeat the accepted work while reporting success.
  const redo = flagValues(argv, '--redo');
  const saved = savedPhases(sessionDir);
  const unknown = redo.filter((p) => p.trim() && !saved.includes(p.trim()));
  if (unknown.length && saved.length) {
    console.error(
      `No saved result for phase(s) ${unknown.join(', ')} in run ${fdaId} — --redo would drop nothing and the phase would replay from disk.`,
    );
    console.error(`Phases this run saved: ${saved.join(', ')}.`);
    return 1;
  }
  if (redo.length && !saved.length) {
    console.error(
      `Note: run ${fdaId} saved no phase result, so --redo drops nothing — every phase executes again on the resume.`,
    );
  }

  // The recovery budget. Checked at set time — not at resume time — because the
  // set IS the recovery decision, and refusing here is what turns "never loop
  // forever" from a prompt instruction into a property of the system.
  const history = readVerdictHistory(sessionDir);
  if (history.length >= VERDICT_SET_CAP) {
    console.error(
      `Run ${fdaId} has spent its recovery budget: ${history.length}/${VERDICT_SET_CAP} verdicts already recorded.`,
    );
    console.error('This ceiling is enforced in code so a recovery loop can never run away on its own.');
    console.error('A human decides now: fix it by hand, skip the task, or split it into smaller tasks.');
    console.error(
      'The cheapest healthy path: convert the remaining gaps into a FOLLOW-UP task brief (task-sequencer) — ' +
        'a fresh run starts with small sessions and clean context, instead of re-resuming this one at full width.',
    );
    console.error(`To deliberately grant more recoveries, delete: ${join(sessionDir, VERDICT_HISTORY_FILE)}`);
    return 1;
  }

  mkdirSync(sessionDir, { recursive: true });
  const verdict = writeRunVerdict(sessionDir, {
    fda_id: fdaId,
    outcome: outcomeOf(root, fdaId, dataDir),
    missing,
    redo,
    note: flagValue(argv, '--note') || '',
  });
  const spent = appendVerdictHistory(sessionDir, verdict).length;
  if (json) console.log(JSON.stringify(verdict, null, 2));
  else {
    console.log(`Verdict recorded for run ${fdaId} — ${verdict.missing.length} item(s) of missing work.`);
    if (verdict.redo.length) console.log(`Phases to re-run: ${verdict.redo.join(', ')}`);
    console.log(`Recovery budget: ${spent}/${VERDICT_SET_CAP} used.`);
    console.log(`Apply it:  node imp/<the same fda_*.mjs> --fda-id ${fdaId} --resume`);
  }
  return 0;
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
if (isMain) process.exit(main(process.argv.slice(2)));
