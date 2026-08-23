---
description: Execute ALL tasks in order until done (goal mode)
argument-hint: '[optional limit, e.g.: 3 tasks] [--light]'
---

Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/harness_bridge.md`, and follow Step 3 (goal mode) to the letter.

Before any task: read `ai-docs/stack.md`. A "decide later" layer that any task
will touch = STOP and resolve it with me first (cookbook `stack.md`, same flow
as /stack) — implementing with an undecided stack is guaranteed rework.

Limit/instructions from the engineer: $@

**Token discipline — your own context is a cost.** This session pays for every
line it carries forward (a real project's goal session burned 240M tokens
mostly re-reading its own history). Never paste briefs, reports or FDA output
into the conversation — reference paths; the viewer (`npm run fda:viewer`) is
the log. Report each task in ONE line. Never re-read `task-master.md` in full
— the sequencer owns it. For routine milestones prefer `--light`
(`fda_plan_build_test`); the full `fda_sdlc` is for bigger/riskier tasks.

**FDA selection (evaluate after each brief is written):** an exact
`Mode: prototype` line selects `fda_prototype.mjs` for that brief. Otherwise,
if the engineer's instructions contain `--light`, use
`fda_plan_build_test.mjs`; the default is `fda_sdlc.mjs`. Prototype takes
precedence over `--light` because it is the brief's explicit per-task opt-in.

Loop, until no unblocked task remains OR a milestone boundary closes (step 3):

1. `task-sequencer` → next unblocked issue → brief in `ai-docs/actual-todo/`
   (sequencer stopped on the **theme gate** — right after the greenfield
   foundation task, no closed `theme` decision log? PAUSE the loop and resolve
   with me per the cookbook: `/theme` (recommended) or record my explicit
   acceptance of the default theme. Never decide for me, never skip silently.
   Stopped on the **env gate** — foundation task picked but
   `node imp/scripts/env-preflight.mjs` reports dev keys missing from
   `.env.local`? PAUSE and provision with me mid-goal per the cookbook:
   CLI parts yourself, dashboard keys from me — then continue.
   Stopped on an **impossible/circular dependency** with a recommended
   split (Task 06 needs Task 07's schema, 07 is blocked by 06)? Apply
   the split once — do not ask — and re-delegate. If the second pass
   still cannot write a brief, THEN ask.)
2. `node imp/<fda>.mjs ai-docs/actual-todo/<brief>.md` — ONE task per run, never batch them
   (`<fda>` = `fda_prototype` for `Mode: prototype`; otherwise
   `fda_plan_build_test` when `--light`, `fda_sdlc` by default)
3. exit 0 → report to me in one line (task, phases, tokens, commit) and continue
   — then inspect `ai-docs/milestones.md` plus task statuses. If that task made
   every task of a milestone `done`, run the milestone QA immediately, before
   selecting any task from a later milestone:

   ```bash
   node imp/fda_qa.mjs "<milestone-id>"
   ```

   A UI milestone requires a valid `ai-docs/ui/contract.json`; the QA FDA
   resolves named rules to `APPLY` or reasoned `SKIP`; only browser/audit
   evidence earns `PASS`. It blocks on missing or
   invalid contracts, failed Playwright evidence, or a failed design audit.
   An API-only milestone exits 0 with a durable `Status: skipped` report and
   its reason. QA exit 0 → report the QA report path, then drain the
   milestone's documentation in ONE call (per-task runs skip their
   `document` phase by default — `sdlc.document: per_milestone`):

   ```bash
   node imp/fda_document.mjs "Document milestone <milestone-id>: what shipped across its tasks — read ai-docs/milestones.md and the completed briefs in ai-docs/todos/, write/update the docs, and commit them"
   ```

   — then, when other milestones remain, **END THIS LOOP at the milestone
   boundary**: print a 5-line handoff (milestone done, QA report path, next
   milestone id, "state is durable in ai-docs/ — run `/goal` again in a NEW
   session to continue"). Every loop artifact lives on disk, so the fresh
   session loses nothing and starts without this conversation's accumulated
   weight — one milestone per session is the cheap shape. Only when NO
   unblocked task remains anywhere do you continue to the final delivery
   below. QA exit != 0
   → **STOP the goal**; show the phase, rule id/evidence, and artifact path.
   Never silently defer QA, continue into the next milestone, or mark a failed
   milestone complete. This automatic boundary supersedes the cookbook's
   legacy “suggest `/qa` only” sentence.

4. exit != 0 → recover automatically while the run is making PROGRESS
   (cookbook `harness_bridge`, "On failure"): each failure that names a
   NEW gap an FDA can apply is yours to repair without asking
   (`--fda-id … --resume`, with a verdict `--missing` naming the gap).
   A plain re-run is legitimate ONLY when the tree changed since the
   failure or an engine died — the runner now REFUSES a bare resume
   over an identical tree, and counts every bare resume against the
   run's combined recovery budget. Treat any such refusal as
   STOP-and-ask, never work around it (`--retry-unchanged` is the
   engineer's override, not yours). Report each recovery to me in one
   line (what failed → what you fixed) and continue. Fixing one gate
   violation often reveals the next; that chain is progress, walk it.
   From the THIRD recovery of the same run onward, prefer converting
   the remaining gaps into a FOLLOW-UP brief via the task-sequencer —
   a fresh run starts with small sessions and clean context, resuming
   a long run re-opens its giant sessions at full width.
   STOP only when: the SAME violation comes back (no progress), the
   outcome is `no_progress` / `attempt_cap` / `budget_exhausted` /
   `engine_exhausted`, or `verdict.mjs set` / the resume itself refuses
   because the run's recovery budget is spent (both caps are enforced
   in code — never work around them). On STOP: show the phase, the gate
   violations, the trace AND your recommended fix. I decide: fix, skip
   or re-run — and if I answer "continue" (or equivalent), that IS the
   authorization for exactly the fix you recommended: execute it,
   never re-ask.

Briefs with a `Spec: NNNN (…)` line arm the FDA's spec-coverage gate — on
success, check the spec's Traceability table reflects the new tests and flag
it if it doesn't. The tested FDAs then run `spec_close` in code: when the
current task is the last linked task, it appends the Delivery Gate and sets
`Status: done` before committing. A `spec_close` pending result is actionable
planning metadata in the trace, never a transition to remember after the loop.

Suggest I keep `npm run fda:viewer` open in another terminal to watch live.

When everything is done, fulfill Step 4 of the cookbook (deliver it RUNNING) before the summary:
the app starts with ONE command (`npm run dev` — if it needs 2+ processes, dispatch an
FDA to create the single script), env/database ready and smoke-check done. Whatever
requires human action (login, account), ask for it in the MIDDLE of the goal and
continue — no homework at the end. Final summary: tasks, commits, tokens — and ALWAYS
closing with the **How to test** section (minimal command, URL, short checklist of
what was delivered) + an offer to start the dev server yourself right now.

Before declaring the goal complete, verify every completed UI milestone has a
passing report in `ai-docs/qa/` (and every API-only milestone has its reasoned
skipped report). A missing report is a blocking unfinished boundary: run
`node imp/fda_qa.mjs "<milestone-id>"`; failure means STOP.

Running locally and tested? The next rung is `/launch` — suggest it at the end
(it puts the app on a public URL and then into real production, guided).
