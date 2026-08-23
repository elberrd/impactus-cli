# Run FDA

Never implement in place of an FDA. Launch and observe.

```bash
node imp/fda_scout.mjs "map auth flow"
node imp/fda_plan.mjs "add /health endpoint"
node imp/fda_plan_build_test.mjs "implement the plan" --fda-id <id from plan run>
node imp/fda_build_test.mjs "brief is already autocontained — skip planner"
node imp/fda_sdlc.mjs "full feature from ai-docs issue"   # planner auto-skips on self-contained briefs; review only on green suites; docs drain per milestone (sdlc: block)
node imp/fda_prototype.mjs ai-docs/actual-todo/<brief-with-Mode-prototype>.md
```

`fda_prototype` refuses prompts without an exact top-level `Mode: prototype`
line. That marker is the deliberate authorization to skip tests and review;
`/task` and `/goal` select the runner from it automatically.

Watch:

```bash
npm run fda:sessions
npm run fda:phases -- <fda_id>
npm run fda:tail -- <fda_id>
```

## How a run ended, and when it stops itself

Every run closes with ONE named outcome (`goal_met`, `verification_failed`,
`attempt_cap`, `no_progress`, `budget_exhausted`, `breadth_exceeded`,
`blocked_by_gate`, `engine_exhausted`, `stopped_by_request`, `aborted`, `failed`) — printed in the end
banner, stored on the session and shown by `npm run fda:sessions`. Report it to
the engineer verbatim; only `goal_met` is success. Full table: cookbook
`observability.md`.

Two of them are the run stopping ITSELF rather than failing, and they are good
news, not a defect:

- `no_progress` — a repair round changed nothing in the tree and the same checks
  kept failing (`stop.no_progress_window`, default 2 rounds). The comparison is
  content-based, so a repair that edited the same file again counts as progress,
  and a round whose repair was REPLAYED on `--resume` never counts at all. The
  run is genuinely stuck; more rounds would only spend the engineer's plan. Tell
  them WHAT kept failing and hand the decision back — do not re-run blindly.
- `attempt_cap` — the loop spent its `stop.attempt_cap` rounds (default 3) with
  the suite still red.

`breadth_exceeded` and the wall-clock `budget_minutes` are off by default. The
TOKEN budgets ship ON with generous room: `stop.token_budget` (30M for the run
lifetime, resumes included — warned at 50%/80%) and `stop.phase_token_budget`
(8M for one phase, cut mid-send), plus `stop.phase_timeout_minutes` (50) for a
hung engine. A run stopped as `budget_exhausted` is the guard working: report
the spend, and let the engineer decide between fixing the approach and raising
the knob — never raise it yourself. All keys live in the optional `stop:` block
of `imp/fia.config.yaml`; the code defaults apply when it is absent, so never
tell the engineer they must add it.

A `session_rotation` log line in a run is normal, not a defect: past
`defaults.session_rotation_context` (default 180k tokens of live context) the
agent's next phase continues the SAME run in a fresh engine session with a
compact reseed — resuming a giant session re-reads its whole prefix on every
turn, which is where runaway runs burn most tokens. The archived transcript
stays on disk (`pi_session.<n>.rotated.jsonl` / `raw_output.jsonl`).

## Automatic recovery (once)

A first recoverable failure is retried in CODE, not by asking the engineer:

- Finder/Explorer junk (`.DS_Store`, `Thumbs.db`, `desktop.ini`) is benign —
  reverted as `external_change`, never a `PermissionBreach`.
- A write outside the agent's `writes:` allowlist that rolled back completely
  retries the same phase once, with a note listing the paths to leave alone.
  A second breach, or an unrecoverable path (pre-existing untracked file with
  no copy in git), fails the run and surfaces.
- Envelope gates already have one correction round (`retries: 1` on agent
  phases). The UI-conformance gate already has one `fix_ui` builder round.

When YOU (the orchestrator) would bring the engineer something to correct
that an FDA can apply — leftover UI violation, missing test, brief checkbox,
or a recommended `--resume` after a revert — dispatch that ONE repair first
(`--fda-id … --resume`, with a verdict `--missing` when you can name the
gap). If that also fails, or the outcome is `no_progress` / `attempt_cap` /
`budget_exhausted` / `engine_exhausted`: hand the decision back. Never a
third attempt on your own. Never implement in place of an FDA. (Goal mode
runs by a different rule — recover while each failure names a NEW gap, per
"On failure" in `harness_bridge.md`; the recovery budget enforced by
`verdict.mjs` bounds both.) When you hand the decision back, include your
recommended fix — and if the engineer answers "continue", that authorizes
exactly that fix: execute it, never re-ask.

