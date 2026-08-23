import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as fs from 'node:fs';
import { createConsole } from './console.mjs';
import { execute } from './agents.mjs';
import { loadOrCreateBaseline, runChangedPaths } from './git-helper.mjs';
import { nowIso } from './utils.mjs';
import { stopPolicyOf, StopCondition, manualStopState } from './stop.mjs';
import { clearFailureStamp, repoStamp, writeFailureStamp } from './tree-guard.mjs';
import { OUTCOMES, classifyFailure, isTerminalOutcome, outcomeIsSuccess } from './outcome.mjs';

/** The fda_*.mjs that is running, for the recovery lines finish() prints. */
function scriptName() {
  return basename(process.argv[1] || 'fda.mjs');
}

export class PhaseHandle {
  constructor(run, phase) {
    this.run = run;
    this.phase = phase;
  }

  log(payload) {
    this.run.tracer.event({
      fda_id: this.run.fdaId,
      phase_id: this.phase.phase_id,
      type: 'log',
      name: this.phase.params.name,
      payload,
    });
    this.run.console.note(Object.entries(payload).map(([k, v]) => `${k}: ${v}`).join(', '));
    if (this.phase.params.kind === 'engineer' && payload.input) {
      this.run.tracer.sessionRequest(this.run.fdaId, String(payload.input));
    }
  }

  call(call) {
    if (this.phase.params.kind !== 'agent') {
      throw new Error('ph.call() is only valid inside an agent phase');
    }
    return execute(this.run, this.phase, call);
  }
}

// One process-level handler: Ctrl+C / kill closes the session with the named
// `aborted` outcome in the trace (no eternal 'running' orphans) and exits with
// the conventional code. Everything in here must stay SYNCHRONOUS — only sync
// writes survive a signal handler.
let activeRun = null;
let signalsInstalled = false;
function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      try {
        activeRun?.settle(OUTCOMES.ABORTED, 'the run was interrupted by a signal');
      } catch {
        /* best effort — the exit must not be blocked */
      }
      process.exit(code);
    });
  }
}

export class Run {
  constructor(cfg, fdaId, tracer, engineer, { resume = false } = {}) {
    this.cfg = cfg;
    this.fdaId = fdaId;
    this.tracer = tracer;
    this.console = createConsole(tracer, fdaId);
    this.engineer = engineer;
    this.resume = resume;
    this.phases = [];
    this.tokens = 0;
    this.cost = 0;
    this._seq = tracer.maxPhaseSeq(fdaId);
    this.repoRoot = process.cwd();
    this.fs = fs;
    this.env = { ...process.env };
    this.sessionDir = join(cfg.defaults?.data_dir || 'imp/data', 'sessions', fdaId);
    fs.mkdirSync(this.sessionDir, { recursive: true });
    this.contextHandoffDir = join(this.sessionDir, 'context_handoff');
    fs.mkdirSync(this.contextHandoffDir, { recursive: true });
    this._agentMapPath = join(this.sessionDir, 'agent_map.json');
    this.agentMap = existsSync(this._agentMapPath)
      ? JSON.parse(readFileSync(this._agentMapPath, 'utf8'))
      : {};
    this.phaseResultsDir = join(this.sessionDir, 'phase_results');
    fs.mkdirSync(this.phaseResultsDir, { recursive: true });
    // Pre-flight photo of the working tree (content fingerprint per dirty
    // path), persisted with the session and reloaded on --resume. The commit
    // phases diff against it so pre-existing dirt — docs and WIP another
    // session left behind — never gets swept into a FIA commit.
    this.baseline = loadOrCreateBaseline(this.sessionDir, this.repoRoot);
    this.replayed = 0;
    // Set by ensure() when a resumed run carries a verdict (see continuation.mjs):
    // the scope of a BOUNDED continuation, handed to every agent phase.
    this.verdict = null;
    // Deterministic stop conditions + the named terminal outcome. `settled`
    // makes closing the run first-writer-wins: the precise reason (a stop
    // condition, a gate, a signal) must never be overwritten by the vaguer
    // one that follows it up the stack.
    this.stop = stopPolicyOf(cfg);
    // Lifetime spend across ALL attempts of this fda_id: the token budget is a
    // RUN-lifetime ceiling, so a resume must not reset the meter (that reset
    // is exactly how a real run re-burned 8 identical expensive rounds).
    // Fails open — an unreadable session row reads as 0.
    this.tokensBaseline = resume ? tracer.sessionTokens(fdaId) : 0;
    this._budgetWarned = new Set();
    this.startedAtMs = Date.now();
    this.settled = false;
    this.outcome = null;
    this.outcomeReason = '';
    for (const warning of this.stop.warnings) this.console.note(warning);
    activeRun = this;
    installSignalHandlers();
  }

