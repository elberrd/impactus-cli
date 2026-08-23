# Harness bridge — from PRD to shipped tasks

The harness plans (PRD → map → screens → issues); the FIA executes (one FDA per task, fresh context each run). You orchestrate the loop — you never implement.

## Step 0 — PRD review (optional but recommended)

Delegate to the `reviewer` subagent: "review `ai-docs/PRD.md` for gaps, ambiguity and missing acceptance criteria". Apply the engineer's edits before planning.

## Step 1 — Generate the plan artifacts

Precondition: read `ai-docs/stack.md`. A layer marked "decide later" that
the plan will touch → resolve it FIRST with the engineer (cookbook
`stack.md`, same flow as `/stack`) — planning against an undefined stack
produces tasks that get rewritten.

Second precondition for any product with UI: require and validate
`ai-docs/ui/contract.json` with
`node .agents/scripts/ui-contract.mjs check --json`. Missing/invalid means run the
`ui-contract.md` cookbook and wait for the engineer's one confirmed profile
choice. This artifact deterministically selects shell, breadcrumb, theme,
DataTable/advanced controls, Kanban and reasoned skips; quality invariants are
non-waivable. No planning agent guesses applicability.

Either path produces the same files:

- **Harness path**: the engineer runs `/start` in Claude Code.
- **Pi path**: delegate in order — `start-mapper` (→ `ai-docs/map.yaml`), `screen-routes-generator` (→ `ai-docs/screens-routes.md`), `task-master-generator` (→ `ai-docs/todos/issues/NN-<slug>.md` + `ai-docs/todos/task-master.md` + one spec per major capability in `ai-docs/specs/`, with `Spec:` lines on the issues that prove scenarios), then `component-architect` (→ `ideal-components.md` + SEEDS only the contract-applicable rows in `ai-docs/components/registry.md`) and `ui-component-page` (→ the live `/ui-components` page). The component steps follow the contract; `not_applicable`/`waived` become `SKIP <rule-id> — <reason>`, never fake work. Greenfield (no app scaffold yet): skip `ui-component-page` without trying — the foundation Task 01 creates the page from the applicable registry.

