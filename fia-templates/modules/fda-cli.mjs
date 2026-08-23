import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig, validate } from './agents.mjs';
import { ensure } from './session.mjs';
import { classifyFailure, outcomeIsSuccess, outcomeLabel } from './outcome.mjs';
import { resolvePrompt } from './utils.mjs';

export function parseFdaArgs(argv, { agentDefault } = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', default: 'imp/fia.config.yaml' },
      'fda-id': { type: 'string' },
      resume: { type: 'boolean', default: false },
      'retry-unchanged': { type: 'boolean', default: false },
      agent: { type: 'string', default: agentDefault },
      debug: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log('Usage: node imp/fda_*.mjs "<prompt>" [--config imp/fia.config.yaml] [--fda-id id] [--resume] [--debug]');
    console.log('  --resume  with --fda-id: skip phases that already succeeded in that run (reuses saved results).');
    console.log('            The prompt may be omitted — the one saved with the original run is reused.');
    console.log('  --retry-unchanged  with --resume: override the unchanged-tree guard (a failed run');
    console.log('            whose tree has not moved is otherwise refused — re-running cannot pass).');
    console.log('  --debug   print the full technical stack trace when a run fails');
    console.log('  Agent phases get 1 automatic correction round by default when a gate fails (retries: 1).');
    process.exit(0);
  }
  const promptArg = positionals.join(' ').trim();
  if (values.resume && !values['fda-id']) {
    console.error('--resume requires --fda-id <id> of the failed run (see `npm run fda:sessions`)');
    process.exit(1);
  }
  // On resume the prompt is optional: runFda() reloads the one saved in the trace.
  if (!promptArg && !(values.resume && values['fda-id'])) {
    console.error('Missing prompt argument');
    process.exit(1);
  }
  return {
    prompt: promptArg,
    config: values.config,
    fdaId: values['fda-id'] || null,
    resume: values.resume,
    retryUnchanged: values['retry-unchanged'],
    agent: values.agent,
    debug: values.debug,
  };
}

export function phaseParams(name, kind, owner, description, extra = {}) {
  if (!description || description.trim().toLowerCase() === name.replace(/_/g, ' ')) {
    throw new Error(`phase ${name}: description is required and must explain intent`);
  }
  // Agent phases get one automatic correction round by default: a failed gate
  // is re-prompted once before the run fails. Code/engineer phases get none.
  return { name, kind, owner, description, retries: kind === 'agent' ? 1 : 0, ...extra };
}

/** The prompt saved with the original run (sessions.request), for --resume. */
function savedRequest(cfg, fdaId) {
  const dbPath = cfg.observability?.db || `${cfg.defaults?.data_dir || 'imp/data'}/fia.db`;
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT request FROM sessions WHERE fda_id=?').get(fdaId);
    db.close();
    return row?.request || '';
  } catch {
    return '';
  }
}

/**
 * Fire the opt-in end-of-run notification. Awaited HERE and nowhere else: both
 * exits below are `process.exit`, which truncates pending async work, and a
 * `process.on('exit')` handler could never finish an HTTP request. Exactly one
 * call per termination path, so the notification cannot be sent twice.
 * `notifyRunEnd` never throws — the try/catch only guards the import itself.
 */
async function announceRunEnd(run, cfg) {
  if (!run) return;
  try {
    const { notifyRunEnd } = await import('./notify.mjs');
    await notifyRunEnd(
      {
        event: 'run_end',
        fdaId: run.fdaId,
        outcome: run.outcome,
        reason: run.outcomeReason,
        accepted: run.outcome ? outcomeIsSuccess(run.outcome) : false,
        tokens: run.tokens,
        cost: run.cost,
        durationSeconds: run.startedAtMs ? (Date.now() - run.startedAtMs) / 1000 : null,
        project: basename(run.repoRoot || process.cwd()),
      },
      { project: cfg?.notify },
    );
  } catch {
    /* notifications are a courtesy — never let one affect the run's exit */
  }
}

