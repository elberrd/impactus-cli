/**
 * Terminal outcomes for an FDA run — the NAMED reason a run stopped.
 *
 * A run used to end as a boolean (`success` / `fail`) and the human reason
 * survived only as a console line. This module is the single vocabulary shared
 * by the writer (runner.mjs, when it settles a run) and every reader (the
 * trace, fia-query, the TUI). One module so a new outcome can never be spelled
 * two ways.
 *
 * NOTE ON CLASSIFICATION: this module deliberately imports nothing from
 * agents.mjs / permissions.mjs — those import the runner, so importing their
 * error classes here would close a cycle. `classifyFailure` therefore duck
 * types on the error instead of using `instanceof`.
 */

export const OUTCOMES = Object.freeze({
  GOAL_MET: 'goal_met',
  VERIFICATION_FAILED: 'verification_failed',
  ATTEMPT_CAP: 'attempt_cap',
  NO_PROGRESS: 'no_progress',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  BREADTH_EXCEEDED: 'breadth_exceeded',
  BLOCKED_BY_GATE: 'blocked_by_gate',
  ENGINE_EXHAUSTED: 'engine_exhausted',
  STOPPED_BY_REQUEST: 'stopped_by_request',
  ABORTED: 'aborted',
  FAILED: 'failed',
});

/** Every terminal outcome, in a stable order (worst-to-vaguest after success). */
export const TERMINAL_OUTCOMES = Object.freeze([
  OUTCOMES.GOAL_MET,
  OUTCOMES.VERIFICATION_FAILED,
  OUTCOMES.ATTEMPT_CAP,
  OUTCOMES.NO_PROGRESS,
  OUTCOMES.BUDGET_EXHAUSTED,
  OUTCOMES.BREADTH_EXCEEDED,
  OUTCOMES.BLOCKED_BY_GATE,
  OUTCOMES.ENGINE_EXHAUSTED,
  OUTCOMES.STOPPED_BY_REQUEST,
  OUTCOMES.ABORTED,
  OUTCOMES.FAILED,
]);

const LABELS = Object.freeze({
  [OUTCOMES.GOAL_MET]: 'goal met',
  [OUTCOMES.VERIFICATION_FAILED]: 'verification failed',
  [OUTCOMES.ATTEMPT_CAP]: 'attempt cap reached',
  [OUTCOMES.NO_PROGRESS]: 'no progress',
  [OUTCOMES.BUDGET_EXHAUSTED]: 'budget exhausted (time or tokens)',
  [OUTCOMES.BREADTH_EXCEEDED]: 'change breadth exceeded',
  [OUTCOMES.BLOCKED_BY_GATE]: 'blocked by a gate',
  [OUTCOMES.ENGINE_EXHAUSTED]: 'engines exhausted',
  [OUTCOMES.STOPPED_BY_REQUEST]: 'stopped by request',
  [OUTCOMES.ABORTED]: 'aborted',
  [OUTCOMES.FAILED]: 'failed',
});

/** Is this value one of the known terminal outcomes? */
export function isTerminalOutcome(value) {
  return typeof value === 'string' && TERMINAL_OUTCOMES.includes(value);
}

/** A short English label for a student-facing line. Unknown values degrade. */
export function outcomeLabel(outcome) {
  return LABELS[outcome] || 'unknown outcome';
}

/** Only `goal_met` means the run did what it was asked to do. */
export function outcomeIsSuccess(outcome) {
  return outcome === OUTCOMES.GOAL_MET;
}

/**
 * The terminal outcome an in-flight error stands for. Duck typed on purpose:
 * `GateFailure`, `PermissionBreach` and `EngineFailure` are declared as
 * `class X extends Error {}`, so `error.name` is the INHERITED 'Error' — the
 * class name only shows up on `error.constructor.name`. Both are checked, and
 * an error that already carries an `outcome` (StopCondition) wins outright.
 */
export function classifyFailure(error) {
  if (isTerminalOutcome(error?.outcome)) return error.outcome;
  const names = [error?.name, error?.constructor?.name];
  if (names.includes('GateFailure') || names.includes('PermissionBreach')) return OUTCOMES.BLOCKED_BY_GATE;
  if (names.includes('EngineFailure')) return OUTCOMES.ENGINE_EXHAUSTED;
  return OUTCOMES.FAILED;
}