After the tasks land, draft `ai-docs/milestones.md` yourself (3–6 milestones, first = the MVP, its `Done when:` list coming from the PRD's `## Launch criteria`) and confirm with the engineer. Greenfield (Task 01 is the foundation task, `Kind: foundation` in its issue): the first milestone's `Done when:` also lists the theme checkpoint — "visual identity approved: closed `theme` decision log in `ai-docs/decisions/`". Write each one in EXACTLY this shape — the viewer's Plan tab and `/status` parse the H2 heading and the `Status:` line, so a creative variant is invisible to both:

```
## M1 — <name>

Goal: <one line>
Done when:
- <verifiable exit condition>
- <…>
Tasks: 01, 02, 05
Status: pending
```

A milestone is `done` only when its exit conditions are verified — task count alone never flips it, and the status is declared in the file, never derived.

Then make the plan durable: `node imp/scripts/docs-commit.mjs --message
"docs(plan): map, screens, tasks, specs, milestones" ai-docs`. Plan artifacts
left uncommitted sit in the working tree and contaminate the next FDA's
commit; the script only accepts `ai-docs/` paths and refuses to run while an
FDA is active — commit BEFORE dispatching the first task.

After the artifacts land, show them to the engineer: `npm run plan -- --detach` opens the viewer's "Plan" view (screens, tasks, design system, generated files) at http://127.0.0.1:4600#plan. If the script is missing, just mention `npm run plan`.

## Step 2 — One task, one FDA, one fresh context

1. Delegate to `task-sequencer`: it archives the previous brief and writes ONE just-in-time implementation brief in `ai-docs/actual-todo/`.
   - **Theme gate (greenfield checkpoint)**: the sequencer refuses any
     post-foundation task while no closed `theme` decision log exists in
     `ai-docs/decisions/` (foundation = the issue with `Kind: foundation`;
     check: `node imp/scripts/decision-log.mjs list --command theme --json` →
     ANY record with `"status": "closed"` passes — never `latest`: a newer
     open log from an abandoned re-run must not cancel an earlier approval).
     When it stops there, resolve with the engineer —
     never around them: offer `/theme` (recommended — interview + preview +
     approval) or "keep the current default theme", which is ALSO a recorded
     decision (`open theme --topic "accept default theme"` + `close <id>
     --outcome "engineer accepted the stack default theme"`), never a silent
     skip. Then re-delegate to the sequencer.
   - **UI contract gate**: every UI/foundation/kit brief requires a validated
     `ai-docs/ui/contract.json`, copies relevant named rules and preserves
     reasoned SKIPs. A task contradicting a skip pauses and returns to
     `/ui-contract`; no feature FDA edits applicability.
   - **Env gate (foundation preflight)**: before the foundation brief
     (`Kind: foundation`), the sequencer runs
     `node imp/scripts/env-preflight.mjs --json` (alias `npm run env:check`) —
     the dev keys the declared stack reads at build/boot must already be in
     `.env.local`. When it stops there, provision MID-flow with the engineer:
     CLI-able parts yourself (`npm install convex && npx convex dev --once`,
     after the one-time login), dashboard-only keys by the engineer (Clerk
     publishable + secret — secrets go in THEIR terminal, never the chat).
     Re-run the preflight, then re-delegate. The sequencer also copies the
     `Kind: foundation` line into the brief: it makes the FDA's test phase run
     `npm run build` too, so a scaffold that only passes unit tests can never
     reach review with a broken build.
   - **Impossible dependency (hidden cycle)**: the sequencer found that the
     picked issue's spec needs a schema/feature a later, blocked-by-this-task
     issue will introduce (Task 06 proving tag–task deletion, Task 07 creates
     the tasks table and is blocked by 06). It applies ONE split itself
     (narrow now, move leftover scenarios to the later issue, keep every
     `S-n`). If it stopped to ask anyway, tell it to apply the recommended
     split and re-delegate once — do not ask the engineer. Theme/env/stack
     still pause. A second failure to write a brief is the only time you ask.
   - UI task ⇒ the brief MUST carry the "Design system components" section
     mapping every UI need to `ai-docs/components/registry.md` (cookbook
     `components.md`). A need with NO registry equivalent: interactive → ask
     the engineer (one question, with recommendation) and run the
     `/component` flow first; goal mode → run the flow yourself (register +
     install + page), continue, and report the additions in the final summary.
     The FDA never invents a component.
   - Issue with a `Spec: NNNN (S-…)` line ⇒ the brief copies it (plus the
     relevant scenario excerpts). That line arms the FDA's spec-coverage
     phase — every listed ID must appear in a test marker
     `spec:NNNN covers:…` (cookbook `specs.md`) or the run fails.
   - Rows in `ai-docs/examples/registry.md` whose Tags match the task ⇒ the
     brief gains a `## Reference examples` section (slug · what to take ·
     license), cookbook `examples.md`. No match, no section — the shelf is a
     reference, never a gate, and examples teach shape, not code to paste.
   - A brief NEVER contains commit instructions ("commit at the end",
     "report … and commit"). Committing is the FDA's own deterministic phase —
     after review, pathspec-limited to the run's work. A brief that asks the
     builder to commit produces a contaminated commit and a rejected review.
   - Exact `Mode: prototype` is an explicit, per-task opt-in copied from the
     issue into the brief. It selects `fda_prototype`; no marker means a normal
     tested FDA. Never infer prototype mode from task size or wording.
2. Run the FDA with the brief file path as the prompt (plain path — `resolvePrompt` inlines file contents):

```bash
node imp/fda_plan_build_test.mjs ai-docs/actual-todo/<brief>.md
# brief already autocontained (skip planner, save ~1-2.5M tokens):
node imp/fda_build_test.mjs ai-docs/actual-todo/<brief>.md
# bigger/riskier: plan (auto-skipped on self-contained briefs) → build →
# test + fix rounds → review (green suites only) → commit. Docs default to one
# fda_document per MILESTONE (`sdlc:` block in imp/fia.config.yaml).
node imp/fda_sdlc.mjs ai-docs/actual-todo/<brief>.md
# fast prototype (build + lint only, no tests/review; brief MUST carry Mode: prototype):
node imp/fda_prototype.mjs ai-docs/actual-todo/<brief>.md
# defect: RED reproduction test (gated as a real assertion failure) → fix → green
node imp/fda_bug.mjs ai-docs/actual-todo/<brief>.md
```

Tiny, self-evident changes skip this pipeline entirely — `/quick` triages and
runs `node imp/fda_quick.mjs "<description>"`: no issue, no brief, audit entry
appended to `ai-docs/todos/quick-log.md`.

3. Check the outcome (`npm run fda:sessions`, or the timeline at `npm run fda:viewer`). Exit 0 = accepted.
   - For tested briefs carrying `Spec: NNNN (…)`, the FDA's deterministic
     `spec_close` phase closes the spec when this is its final linked task:
     every other task on the spec's `Tasks:` line must already be `done`.
     It appends the Delivery Gate evidence and sets `Status: done` before the
     implementation commit. Incomplete or missing planning metadata leaves it
     open and writes the exact reason to the trace — never rely on the agent to
     remember this transition after the run.
   - The FDA's **checklist gate** ticks-or-fails the brief's checkboxes: the
     builder reconciles them (verified → `[x]`, inapplicable → `[x] … — N/A`)
     and the run refuses to close while any `- [ ]` remains. Before announcing
     a task finished, glance at the brief in `ai-docs/actual-todo/` — unchecked
     boxes mean the task is NOT done (a legacy runner without the gate, or a
     failed run), so never announce it as finished; reconcile via the issue
     protocol or resume the run instead.
   - The FDA's **UI-conformance gate** loads the validated contract, resolves
     named APPLY/SKIP decisions, then audits every frontend component file the run
     changed against `ai-docs/ui/patterns.md` and its applicable defaults (field
     errors inline under each field — never only a banner or toast —,
     success/failure toasts after mutations, create/edit in a `Dialog`,
     `AlertDialog` for destructive actions, components from the registry):
     one repair round, then the run refuses to close on surviving violations.
     A brief whose `Surface:` line lacks `ui` stands the gate down; UI
     violations in the failure trace mean the interaction patterns need
     fixing, not the feature.
4. Update the issue `Status:` (task-sequencer does this on the next pass).

## Step 3 — Goal mode (run until done)

When the engineer says "go all the way" / "run every task":

```
repeat:
  1. task-sequencer → next unblocked issue → brief
  2. brief has exact `Mode: prototype`? run fda_prototype
     otherwise run fda_sdlc (or fda_plan_build_test when /goal --light)
  3. exit 0? → report the phase summary, continue
     exit != 0? → recover while each failure is NEW (see On failure), then continue or STOP
until no unblocked issues remain
```

Rules for the loop:

- One FDA run per task — never batch tasks into one run (fresh context is the point).
- The theme gate applies INSIDE the loop: right after the foundation task
  (`Kind: foundation`) completes, the sequencer will stop the next pick — pause
  the loop and resolve the checkpoint with the engineer (Step 2: `/theme`, or
  record explicit acceptance of the default theme). Visual identity is a human
  decision; no FDA and no goal mode decides it.
- The env gate too: the foundation brief only exists after
  `node imp/scripts/env-preflight.mjs` passes — resolve missing keys with the
  engineer mid-goal (Step 2), never by scaffolding around them and letting the
  review discover the broken build.
- A hidden cycle (picked issue needs a later blocked-by-this-task schema)
  is NOT a human gate: apply the recommended split once and re-delegate.
  Ask only if the second sequencer pass still cannot write a brief.
- UI component missing from `ai-docs/components/registry.md` → follow the
  `components.md` cookbook protocol: register + install it yourself (the
  `/component` flow), continue the loop, and list every component added in
  the final summary. The FDA never invents a component.
- Report progress after every task: task name, phases, tokens, commit sha.
  "Task finished" requires the brief's checkboxes fully ticked (the checklist
  gate guarantees it on exit 0) — a brief left with `- [ ]` is an unfinished
  task, whatever the announcement says.
