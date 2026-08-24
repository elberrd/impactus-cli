<p align="center">
  <img src="https://raw.githubusercontent.com/elberrd/impactus-cli/main/assets/impactus-cli-logo.jpeg" alt="IMPACTUS CLI logo" width="140" />
</p>

<h1 align="center">IMPACTUS CLI</h1>

<p align="center">
  The IAI installer — agent harness + FIA, running entirely on the AI subscriptions you already have.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/impactus"><img src="https://img.shields.io/npm/v/impactus?label=npm&color=black" alt="npm version" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.12-black" alt="Node >= 22.12" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-black" alt="MIT license" /></a>
</p>

> [!WARNING]
> **Alpha software.** IMPACTUS CLI `2.x` is in active development. Commands,
> flags, templates and the stamped runtime change between releases without
> deprecation cycles. Pin a version if you need stability, and expect to run
> `npx impactus --update-runtime` in installed projects often — `imp doctor`
> tells you when an install has fallen behind.

**IMPACTUS CLI** (npm package `impactus`) is the installer of the **IAI
method**. It exists so students and followers of
**[IMPACTUS Academy](https://www.impactus.academy)** can do **assisted vibe
coding** in a simpler and more professional way: you describe the product, the
agents plan, build and test it — and the method keeps everything traceable
(PRD, specs, decision log, quality gates), so what comes out is a real,
maintainable codebase instead of a throwaway prototype.

```bash
npx impactus
```

One command stamps your project with the **agent harness** plus the **FIA**,
running entirely inside the AI subscriptions you already have (Claude Pro/Max,
ChatGPT Plus/Pro and — when you have it — Grok Build on xAI) — no API keys,
no per-token billing.

## What the names mean

| Name | What it is |
| --- | --- |
| **IAI** | The method taught at IMPACTUS Academy for building production software with AI agents. This CLI is its installer. |
| **FIA** | The **IAI Agent Factory** — the agent runtime stamped into your project (`imp/` + `.pi/`): Pi as the interactive agent, the FDAs as the workforce, plus an observability database, quality gates and dashboards. |
| **FDA** | **Fully-automated Dev Agent** — a deterministic, non-interactive agent run (`imp/fda_*.mjs`) that takes a task end to end: implements, tests, passes the quality gates and commits, with every step recorded. |
| **Pi** | The interactive agent you talk to (the `imp` command opens it): `/idea`, `/map`, `/task`, `/goal`, `/guide`… It plans with you and dispatches the FDAs. |
| **Harness** | The agent-workflow scaffold for Claude Code and Cursor (`/start`, `/dev`, `/sv`, 9 specialist agents, skills and gates) — the base of every install. |
| **imp** | The brand launcher (`npm i -g impactus`) — a thin wrapper over the real `pi` binary, not a fork. |

## Who can use it

Anyone can run the installer — **signing in is optional and asked right at
the start**:

- **Signed in** ([Impactus Academy](https://www.impactus.academy) student with
  an active enrollment): the full installer — the ready-made project templates
  plus the whole automated template pipeline (cloud provisioning, keys,
  webhooks, GitHub, deploy).
- **Without signing in** (guest mode): the CLI still installs the **agent
  harness + the FIA agents**, but nothing from the templates — the CLI shows
  the limitation up front and again in the final summary.

Login uses the OAuth device flow (browser, one time per computer); access is
revalidated on every use. Templates and harness are delivered by the academy's
API — they are **not** in this repository or in the npm package, and the CLI
has no clone path (the harness is served without a token; the templates
require an active enrollment).

```bash
npx impactus --login    # authenticate this computer
npx impactus --whoami   # subscription status
npx impactus --logout   # revoke + remove the local token
```

## Quick start

```bash
npx impactus
```

The wizard asks **everything up front** (sign-in, project folder, how to
start, stack, addons), shows a summary, and only then executes the whole
install at once. After it finishes you work in **two cockpits**:

- **Claude Code / Cursor** — the harness slash commands, for interactive
  building (`/start`, `/dev`, `/sv`, `/test-ui`…).
- **Pi** (the `imp` command opens it) — the FIA: planning interviews
  (`/idea`, `/map`) and the fully-automated runs (`/task`, `/goal`), with
  dashboards via `npm run tui` and `npm run fda:viewer`.

The flow, in short: **describe** the product (PRD) → **plan** (map, screens,
tasks) → **build** (interactively or via FDAs) → **follow along**
(dashboards) → **launch**. Every step below is optional and resumable — and
`/guide` (inside `pi`) always tells you the next best command.

One login is left for the very end: inside `pi`, `/login openai-codex` (for
the Codex roles). Claude runs through the official `claude` CLI you already
use — the CLI never asks for an API key.

### Installer & launcher commands

```bash
npx impactus                   # install (the wizard asks everything up front)
npx impactus --login           # authenticate this computer (browser, one time)
npx impactus --whoami          # subscription status
npx impactus --logout          # revoke + remove the local token
npx impactus --verify --dir .  # audit an installed project (read-only)
npx impactus --update-runtime --dir .  # re-stamp imp/ + .pi/ from a newer CLI
npx impactus my-app --clerk-app app_... # deterministically reuse this Clerk app
npx impactus my-app --new-clerk-app     # force a fresh Clerk app

npm i -g impactus              # installs the `imp` launcher:
imp init                       # install into the current folder (same as npx impactus)
imp                            # open Pi here (installs Pi if it's missing)
imp update                     # update impactus + Pi + the pinned Pi extensions
imp tui                        # the project dashboard in the terminal
imp doctor                     # read-only checkup: subscriptions, CLIs, Pi, project
                               # (--gates self-tests the FIA gates with injected defects)
imp fix                        # repair what doctor found (plan + consent; restores missing files only)
imp stop                       # the stop button: halts FDA runs cleanly before the next
                               # phase (fails closed; --status / --clear to disarm)
imp handoff                    # continue the newest Pi conversation in `claude`
                               # (Codex outage? your work keeps moving)
imp llm                        # numbered list of the FDA agents + the LLM each runs on;
                               # switch by number or name (`imp llm set 1 fable`,
                               # `imp llm set builder grok-4.6 --effort high`);
                               # one run only: node imp/fda_*.mjs … --llm "grok-4.6 high"
imp defer                      # postpone a task blocked on something external (API keys,
                               # a decision): sealed probes quarantined reversibly;
                               # `imp defer resume <n>` brings it back
imp health                     # loop-health report: how well the agent loop is working
imp rewind                     # undo an FDA run — checkpoints, preview, restore-only
imp notify                     # run-end pings (webhook/Slack/Discord/Telegram); off by default
imp settings                   # where every machine setting comes from (read-only)
```

### Clerk and deployment safety

The installer always invokes the tested `npx -y clerk@3.1.0 --mode agent`
binary—never a global or floating Clerk CLI. It signs in with `clerk auth
login`, reuses the app already linked to the project before considering an
exact-name match, and creates a new app only when selection is unambiguous.
`--clerk-app <app_id>` and `--new-clerk-app` are mutually exclusive; in
`--yes`, duplicate exact names stop with an instruction to pass the app ID.

Provisioning pulls development keys, proves that publishable key, secret key,
issuer, and selected development instance agree, reconciles the `convex` JWT
template (`aud: "convex"`, 3600 seconds), enables Clerk Billing when selected,
and ends with read-only `clerk doctor --json --spotlight`. Reused apps show the
configuration diff before any mutation; unattended installs stop when such a
change needs approval.

The installer's quick deploy is always a **Vercel Preview** (`vercel deploy
--yes`). Development Clerk keys and Convex dev variables are sent only to the
`preview` target. Production belongs to `/launch`, which requires a matching
`pk_live_`/`sk_live_` pair, explicit Convex Production, the production webhook
secret, and the final domain. Test keys are a hard stop in that flow.

`CLERK_WEBHOOK_SIGNING_SECRET` is the canonical webhook variable; the
templates' `convex/http.ts` reads it with a legacy `CLERK_WEBHOOK_SECRET`
fallback, and the installer sets BOTH names so projects generated from older
template versions keep working. The webhook is optional for first access —
both templates sync the signed-in user on first load via `users.ensure` — and
it is what keeps external profile changes and deletions in sync. Existing
projects are not rewritten automatically—follow
[the manual Clerk migration guide](./CLERK_MIGRATION.md).

The development-key banner and Clerk telemetry notice are expected locally and
in Preview. Telemetry stays at Clerk's default; opt out explicitly with
`npx -y clerk@3.1.0 telemetry disable` or `CLERK_TELEMETRY_DISABLED=1`.
Cookie cleanup is only relevant after a 431 error, a login loop, or switching
the localhost project to another Clerk instance. New templates protect each
resource with `auth.protect()` and ship no `createRouteMatcher`; projects
installed from older template versions may still see the deprecation as a
warning in `--verify` and the security scan — follow the migration guide to
clear it.

### Inside `pi` (run `imp`) — plan and automate

| Command | What it does |
| --- | --- |
| `/idea [topic]` | Interview from scratch → an evidence/assumption-aware PRD with a falsifiable hypothesis, measurable signals and the thinnest end-to-end MVP. On an existing system it adds a new `## Module:` chapter instead. |
| `/stack [tech?]` | Decides pending stack layers, generates docs for each technology in `ai-docs/apis/`, installs CLIs, MCPs and skills. |
| `/grill [target]` | Stress-tests the PRD one question at a time, recording every decision. |
| `/prd [focus]` | Quick reviewer opinion on the PRD. |
| `/map` | Conditional architecture checkpoint → map + screens + tasks + milestones; opens the plan in the browser when done. Simple plans skip the checkpoint automatically. |
| `/task [n] [--llm "<model> [level]"]` | Runs ONE task end to end via FDA. A brief explicitly marked `Mode: prototype` uses the guarded lint/typecheck-only prototype flow. `--llm "grok 4.6 high"` (or `"builder=opus xhigh"`) runs THAT task on another LLM without touching the roster — same flag on `/goal`, `/quick`, `/bug`. |
| `/goal [--light]` | Runs ALL tasks until done. `Mode: prototype` applies per brief; otherwise `--light` skips review+document phases. A completed milestone automatically runs blocking browser QA before the next one. |
| `/feature "what you want"` | New feature in an existing system: delta interview → delta spec + new tasks. |
| `/bug "the symptom"` | Records the defect, runs proportional RCA when ambiguity/risk requires it, proves a valid failing test first (RED), then fixes it. |
| `/quick "small change"` | Triage: a genuinely small change ships in one sitting; anything bigger routes to `/feature` or `/bug`. |
| `/spec [capability]` | Durable spec — requirements + BDD scenarios + traceability gates. |
| `/onboarding [focus?] [--report-only]` | Existing project, first run: chains `/absorb` → `/stack` → `/kit` in one guided pass — ends ready for `/idea` or `/feature`. Interrupted tours resume where they stopped; `--report-only` defers the design-system decisions. |
| `/absorb [focus]` | Existing project → as-built PRD, map, conventions, stack manifest, component registry and the maintained `ai-docs/wiki/` (pages agents read instead of re-reading the code). |
| `/kit` | Design-system audit of existing code: as-built registry, `/ui-components`, gap report vs the core kit (including interaction contracts: yellow search highlight, Combobox width, calendar month/year jump, Filter + chips, one component per card), then approved design-only tasks. |
| `/ui-contract [profile\|show\|review]` | Chooses the deterministic UI product profile, capability applicability, and implementation per shell/navigation/theme/table/Kanban surface. An explicit existing/specified library or custom component wins for its named surface and resolves through a concrete local entrypoint; an unrelated package cannot claim every surface. If nothing detailed was requested, the versioned `fia-universal` kit is the fallback. Optional capabilities change atomically with `capability --name <capability> --enabled true\|false` (Kanban enables drag-and-drop; advanced tables enable base tables; enabling tables also turns on the professional advanced controls unless the contract waived them — disable explicitly to opt out; conflicting disables fail without writing); quality invariants cannot be waived. |
| `/component`, `/theme`, `/design`, `/example` | Design system: add a component (register + isolated `/ui-components` card), change colors/fonts, redesign from references, register an external reference. |
| `/launch` | Go live — public beta and production, with readiness gates. |
| `/qa [scope?]` | Browser QA at milestone/spec/task — Playwright e2e, responsive check, design audit, durable report. |
| `/agents` | Visual roster editor: engine, model and fallbacks per FDA agent — with automatic mid-run relay when an engine dies. |
| `/llm ["1 → fable"?]` | Quick model switch: numbered list of the FDA agents with the LLM each one runs on — answer by number or name and it's applied (same safe write path as `/agents`; also `imp llm` in a terminal). Engines: Claude Code, Codex/any Pi provider, Cursor and Grok Build (`grok-4.6`). |
| `/defer [n \| resume n]` | Postpone a task that cannot proceed right now (missing API keys, a pending decision): status → deferred, sealed holdout probes quarantined reversibly; `resume` brings everything back (also `imp defer` in a terminal). The launch check warns about every open deferral. |
| `/status` | Progress + latest runs. |
| `/evolve --run <id>` / `--since <period>` | Evidence-backed retrospective of a finished FDA run or project-history window; writes local reports and never changes the system automatically. |
| `/guide [goal?]` | Lost? Reads the project state, confirms your goal in one question and charts the shortest route. |
| `/note "idea"` | One line into `ai-docs/inbox.md` — zero questions. |
| `/fia` | Factory overview. |

**Added an example? Reconcile it before implementation.** `/example` only
researches and registers prior art; it does not silently change product scope.
After adding an example, run `/grill ai-docs/PRD.md` and explicitly point it to
the relevant `ai-docs/examples/<slug>/NOTES.md` so you can approve which
findings become product requirements. Then run `/map` with an instruction such
as `Reconcile the plan with the approved example findings; update the open
specs and tasks with what was added to the PRD.` Do this before `/task` or
`/goal`. Ideas you reject remain optional inspiration on the example shelf.

### In Claude Code / Cursor — the harness, interactive building

| Command | What it does |
| --- | --- |
| `/start` | Runs the same conditional architecture checkpoint, then initializes the project from the PRD: map, screens, tasks and design system. |
| `/dev [task?]` | Executes a dev task test-first (no argument = the next frontier task). |
| `/sv` | Save: build verification + git commit + database backup. |
| `/test-ui [flow?]` | Tests the UI in a real browser, with automated sign-in and issue detection. |
| `/team [task]` | Multi-agent orchestration: parallel specialist agents on one task. |
| `/restore` | Rolls code + database back to a previous save (destructive — confirms first). |
| `/grill`, `/stack`, `/absorb`, `/onboarding`, `/quick`, `/spec`, `/feature`, `/bug`, `/component`, `/theme`, `/ui-contract`, `/design`, `/example`, `/kit`, `/launch`, `/qa`, `/note` | The same planning, spec and design-system commands also live here. |

### Dashboards & utilities (npm scripts stamped into the project)

```bash
npm run tui           # terminal dashboard: tasks, specs, milestones, runs, Pi commands
npm run plan          # web viewer, "Plan" tab — everything /map created
npm run agents        # web viewer, "Agents" tab — engine/model per FDA
npm run fda:viewer    # the full web viewer (observability of every run)
npm run launch:check  # launch readiness: blockers/warnings before going live
npm run env:check     # which keys your declared stack still needs in .env.local
npm run loop:health   # five-dimension score of this project's agent work loop
npm run wiki:check    # which ai-docs/wiki/ pages the code has outgrown
npm run security:scan # L1 security scan (deterministic patterns, zero tokens)
npm run fda:rewind    # an FDA run's checkpoints, and undo it (restore-only)
npm run fda:verdict   # record what a closed run still owes → the next --resume
                      #   is bounded to exactly that
npm run notify        # show (or --test) the run-end notification targets
npm run fda:status    # is an FDA running in this repo right now?
npm run fda:cost-report # token cost breakdown: fresh input vs cache reads vs output per phase
npm run docs:commit   # commit ai-docs/ artifacts (docs only)
```

### Something not working? — the maintenance ladder

```bash
imp doctor                             # 1. what is wrong? (read-only, never touches a file)
imp fix                                # 2. put back what is MISSING (shows the plan, asks first)
npx impactus --update-runtime --dir .  # 3. imp/ + .pi/ outdated? re-stamp from a newer CLI
imp update                             # 4. update the CLI itself, Pi and the pinned extensions
```

`imp doctor` checks your subscriptions (Claude/Codex/Cursor/Grok Build), the core CLIs,
Pi and — inside a project — the install itself, and every finding ends in the
command that repairs it. `imp fix` only ever **restores what disappeared**
(deleted harness/runtime/skill files, the `AGENTS.md` block) and never
overwrites a file you changed: those are reported, not touched. Use
`--dry-run` to see the plan, `--yes --commit` to run it unattended with one
git commit per fix.

Three checkups sit next to that ladder, read-only until you say otherwise:
`imp health` scores five dimensions of your agent loop (understanding,
execution, validation, delivery, learning) from the project's own evidence and
names the command that repairs each finding — `--html` also writes
`imp/reports/loop-health.html`. Inside Pi, `/evolve --run <id>` or
`/evolve --since 14d` turns traces into a factual retrospective and proposes
the smallest durable workflow improvement; its reports stay under
`imp/reports/evolution/` and it never applies a recommendation. `imp rewind` lists the checkpoints of every
FDA run, previews the exact file impact of undoing one, and restores only with
`--yes`: it never resets, never rewrites history, so the rewind itself is
undoable. Long run? `imp notify` shows (and `--test` exercises) the ping that
fires when a run ends — off until you turn it on, and it can never fail a run.
For documentation drift, ask the agent for a project-knowledge audit: the
shipped `project-knowledge-audit` skill compares active rules and current-state
docs with repository evidence, while leaving historical decisions and intent
alone unless you explicitly request a correction.

Three more guards watch the factory itself. `imp stop` is the stop button:
arm it from any terminal (or just `touch imp/data/fia-stop`) and no new FDA
run starts while an in-flight one stops cleanly before its next phase — it
fails **closed** (even an unreadable stop file stops runs) and `--clear`
disarms it. `npm run gates:probe` (also `imp doctor --gates`) is the gate
self-test: it injects deliberate defects against throwaway fixtures and
asserts every quality gate goes red — the only check that measures the
harness instead of your code. And the **regression floor** rides along
automatically: after every green suite the runtime records how many test
files (and passing tests) it observed in `imp/data/floor.json`, and a later
"green" run that lost tests turns red until they come back — agents cannot
edit the floor, so deleting tests is never a way to pass. Sealed next to it,
`imp/data/holdout/` holds **holdout probes**: acceptance checks written when
a task's brief is created (before the code exists), agent-write-protected and
never quoted into the brief, and run after the suite goes green with no
automatic repair round (`npm run holdout`).

### Example 1 — from zero, WITHOUT the template (your own stack; works as guest)

```bash
npx impactus              # pick "Build my own stack" (or "I don't know yet")
cd my-app
imp                       # open Pi
/login openai-codex       # one time only
/idea                     # interview → PRD + the best stack (all into ai-docs/)
/stack                    # docs for each tech + CLIs, MCPs and skills
/grill                    # stress-test the PRD before building
/map                      # architecture when needed → screens, tasks, milestones
/task                     # Task 01: create the app/Foundation first
/theme                    # approve its visual identity (or `/theme accept`)
/goal                     # run every remaining task with that identity
npm run tui               # follow along in another terminal
```

`/theme` intentionally comes after the Foundation: without an executable app
there are no real components for its Current × Proposed preview. You can
instead run `/goal` immediately after `/map`; it builds the Foundation, pauses
at the same theme checkpoint for your decision, and then resumes.

Next.js remains the recommended/default frontend; Vue, Nuxt, Svelte or another
frontend is never inferred. When you explicitly request one, `/idea`/`/stack`
records it and `/map` requires concrete library/custom implementations for the
active UI surfaces. The Next/React `fia-universal` adapter then refuses to
write into the incompatible stack instead of silently changing it.

### Example 2 — from zero, WITH the ready-made template (signed-in students)

```bash
npx impactus              # sign in; pick "Recommended stack (ready-made template)"
# the CLI provisions everything: Convex + Clerk + keys + webhooks (+ GitHub/deploy)
cd my-app
npm run dev:convex        # terminal 1 — backend (watch + codegen)
npm run dev               # terminal 2 — Next.js → http://localhost:3000

# the app already runs — now shape it into YOUR product:
imp                       # open Pi
/grill                    # sharpen the PRD (template features are the baseline)
/map                      # plan screens + tasks on top of the template
/goal                     # let the FDAs build it — or /dev in Claude Code, task by task
```

### Example 3 — an EXISTING web app (brownfield)

```bash
cd my-app
npx impactus --dir .      # detects the existing project → harness + FIA only,
                          # nothing in your code is overwritten
imp
/onboarding               # guided pass: /absorb → /stack → /kit (as-built PRD,
                          # map, stack docs, design-system audit)
/feature "CSV export on the reports page"   # new feature → delta spec + tasks
/bug "login loops after logout"             # defect → proven RED, then the fix
/evolve --since 14d                          # repeated friction → local evidence report
/quick "rename the Save button"             # small change, no ceremony
/task                     # execute — or /goal for everything approved
```

## What you get

One command takes a project from zero to running locally — a SaaS starter
(Next.js + Convex + Clerk, single or multi-tenant) or your own stack — plus
the agent harness (skills, commands, gates) and the FIA runtime:

- **`imp/`** — the FDA runner: deterministic sequencers, quality gates, an
  observability SQLite, the terminal TUI and the web viewer.
- **`.pi/`** — Pi's project config: prompts, the `fia` skill and cookbooks.
- **`ai-docs/`** — the project's living documentation: PRD, stack manifest,
  specs, decisions, the component registry + live `/ui-components` page, and
  the repo wiki (`wiki/`, kept honest by `npm run wiki:check`).
- **Design system** — `/ui-components` demos the kit for real. Search
  highlights in yellow, Combobox dropdowns match the trigger, calendars jump
  month and year, tables filter from the header (chips, not a button farm),
  and each showcase card is one component.

## Requirements

- **Node.js >= 22.12**
- An **active [Impactus Academy](https://www.impactus.academy) enrollment**
  for the templates + automated pipeline (optional: without it the installer
  delivers the harness + agent only)
- Recommended, **not required** (the installer only warns and keeps going):
  **Claude Code** with a Claude **Pro/Max** subscription, and/or — for FIA's
  Codex roles — a **ChatGPT Plus/Pro** subscription (login at the end via
  `/login openai-codex` in Pi). **Grok Build** (`grok login`, xAI
  subscription) is picked up automatically as a third engine when present.
  With none, everything still installs; you get the best results with one of
  these, and other providers/models can be added later inside Pi with `/login`.

Everything runs inside these subscriptions — no API keys, no per-token
billing.

## Documentation

[`DOCS.md`](./DOCS.md) is the full documentation: install modes, the
pipeline, addons, the FIA runtime, the planning layer and the complete flag
reference. `npx impactus --help` lists every flag.

## Status & support

IMPACTUS CLI is **alpha** and distributed to enrolled students. Bug reports and
reproductions are welcome in the
[issues](https://github.com/elberrd/impactus-cli/issues); support and
onboarding happen inside the academy community.

## License

[MIT](./LICENSE) — covers this repository: the installer CLI and the runtime
it stamps (`fia-templates/`, `pi-templates/`). The project templates and the
agent harness are proprietary and live in private repositories — they are not
part of this package. The templates are delivered only to enrolled students;
the harness is served by the academy's API to any installer run.
