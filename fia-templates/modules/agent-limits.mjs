/**
 * Adapter-side enforcement of per-send ceilings: a wall-clock timeout and a
 * token cut. Engines expose no native turn cap (`claude` and `pi` have no
 * --max-turns), so the harness enforces limits on the child process itself —
 * this is the ONLY place a runaway phase can be stopped while it is running.
 * SIGTERM first (the CLIs flush and exit), SIGKILL 10s later if it lingers.
 * The reason is reported as `terminated` on the adapter result; the agent
 * layer (agents.mjs doSend) classifies it — spend recorded so far is never
 * lost, because accounting happens before classification.
 */
const HARD_KILL_DELAY_MS = 10000;

export function armLimits(child, limits = {}) {
  let terminated = '';
  let softTimer = null;
  let hardTimer = null;
  const kill = (why) => {
    if (terminated) return;
    terminated = why;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, HARD_KILL_DELAY_MS);
    hardTimer.unref?.();
  };
  if (limits.timeoutMs > 0) {
    softTimer = setTimeout(() => kill('timeout'), limits.timeoutMs);
    softTimer.unref?.();
  }
  return {
    /** Called by the adapter as usage accumulates; cuts at the token ceiling. */
    noteTokens(total) {
      if (limits.maxTokens > 0 && total >= limits.maxTokens) kill('token_budget');
    },
    /** Called on child close: clears the timers, returns why it was cut ('' = it wasn't). */
    finish() {
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      return terminated;
    },
  };
}