- On failure: recover automatically while the run is making PROGRESS —
  never ask permission for a repair an FDA can apply. The FDA itself
  already retries a fully-rolled-back allowlist breach once (and treats
  Finder/Explorer junk like `.DS_Store` as benign). If you would bring
  the engineer something to correct that an FDA can apply — leftover UI
  violation, missing test, brief checkbox, a malformed receipt field, or
  a recommended `--resume` after a revert — dispatch the repair
  (`--fda-id … --resume`, with `verdict set --missing` naming the gap),
  report it in one line (what failed → what you fixed) and continue.
  Progress means each failure is a DIFFERENT gap than the last: fixing
  one gate violation often reveals the next, and that chain is yours to
  walk without asking. A BARE resume (no verdict) is legitimate only
  when the tree changed since the failure or an engine died — the
  runner refuses an identical-tree resume and counts every bare resume
  against the run's combined recovery budget; treat a refusal as
  STOP-and-ask (`--retry-unchanged` is the engineer's override, never
  yours). From the third recovery of one run onward, prefer converting
  the remaining gaps into a FOLLOW-UP brief via the task-sequencer —
  a fresh run starts with small sessions and clean context. STOP and
  hand the evidence (`fda:phases`, gate violations, envelope) only
  when: the SAME violation returns (no progress), the outcome is
  `no_progress` / `attempt_cap` / `budget_exhausted` /
  `engine_exhausted` (login/limit), or `verdict set` / the resume
  itself refuses because the run's recovery budget is spent — both
  caps are enforced in code, never worked around, and they are what
  make this loop safe to run without asking. Always include your
  recommended fix in the STOP report; if the engineer then answers
  "continue" (or equivalent), that IS the authorization for exactly
  that recommendation — execute it, never re-ask. A recovery verdict
  corrects evidence so it becomes TRUE — it never waives a gate or
  relaxes a security/isolation boolean to make one pass. Never
  implement in place of an FDA.