`stopped_by_request` is not a failure and never gets a repair round: the
engineer pressed the stop button. No run starts while it is armed — disarm
with `imp stop --clear`, then resume the interrupted run as below. `imp stop`
arms it (`--reason "…"` attaches a note, `--status` reports), and the reader
fails CLOSED: even a stop file that cannot be read keeps runs stopped.

`holdout` is the one gate with NO repair round. `imp/data/holdout/` holds
acceptance probes sealed when the brief was written, in a directory agents
cannot write; a violation ends the run for a human to read. Run them on
demand with `npm run holdout` (`--list`, `--require`); a green run prints
`HOLDOUT_PASSED scenarios=N`. Never "fix" a probe — bring the violation to
the engineer.

A task that cannot proceed for a reason OUTSIDE the code — missing API keys,
a paid account the engineer will only create later, a pending decision — is
DEFERRED, never worked around: `/defer <n>` (or `imp defer <n>` in a
terminal) marks it deferred and quarantines its sealed probes reversibly
(`NN-*` → `_NN-*`, content untouched); `/defer resume <n>` brings everything
back. Never rename or edit anything in `imp/data/holdout/` yourself, and
never weaken a probe so a run can pass — the script is the only sanctioned
path, it refuses while a run is live, and the launch check warns about every
open deferral.

## Re-running a failed FDA (resume)

When an FDA fails mid-run and the engineer chooses "re-run", NEVER start from
zero — phases that already succeeded are replayed from their saved results:

```bash
node imp/fda_sdlc.mjs "<same prompt>" --fda-id <failed run id> --resume
```

Only the failed phase and everything after it execute again. This is the
default for any re-run; a fresh run (no `--resume`) is only for when the
engineer explicitly wants to redo the whole flow.

A bare resume is guarded in code: over a tree IDENTICAL to the one that
failed it is refused (re-running cannot end differently — fix the code, or
record a verdict first), and every bare resume spends the run's combined
recovery budget (`verdicts + bare resumes >= 8` refuses with the instruction
to convert the remaining gaps into a follow-up task). Treat a refusal as
STOP-and-ask; `--retry-unchanged` is the engineer's override for genuinely
flaky failures, never yours. The `/qa` audit and `ui_verify` carry the same
guard individually — a tree they already rejected is not re-judged.

When the ENGINE itself died (expired login, plan limit, crash, provider
outage), the resume also continues on that agent's `fallbacks:` chain instead
of retrying the engine that already proved it cannot finish — and the
substitute is handed the interrupted attempt's transcript so it picks up where
the work stopped. Expect `engine_fallback` / `engine_relay` /
`engine_continuation` in the trace; with no viable fallback the resume retries
the original engine out loud (limits reset, outages end).

## Bounded continuation — resume the MISSING work, not the whole run

A run that closed `verification_failed` / `attempt_cap` / `no_progress` did real
work; what it lacks is a judgement about what is still owed. Blindly resuming
either repeats accepted work or stops at the same wall. So when the engineer says
what is missing — or when you reviewed the run and can say it yourself — record
it BEFORE resuming:

```bash
node imp/scripts/verdict.mjs set <fda_id> \
  --missing "the empty state is not handled" \
  --missing "no test covers the 403 path" \
  --redo review                      # phases whose saved result must NOT replay
node imp/fda_sdlc.mjs --fda-id <fda_id> --resume
```

The resumed run then drops the saved results of the phases named by `--redo` (so
they execute again), and hands EVERY agent phase the scope in writing with an
instruction not to re-open anything else. Look for `bounded_continuation` in the
trace. The verdict is **one-shot** — consumed by that run, so a later resume is
unrestricted again; record a new one if the work is still not done.

`--redo` names a phase OF THAT RUN, and the vocabulary is not shared: `review`
above is an `fda_sdlc` phase and does not exist in `fda_plan_build_test`, and a
repeated phase is counter-suffixed (`test_1`, `fix_1`). `set` checks each name
against the phases the run saved and refuses an unknown one with the list — so
copy the name from that list, never from this example.

Rules for you: `--missing` items are the GAP in plain English, never a design
(the agent reads the workspace and decides how). Never invent them — either the
engineer said it or you verified it in the code. `verdict show <fda_id>` reads
one back, `verdict clear <fda_id>` drops it, and `set` refuses while that run is
still in progress.

`set` also refuses once the run has spent its **recovery budget** (4 verdicts
per run, counted in a ledger `clear` never resets). That refusal is a real
STOP: never work around it, never delete the ledger yourself — bring the
evidence and your recommended fix to the engineer, who decides (deleting the
ledger to grant more recoveries is a human-only act). A verdict corrects
evidence so it becomes TRUE; it never waives a gate or relaxes a
security/isolation boolean to make one pass.
