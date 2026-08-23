import { basename, join, resolve } from 'node:path';
import { readFileSync, writeFileSync, rmSync, mkdirSync, linkSync, renameSync } from 'node:fs';
import { Tracer } from './tracer.mjs';
import { Run } from './runner.mjs';
import { engineerName, newId, nowIso } from './utils.mjs';
import { resolveEngines } from './engines.mjs';
import {
  RECOVERY_CAP,
  appendResumeHistory,
  clearRunVerdict,
  readEngineErrors,
  readRunVerdict,
  recoveryLedger,
  relayModeOf,
  shouldArmFallback,
} from './continuation.mjs';
import { readFailureStamp, repoStamp } from './tree-guard.mjs';
import { manualStopState } from './stop.mjs';

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the pid EXISTS but belongs to another user — the run is alive
    // and the lock must hold (same rule as the reader, imp/scripts/
    // fda-lock.mjs); anything else (ESRCH) means dead.
    return err?.code === 'EPERM';
  }
}

/**
 * Best-effort single-run lock: two concurrent FDAs in the same repo would roll
 * back each other's writes through the permission gate. Acquisition is ATOMIC
 * and full-content: a complete temp file is hard-LINKED into place — link() is
 * create-exclusive AND exposes the finished JSON, so a competing reader can
 * never observe a half-written lock (a plain `wx` write opens the file empty
 * first, and an empty lock reads as stale). A stale lock (dead pid, or
 * unreadable) is stolen via an exclusive rename — only one contender's rename
 * succeeds; the loser retries and meets the winner's live lock. A live holder
 * aborts with the exact recovery command, and elapsed time alone never
 * discards a lock — only a dead pid does.
 */
export function acquireLock(dataDir, fdaId) {
  const lockPath = join(dataDir, '.fda.lock');
  // runner/started_at feed the read-only warning that interactive sessions
  // print while this run is alive (imp/scripts/fda-lock.mjs).
  const payload = JSON.stringify(
    { pid: process.pid, fda_id: fdaId, runner: basename(process.argv[1] || '', '.mjs'), started_at: nowIso() },
    null,
    2,
  );
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch {
    return; /* best-effort lock — never break the run over filesystem issues */
  }
  const readLock = () => {
    try {
      return JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      return null; // no lock, or unreadable
    }
  };
  const alreadyActive = (existing) =>
    new Error(
      `another FIA run is already active in this repository (fda_id ${existing.fda_id || 'unknown'}, pid ${existing.pid}).\n` +
        'Two runs at once would roll back each other\'s work. Wait for it to finish —\n' +
        'or, if you are sure nothing is running, remove the lock and try again:\n' +
        `  rm ${lockPath}`,
    );
  const tmp = `${lockPath}.${process.pid}.tmp`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(tmp, payload);
      linkSync(tmp, lockPath); // EEXIST when someone holds (or just took) the lock
      rmSync(tmp, { force: true });
      // Released on any exit (finish, error, or the runner's SIGINT/SIGTERM
      // handler, which exits via process.exit and therefore fires 'exit').
      process.once('exit', () => {
        try {
          const current = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (current?.pid === process.pid) rmSync(lockPath, { force: true });
        } catch {
          /* best effort */
        }
      });
      return;
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      // A live holder aborts REGARDLESS of what failed — the old pre-write
      // probe threw on EACCES-with-live-lock too, and degrading to "proceed"
      // here would start a second run alongside a real one.
      const existing = readLock();
      if (existing?.pid && existing.pid !== process.pid && pidAlive(existing.pid)) {
        throw alreadyActive(existing);
      }
      if (err?.code !== 'EEXIST') return; // true filesystem issue, no live holder → degrade
      // Stale (dead pid, or unreadable) — steal EXCLUSIVELY: rename can only
      // succeed for one contender, so two processes judging the same lock
      // stale can never both proceed to re-create it.
      try {
        const grave = `${lockPath}.stale-${process.pid}`;
        renameSync(lockPath, grave);
        rmSync(grave, { force: true });
      } catch {
        /* lost the steal race — the next attempt re-examines the new holder */
      }
    }
  }
  // Three create→examine→steal rounds without ever holding the lock: the path
  // is churning (another runner starting in lockstep, or a crash loop).
  // Returning silently would run with every reader-side guard down — abort.
  const existing = readLock();
  if (existing?.pid && existing.pid !== process.pid && pidAlive(existing.pid)) throw alreadyActive(existing);
  throw new Error(
    `could not acquire the FIA run lock (${lockPath} keeps changing hands).\n` +
      'Another run is probably starting at the same instant — wait a moment and retry;\n' +
      `if nothing is running, remove the lock and retry:  rm ${lockPath}`,
  );
}