- Suggest keeping `npm run fda:viewer` open — it live-updates every 2s.
- When the **last task of a milestone** completes inside the loop (all tasks
  listed under that milestone are now `done`), run
  `node imp/fda_qa.mjs "<milestone-id>"` before selecting work from a later
  milestone. UI scope requires the validated contract plus Playwright/design
  evidence; API-only writes a reasoned skipped report. Any non-zero QA result
  STOPS the loop. Never silently defer this boundary. QA green: drain the
  milestone's documentation with ONE `fda_document` run (per-task runs skip
  their `document` phase by default — `sdlc.document: per_milestone`), then
  END the goal loop at this boundary when other milestones remain — hand off
  in 5 lines and have the engineer run `/goal` again in a NEW session. All
  state is durable in `ai-docs/`; a fresh session per milestone avoids the
  accumulated orchestrator context that is the biggest hidden token cost of
  a long goal.

## Step 4 — Deliver it RUNNING (definition of done)

A goal (or a single task, when that's what the engineer asked for) is NOT done
when the last FDA exits 0. It is done when the engineer can see it working with
the least possible effort. Before the final summary:

1. **Verify it boots**: deps installed, `.env`/`.env.local` present and valid,
   database created/migrated/seeded. Auth in the stack ⇒ the test users exist
   (ONE per profile/role, via the provider's test mechanism — Clerk:
   `+clerk_test` emails + fixed code `424242`) and the
   `ai-docs/test-credentials.md` roster is filled. Start the dev server,
   smoke-check the URL (HTTP 200), then stop it. Fix-forward anything broken
   via an FDA.
2. **One command to run**: if the stack (see `ai-docs/stack.md`) needs 2+
   processes (e.g. `npx convex dev` + `next dev`), dispatch a small FDA brief
   to add a single `npm run dev` that starts everything (e.g. concurrently).
   You orchestrate — the FDA edits.
3. **Human-only steps happen MID-goal, not as homework**: anything interactive
   (OAuth login, account creation, paid provisioning) — give the engineer the
   exact command, wait for confirmation, then CONTINUE the goal. Choices you
   can't make (database name, project name) — ask objectively, or use an
   obvious default and say so. Never leave these as footnotes at the end.

The final summary MUST end with a **"How to test"** section:

- the minimal command(s) — ideally just `npm run dev`
- the URL to open, and the test credentials: echo the
  `ai-docs/test-credentials.md` roster (one user per profile) and tell the
  engineer to KEEP them — they are how every future QA session signs in
- a 3–6 item manual checklist covering what was delivered
- an offer to start the dev server yourself right now and hand over the URL