  /**
   * Close the run with a NAMED terminal outcome — FIRST WRITER WINS. Returns
   * the stored outcome, so a later caller can still report what the run
   * actually ended as. Trace writes are best-effort: a failed write must never
   * mask the real failure that is on its way up the stack.
   */
  settle(outcome, reason = '') {
    if (this.settled) return this.outcome;
    this.settled = true;
    this.outcome = outcome;
    this.outcomeReason = String(reason || '');
    const accepted = outcomeIsSuccess(outcome);
    // The tree fingerprint of a FAILED run: session.ensure() refuses a bare
    // --resume while the tree has not moved (re-running is provably futile).
    // Deliberate pauses are exempt — a manual stop or a spent budget resumes
    // legitimately unchanged (the human raises the knob / disarms the button),
    // and an aborted run may have died before the tree tells the story.
    const NO_STAMP = new Set([OUTCOMES.STOPPED_BY_REQUEST, OUTCOMES.ABORTED, OUTCOMES.BUDGET_EXHAUSTED]);
    if (accepted) clearFailureStamp(this.sessionDir);
    else if (!NO_STAMP.has(outcome)) writeFailureStamp(this.sessionDir, { stamp: repoStamp(this.repoRoot), outcome });
    try {
      this.tracer.event({
        fda_id: this.fdaId,
        phase_id: this.phases.at(-1)?.phase_id || '',
        type: 'run_end',
        name: outcome,
        payload: {
          outcome,
          reason: this.outcomeReason,
          accepted,
          phases: this.phases.length,
          replayed: this.replayed,
          tokens: this.tokens,
          cost: this.cost,
        },
      });
    } catch {
      /* trace unavailable — the session row below is what readers rely on */
    }
    try {
      this.tracer.sessionFinish(this.fdaId, accepted, { outcome, reason: this.outcomeReason });
    } catch {
      /* trace unavailable — never mask the failure being reported */
    }
    return this.outcome;
  }

  /**
   * The two RUN-level stop conditions, both free to evaluate. Checked before a
   * phase is created so a stopped run never leaves a half-started phase in the
   * trace; settled here because the throw happens outside runPhase's catch.
   */
  #enforceStopConditions() {
    let stop = null;
    // The manual stop button is checked FIRST: an explicit human request
    // outranks every automatic limit. Reading it fails closed (see stop.mjs) —
    // an unreadable stop file stops the run too. Both paths are resolved
    // against THIS run's repo, never the process cwd, and the canonical
    // imp/data location is checked even when data_dir was moved.
    const manual = manualStopState(
      resolve(this.repoRoot, this.cfg.defaults?.data_dir || 'imp/data'),
      this.repoRoot,
    );
    if (manual.stopped) {
      stop = new StopCondition(
        OUTCOMES.STOPPED_BY_REQUEST,
        `a manual stop is armed (${manual.path})${manual.reason ? ` — ${manual.reason}` : ''} — ` +
          'stopping before the next phase; nothing is lost',
      );
    }
    if (!stop && this.stop.budget_minutes > 0) {
      const elapsed = (Date.now() - this.startedAtMs) / 60000;
      if (elapsed >= this.stop.budget_minutes) {
        stop = new StopCondition(
          OUTCOMES.BUDGET_EXHAUSTED,
          `the time budget of ${this.stop.budget_minutes} minute(s) is used up (${elapsed.toFixed(1)} minutes elapsed) — ` +
            'stopping instead of spending more of your plan',
        );
      }
    }
    if (!stop && this.stop.token_budget > 0 && this.lifetimeTokens() >= this.stop.token_budget) {
      stop = new StopCondition(OUTCOMES.BUDGET_EXHAUSTED, this.#tokenBudgetMessage());
    }
    if (!stop && this.stop.breadth_ceiling > 0) {
      const changed = runChangedPaths(this.repoRoot, this.baseline).length;
      if (changed > this.stop.breadth_ceiling) {
        stop = new StopCondition(
          OUTCOMES.BREADTH_EXCEEDED,
          `this run has already changed ${changed} file(s), over the breadth ceiling of ${this.stop.breadth_ceiling} — ` +
            'stopping before the change spreads any further',
        );
      }
    }
    if (!stop) return;
    this.settle(stop.outcome, stop.message);
    throw stop;
  }