export function ensure(cfg, fdaId = null, { resume = false, retryUnchanged = false } = {}) {
  if (resume && !fdaId) throw new Error('resume requires the fda_id of the failed run');
  const dataDir = cfg.defaults?.data_dir || 'imp/data';

  // The manual stop button is checked before ANYTHING else is read or written
  // (same rule as an in-flight run: stop.mjs fails closed on an unreadable
  // file). Starting a run past an armed stop would defeat the button's whole
  // point — being reachable from outside the run's own terminal.
  // `ensure()` runs before any Run exists; the FDA contract is that the
  // process cwd IS the repo root (Run sets repoRoot = process.cwd()), so it
  // doubles as the canonical-path anchor here.
  const manual = manualStopState(resolve(process.cwd(), dataDir), process.cwd());
  if (manual.stopped) {
    throw new Error(
      `a manual stop is armed for this repository (${manual.path})${manual.reason ? ` — ${manual.reason}` : ''}.\n` +
        'No FDA run starts while it is in place. Disarm it first:\n' +
        '  imp stop --clear      (or: npm run fda:stop -- --clear)',
    );
  }

  // A BARE resume of a FAILED run — no verdict recorded, no engine death to
  // recover from — is refused while the tree is provably identical to the one
  // that failed: re-running everything cannot end differently, and this exact
  // uncounted loop once re-ran 16 build cycles on a real project. Exemptions
  // are the legitimate recoveries: a pending verdict (bounded continuation),
  // an armed engine-death marker (relay), or the human's --retry-unchanged.
  // Every bare resume also spends the run's combined recovery budget, so the
  // verdict cap cannot be bypassed by resuming without one.
  if (resume && fdaId) {
    const sessionDir = join(dataDir, 'sessions', fdaId);
    const failure = readFailureStamp(sessionDir);
    const hasVerdict = Boolean(readRunVerdict(sessionDir));
    const engineDeath = Object.values(readEngineErrors(sessionDir)).some(shouldArmFallback);
    if (failure && !hasVerdict && !engineDeath) {
      const ledger = recoveryLedger(sessionDir);
      if (ledger.total >= RECOVERY_CAP) {
        throw new Error(
          `run ${fdaId} has spent its combined recovery budget: ${ledger.verdicts} verdict(s) + ${ledger.bareResumes} bare resume(s) >= ${RECOVERY_CAP}.\n` +
            'More resumes of THIS run would only repeat the loop. Convert what is still missing into a\n' +
            'follow-up task instead: have the task-sequencer write a NEW brief for the remaining gaps\n' +
            '(a fresh run starts with small sessions and clean context) — or fix the code by hand.',
        );
      }
      const stamp = repoStamp(process.cwd());
      const unchanged = Boolean(stamp && failure.stamp === stamp);
      if (unchanged && !retryUnchanged) {
        throw new Error(
          `nothing changed in the repository since run ${fdaId} failed (${failure.outcome}) — resuming would repeat the same failure.\n` +
            'Pick one:\n' +
            '  - fix the code by hand, then resume;\n' +
            '  - record what is missing so the resume is BOUNDED:  node imp/scripts/verdict.mjs set ' +
            `${fdaId} --missing "<gap>"\n` +
            '  - genuinely flaky failure? force it:  --retry-unchanged',
        );
      }
      appendResumeHistory(sessionDir, { at: nowIso(), bare: true, unchanged, overridden: unchanged && retryUnchanged });
    }
  }

  // Engine resolution happens before anything is traced: agents whose engine
  // is hard-unavailable fall back down their declared chain; an agent this
  // FDA requires (cfg._required, recorded by validate) with nothing available
  // is a fail-fast — better than dying mid-run inside a phase. On --resume,
  // the interrupted run's engine-failure markers count as unavailability too
  // (that engine already proved it cannot finish), so the resumed run keeps
  // moving on the fallbacks instead of dying on the same outage again.
  // A typo in defaults.relay must not silently become 'auto': say so once.
  const relayRaw = cfg.defaults?.relay;
  if (relayRaw !== undefined && relayRaw !== relayModeOf(cfg)) {
    console.log(`  ⚠ unknown relay mode "${relayRaw}" in imp/fia.config.yaml — using "auto" (valid: auto | resume | off)`);
  }

  // relay 'off' means the student owns every engine switch — the resumed run
  // must not walk the chain on its own either.
  const runtimeFailures = {};
  if (resume && fdaId && relayModeOf(cfg) !== 'off') {
    const markers = readEngineErrors(join(dataDir, 'sessions', fdaId));
    for (const [name, marker] of Object.entries(markers)) {
      if (shouldArmFallback(marker)) runtimeFailures[name] = marker;
    }
  }
  const { decisions } = resolveEngines(cfg, cfg._required || null, { runtimeFailures });
  const blocked = decisions.filter((d) => d.blocked && (cfg._required || []).includes(d.agent));
  if (blocked.length) {
    throw new Error(
      'no engine available for required agent(s):\n' +
        blocked.map((d) => `- ${d.agent}: ${d.reason}`).join('\n') +
        '\nFix the login/install above, or declare `fallbacks:` for the agent in imp/fia.config.yaml (see the Agents tab: npm run agents).',
    );
  }

  const id = fdaId || newId(8);
  acquireLock(dataDir, id);
  // Every child agent inherits this ({...process.env} in the engine spawns):
  // the session hooks and the Pi fda-lock extension stay silent inside the
  // run's own process tree — only OUTSIDE sessions get the read-only
  // warning/block while the lock is held.
  process.env.FIA_FDA_RUN = id;
  const db = cfg.observability?.db || `${dataDir}/fia.db`;
  const eventsJsonl = `${dataDir}/sessions/${id}/events.jsonl`;
  const tracer = new Tracer(db, eventsJsonl);
  const run = new Run(cfg, id, tracer, engineerName(), { resume });
  const scriptPath = process.argv[1] || '';
  tracer.sessionStart(id, run.engineer, basename(scriptPath, '.mjs'));

  // BOUNDED CONTINUATION. A verdict recorded after the previous attempt says what
  // is still MISSING; this run is narrowed to exactly that. The phases it names
  // have their saved results removed, so the ordinary resume rule ("no saved
  // result → execute") re-runs them — no special case in the replay predicate,
  // which is the part of the runner least safe to complicate. The verdict is
  // then consumed: a scope is a one-shot instruction, and leaving it would
  // re-narrow every later resume, including one meant to be unrestricted.
  if (resume) {
    const sessionDir = join(dataDir, 'sessions', id);
    const verdict = readRunVerdict(sessionDir);
    if (verdict) {
      run.verdict = verdict;
      // REQUESTED is not APPLIED. `verdict.mjs set` refuses a phase this run never
      // saved, but a verdict written straight through writeRunVerdict has no such
      // guard — and dropping nothing means the phase REPLAYS from disk while the
      // log says it was re-run. Record the two lists separately so the ledger
      // never claims work that did not happen.
      const redone = [];
      const skipped = [];
      for (const phase of verdict.redo) {
        if (!/^[A-Za-z0-9_-]+$/.test(phase)) {
          skipped.push(phase); // never let a verdict name a path
          continue;
        }
        try {
          rmSync(join(sessionDir, 'phase_results', `${phase}.json`));
          redone.push(phase);
        } catch {
          skipped.push(phase); // nothing saved for it — the phase replays as it was
        }
      }
      run.console.note(
        `bounded continuation: ${verdict.missing.length} item(s) of missing work` +
          (redone.length ? `, re-running ${redone.join(', ')}` : '') +
          (skipped.length ? `, ${skipped.join(', ')} had no saved result (nothing dropped)` : ''),
      );
      tracer.event({
        fda_id: id,
        phase_id: '',
        type: 'log',
        name: 'bounded_continuation',
        payload: {
          missing: verdict.missing,
          redo: redone,
          redo_requested: verdict.redo,
          redo_skipped: skipped,
          outcome: verdict.outcome ?? null,
        },
      });
      clearRunVerdict(sessionDir);
    }
  }
  tracer.processStart(id, 'fda', '', process.pid, process.argv.join(' '));
  run.console.sessionStarted(id, run.engineer);
  for (const d of decisions) {
    if (d.changed) {
      run.console.engineFallback(d.agent, d.from, d.to, d.reason);
      tracer.event({
        fda_id: id,
        type: 'engine_fallback',
        name: d.agent,
        payload: { from: d.from, to: d.to, reason: d.reason, ...(d.runtime ? { runtime: true, kind: d.kind } : {}) },
      });
    }
    // Runtime-only failure with no viable fallback: the resumed run retries
    // the engine the student chose — say so out loud instead of dying at the
    // door (limits reset, outages end).
    if (d.retry_failed_engine) {
      run.console.engineRetry(d.agent, `${d.reason} and no fallback is available — retrying it`);
      tracer.event({
        fda_id: id,
        type: 'log',
        name: 'engine_retry_after_failure',
        payload: { agent: d.agent, reason: d.reason, kind: d.kind },
      });
    }
    // Loud, non-blocking warning: this engine bills per token via an API key,
    // OUTSIDE any subscription. FIA never requires this setup.
    if (d.api_key_provider) {
      console.log(
        `\n  ⚠⚠ WARNING: agent "${d.agent}" runs on Pi provider "${d.api_key_provider}" through an API key.\n` +
          '     Every token is billed to that key — this is OUTSIDE your Claude/Codex subscription.\n' +
          '     To stay inside a subscription, switch this agent to claude_code or openai-codex\n' +
          '     in imp/fia.config.yaml (visual editor: npm run agents). The run continues anyway.\n',
      );
      tracer.event({
        fda_id: id,
        type: 'log',
        name: 'api_key_billing_warning',
        payload: { agent: d.agent, provider: d.api_key_provider },
      });
    }
  }
  if (!fdaId) console.log(`fda_id: ${id}`);
  return run;
}

export { Run };
