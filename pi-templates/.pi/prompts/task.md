---
description: Execute ONE task via FDA (the next one, or the one I point to) — optionally on another LLM just for this run
argument-hint: "[number or description] [--llm \"grok 4.6 high\" | \"builder=opus xhigh\"]"
---
Read `.pi/skills/fia/SKILL.md` and the cookbook `.pi/skills/fia/cookbooks/harness_bridge.md`, and follow Step 2.

Requested task: $@ (if empty, the next unblocked one from `ai-docs/todos/issues/`).

**LLM for this run only.** If my request carries `--llm "…"` — or plain words
like "on grok 4.6 high", "with opus xhigh", "builder on codex" — that is a
run-scoped choice: append `--llm "<my words>"` to the FDA command in step 2
(repeat the flag for several agents, e.g. `--llm "builder=grok-4.6 high"
--llm "reviewer=opus"`). The script normalizes the spelling, clamps the level
to the engine, refuses ambiguous ids with the fix, prints the `old → new`
line (repeat it to me) and keeps it on `--resume`. NEVER edit
`imp/fia.config.yaml` for this — a durable switch is `/llm`.

1. Delegate to the `task-sequencer` to generate the brief in `ai-docs/actual-todo/`
   (it stops on the **theme gate** right after the greenfield foundation task —
   no closed `theme` decision log yet. Resolve with me per the cookbook: `/theme`,
   or record my explicit acceptance of the default theme — then re-delegate.
   It also stops on the **env gate** before the foundation task itself —
   `node imp/scripts/env-preflight.mjs` reports dev keys missing from
   `.env.local`. Provision with me mid-flow per the cookbook: CLI parts
   yourself, dashboard keys from me — then re-delegate.
   Stopped on an **impossible/circular dependency** with a recommended
   split? Apply the split once — do not ask — and re-delegate. If the
   second pass still cannot write a brief, THEN ask.)
2. Select from the brief, deterministically, then run ONE FDA:
   - exact line `Mode: prototype` → `node imp/fda_prototype.mjs ai-docs/actual-todo/<brief>.md`
   - otherwise → `node imp/fda_plan_build_test.mjs ai-docs/actual-todo/<brief>.md`
   - bigger/riskier normal task (never a prototype) → `node imp/fda_sdlc.mjs …`, as the cookbook shows
3. Follow along and report to me: phases executed, gate results, tokens and commit (if any).
   Brief with a `Spec: NNNN (…)` line → the FDA's spec-coverage gate is armed;
   on success, confirm the spec's Traceability table gained the new test paths.
   The tested FDAs then run `spec_close` in code: if this is the final linked
   task, Delivery Gate evidence and `Status: done` land before the commit; if
   metadata is incomplete, the trace says exactly why the spec stayed open.

Rules: you implement NOTHING — the FDA does the work. If the FDA fails
(exit != 0), apply ONE automatic recovery per the cookbook (re-run /
repair once) before asking me. If that also fails, stop and show me the
evidence (`npm run fda:phases -- <fda_id>`). Never a third attempt on
your own.

When reporting success, if the task is testable in the browser, ALWAYS close with
**How to test**: minimal command to start (ideally `npm run dev`), URL and the
test steps for that task. If something is missing to run it (env, database, seed),
apply Step 4 of the cookbook before reporting — whatever is interactive, ask me
to run it and continue.