  saveAgentMap(agent, entry) {
    this.agentMap[agent] = entry;
    writeFileSync(this._agentMapPath, JSON.stringify(this.agentMap, null, 2));
  }

  /** Tokens spent across every attempt of this run, this process included. */
  lifetimeTokens() {
    return this.tokensBaseline + this.tokens;
  }

  #tokenBudgetMessage() {
    return (
      `the token budget of ${this.stop.token_budget} is used up ` +
      `(${this.lifetimeTokens()} spent across all attempts of this run) — ` +
      'stopping instead of spending more of your plan'
    );
  }

  /**
   * Token ceilings, checked BETWEEN SENDS by the agent layer (doSend) — the
   * between-phase check alone cannot stop a phase that is already running
   * away (a real project recorded a single 36M-token phase). Throws a
   * StopCondition, settled here so the precise reason survives the stack.
   * Warnings at 50% and 80% of the run budget print once each.
   */
  checkTokenBudget({ phaseTokens = 0 } = {}) {
    if (this.stop.token_budget > 0) {
      const spent = this.lifetimeTokens();
      for (const pct of [50, 80]) {
        if (spent >= (this.stop.token_budget * pct) / 100 && !this._budgetWarned.has(pct)) {
          this._budgetWarned.add(pct);
          this.console.note(`token budget: ${spent} of ${this.stop.token_budget} spent (past ${pct}%)`);
          try {
            this.tracer.event({
              fda_id: this.fdaId,
              phase_id: this.phases.at(-1)?.phase_id || '',
              type: 'log',
              name: 'budget_warning',
              payload: { spent, budget: this.stop.token_budget, pct },
            });
          } catch {
            /* tracing must never block the run */
          }
        }
      }
      if (spent >= this.stop.token_budget) {
        const stop = new StopCondition(OUTCOMES.BUDGET_EXHAUSTED, this.#tokenBudgetMessage());
        this.settle(stop.outcome, stop.message);
        throw stop;
      }
    }
    if (this.stop.phase_token_budget > 0 && phaseTokens >= this.stop.phase_token_budget) {
      const stop = new StopCondition(
        OUTCOMES.BUDGET_EXHAUSTED,
        `this phase alone spent ${phaseTokens} tokens, at or over the per-phase budget of ` +
          `${this.stop.phase_token_budget} — stopping instead of letting one phase spend the whole plan`,
      );
      this.settle(stop.outcome, stop.message);
      throw stop;
    }
  }

  addUsage(tokens, cost) {
    this.tokens += tokens;
    this.cost += cost;
    this.tracer.sessionAddUsage(this.fdaId, tokens, cost);
  }

  async runPhase(params, fn) {
    // Resume: a phase that already succeeded in this fda_id is not re-executed —
    // its persisted result is replayed so later phases see the same inputs.
    // EXCEPT kind 'code' (tests, commits): those verify the CURRENT tree and
    // always re-run — replaying a saved failed suite result would be a no-op.
    // A phase declared `replay: false` re-runs too: a verdict about the
    // CURRENT tree (ui_verify) must never be replayed from before a hand-fix,
    // or a failed gate becomes a permanent dead end on --resume.
    const resultFile = join(this.phaseResultsDir, `${params.name}.json`);
    if (this.resume && params.kind !== 'code' && params.replay !== false && existsSync(resultFile)) {
      const saved = JSON.parse(readFileSync(resultFile, 'utf8'));
      this.tracer.event({
        fda_id: this.fdaId,
        phase_id: '',
        type: 'log',
        name: `${params.name}: reused (resume)`,
        payload: { resumed: true },
      });
      this.console.note(`phase ${params.name}: reused from the previous run (resume)`);
      this.replayed += 1;
      return saved.result;
    }
    // A replayed phase costs nothing, so the run-level limits are only checked
    // for phases that are about to actually execute (the branch above returns).
    this.#enforceStopConditions();
    this._seq += 1;
    const phase = {
      phase_id: `${this.fdaId}_${String(this._seq).padStart(2, '0')}_${params.name}`,
      fda_id: this.fdaId,
      seq: this._seq,
      params,
      status: 'running',
      attempt: 0,
      error: null,
      started_at: nowIso(),
      ended_at: null,
    };
    this.phases.push(phase);
    this.tracer.phaseUpsert(phase);
    this.tracer.event({
      fda_id: this.fdaId,
      phase_id: phase.phase_id,
      type: 'phase_start',
      name: params.name,
      payload: { kind: params.kind, owner: params.owner, description: params.description },
    });
    this.console.phaseStarted(phase);
    const t0 = Date.now();
    const handle = new PhaseHandle(this, phase);
    try {
      const result = await fn(handle);
      try {
        writeFileSync(resultFile, JSON.stringify({ status: 'success', result: result ?? null }, null, 2));
      } catch {
        /* non-serializable result — phase will simply re-run on resume */
      }
      phase.status = 'success';
      phase.ended_at = nowIso();
      this.tracer.phaseUpsert(phase);
      this.tracer.event({
        fda_id: this.fdaId,
        phase_id: phase.phase_id,
        type: 'phase_end',
        name: params.name,
        payload: { status: 'success' },
      });
      this.console.phaseEnded(phase, (Date.now() - t0) / 1000);
      return result;
    } catch (error) {
      phase.status = 'fail';
      phase.error = String(error.message || error).slice(0, 1000);
      phase.ended_at = nowIso();
      this.tracer.phaseUpsert(phase);
      this.tracer.event({
        fda_id: this.fdaId,
        phase_id: phase.phase_id,
        type: 'error',
        name: params.name,
        payload: { error: phase.error },
      });
      const outcome = this.settle(classifyFailure(error), phase.error);
      this.console.phaseEnded(phase, (Date.now() - t0) / 1000);
      this.console.sessionFinished(false, this.tokens, this.cost, this.cfg.observability?.db, outcome);
      throw error;
    }
  }

  finish({ accepted = true, reason = '', outcome = null } = {}) {
    // Replayed phases count as successful work: a resumed run where everything
    // was reused (and nothing newly executed failed) is still a success.
    const phasesOk =
      this.phases.length + this.replayed > 0 && this.phases.every((p) => p.status === 'success');
    const ok = phasesOk && accepted;
    if (phasesOk && !accepted) {
      const note = reason || 'the run acceptance criterion was not met';
      this.tracer.event({
        fda_id: this.fdaId,
        phase_id: this.phases.at(-1)?.phase_id || '',
        type: 'error',
        name: 'not_accepted',
        payload: { reason: note },
      });
      this.console.note(`not accepted: ${note}`);
    }
    // The caller names the outcome when it knows it precisely (attempt cap, no
    // progress…); otherwise it is derived. Settling is first-writer-wins, so a
    // run already closed by a stop condition or a signal keeps that reason.
    const resolved = isTerminalOutcome(outcome)
      ? outcome
      : ok
        ? OUTCOMES.GOAL_MET
        : OUTCOMES.VERIFICATION_FAILED;
    // `reason` is BY CONSTRUCTION the not-accepted explanation — every caller
    // writes it as the sentence for the failure branch (the block above only
    // prints it when !accepted). Storing it on a green run made the trace, the
    // viewer tooltip and the Slack ping all say "suite failed after 3 fix
    // attempt(s)" next to `accepted: yes`.
    const settled = this.settle(resolved, ok ? '' : reason);
    this.console.sessionFinished(ok, this.tokens, this.cost, this.cfg.observability?.db, settled);
    // A run that closed WITHOUT meeting its goal has to say what to do next.
    // Only the exception paths used to (the generic catch and the StopCondition
    // panel in fda-cli.mjs), so the three outcomes a red suite actually produces
    // — verification_failed, attempt_cap, no_progress — ended the session with a
    // bare banner and an fda_id that had scrolled off the top of the run.
    if (!ok) this.console.recoveryRoutes(this.fdaId, settled, scriptName());
    return ok ? 0 : 1;
  }
}