/**
 * Shared prologue + error boundary for every fda_*.mjs script: parse args, load
 * and validate the config, ensure the session, then run `main`. Any failure is
 * reported as a short human message (reason + fda_id + the exact resume
 * command) instead of a raw stack trace — the stack only shows with --debug.
 *
 * `main({ run, cfg, prompt, args })` must return the process exit code
 * (usually `run.finish(...)`).
 */
export async function runFda(main, { agents = [], agentDefault } = {}) {
  const script = basename(process.argv[1] || 'fda.mjs');
  let args;
  try {
    args = parseFdaArgs(process.argv.slice(2), { agentDefault });
  } catch (error) {
    console.error(`Invalid arguments: ${String(error?.message || error)}`);
    console.error(`Run \`node imp/${script} --help\` to see the accepted options.`);
    process.exit(1);
  }
  let run = null;
  let cfg = null;
  try {
    cfg = loadConfig(args.config);
    if (!args.prompt && args.resume && args.fdaId) {
      args.prompt = savedRequest(cfg, args.fdaId);
      if (!args.prompt) {
        console.error(`No saved prompt found for run ${args.fdaId} — pass the prompt again:`);
        console.error(`  node imp/${script} "<prompt>" --fda-id ${args.fdaId} --resume`);
        process.exit(1);
      }
    }
    const required = typeof agents === 'function' ? agents(args) : agents;
    if (required.length) validate(cfg, required);
    run = ensure(cfg, args.fdaId, { resume: args.resume, retryUnchanged: args.retryUnchanged });
    // Surfaced on the run so gates deep in the phase flow (ui_verify) can
    // honor the same override without re-parsing argv.
    run.retryUnchanged = args.retryUnchanged;
    const prompt = resolvePrompt(args.prompt);
    const exitCode = await main({ run, cfg, prompt, args });
    await announceRunEnd(run, cfg);
    process.exit(exitCode ?? 0);
  } catch (error) {
    // Close the session here too. `runPhase`'s catch only sees a throw from
    // INSIDE a phase body; anything that fails between phases (entry-point glue
    // dereferencing a replayed result, a gate helper called outside runPhase)
    // would otherwise leave status='running', ended_at NULL, no outcome and no
    // run_end event — the eternal orphan the signal handler exists to prevent.
    // settle() is first-writer-wins, so this is a no-op on every path that
    // already settled (stop conditions and phase failures included).
    try {
      run?.settle(classifyFailure(error), String(error?.message || error).slice(0, 1000));
    } catch {
      /* the trace is unavailable — never let it mask the real failure below */
    }
    const fdaId = run?.fdaId || args.fdaId || null;
    // A stop condition is the policy working, not a crash: the run was already
    // settled with its named outcome before the throw, so it gets a calm panel
    // that points at the knob instead of a failure banner and a stack trace.
    if (error?.name === 'StopCondition') {
      console.error(`\n■ FIA run stopped: ${String(error.message || error)}`);
      console.error(`  Recorded outcome: ${outcomeLabel(error.outcome)} — nothing was lost.`);
      if (error.outcome === 'stopped_by_request') {
        console.error('  Disarm the stop button when you are ready:  imp stop --clear');
      } else {
        console.error('  Tune the limits in imp/fia.config.yaml under `stop:`.');
      }
      if (fdaId) console.error(`  Resume when you are ready:  node imp/${script} --fda-id ${fdaId} --resume`);
      await announceRunEnd(run, cfg);
      process.exit(1);
    }
    console.error(`\n✗ FIA run failed: ${String(error?.message || error)}`);
    if (fdaId) {
      console.error('  Nothing is lost — resume from the phase that failed with:');
      console.error(`    node imp/${script} --fda-id ${fdaId} --resume`);
    }
    if (args.debug || process.env.FIA_DEBUG) console.error(`\n${error?.stack || error}`);
    else console.error('  (add --debug to see the full technical stack trace)');
    await announceRunEnd(run, cfg);
    process.exit(1);
  }
}
