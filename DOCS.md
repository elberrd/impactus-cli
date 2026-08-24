# IMPACTUS CLI — Full documentation

Reference manual for **CLI v2**: architecture, pipeline, addons, template,
harness, **FIA — the IAI Agent Factory** and how to extend it. Getting started:
[README](./README.md).

> **v2 (`impactus`)** adds the FIA: Pi package (`.pi/`), Node runner
> (`imp/`), deterministic FDAs (`fda_*.mjs`), observability SQLite
> (`imp/data/fia.db`) and subscription-based authentication (Claude CLI + Pi/Codex).

**Contents**

1. [The three pieces](#1-the-three-pieces)
2. [Access: sign-in, guest mode and tokens](#2-access-sign-in-guest-mode-and-tokens)
3. [Install modes, stack paths and the pipeline](#3-install-modes-stack-paths-and-the-pipeline)
4. [Philosophy: maximal template, guided removal](#4-philosophy-maximal-template-guided-removal)
5. [Addons](#5-addons)
6. [Integrations: skills, CLIs and service keys](#6-integrations-skills-clis-and-service-keys)
7. [The Documents page (storage)](#7-the-documents-page-storage)
8. [The harness](#8-the-harness)
9. [FIA — the IAI Agent Factory](#9-fia--the-iai-agent-factory)
10. [The durable planning layer](#10-the-durable-planning-layer)
11. [The design-system layer](#11-the-design-system-layer)
12. [Pi command reference](#12-pi-command-reference)
13. [The web UI (`--ui`)](#13-the-web-ui---ui)
14. [Maintenance: `imp doctor`, `imp fix`, `--verify`, `--update-runtime`, `imp update`](#14-maintenance-imp-doctor-imp-fix---verify---update-runtime-imp-update)
15. [Recipes — worked examples](#15-recipes--worked-examples)
16. [Flag reference](#16-flag-reference)
17. [Environment variables](#17-environment-variables)
18. [Extending: a new addon, a new template](#18-extending-a-new-addon-a-new-template)
19. [CLI development](#19-cli-development)

---

## 1. The three pieces

| Piece        | Source              | What it is                                                              |
| ------------ | ------------------- | ----------------------------------------------------------------------- |
| **CLI**      | this repo (`impactus` on npm) | Interactive Node.js installer (ESM + @clack/prompts)      |
| **Harness**  | private repo (community API) | Agent-workflow scaffold (/start, /dev, /sv, 9 agents, skills) — **the base, always installed** |
| **Template** | private repo (community gated API) | Next.js 16 + Convex + Clerk + shadcn/Tailwind v4 app, with EVERYTHING implemented — **optional** |

The CLI **does not bundle** the template or the harness: both are downloaded at
install time **exclusively through the community API** — there is no direct
GitHub clone. The templates require the paying-student token; the harness is
also served **without** one (guest mode installs harness + FIA only — see §2).
The FIA/Pi runtime (`imp/` + `.pi/`) IS bundled in the npm package
(`fia-templates/`, `pi-templates/`) and stamped locally.

**Tenancy**: `--tenancy single` (default) downloads live1; `--tenancy multi`
downloads **live2** — multi-tenant with organizations owned by the
**app itself** (Convex tables; Clerk only authenticates identity): data and
billing per organization, roles (`admin`/`member`) with a per-module permission
matrix, email invites, mandatory onboarding and an `/admin` panel with user and
organization management. The `convex` JWT template is the SAME simple one in
both templates (no org claims) and the webhook subscribes only to `user.*` (and
is optional — `users.ensure` syncs on first login). Both templates ship the
`/admin` panel; in live2 the FIRST user to sign in becomes super-admin, and the
CLI additionally sets `SUPERADMIN_EMAILS` in Convex with the Clerk account
email during installation (extra bootstrap). Spec/roadmap: `live2-spec.md`
in the private `impactus-internal-docs` repo.

The overall shape of an install:

```
npx impactus
      │
      ├─► ACCESS — sign in (optional; valid session skips the question)
      │
      ├─► name/folder + MODE (harness only  |  harness + template)
      │
      ├─ full mode ──► DECISIONS: template (live1 | live2), addons, shadcn,
      │               │    deps, storage, webhook, GitHub, deploy, FIA —
      │               │    all at once, then one summary + confirm
      │               ├─► DOWNLOADS the template to a tmp (community gated API)
      │               ├─► install ──► reconciles the choice against the
      │               │    downloaded template.addons.json, then REMOVES
      │               │    everything that was not chosen
      │               ├─► Convex + Clerk + webhook + storage + skills/CLIs
      │               └─► GitHub + Vercel (optional)
      │
      ├─► harness merge (community download — always, in both modes)
      ├─► stack manifest + docs + tooling (ai-docs/stack.md)
      ├─► FIA stamp (imp/ + .pi/ from the bundled templates)
      ├─► Impeccable design skill (optional)
      └─► final summary + next steps
```

## 2. Access: sign-in, guest mode and tokens

Signing in is **optional** and is the first question of the installer
(`steps/auth.js`). What it decides:

| State | What the installer delivers |
| --- | --- |
| **Signed in**, active subscription | Everything: templates + the automated template pipeline (Convex, Clerk, keys, webhooks, GitHub, deploy) and the harness + FIA. |
| **Guest** (declined the sign-in) | Harness + FIA only. Every template path is locked (`steps/mode.js`), announced up front and again in the final summary. |
| **Inactive subscription** | Same as guest, after a renewal warning with the checkout URL. The saved token is kept — renewing reactivates it. |

The decision tree on every run:

1. `IMPACTUS_TOKEN` set (CI/automation) → verified; an invalid token **fails
   loudly** (automation never silently degrades to a harness-only install).
2. A saved token exists (`~/.impactus-cli/auth.json`) → verified. Valid →
   "Welcome back" and no questions. Expired/revoked (401) → cleared, the offer
   below includes a fresh login. Community unreachable (5xx/network) → the run
   exits WITHOUT deleting the credential ("your login is still saved").
3. Interactive → the "Sign in (optional)" note + a two-option select:
   **Sign in (recommended)** (device flow) or **Continue without signing in**
   (guest mode, `ctx.guest = true`).
4. `--yes` with no token → guest mode with a warning (there are no prompts to
   ask with); `--mode full` / `--stack recomendada` then error out instead of
   silently downgrading.

**Device flow** (OAuth 2.0 Device Authorization Grant, RFC 8628): the CLI
calls `POST /api/cli/device/start` on the community API, opens the browser at
the community's `/cli` page with a user code, and polls
`POST /api/cli/device/poll` until approved (10-minute deadline, `slow_down`
honored). The token is saved to `~/.impactus-cli/auth.json` (mode **600**) with
the API base and a device label (`<hostname> (<platform>)`) shown in the
student's token list. During an install, a DENIED authorization falls back to
guest mode (the run continues); `--login` standalone still exits 1.

**Access is revalidated on every use** (`GET /api/cli/verify` re-checks the
enrollment), and the template download re-checks it again server-side. The
harness tarball is served **without** a token (`PUBLIC_TEMPLATES` on the
community server) — harness + FIA are the free tier; `live1`/`live2` answer
`401 missing_token` to anonymous requests.

Subcommands (each authenticates/reports and exits):

```bash
npx impactus --login    # device flow now; errors out if denied
npx impactus --whoami   # "Authenticated as <name> — subscription active ✓" | inactive | expired
npx impactus --logout   # revokes server-side (best-effort) + deletes auth.json
```

State on disk — `~/.impactus-cli/` (dir mode 700; a pre-rebrand
`~/.create-iai/` found on the machine is RENAMED to this on first touch, so
the login, keys and logs survive — `src/lib/state-dir.js`):

| Path | What |
| --- | --- |
| `auth.json` | `{ token, apiBase, savedAt, label }`, mode 600. |
| `config.json` | Machine-wide preferences (today the `notify` block), mode 600 — hand-edited, read by `imp settings` and by the run notifier (§14.6). |
| `keys/<slug>.env` | Service keys pasted in the web UI (`--keys` reads them; mode 600, machine-local only). |
| `logs/run-<timestamp>.log` | Full log of each installer run (secrets redacted) — what students attach to bug reports. |

Dev/testing: `--api <url>` or `IMPACTUS_API` point the CLI at another
community deployment; a custom base prints a one-time warning (the saved token
is sent to that host).

## 3. Install modes, stack paths and the pipeline

### 3.1 The four stack paths

Right after name/folder, the CLI asks **how to start** (stored in
`ctx.mode` + `ctx.stackPath`, set in `steps/mode.js`):

| Path | Trigger | Mode | What happens |
|---|---|---|---|
| `template` | "Recommended stack" pick, `--stack recomendada`, `--mode full`, the `--yes` default in a new folder | `full` | Downloads the ready-made template and runs the full pipeline. The harness still comes in (last). |
| `custom` | "Build my own stack" pick, `--stack propria`/`custom`, or `--stack cat=opt` pairs | `harness` | The layer-by-layer wizard (§3.3). May switch to `full` mid-wizard when the choices match the recommended stack. |
| `discover` | "Not sure yet" pick, `--stack depois`, `--mode harness` in a new folder | `harness` | Everything pending — Pi (`/idea`) extracts PRD + stack later. |
| `brownfield` | Existing project detected (folder has `package.json` or `.git` and was not created by the CLI) | `harness` | `/absorb` maps the real stack and fills the manifest. `--stack depois` on an existing project also lands here. |

Flag precedence: `--stack` > `--mode`/`--harness-only` > `--yes`. A `--mode`
that conflicts with the mode `--stack` implies is a **hard error**. In guest
mode (§2) any flag that forces the template (`--mode full`,
`--stack recomendada`) throws a "needs the community sign-in" error rather
than silently downgrading, and interactive menus simply don't offer the
template path. A leftover install-state marker (a previous full install died
midway) is treated as a **resume** of the full install — never as an existing
project — and requires the sign-in.

The harness is **always** installed; the mode only decides whether the
template comes along.

### 3.2 Pipeline

The prelude (steps 1–5) always runs; the `[i/n]` counter only knows the exact
total after the mode is resolved (`main.js` builds the list in two phases — the
prelude, then the tail for the chosen mode).

**Prelude (always):**

| #  | Step | File | Notes |
| -- | ----- | ------- | ----- |
| 1  | Access — sign in (optional) | `steps/auth.js` | Valid session → "Welcome back"; otherwise offers the device-flow login. Declining sets **guest mode** (§2) |
| 2  | Engines — Claude Code and Codex | `steps/preflight.js` | Status only — NEVER blocks. Missing engine → install/login guidance and the run continues; the final summary repeats the roster with the exact commands |
| 3  | Name and folder | `steps/project.js` | `.` installs in the current folder |
| 4  | **How to start — mode + stack path** | `steps/mode.js` | Sets `ctx.mode` + `ctx.stackPath`; agent-files conflict policy asked here too |
| 5  | Your stack — layer by layer | `steps/stack.js` | Only the `custom` path asks; may switch `ctx.mode` to `full` (never for guests) |

**`full` mode (harness + template):** each step declares a CAPABILITY
(`core` always runs; `convex`/`clerk`/`shadcn`/`storage`/`mcps` only when the
template declares them in `requires` — see §4.4 and `src/lib/pipeline.js`).

| #  | Step | File | Notes |
| -- | ----- | ------- | ----- |
| 6  | **Decisions — assemble the installation** | `steps/decisions.js` | ALL questions at once (template variant, addons, shadcn, deps, storage, webhook, GitHub, deploy, FIA) + summary/confirm |
| 7  | CLIs (git, gh, vercel) | `steps/preflight.js` | Auto-install (git: PM, or the official installer on a PM-less Windows / the native CLT dialog on a brew-less Mac); logins only when push/deploy was chosen. NEVER blocks: availability is re-probed on the machine (no "did you install it?" self-reporting) and anything still missing is skipped with the person's consent — the fix lands in the final summary and `ai-docs/inbox.md`, and the dependent steps (commit/push, publish, deploy) degrade to manual notes |
| 8  | FIA — Pi install/update | `steps/preflight.js` | Codex login stays for AFTER the install; a failed Pi install degrades (continues without FIA) |
| 9  | **Template download** | `steps/project.js` | Community gated API (tarball) → tmp; reads the manifest |
| 10 | Install + prune + npm install | `steps/project.js` | Copies from tmp; applies addons BEFORE the install |
| 11 | Update deps (optional) | `steps/deps.js` | none / safe (patch/minor) |
| 12 | MCPs (Playwright, Convex) | `steps/project.js` | `claude mcp add` |
| 13 | shadcn preset + block | `steps/shadcn.js` | Optional |
| 14 | Convex — cloud project | `steps/convex.js` | Login + env; 1st push fails on purpose (issuer missing) |
| 15 | Clerk — app, keys, JWT | `steps/clerk.js` | `convex` JWT template (the SAME simple one in single and multi — no org claims) + issuer in Convex |
| 16 | Convex — publish functions | `steps/convex.js` | Also regenerates `_generated` |
| 17 | Clerk → Convex webhook | `steps/webhook.js` | Optional; subscribes only to `user.*` events (multi included) |
| 18 | Storage — Convex or R2 | `steps/storage.js` | R2 with wrangler assistant (bucket + CORS); consumes keys from `--keys` |
| 19 | **Keys — activate integrations** | `steps/service-keys.js` | See §6.1 — AI prompts, `--keys`, webhooks via API |
| 20 | **Integrations — skills and CLIs** | `steps/integrations.js` | See §6 |
| 21 | Git + GitHub | `steps/github.js` | Private/public repo, push |
| 22 | Vercel Preview deploy | `steps/deploy.js` | Optional (dev credentials stay in Preview) |
| 23 | Harness | `steps/harness.js` | Merge without overwriting anything (always) |
| 24 | Stack — manifest and docs | `steps/stack-docs.js` | `ai-docs/stack.md` + stack block in `AGENTS.md` |
| 25 | FIA — Pi + FDAs | `steps/fia.js` | Stamps `imp/` + `.pi/`, npm scripts, SQLite + the runtime manifest (§14.2) |
| 26 | Impeccable — design skill | `steps/impeccable.js` | Optional, default on; requires Node ≥ 22.12 |
| 27 | Final summary | `steps/finish.js` | URLs + integrations report + pending items |

**`harness` mode (harness only):**

| #  | Step | File | Notes |
| -- | ----- | ------- | ----- |
| 6  | CLIs (git) | `steps/preflight.js` | Binaries only — no gh, no Vercel (the harness always comes through the community API, token or not). Same never-blocks contract: git that can't be installed is skipped on request and the commit degrades |
| 7  | Harness | `steps/harness.js` | Merge into the folder; runs `git init` if missing |
| 8  | Stack — manifest, docs and tooling | `steps/stack-docs.js` | Manifest + `AGENTS.md` block + skills/CLIs/MCPs of the chosen techs (incl. Neon/Supabase dev DB) |
| 9  | FIA — Pi + FDAs | `steps/fia.js` | Stamps `imp/` + `.pi/` |
| 10 | Impeccable — design skill | `steps/impeccable.js` | Optional, default on |
| 11 | Final summary | `steps/finish.js` | Harness next steps (no `npm run dev`) |

Logs of each run: `~/.impactus-cli/logs/run-<timestamp>.log`.

### 3.3 The stack catalog and the layer-by-layer wizard

`src/stack-catalog.js` is the **single data source** for everything the
installer knows about stack layers: the wizard, the manifest renderer and the
tooling step are all driven by it. Adding a technology = one catalog entry
(docs/skills/CLI/MCP/envs), no logic changes. `depois` ("decide later") is a
valid answer in ANY category — the literal is a stored/CLI value kept for
compatibility.

The eight categories, in question order, and every option:

| Category | Options (default first) | Conditional logic |
|---|---|---|
| `frontend` | **`nextjs`** (Next.js App Router) | — |
| `backend` | **`convex`** (database + backend together, no API layer) · `hono` (own API — a route handler inside Next.js, single deploy) | — |
| `database` | **`neon`** (serverless Postgres, instant no-account provisioning) · `supabase` (Postgres + platform) · `convex` (built into the backend) | Only asked when `backend=hono`; `backend=convex` forces `convex`; `backend=depois` drags it to pending |
| `orm` | **`drizzle`** · `prisma` · `none` | Only asked when `backend=hono` (an ORM is mandatory there); `backend=convex` forces `none` |
| `auth` | **`clerk`** · `better-auth` (open source, lives in YOUR SQL database — not offered with the Convex backend) | — |
| `blob` | **`r2`** (Cloudflare R2) · `convex-storage` (Convex backend only) · `supabase-storage` (Supabase database only) | — |
| `automations` | **`none`** (in-app scheduling: Convex scheduled functions / Vercel crons) · `modal` (external compute: cron, queues, GPU, long-running Python — a SECOND deploy target, `pip install modal`, `modal setup`) | — |
| `deploy` | **`vercel`** (the only supported path today) | Still a real question — a `--stack` pair list that omits it leaves it pending |

The pure rule engine (`applyStackRules` in `src/lib/stack.js`) enforces the
combinations and **never silently drops an explicit choice** — an overridden
choice produces a printed warning (e.g. `ORM: "drizzle" ignored — the chosen
backend already defines this layer (not applicable).`). The golden rule: the
Convex backend means no API layer and no ORM; the Hono backend means SQL
database (Neon/Supabase) + ORM (Drizzle recommended, Prisma alternative).

Wizard behavior worth knowing: categories decided via `--stack` are not asked
(flags win); "Adjust the choices…" at the review panel reopens ALL layers,
including flag-set ones; if the final choices are exactly the recommended
stack (`matchesTemplateStack`: nextjs + convex + clerk + r2/convex-storage +
vercel — `automations` is ignored and survives as a manifest override), the
wizard offers to switch to the ready-made template (signed-in only; guests get
an informative note and keep building from the manifest). Under `--yes` the
flag choices stand, the rest stays pending, and the template-switch offer
never happens.

### 3.4 `--stack` grammar

```bash
npx impactus my-app --stack recomendada     # full mode: the ready-made template
npx impactus my-app --stack depois          # harness only, all layers pending
npx impactus my-app --stack propria         # harness, interactive wizard (alias: custom)
npx impactus my-app --stack backend=hono,db=neon,orm=drizzle
npx impactus my-app --stack banco=supabase,storage=supabase-storage,jobs=modal
npx impactus my-app --yes --stack backend=hono,db=neon,orm=drizzle,auth=clerk,blob=r2,frontend=nextjs,deploy=vercel,automations=none
```

Canonical categories: `frontend, backend, database, orm, auth, blob,
automations, deploy`. Aliases: `db`/`banco` → `database`, `arquivos`/`storage`
→ `blob`, `autenticacao` → `auth`, `jobs`/`automacoes` → `automations`. A
value with no `=` that isn't a known shortcut **aborts** (an unrecognized
value must never silently change the install type); an invalid pair warns and
that layer is asked again (or stays pending under `--yes`); a known category
with an unknown option is dropped with a warning at validation time.

### 3.5 DEV database provisioning (custom path)

Runs inside the stack-docs step, only when the chosen database is Neon or
Supabase and `.env.local` does not already carry a `DATABASE_URL` (an existing
one is always kept — the database is yours). Everything is fail-soft: a
network/CLI failure warns and prints the manual command; nothing aborts.

- **Neon, instant (recommended, no account)** — Neon Launchpad:
  `POST https://neon.new/api/v1/database` (20 s timeout). `.env.local` gets
  `DATABASE_URL` (+ `DATABASE_URL_DIRECT` when present) plus a claim-URL
  comment; the claim URL also lands in the manifest and as a terminal warning:
  **claim the database into your Neon account within ~72h or it expires**. A
  marker comment prevents a re-run from creating a second database.
- **Neon, in your account** — installs/logs into the `neon` CLI (`neon auth`,
  browser) and runs `neon projects create --name <slug> --output json`
  (2-minute timeout; retried once after a login). Secrets are redacted from
  the run log.
- **Supabase** — installs the `supabase` CLI (brew tap), probes login with
  `supabase projects list`, runs `supabase login` if needed, then
  `supabase projects create <slug>` **inherited**: the Supabase CLI itself
  asks organization, region and the database password — the password is typed
  into the CLI's hidden prompt, never passes through argv and never stays with
  the installer. The connection string comes from the dashboard (Connect) and
  is pasted into the installer (or added to `.env.local` later).
- **Later** — a manual hint is printed (e.g. `npx neon-new@latest --yes` for a
  claimable database, or `neon projects create`).

### 3.6 The stack manifest and the AGENTS.md block

`ai-docs/stack.md` is the **source of truth** agents read before planning,
implementing and launching. Written once by the installer (never overwritten
if present — `/stack` updates it), it carries: the source line
(template/installer/discover/brownfield), a per-layer Summary table with
local-docs pointers (`ai-docs/apis/<tech>.md`, generated by `/stack`), a
"Pending — decide before implementing" checkbox list with the decision rules,
a "Layers" detail section per decided technology (role, official docs,
llms.txt, CLI/MCP/skills, notes, test users for auth, Neon provision +
claim URL), and an "Environments — development × production" table (golden
rule: `.env.local` is development ONLY; every production env lives on Vercel
or the matching service — `/launch` guides the promotion).

`AGENTS.md` gets a compact mirror between `<!-- stack-start/end -->` markers —
decided layers, pending layers ("do NOT invent: stop and decide with the
engineer"), and the pointer to the manifest. Idempotent: marker present ⇒
never rewritten by the installer.

### 3.7 Tooling for the chosen technologies

Outside template mode, the stack-docs step equips the project for every
decided technology (deduped — Convex appears as backend AND database but its
tooling runs once):

1. **Skills** via skills.sh (see §6.2) — e.g. Neon installs `neon`,
   `neon-postgres`, `claimable-postgres`, `neon-postgres-branches` from
   `neondatabase/agent-skills`; Convex/Clerk/Better Auth/Cloudflare install
   their official sources.
2. **Official CLI** via `ensureIntegrationCli` — offered once per binary:
   brew → npm -g → pip fallback (Modal is pip), 5-minute timeout, then an
   optional browser login (default **no**). Convex is `viaNpx` — never
   installed globally. Under `--yes`: hint only, no install, no login.
3. **Official MCP** via `claude mcp add …` — e.g. Neon
   (`--transport http https://mcp.neon.tech/mcp`), Vercel
   (`https://mcp.vercel.com`), Convex (`add-json` with `npx convex mcp
   start`). Supabase and Clerk MCPs need a key/PAT, so the installer prints
   the note and `/stack` guides them later.

Pending layers install nothing — whoever decides later (Pi `/idea` or
`/stack`) gets the tools at decision time. The installer catalog is the
bootstrap; the first `/stack` pass re-verifies everything through the research
ledger (§10).

### 3.8 The decisions phase and the step-by-step behavior (full mode)

**Decisions** (`steps/decisions.js`) follow the professional-scaffolder
pattern: ALL questions first (template, addons, shadcn preset+block, deps,
storage, webhook, GitHub push + repo name + visibility, deploy, FIA,
Impeccable), then one summary panel, then a `Yes — start now / Adjust the
choices… / Cancel` confirm. "Adjust" reopens every question pre-filled with
the prior answers. Whatever a flag decided is never asked; capabilities the
template does not declare never become a question. Execution then runs end to
end with no further *decision* questions (logins/keys for chosen services may
still interact — the summary says so).

The `--yes` defaults, exactly: deps `none` · shadcn no preset + block
`sidebar-07` · storage `convex` (unless `--storage r2` + all four `R2_*` keys
in `--keys`, which configures R2 non-interactively) · webhook off (it needs a
manual dashboard action, so automation never turns it on) · push off (creating
a remote repo is irreversible) · visibility private · deploy off · FIA on ·
Impeccable on.

Step behaviors worth knowing:

- **Deps** — `safe` runs `npm update --save` (patch/minor inside the
  template's ranges). There is deliberately no `latest` mode (major bumps
  broke projects before the first `npm run dev`); the manual path is
  `npx npm-check-updates -i`, package by package, with the app running.
- **shadcn** — a pasted "Get Code" command runs verbatim; a bare code becomes
  `npx shadcn@latest apply <code>`. Blocks install with
  `npx shadcn@latest add -y -o <block…>` (deterministic, no mid-install
  prompts) and a **guard-rail** restores application code the block demo
  would clobber: modified tracked app files are checked out back to the
  baseline commit, unused new demo files are removed — the block's real value
  (`components/ui/*`, `hooks/*`, `lib/*`, deps) stays. `hooks/use-mobile.ts`
  is backed up/restored (the registry version fails the template's eslint and
  would block every commit). A warn-only `npx tsc --noEmit` closes the step.
- **Convex** — two phases. `setupConvex` logs in
  (`npx convex login --device-name "impactus installer"`) and provisions
  with `npx convex dev --once --configure=new --project <slug>
  --dev-deployment cloud --tail-logs disable`; success is judged by the env
  vars, NOT the exit code — the very first push fails ON PURPOSE
  (`auth.config.ts` reads `CLERK_JWT_ISSUER_DOMAIN`, which Clerk sets next).
  A crashed re-run that finds `CONVEX_DEPLOYMENT` + `NEXT_PUBLIC_CONVEX_URL`
  in `.env.local` reconnects with a plain `dev --once` instead of creating a
  SECOND cloud project. `NEXT_PUBLIC_CONVEX_SITE_URL` is derived
  (`.convex.cloud` → `.convex.site`). `finalizeConvex` publishes the
  functions after Clerk (also regenerates `convex/_generated`); its failure
  is only a warning ("run `npx convex dev`").
- **Clerk** — deterministic provisioning through the pinned
  `npx -y clerk@3.1.0 --mode agent` (no global install/floating version).
  Authentication uses `clerk auth login`; `whoami --json`, `apps ... --json`
  and the API responses are parsed structurally. Selection precedence is
  `--new-clerk-app` → `--clerk-app <app_id>` → the valid project link stored
  by Clerk → one exact-name app → interactive choice/create. Duplicate exact
  names abort under `--yes`, preventing duplicate apps. The CLI pulls the dev
  keys, validates the pk/sk environment and proves the secret key resolves to
  the selected development instance, then reconciles the `convex` JWT template
  (`{"name":"convex","claims":{"aud":"convex"},"lifetime":3600}`). A
  new app is reconciled automatically; a reused app shows the diff and needs
  confirmation (`--yes` fails closed). Clerk Billing is enabled when selected.
  The issuer derived from the verified publishable key is written as
  `CLERK_JWT_ISSUER_DOMAIN` on Convex, the Clerk account email seeds
  `SUPERADMIN_EMAILS`, and read-only `clerk doctor --json --spotlight` closes
  the step. `--fix` is never automatic.
- **Webhook** — semi-automatic by necessity (endpoint + signing secret are
  dashboard-only in Clerk): the CLI mints the Svix dashboard URL via the
  Clerk API, prints exactly what to paste
  (`https://<name>.convex.site/clerk-users-webhook`, events `user.created`,
  `user.updated`, `user.deleted`), captures the `whsec_` secret (written to
  `.env.local` FIRST, then set on Convex under BOTH names —
  `CLERK_WEBHOOK_SIGNING_SECRET` (the canonical name, which the templates'
  `convex/http.ts` now reads with a legacy fallback) and the legacy
  `CLERK_WEBHOOK_SECRET`, kept so projects generated from older template
  versions (which read only the legacy name) stay working. Both templates
  sync the signed-in user on first load via `users.ensure`, so the webhook is
  optional for signup; it is what keeps external profile changes and
  deletions in sync.
- **GitHub** — commit `feat: project configured by impactus (Convex +
  Clerk + shadcn/ui)`; a lefthook/eslint rejection shows the lint output and
  the documented escape hatch `LEFTHOOK=0 git commit -m "initial setup"`
  (never misblamed on git identity). Push runs `gh repo create <name>
  --private|--public --source=. --remote=origin --push`.
- **Deploy** — `vercel link --yes --project <slug>`, then an **additive Preview-only** env
  sync (only missing keys are added; existing Vercel values are kept, with a
  note when they differ from `.env.local`; values travel via stdin, never
  argv; `CONVEX_DEPLOYMENT` is deliberately not copied — CLI-only var), then
  `vercel deploy --yes`. The URL uses the DEV Convex backend and DEV Clerk
  keys, all scoped to Vercel `preview`; the installer never copies them to
  Production. `/launch` is the explicit production promotion and blocks until
  matching `pk_live_`/`sk_live_`, Convex Production, a production webhook and
  the final own domain are present.

Clerk's development-key and telemetry notices are expected locally and in
Preview. Telemetry keeps the official default; opt out with
`npx -y clerk@3.1.0 telemetry disable`, `CLERK_TELEMETRY_DISABLED=1`, or the
standard `DO_NOT_TRACK=1`. Cookie cleanup is troubleshooting only for a 431,
login loop, or an intentional instance switch. Existing apps follow
`CLERK_MIGRATION.md`; no codemod is applied.

## 4. Philosophy: maximal template, guided removal

Instead of the CLI *generating* code (fragile, hard to test), the template
ships with **all integrations implemented and working together** — and the CLI
**removes what the user did not choose**. The order is: **decide** (all addon
questions in the decisions phase) → **download** → **reconcile** (against the
downloaded manifest) → **prune** → `npm install`. Three mechanisms, all
described in the `template.addons.json` manifest (at the template root):

### 4.1 Markers in the code

Snippets belonging to an addon sit between markers:

```ts
// live1:addon:sentry:start
import { withSentryConfig } from "@sentry/nextjs"
// live1:addon:sentry:end
```

Stripper rules (`src/lib/addons.js` — pure, tested):

- Addon **not chosen** → the whole block is deleted.
- Addon **chosen** → the code stays; the marker lines disappear.
- **Inverse block** `live1:addon!:<id>` → only exists when the addon was NOT
  chosen. Real example from `next.config.ts` — the minimal baseline CSP vs.
  the full CSP of the `csp` addon:

  ```ts
  // live1:addon!:csp:start
  { key: "Content-Security-Policy", value: "frame-ancestors 'self';" },
  // live1:addon!:csp:end
  // live1:addon:csp:start
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  // live1:addon:csp:end
  ```

- Works in any text file — the marker is matched anywhere in the line, so any
  comment syntax works: `//` (TS/JS), `{/* */}` (JSX), `#` (YAML,
  `.env.example`), `<!-- -->` (md). Nested blocks are supported; stray/extra
  `end` markers are tolerated instead of corrupting output.
- The scan skips `node_modules`, `.git`, `.next`, `_generated`, `public`,
  files over 1 MiB, and any file without the `live1:addon` substring; only
  text extensions are touched. The literal `live1:` prefix is the fixed
  protocol string in EVERY template (live2 included) — not per-template.
- **Virtual ids** (`manifest.virtual`) join the keep-set when ANY member addon
  was chosen; they exist only for markers shared by several addons — e.g.
  `billing-ui` (stripe|asaas|clerk-billing → the "Subscription" sidebar item)
  and `signup-hooks` (notifications|resend → the new-signup hooks import).

### 4.2 Files/dependencies manifest

`template.addons.json` lists, per addon: `files` (deleted), `dependencies`/
`devDependencies` and `scripts` (pruned from package.json). A file listed by
more than one addon (e.g. `app/dashboard/billing`, shared by stripe/
asaas/clerk-billing) is only deleted when **none** of them was chosen.
Emptied parent folders are removed too. A representative real entry:

```json
"sentry": {
  "label": "Sentry (+ Spotlight no dev)",
  "files": ["sentry.server.config.ts", "sentry.edge.config.ts",
            "instrumentation-client.ts", "app/global-error.tsx"],
  "dependencies": ["@sentry/nextjs"],
  "devDependencies": ["@spotlightjs/spotlight"],
  "scripts": ["dev:spotlight"]
}
```

### 4.3 Recording the choice

The generated project gets `imp/iai.config.json` (older versions kept it at
the root):

```json
{ "createdWith": "impactus", "addons": ["analyzer", "commitlint", "csp", "knip", "rate-limit", "sentry"] }
```

and the manifest is removed. `npm install` runs only after the pruning (never
downloads what was cut) and `convex dev --once` (the Convex step) regenerates
`convex/_generated` for the reduced set. After the install the CLI runs
`npx prettier --write .` and amends the initial commit
(`chore: initial template (impactus)`, with `LEFTHOOK=0` so the project's
fresh git hooks don't fire on the internal amend) — stripping blocks can leave
formatting Prettier would rewrite, and the amend keeps `format:check` green in
the generated project's CI. `.env.local` is seeded from the already-pruned
`.env.example` (born clean — no dead config for unchosen addons) and the four
Clerk routing defaults are always upserted.

### 4.4 Template catalog and the template's addon catalog

`TEMPLATES` (`src/config.js`) is the single source of installable templates
(live1 single-tenant, live2 multi-tenant). Each entry declares `repo`
(documentational — the real allowlist lives on the community server),
`available` (publication gate: `false` hides it from the select AND
hard-errors an explicit `--template-id`), `strip` (folders deleted right after
extraction — both templates strip `packages/`), `tenancy` and `requires` — the
capabilities the pipeline turns on (`convex`, `clerk`, `shadcn`, `storage`,
`mcps`; pure helper in `src/lib/pipeline.js`). The choice comes from
`--template-id` (or the legacy `--tenancy` shortcut, or an interactive
question). There is no direct fork/clone flag: the download is always the
gated one, by the catalog `id`; `--template-ref <branch|tag>` tests a template
branch through the same gate.

The addon CHOICE happens in the decisions phase, against the CLI's built-in
catalog — but the downloaded `template.addons.json` may declare its own
`groups`/`presets` fields (same format as `ADDON_GROUPS`/`ADDON_PRESETS`).
When it does, `reconcileAddons` makes the TEMPLATE'S catalog win after the
download: flag-driven selections are re-resolved from scratch against it;
interactive selections are intersected (ids the template doesn't know are
dropped with a warning; template options the CLI never asked about stay out,
with a pointer to the project README). A new template can expose its own
options without a CLI release. Today neither live template declares them, so
the built-in catalog applies end to end.

To ADD a template: an entry in `TEMPLATES` + repo on the community backend's
allowlist (`cli-paid-gate.md`, private `impactus-internal-docs` repo) +
`TEMPLATE_GITHUB_TOKEN` scope. See §18.

### 4.5 Crash recovery: the state marker, resume and rollback

- `installTemplate` writes `.impactus-cli-state.json` into the target FIRST
  (`{ version, startedAt, mode }`); the finish step removes it. A leftover
  marker therefore means a full install died midway. Installs started by a
  pre-rebrand CLI wrote `.create-iai-state.json` — readers accept both names
  (`hasStateMarker`) and the finish step removes both.
- A folder with the marker is a **resume**, never an "existing project":
  re-running the installer there warns, recommends continuing the full
  install (the pipeline is idempotent — it reuses the folder, `.env.local`
  and any cloud resources instead of duplicating Convex/Clerk), and skips the
  agent-files question (the agent files present are the template's own
  half-copied tree). Guest mode + marker is a hard error — only the gated
  template flow can resume safely.
- On a fatal error or Ctrl-C, the CLI cleans the tmp download and — only for
  folders it CREATED itself — offers to delete the partial project (default
  no; never under `--yes`). If `.env.local` already points at cloud services,
  it warns first that deleting the folder does NOT delete them and that
  `.env.local` is the only local record (dashboard.convex.dev,
  dashboard.clerk.com, console.neon.tech).

### 4.6 Agent-files conflict policy

A target folder that already has agent files (`.claude`, `.cursor`,
`.cursorrules`, `.agents`, `.pi`, `.windsurf`, `.windsurfrules`, `CLAUDE.md`,
`HARNESS.md`, `imp/HARNESS.md`) gets the question up front (or
`--agent-files add|replace`):

- **add** (default) — only what's missing is copied; every pre-existing file
  wins. In full mode the template copy protects those subtrees and merges
  them per-file.
- **replace** — the current agent files are MOVED (never deleted) to
  `.agents-backup-<YYYY-MM-DD_HH-mm-ss>/` inside the project, then the
  incoming ones land.

App code, `ai-docs/`, `docs/`, `AGENTS.md` (always append-merged), root
`.mcp.json` and `imp/` are never part of the policy.

## 5. Addons

### 5.1 Groups and presets

| Group (flag) | Options | Default (`padrao`) |
| ------------ | ------ | ----------------- |
| `--addons` (Quality/DX) | `commitlint`, `knip`, `analyzer` | commitlint, knip, analyzer |
| `--observability` | `sentry`, `logging` | sentry |
| `--analytics` (single) | `none`, `posthog`, `vercel-analytics` | none |
| `--security` | `csp`, `rate-limit` | csp, rate-limit |
| `--emails` (single) | `none`, `resend` | none |
| `--platform` | `notifications` | none |
| `--payments` (single) | `none`, `stripe`, `asaas`, `clerk-billing` | none |

**Presets** (`--preset`): `minimo` (nothing), `padrao` (the recommended set),
`saas` (padrao + logging, posthog, notifications, resend, stripe). `completo`
predates the english-first rename and is a deprecated alias of `saas`
(accepted with a warning; no longer listed in pickers).

**Precedence**: group flag > `--preset` > default (`padrao`). A group flag
fully overrides its group; the other groups keep their preset values. Lists
accept `none` and `all`. The three `single` groups are validated at parse time
(a bad `--payments` value is a fatal error); multi-group values are validated
at resolve time (bad ones warn and are ignored). Examples:

```bash
npx impactus my-saas --preset saas --payments asaas      # saas set, stripe swapped for asaas
npx impactus my-mvp --preset minimo --observability sentry --yes
npx impactus my-app --yes --addons none --security csp   # padrao base, quality emptied, security reduced
```

Interactively, the decisions phase offers the presets (`Default
(recommended)` / `Minimal` / `SaaS` / `Customize…` — one question per group,
recommended options pre-selected), then one summary with an
"Adjust the choices…" loop before anything executes. Under `--yes` the
`padrao` preset applies and the summary is informational.

**Always included** (not a choice): TypeScript strict, T3 Env (env vars
validated at build), Vitest + convex-test, Playwright, ESLint + Prettier,
Lefthook, SEO (sitemap/robots/OG), CI, Dependabot, `.vscode`, i18n pt-BR/en,
**Documents** page (upload → Convex Storage or R2, decided at runtime).

### 5.2 What each addon turns on in the template

| Addon | Key files | Envs (where) |
| ----- | -------------- | ----------- |
| commitlint | `commitlint.config.mjs` + commit-msg hook in `lefthook.yml` | — |
| knip | `knip.json`, `check:deps` script | — |
| analyzer | wrapper in `next.config.ts`, `build-stats` script | — |
| sentry | `sentry.*.config.ts`, `instrumentation*.ts`, `app/global-error.tsx` | `NEXT_PUBLIC_SENTRY_DSN` (+ ORG/PROJECT/AUTH_TOKEN for sourcemaps) |
| logging | `lib/logger.ts` (LogTape, JSON in prod) | — |
| posthog | `components/analytics/posthog-provider.tsx` | `NEXT_PUBLIC_POSTHOG_KEY` |
| vercel-analytics | `<Analytics />` in `components/analytics.tsx` | — |
| csp | full CSP in `next.config.ts` (inverse block removes the baseline) | — |
| rate-limit | `convex/lib/rateLimiter.ts` + calls in mutations | — |
| notifications | `convex/notifications.ts`, `convex/lib/notificationKinds.ts` registry, bell in the header; email channel when resend is also present (`signup-hooks` virtual) | — |
| resend | `convex/emails.ts` + single template `convex/lib/emailTemplate.ts` + scheduling in `users.upsertFromClerk` | `RESEND_API_KEY` (Convex) |
| stripe | `convex/stripe.ts`, `convex/subscriptions.ts`, `/stripe-webhook` webhook, billing page | `STRIPE_*` + `SITE_URL` (Convex) |
| asaas | `convex/asaas.ts`, `convex/assinaturasAsaas.ts`, `/asaas-webhook` webhook, billing page, skill | `ASAAS_*` (Convex) |
| clerk-billing | `components/billing/clerk-pricing.tsx` (PricingTable) | plans in the Clerk dashboard |

All degrade gracefully without their key (no-op/warning), so the app runs
immediately after the install and each service is activated whenever you want.

## 6. Integrations: skills, CLIs and service keys

For each chosen addon with official tooling, the CLI installs the **agent
skills** into the project (via [skills.sh](https://skills.sh), recorded in
`skills-lock.json`) and offers to install/log into the **official CLI**
(pipeline step 20):

| Addon  | Skills (`npx skills add …`)  | Official CLI | Login | Keys/dashboard |
| ------ | ---------------------------- | ----------- | ----- | -------------- |
| stripe | `https://docs.stripe.com` (all) | `stripe` (brew `stripe/stripe-cli/stripe`) | `stripe login` | https://dashboard.stripe.com/apikeys |
| sentry | `getsentry/sentry-for-ai` — only the 4 relevant of ~35: `sentry-nextjs-sdk`, `sentry-get-started`, `sentry-debug-issue`, `sentry-fix-issues` | `sentry-cli` (npm `@sentry/cli`) | `sentry-cli login` | https://sentry.io/settings/auth-tokens/ |
| resend | `resend/resend-skills` (all)  | `resend` (npm `resend-cli`) | `resend login` | https://resend.com/api-keys |
| asaas  | — (no official skills; PROJECT skill in `.claude/skills/asaas`) | — (no CLI; REST API) | — | https://sandbox.asaas.com · https://www.asaas.com |
| r2 (storage) | `cloudflare/skills` (cloudflare + wrangler) | `wrangler` | `wrangler login` | dash.cloudflare.com → R2 |

`ensureIntegrationCli` is shared with the stack-tooling step (§3.7): each
binary is offered ONCE per install; install order brew → npm -g → pip
(5-minute timeout each); the login confirm defaults to **no**; `--yes` prints
the hint and installs/logs nothing. Everything is best-effort: a network
failure on skills never aborts the installation, and the final summary lists
the commands to redo it manually.

### 6.1 Service keys, AI prompts and `--keys` (step 19)

Central catalog: `SERVICES` in `src/config.js` — for each external service
(Clerk, Convex, Stripe, Asaas, Resend, Sentry, PostHog, R2) it declares what
is automatic, the envs (exact name, `convex`/`local` destination, format
regex) and the AI prompt steps. Three consumers:

1. **Web UI (`--ui`)** — "Integrations & keys" section: each service becomes a
   card with its status (✅ automatic at install · optional key), a
   **"Copy AI prompt"** button (to paste into a browser-automation extension,
   e.g. Claude in Chrome — the agent finds/creates the keys in the dashboard
   and returns `KEY=value` lines), a paste box that fills the fields by
   itself, and regex-validated fields. Pasted keys are saved to
   `~/.impactus-cli/keys/<slug>.env` (permission **600**, machine-local only)
   and the generated command references the path via `--keys` — no secret ever
   appears in the command/history.
2. **Terminal (`steps/service-keys.js`)** — same flow without the UI: per
   service, a select offers "See the AI prompt and paste the keys" (default) /
   "I already have the keys — paste now" / "Skip — activate later (the
   feature stays dormant, nothing breaks)". Each env is validated against its
   regex (masked prompt for secrets) and written where the template reads it
   (`npx convex env set` + mirror in `.env.local`, or `.env.local` only for
   the `NEXT_PUBLIC_*` ones).
3. **Webhooks via API** — with the key in hand, the CLI creates the
   **Stripe** webhook (`POST /v1/webhook_endpoints` with the events
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, the `api_version` pinned to the
   stripe-node version INSTALLED in the project, capturing the `whsec_`) and
   the **Asaas** one (`POST /v3/webhooks` — production or sandbox base per
   `ASAAS_ENV` — with `authToken` = the locally generated
   `ASAAS_WEBHOOK_TOKEN`, the same value the backend validates in the
   `asaas-access-token` header) pointing to
   `https://<deployment>.convex.site/...`. Failed? It prints the manual step.

The exact env catalog this step applies:

| Service | Env (destination) | Validation |
| --- | --- | --- |
| stripe | `STRIPE_SECRET_KEY` (Convex, secret) | `^(sk\|rk)_test_…` — TEST keys only; restricted `rk_test_` accepted, `sk_live_` rejected |
| | `STRIPE_PRICE_ID` (Convex) | `^price_…` |
| | `STRIPE_WEBHOOK_SECRET` (Convex, auto via API) | `^whsec_…` |
| | `SITE_URL` (Convex, auto) | `http://localhost:3000` in dev |
| asaas | `ASAAS_API_KEY` (Convex, secret) | `^\$?aact_…` |
| | `ASAAS_ENV` (Convex, user) | `production` \| `sandbox` |
| | `ASAAS_VALUE` (Convex, user) | e.g. `49.90` |
| | `ASAAS_WEBHOOK_TOKEN` (Convex, generated locally) | random 24-byte base64url |
| resend | `RESEND_API_KEY` (Convex, secret) | `^re_…` — test mode until a domain is verified (`EMAIL_FROM`, `RESEND_TEST_MODE=false` for prod) |
| sentry | `NEXT_PUBLIC_SENTRY_DSN` (.env.local) | `https://…@…/<id>` |
| posthog | `NEXT_PUBLIC_POSTHOG_KEY` (.env.local) | `^phc_…` |
| | `NEXT_PUBLIC_POSTHOG_HOST` (.env.local) | `https://us.i.posthog.com` or `https://eu.i.posthog.com` |

Extra `--keys`-only keys (applied straight to Convex when the matching addon
was chosen): `EMAIL_FROM`, `RESEND_TEST_MODE`, `ASAAS_DESCRIPTION`.

Security rules: every secret is redacted from the run log; a dashboard env
left at its factory default activates nothing; everything is optional (without
a key the addon degrades as always); the final summary shows the report
(`ctx.serviceReport`) and offers to delete the keys file that was used.

### 6.2 Agent skills — the skills.sh standard

Every official skill (this step, the storage step and the stack step) goes in
through the same door: `src/lib/skills.js`, which drives the
[skills.sh](https://skills.sh) CLI — the `skills` npm package, the standard the
vendors publish against. The sources are declared as data:
`ADDON_TOOLING[*].skills` and `OPTIONAL_SKILLS` in `src/config.js`, `skills`
per option in `src/stack-catalog.js`.

On disk, per engine:

| Engine | Path | How it gets there |
| ------ | ---- | ----------------- |
| Cursor | `.agents/skills/<name>/SKILL.md` | the canonical store, read directly ("universal") |
| Claude Code | `.claude/skills/<name>` | symlink to the store |
| Pi (FIA agents) | `.agents/skills/<name>` | native `.agents/` discovery — no copy of its own |

`skillsAddArgs(spec, agents)` builds the argv and `installProjectSkills` runs it
**once**, with `-a claude-code cursor`. Measured against skills@1.5.22
(Aug 2026): `-a claude-code` alone never creates `.agents/skills/` (Cursor gets
nothing), and the comma form `-a a,b` is rejected and installs nothing. The
`-a` stays last in the argv so the variadic cannot swallow the `-y`. A failure
warns without failing the step (as ever, nothing about skills aborts an
install; the manual command is printed).

Pi needs no leg of its own: it scans the project's `.agents/skills/` natively
(behind the same project-trust gate as `.pi/skills/`, in interactive and
headless runs alike), so one canonical copy serves the three engines. Older
CLI versions DID run a second `skills add … -a pi` per source — and since Pi
dedupes discovered skills by realpath, that real copy made every skill load
twice and opened each Pi session with a "Skill conflicts" panel listing all of
them. `prunePiSkillCopies(dir)` cleans those leftovers: lock-driven (so
harness-owned skills like `.pi/skills/fia/` are never touched) and
conservative (a copy is only removed when its `.agents/skills/` canonical
exists). It runs in the FIA step and in `--update-runtime`, which is how
projects stamped by the old flow heal on their next update.

The install is recorded in `skills-lock.json` (v1: `{version, skills: {<name>:
{source, sourceType, skillPath, computedHash}}}`), which the project commits —
`.agents/` and the vendor folders under `.claude/skills/` are gitignored. Hence
the commands worth knowing in the generated project:

```bash
npx skills list                  # what is installed
npx skills find <query>          # search the catalog (--owner <org> to narrow)
npx skills update [name]         # update one skill, or all
npx skills experimental_install  # restore everything from skills-lock.json
```

`npx skills use <pkg>@<skill>` prints a single skill's prompt without
installing anything — handy for a one-off. And `--verify` audits the coverage
(see §14.1).

## 7. The Documents page (storage)

Always present at `/dashboard/documentos`: multi-file upload with
drag-and-drop and progress, download via signed URL and deletion with
confirmation. The backend decides the destination at **runtime**:

- **Convex File Storage** (default, zero config): `ctx.storage.generateUploadUrl`.
- **Cloudflare R2**: activates when the four envs `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` exist in the Convex
  deployment — a partial fill just stays on Convex Storage until completed.
  Uses the official `@convex-dev/r2` component; the endpoint is derived from
  the Account ID.

Validation (MIME allowlist + 25 MB) is server-side in `convex/documentos.ts`;
the browser sends the binary STRAIGHT to storage via signed URL.

The storage step (pipeline step 18) wires R2 with a **wrangler assistant**:
installs/logs into `wrangler` if wanted, picks the Cloudflare account from
`wrangler whoami`, creates the bucket (suggested name `<project>-files`;
"already exists" counts as success) and applies the CORS policy — Cloudflare's
`rules`/`allowed` JSON shape, NOT AWS S3 style:

```json
{ "rules": [ { "allowed": {
    "origins": ["http://localhost:3000"],
    "methods": ["GET", "PUT"],
    "headers": ["Content-Type"] },
  "maxAgeSeconds": 3600 } ] }
```

(an extra production origin can be added during the prompt). The one thing
wrangler cannot do is the **S3 API token** — dashboard-only, Secret shown only
once: `Cloudflare → R2 → Manage API Tokens → Create API Token`, minimum scope
"Object Read & Write" on the project bucket. The four values are prompted
(masked for the secret), set with `npx convex env set` and mirrored into
`.env.local`. Fully non-interactive R2 is possible with
`--yes --storage r2 --keys <file>` when the file carries all four keys (the
R2 AI prompt returns exactly that). The installer also installs the official
Cloudflare agent skills (`cloudflare` + `wrangler`) so the coding agent knows
R2 by heart from day one.

## 8. The harness

**The installer's base — always installed**, in both modes. Downloads the
harness through the community API (the only path — with the student token, or
anonymously in guest mode: harness + FIA are the free tier)
and merges **without overwriting anything** — existing files
win, the harness `README.md` becomes `imp/HARNESS.md`, and its `AGENTS.md` is
appended to the project's between the `<!-- harness-start/end -->` markers.
For Claude Code AND Cursor it brings **22 slash commands**, 9 specialist
agents, 6 skills and the whole `ai-docs/` scaffold: PRD template, maps,
task roadmap (`todos/`), specs (`specs/0000-example.md`), milestones, inbox,
decisions/, ui/ (interaction patterns), components/ (140+ reference docs),
apis/, examples/, `wiki/` (the page contract in `wiki/README.md` + the optional
`wiki-plan.yaml` — §10) and `start/map-start.yaml`.

Skills shared with the templates (`HARNESS.templateOwnedPaths` — the four
professional ones, in `.claude/skills` and `.cursor/skills`): the harness is
the SINGLE SOURCE of this material. In `full` mode the harness copy of a path
is discarded only when the installed template actually shipped that path
(the merge runs after the template install, so the destination already
reflects it) — a template that brings its own variant wins in that path
(live2 ships only `security`, its multi-tenant variant), and a template
without the skill inherits the harness version. In `harness` mode (no
template) everything comes from the harness. The `asaas` skill belongs to an
addon and lives only in the templates.

In `full` mode it runs last (the git repo already exists, created during the
template install); in `harness` mode the folder may have no git — the step
runs `git init` before the best-effort commit. The `--no-harness`/
`--skip-harness` flags only apply in `full` mode (template WITHOUT the
harness); in `harness` mode they are ignored with a warning.

**Extraction and the Windows symlink fallback.** Every gated download
(harness AND templates, `src/lib/template-fetch.js`) unpacks with the system
`tar` first; when it is missing or fails, a built-in pure-JS extractor
(`src/lib/tar-extract.js`) re-extracts from scratch. The case that motivates
it: the harness ships 50+ mirror symlinks (`.agents/*` and `.cursor/agents/*`
pointing into `.claude/` and `.cursor/`), and Windows' bundled tar cannot
CREATE symlinks without a privilege students don't have (admin shell or
Developer Mode) — every link died with "Invalid argument" and the install
aborted as a false "corrupted download". The built-in extractor tries a real
link first and, on the first failure, MATERIALIZES every link as a copy of
its resolved target instead — each engine still finds real content at its
mirrored path, and the machines that do allow symlinks keep them. Only when
both extractors refuse the bytes does the run fail (`extract_failed` — a
genuinely corrupted download). The same degradation exists in `imp fix`
(§14.5): restoring a `link:` manifest entry falls back to copying the
target when `symlink()` is denied.

The harness also ships `.claude/settings.json` with
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (required by `/team`) and the two
fda-lock hooks (SessionStart warn + PreToolUse gate — the read-only guard
while an FDA runs, §9.5), plus `.mcp.json`/`.cursor/mcp.json` with the
`playwright` and `convex` MCP servers. Both are launched through npx **with
`-y`**: without it, a cold npx cache puts its "Ok to proceed?" prompt on the
MCP stdio channel and the server dies before the handshake — the classic
"Connection closed" on a student's first run (Windows especially). `imp
doctor` warns about any npx MCP server missing the flag and `imp fix` adds it
(§14.4–14.5).

**The stamp manifest.** Right after the merge, the step writes
`imp/.harness-manifest.json` — the harness counterpart of
`imp/.runtime-manifest.json` (§14.2). It is built from the ADAPTED clone
(`README.md` already renamed to `imp/HARNESS.md`, `AGENTS.md` removed for the
marker merge, template-owned paths discarded), so its keys are exactly the
project-relative paths the harness shipped; each value is the sha1 of the
harness content, or `link:<target>` for a symlink (the merge copies links
verbatim, so the recorded target is what a healthy disk must show). On a
Windows machine where the extractor materialized the links as copies, the
clone has real files at those paths — the manifest then records content
sha1s, which matches that disk just the same.

That baseline is what makes a missing/pristine/modified classification
possible for harness files: `imp doctor` reports it and `imp fix` restores
the missing ones. A file the merge KEPT — the project's version won the
no-overwrite rule — records the HARNESS sha on purpose: it then reads as
"differs from the stamp", which is the truth, and it keeps `imp fix` from
ever silently overwriting your version. Projects installed by an older CLI
have no manifest (doctor says so); the next harness stamp records one.

### 8.1 Command reference (Claude Code / Cursor — all 22)

The core build loop:

| Command | What it does |
| --- | --- |
| `/start [--components] [--restart]` | Conditional architecture checkpoint, then the existing 6-step initialization: PRD check → `screens-routes.md` → task breakdown (vertical slices, one issue file per task with `Blocked by:`, specs + milestones) behind a **mandatory approval checkpoint** → `map.yaml` → component registry seeding → live `/ui-components` page. The checkpoint writes optional `architecture.md` only for consequential choices and never renumbers `workflow_progress`. Resumable; `--restart` starts over; `--components` skips the step-5/6 confirmation. Missing PRD stops with a `/grill` suggestion. |
| `/dev [task?]` | Executes ONE dev task test-first. No argument = the next **frontier** task (pending, all blockers done). The `task-sequencer` writes a just-in-time brief in `ai-docs/actual-todo/`; four gates run before code (blocking questions, registry-only components, interaction patterns from `ai-docs/ui/patterns.md`, spec traceability markers); TDD loop (red → green at pre-agreed seams); `npm run build` mandatory for `Kind: foundation`/`Kind: kit` briefs; self code-review; closes the task and recomputes the frontier. Also enforces the **theme gate** and the **env-preflight gate** (§10). |
| `/sv [msg?]` | Save: `npm run build` gate → docs-sync check (schema/deps diffs must be reflected in `ai-docs/stack.md`/specs) → conventional commit → Convex export backup to `~/Documents/convex-backups/`. |
| `/test-ui [flow?]` | Tests the UI in a real browser (Playwright MCP; Chrome DevTools MCP fallback) at `http://localhost:3000`: restarts the dev server if needed, walks the flow (default: sign-in), watches console errors and 4xx/5xx, fixes what it finds, re-tests, prints a fixed-format report. Credentials come from the `ai-docs/test-credentials.md` roster (Clerk test users `+clerk_test` / code `424242`), `map.yaml`, or the command-file placeholders. |
| `/team <task>` | Multi-agent orchestration: splits the task into independent subtasks and launches the specialist agents in parallel (frontier tasks are independent by construction; each is claimed before dispatch). |
| `/restore [hash?]` | Destructive rollback with confirmations: `git reset --hard <commit>` and/or `npx convex import --replace` from a backup. `--prod` never by default. |

Planning, specs and scope:

| Command | What it does |
| --- | --- |
| `/grill [doc\|topic?]` | Stress-tests the PRD (default) or any doc/decision — one question at a time, each with a recommendation, decisions recorded in the decision log and written back into the document. Hunts placeholders, evidence/assumption gaps, JTBD/non-users, falsifiable right/wrong signals, the thinnest testable MVP, measurable success criteria, edge cases and `## Launch criteria`. Run BEFORE `/start`. |
| `/stack [tech\|layer?]` | Owns `ai-docs/stack.md`: decides pending layers by interview (IAI preference rules), researches each tech across the 4 mandatory dimensions (docs+llms.txt, skills, CLI, MCP) into the code-verified research ledger, writes `ai-docs/apis/<tech>.md` (9 required sections incl. the Production runbook `/launch` executes), and equips the project (one canonical skills invocation, CLIs, MCPs). |
| `/spec [capability\|NNNN?]` | Creates/updates a durable spec `ai-docs/specs/NNNN-<slug>.md` (requirements FR/NFR, a `## Flow` mermaid diagram, BDD scenarios S-n, traceability, gate log) via a short interview. Definition Gate flips `Status: defined` — the diagram is one of its conditions. |
| `/feature "what you want"` | New functionality on an EXISTING system: size triage (module-sized → `/idea` in Pi), delta mini-grill, delta spec (with its own `## Flow` mermaid diagram of the delta), then ONLY the new tasks (numbering continues, `Blocked by:` real tasks), shown for approval before anything executes. Requires `map.yaml` (`/absorb` first on a never-onboarded system). |
| `/bug "the symptom"` | Registers the defect, classifies the investigation as `direct` or `rca`, and persists a base-SHA/evidence-chain RCA when ambiguity or risk requires it. Critical/sensitive/low-confidence cases wait for explicit RCA approval before claim; then the normal pipeline enforces **RED for the right reason**. |
| `/quick "small change"` | Triage: SIMPLE only when blast radius ≤ ~3 files, one obvious shape, and none of: schema/migrations, auth/permissions, payments, new dependency, new route/page, new UI component, destructive data op. SIMPLE ships in one sitting with the guardrails on + one `## Q-NNN` audit line in `ai-docs/todos/quick-log.md`; anything else routes to `/feature`/`/bug` with the reason. Never touches the roadmap. |
| `/note "idea"` | Appends `- [ ] YYYY-MM-DD — <idea>` to `ai-docs/inbox.md` and stops — zero questions. Later `/feature`/`/quick`/`/spec` tick items with `→ spec NNNN` / `→ Q-NNN` / `→ task NN`. |
| `/absorb [focus?]` | Onboards an EXISTING system: surveys the code, writes `map.yaml`, the as-built PRD (never overwriting a human PRD — `PRD-as-built.md` instead), `stack.md` from what was observed, `conventions.md`, the as-built component registry, the maintained `ai-docs/wiki/` (stamped with `wiki-check.mjs --stamp` at the end, so `npm run wiki:check` reads `fresh`) and a distilled project skill; short interview for what code can't reveal. Changes no code, creates no tasks; recommends `/kit` when the registry comes out empty/duplicated. |
| `/onboarding [focus?] [--report-only]` | The first command on an EXISTING system: chains `/absorb` → `/stack` → `/kit` in one guided pass (each command's own file stays the law — interviews, decision logs and approvals included), resumable via its `onboarding` decision-log rail, then hands over explaining `/idea` (module-sized discovery, in Pi) vs `/feature` (one-sentence delta). `--report-only` defers the `/kit` decisions to a later run. |

Design system and references:

| Command | What it does |
| --- | --- |
| `/component <name + URL/cmd or custom entrypoint> \| list \| sync` | The legal entry path for a UI component: a library component supplies its URL/install command; a project-origin/custom component supplies a confirmed project-relative entrypoint and needs neither. For closed UI surfaces, the UI contract is updated first and outranks registry roles. Then dedupe, inspect/research, install or create, adapt to theme/i18n/a11y, register, and add an isolated `/ui-components` card. `sync` reconciles registry ↔ code ↔ page; `list` prints the registry by category. |
| `/theme [hint\|accept?]` | Visual identity behind a side-by-side preview: ~7-question interview (colors, dark/light, typography, shape, interaction patterns), preserves the UI contract's selected theme library/custom entrypoint, generates its full project-native token set (WCAG AA contrast is a blocker), renders Current × Proposed with REAL registry components, and only applies through that implementation's native provider/files after explicit approval. Canonical `fia-universal` on Next.js maps this to `next/font` + `app/globals.css`; other stacks do not inherit those APIs. `accept` records a conscious "keep the default" decision — enough to satisfy the theme gate. |
| `/ui-contract [profile\|show\|review]` | Creates or reviews schema-v3 `ai-docs/ui/contract.json`: one confirmed product profile resolves app shell, breadcrumb, System/Light/Dark, DataTable/advanced controls and Kanban to `required`, `optional`, `not_applicable` or a scoped `waived`, and records the implementation for each surface. An explicit existing/specified library or custom component always wins for its named surface and must resolve through a concrete local entrypoint; a package is not treated as proof that it implements unrelated surfaces. With no detailed choice, `fia-universal` is the deterministic fallback. A capability boolean changes atomically with `capability --name <capability> --enabled true\|false`; the false→true `dataTables` transition also enables its professional advanced controls (only while the advanced-controls rule is `optional`/`required` — a waived/not_applicable decision stands), while explicitly disabling the advanced capability afterwards records a compact opt-out that an idempotent base-table reassertion preserves. Other dependency enables cascade safely and conflicting disables fail without writing. Every skip keeps a reason; responsive/containment/keyboard/focus/recovery/drag-quality invariants cannot be waived. |
| `/design <images + description>` | Layout redesign from reference images: structure/hierarchy/density/motion come from the reference, colors/fonts/components stay OURS (theme + registry only). Contained scope applies directly; broad scope becomes roadmap tasks. Uses the Impeccable skill for motion when installed. |
| `/example <url> [notes] \| list` | Registers an external reference on the example shelf: reads the source (never registers from a URL alone), pins license + commit, writes `ai-docs/examples/<slug>/NOTES.md` (mandatory `## What NOT to take`) + a registry row. GPL-family/unknown licenses are never copied verbatim. Before implementation, cite the entry's NOTES in `/grill ai-docs/PRD.md`, then ask `/map` to reconcile the approved additions into open specs/tasks. |
| `/kit [focus?] [--report-only]` | Brownfield design-system audit: as-built registry rows → `/ui-components` page → **gap report** vs the core kit (`kit-report.md`: missing needs, below-contract items with file/line evidence — the DataTable contract audited item by item, plus Combobox overlay width, yellow search highlight, calendar month/year caption, pointer cursor, and one-component-per-card isolation from `references/interaction.md` — duplicates without roles) → engineer approves → delta spec + `Kind: kit` design-only tasks with one checkbox per contract item. Changes no component and no screen itself. |

Going live and meta:

| Command | What it does |
| --- | --- |
| `/launch` | From "runs on my machine" to LIVE, in rungs: **Ready** gate (lint/typecheck/test/build green, pushed, CI green) → **Safe** gate (the security skill's checklist walked top to bottom; two hard stops: open data-ownership and any committed secret) → **BETA** (public vercel.app + production backend: Convex prod deploy key, env promotion, deploy, smoke test) → **PRODUCTION** (own domain, `pk_live_`/`sk_live_`, prod webhooks, live payments with one real tested charge). Uses `node imp/scripts/fia-launch-check.mjs --json` as the source of truth when the FIA is installed; everything logged in `ai-docs/launch.md`; every outward step needs an explicit "yes". |
| `/create-command [name] [description]` | Scaffolds a new professionally-structured slash command in `.claude/commands/`, registers it in `scripts/command-overlays.yaml`, and regenerates the Cursor twin via `npm run sync:commands`. |

Every command that generates durable docs commits them via
`node imp/scripts/docs-commit.mjs` (when the FIA is present) and guards its
`imp/scripts/*` usages with a manual fallback — the harness works with or
without the FIA runtime.

### 8.2 The 9 specialist agents

| Agent | Role |
|---|---|
| `task-master-generator` | Breaks the app into vertical-slice (tracer bullet) tasks: `todos/task-master.md` index + one issue file per task with explicit blocking deps; FULL mode also generates specs; DELTA mode (used by `/feature`, `/kit`) only adds new issues. |
| `task-sequencer` | Prepares (never implements) the next task: picks/claims the frontier task and writes the just-in-time brief with "Seams & First Tests"; enforces the theme and env-preflight gates for foundation tasks; a hidden cycle (picked issue needs a later blocked-by-this-task schema) is auto-split once before asking. |
| `screen-routes-generator` | PRD → `ai-docs/screens-routes.md` (screens, routes, navigation flows). |
| `start-mapper` | Reads the whole codebase → `ai-docs/map.yaml` (mapping only). |
| `start-scaffolding` | Folder structure + empty placeholders only — explicitly no implementation code. |
| `component-architect` | Seeds the component registry: core-kit `planned` rows in scaffold-less greenfield, as-built `installed` rows when code exists (`/kit` runs it in as-built mode). |
| `ui-component-page` | Creates/updates the live `/ui-components` design-system page (every registry component rendered for real, searchable, by category). Each card isolates ONE registry component — a kitchen-sink form reused across DateInput/Calendar/Combobox is a contract failure (`references/interaction.md`). |
| `ui-component-researcher` | Researches/documents a single UI component into `ai-docs/components/<lib>/<name>.md`. |
| `api-docs-researcher` | Researches an external API/technology and writes the project-tailored doc into `ai-docs/apis/` (also logs the four research dimensions). |

`.cursor/agents/` **and** `.agents/agents/` are symlinks to
`.claude/agents/` (canonical) — real copies on a Windows machine without
the symlink privilege (§8, extraction fallback). Cursor and Pi discover
agents through `.agents/agents/`; editing only a copy under `.cursor/`
that is not the symlink leaves them on the old prompt. Cursor additionally
ships router skills (`project-workflow` + `workflow-*` wrappers for the
original 8 pipelines) because Cursor routes those commands by skill — the
wrapper then reads `.cursor/commands/<name>.md`.

### 8.3 Skills shipped

Seven skills for both engines: **tdd** (the red→green loop `/dev` follows),
**frontend-profissional**, **design-system** (incl. `references/core-kit.md`
— the canonical component contracts — `references/semantic-fields.md` —
known-domain data never becomes a free-text input — and
`references/interaction.md` — pointer cursor, yellow search highlight,
overlay width = trigger, calendar month/year caption, DataTable Filter +
chips, `/ui-components` one-component-per-card), **security** (incl. the
`/launch` checklist and the multi-tenancy reference), **backend-profissional**,
**examples** (the reference-shelf matching rules), and
**project-knowledge-audit** (advisory drift checks across rules and
current-state docs; historical events and intent are never rewritten). The four professional
ones are the template-ownable paths described above.

In the harness checkout the edit path is **not** `.agents/` first: shared
skills are edited in `harness/.claude/skills/`, `npm run sync:skills`
mirrors them to `harness/.cursor/skills/`, and `harness/.agents/skills/<name>`
is a directory symlink to that Cursor tree — that is the path Cursor and Pi
resolve in a stamped project. Skipping the sync leaves Cursor/Pi on the
previous skill bytes.

### 8.4 Seeing what the plan created

With the FIA installed, `npm run plan` opens the viewer's "Plan" tab
(`http://127.0.0.1:4600#plan`, 100% offline) with optional architecture decisions, screens/routes, tasks
with blockers/criteria, design system and every `ai-docs/` file rendered —
`/map` opens it automatically when it finishes. `npm run agents` (or
`/agents` inside `pi`) opens the "Agents" tab to see engine login status and
edit each FDA agent's engine/model/reasoning and `fallbacks:` chain — saving
rewrites `imp/fia.config.yaml` preserving comments (locked while an FDA
runs). For a one-line switch without the browser, `imp llm` (or `/llm`
inside `pi`) lists the agents numbered and applies "1 → fable"-style changes
through the same write path. See §9.6.

## 9. FIA — the IAI Agent Factory

The FIA is the agent runtime the CLI stamps into every project (unless
`--no-fia`): **Pi** as the interactive agent (§12), deterministic **FDAs**
(fully-automated dev agents, `imp/fda_*.mjs`) as the workforce, an
observability SQLite (`imp/data/fia.db`), quality gates and dashboards.
Everything runs inside the subscriptions the student already has — Claude
through the official `claude` CLI (Pro/Max), Codex through Pi (ChatGPT
Plus/Pro) — never API keys, never per-token billing.

### 9.1 What the stamp does (`steps/fia.js`)

1. Migrates any legacy layout first (`fia/` → `imp/`, root `HARNESS.md`/
   `iai.config.json` → `imp/` — §14.2).
2. Installs/updates the Pi CLI (`npm install -g
   @earendil-works/pi-coding-agent`) WITHOUT any interactive login — the
   Codex login is deliberately the last step, after the install. A failed Pi
   install degrades (warns, EACCES gets a dedicated explanation, the rest of
   the install continues without FIA).
3. Stamps `imp/` (from the bundled `fia-templates/`) and `.pi/` (from
   `pi-templates/.pi/`) — copy-skip-existing, never overwrites; a partial
   stamp is a hard error telling you to re-run (it only adds what's missing).
4. Ensures the gitignore entries (`imp/node_modules/`, `imp/data/sessions/`,
   the SQLite files, backups, `imp/reports/`), merges the npm scripts below (a name conflict
   keeps YOUR script and ships ours as `<name>:fia`), and records the runtime
   manifest (`imp/.runtime-manifest.json`, template sha1 per stamped file —
   the `--update-runtime` baseline; on re-runs existing baselines win).
5. `npm install` inside `imp/`; installs the three Pi packages
   (`pi-subagents`, `pi-mcp-adapter`, `pi-web-access`), each exact-pinned to
   the latest npm version — the pin is what keeps Pi's "Package Updates
   Available" banner away; a student-customized entry (fork/git/path) is
   never touched.
6. Installs the global `imp` launcher (`npm install -g impactus`) so the
   brand command exists on PATH — best-effort, never fails the install.
7. Prints the final note — including, when Codex isn't logged in yet: run
   `imp`, type `/login openai-codex`, finish in the browser, and **never log
   in to Anthropic inside Pi** (there the Claude subscription bills per token
   as "extra usage"; Claude runs through the `claude` CLI in the FDAs).

npm scripts stamped into the project (`FIA.npmScripts`):

```bash
npm run fda:demo      # node imp/fda_prompt.mjs "Summarize this repo…" --agent scout
npm run fda:quality   # node imp/fda_quality.mjs "quality gate"
npm run fda:qa        # node imp/fda_qa.mjs "<scope>"  (browser QA)
npm run fda:sessions  # node imp/scripts/fia-query.mjs sessions
npm run fda:phases    # node imp/scripts/fia-query.mjs phases
npm run fda:tail      # node imp/scripts/fia-query.mjs tail
npm run fda:viewer    # node imp/scripts/fia-viewer.mjs         (web viewer)
npm run plan          # viewer --view plan                       (Plan tab)
npm run agents        # viewer --view agents                     (Agents tab)
npm run launch:check  # node imp/scripts/fia-launch-check.mjs   (read-only readiness)
npm run env:check     # node imp/scripts/env-preflight.mjs      (dev keys preflight)
npm run wiki:check    # node imp/scripts/wiki-check.mjs         (repo-wiki freshness)
npm run security:scan # node imp/scripts/security-scan.mjs      (L1 pattern scan)
npm run loop:health   # node imp/scripts/loop-health.mjs        (agent-loop score)
npm run fda:rewind    # node imp/scripts/rewind.mjs             (undo a run, restore-only)
npm run notify        # node imp/scripts/notify.mjs             (run-end pings, opt-in)
npm run fda:verdict   # node imp/scripts/verdict.mjs                (bounded continuation)
npm run fda:status    # node imp/scripts/fda-lock.mjs status    (is an FDA running?)
npm run fda:stop      # node imp/scripts/fia-stop.mjs           (the stop button)
npm run gates:probe   # node imp/scripts/gate-probes.mjs        (gate self-test)
npm run holdout       # node imp/scripts/holdout.mjs            (holdout probes)
npm run docs:commit   # node imp/scripts/docs-commit.mjs        (ai-docs-only commit)
npm run tui           # node imp/scripts/fia-tui.mjs            (terminal dashboard)
npm run handoff       # node imp/scripts/handoff.mjs            (continue the newest
                      #   Pi conversation in `claude` — see §14.3, `imp handoff`)
```

### 9.2 The FDA runners

Every runner shares the same CLI contract:

```
node imp/fda_<name>.mjs "<prompt-or-brief-path>" [--config imp/fia.config.yaml]
                        [--fda-id <id>] [--resume] [--retry-unchanged]
                        [--llm "<spec>"]… [--agent <name>] [--debug]
```

The prompt may be inline text or a **file path** (a brief file is inlined).
`--resume` requires `--fda-id` and may omit the prompt — it is reloaded from
the trace. `--retry-unchanged` overrides the unchanged-tree guard on a bare
resume (§9.7). `--llm` runs THIS run on another LLM without touching the
roster (§9.3). `--agent` is only read by `fda_prompt`. `--debug` (or env
`FIA_DEBUG`) prints full stack traces. A failed run always prints the exact
resume command (`node imp/fda_<name>.mjs --fda-id <id> --resume`) — nothing
is lost. Exit codes: 0 accepted · 1 any failure (including "phases green but
not accepted") · 130/143 on SIGINT/SIGTERM (the session is closed with the
named `aborted` outcome first, never left as an eternal `running`).

Every run closes with ONE **terminal outcome** — the end banner reads
`══ ACCEPTED (goal met) — …` / `══ FAILED (attempt cap reached) — …` and the
same name lands on the session row (§9.7). A run stopped by a policy limit
(time budget, change breadth) is not a crash: it prints a calm
`■ FIA run stopped: …` panel with the recorded outcome, the knob to tune
(`stop:` in `imp/fia.config.yaml`) and the resume command, and still exits 1.

| Runner | Agents | Phases (code phases in *italics*) | Use it for |
| --- | --- | --- | --- |
| `fda_prompt` | any (default builder) | request → prompt | One agent, one prompt, traced end to end. `npm run fda:demo` is this with the scout. |
| `fda_plan` | planner | request → plan | A written plan, no code changes. |
| `fda_build` | builder | request → build | Implement from a plan/brief — no tests, no commit. |
| `fda_scout` | scout (read-only) | request → scout | Recon: "where is billing implemented?" — any repo change is rolled back. |
| `fda_document` | documenter | request → document | Write up recent changes (docs paths only). |
| `fda_quality` | none | request → *quality* | Lint + typecheck + build + test with no agent — works with nothing logged in. |
| `fda_plan_build_test` | planner, builder (+reviewer for the UI gate) | request → plan → build → *test* → up to `stop.attempt_cap` × (fix → *test*), default 3, cut short by `no_progress` → *spec_coverage* → checklist gate → UI gate → *holdout* → *commit* | The task workhorse (`/task` uses it via the sequencer). |
| `fda_sdlc` | planner, builder, reviewer, documenter | request → plan (or free *plan_skip* when the brief is self-contained — `sdlc.plan: auto`) → build → *test_1* + fix loop (up to `stop.attempt_cap` rounds, same tracker as the siblings) → *spec_coverage* → checklist gate → UI gate → *holdout* → review (green suites only; a red suite records the free *review_skip* instead) → *commit_code* → document (only with `sdlc.document: per_task`; the default `per_milestone` records the free *document_skip* and `/goal` drains docs with one `fda_document` per milestone) → *commit_docs* | Full cycle with an independent review — acceptance requires green tests AND an approved review; a suite still red after the fix rounds ends the run as `attempt_cap` (or `no_progress` when stalled) without paying the reviewer. |
| `fda_bug` | planner, builder (+reviewer) | request → plan → red_test → *red_check* → build → *test* → fix loop (≤ `stop.attempt_cap`, default 3; `no_progress` ends it early) → gates → *commit* | Defect fixing with a **valid RED** gate: the reproduction test must fail on an assertion BEFORE the fix (passing = "bug not reproduced"; module/syntax/env failures = invalid RED). |
| `fda_quick` | builder | request → build → *quality_1* (lint+typecheck+focal test) → one fix round (by design, not from `stop:`; still red = `attempt_cap`) → *quality_2* → *quicklog* → *commit* | Small guarded changes (`/quick`). Appends the `## Q-NNN` audit entry, then stamps the commit sha into it as a separate one-line commit. |
| `fda_build_test` | builder (+reviewer for the UI gate) | request → build → *test* → up to `stop.attempt_cap` × (fix → *test*), default 3, cut short by `no_progress` → *spec_coverage* → checklist gate → UI gate → *holdout* → *commit* | Like `fda_plan_build_test` but **without the planner** — the brief goes directly to the builder. Saves ~1-2.5M tokens per run when the brief is already autocontained. |
| `fda_prototype` | builder | request → build → *quality_1* (lint+typecheck) → one fix round → *quality_2* → *commit* | Fast prototyping: no plan, no test suite, no review, no document — only lint/typecheck as sanity. Requires an exact `Mode: prototype` line; `/task` and `/goal` route that brief here deterministically. |
| `fda_qa` | builder, reviewer | request → scope → preflight → author → *e2e* → audit → report → gate | Browser QA at milestone/spec/task boundaries (`/qa`). Playwright e2e + design audit; writes `ai-docs/qa/` report. The preflight self-heals (installs `@playwright/test` + Chromium into the project); the reviewer audit runs only on a green e2e (a failed e2e records a free `audit_skip` phase); re-running a failed e2e with zero repo changes is refused (`--retry-unchanged` overrides). No fix loop — failures go to `/bug` or `/task`. Does not re-run unit tests. |

Examples:

```bash
node imp/fda_plan_build_test.mjs ai-docs/todos/briefs/task-07.md
node imp/fda_build_test.mjs ai-docs/todos/briefs/task-07.md   # same but no planner
node imp/fda_prototype.mjs ai-docs/todos/briefs/task-07.md    # requires Mode: prototype in the brief
node imp/fda_bug.mjs "Deleting the last org member 500s instead of blocking"
node imp/fda_quick.mjs "Make the empty-state copy on /invoices friendlier"
node imp/fda_qa.mjs "M1"
node imp/fda_sdlc.mjs ai-docs/todos/briefs/task-12.md
node imp/fda_plan_build_test.mjs --fda-id 3fa9c21b --resume     # resume a failed run
node imp/fda_sdlc.mjs ai-docs/todos/briefs/task-12.md --llm "grok-4.6 high"   # this run on another LLM
```

An engine exit without a parseable Report envelope fails fast with the last
stderr lines and a matched **recovery hint**: login-shaped errors point at the
right login command per engine; rate-limit/quota errors say to wait and
re-run ("no extra payment is needed"). Malformed envelope JSON gets 2 re-asks
before failing.

### 9.3 `fia.config.yaml` — the agent roster

FDAs never name a model — they name an **agent**; `imp/fia.config.yaml` maps
agents to engines/models. Edited by hand or via the Agents tab (`npm run
agents` / `/agents` in `pi`), which preserves comments. Never touched by
`--update-runtime` (it's yours). The essentials:

```yaml
defaults:
  coding_agent: pi                     # engine for agents that don't say otherwise
  model: openai-codex/gpt-5.6-sol
  thinking: high                       # minimal|low|medium|high (Pi engines)
  relay: auto                          # engine death mid-run: auto|resume|off
  session_rotation_context: 180000     # live-context ceiling per agent session
                                       # (tokens); past it the next phase starts
                                       # a fresh session with a compact reseed
                                       # instead of resuming the giant one. 0 =
                                       # never rotate.
  tools: [read, bash, edit, write, grep, find, ls]   # Pi tool allowlist
  protected_files:                     # deny-list enforced for EVERY agent
    - imp/modules/
    - imp/fia.config.yaml
    - imp/fda_*.mjs
    - imp/scripts/
    - imp/data/prompt_engineering/
  data_dir: imp/data
  permissions:
    benign_paths: []                   # extra globs reverted as build side effects

observability:
  db: imp/data/fia.db

# Both blocks below ship COMMENTED OUT and are optional: every key has a code
# default, so an untouched config behaves exactly like the documented defaults.
# stop:                    # deterministic stop conditions — §9.7
#   attempt_cap: 3
#   no_progress_window: 2
# notify:                  # run-end notifications — §9.8, off until enabled
#   enabled: true
#   targets: [{ kind: slack, url: 'https://hooks.slack.com/services/…' }]

agents:
  - name: planner
    coding_agent: claude_code          # official `claude` CLI — plan billing
    model: opus                        # alias (sonnet|opus|haiku|fable) or full name
    effort: high                       # low|medium|high|xhigh|max|ultracode
    fallbacks:                         # up to 5; run start, mid-run, resume
      - { coding_agent: pi, model: openai-codex/gpt-5.6-sol, thinking: high }
    prompt_engineering:                # REQUIRED per agent (never inherited)
      system: imp/data/prompt_engineering/planner/system.md
      user: imp/data/prompt_engineering/planner/user.md
    writes: [specs/, ai-docs/]         # allowlist; [] = read-only; omit = anywhere
```

Shipped roster: **planner** (claude_code/opus, writes specs+ai-docs),
**builder** (pi/Codex, writes anywhere but protected), **scout** (pi/Codex,
read-only), **reviewer** (claude_code/sonnet, read-only), **documenter**
(pi/Codex, docs paths only). Each ships a fallback to the other engine.

**Phase overrides** — per-phase `thinking`/`effort` tuning without changing the
agent's default. Exact phase names and trailing-wildcard patterns are both
supported:

```yaml
agents:
  - name: builder
    thinking: medium
    phase_overrides:
      fix_*: { thinking: low }         # all fix rounds
      fix_checklist: { thinking: low } # checklist repair
      fix_ui: { thinking: low }        # UI gate repair
  - name: reviewer
    phase_overrides:
      ui_check: { thinking: low }      # UI rubric is simple
```

Unmatched phases use the agent's base settings. Only `thinking` and `effort`
are accepted inside an override; engine, model, prompts, permissions and
fallbacks remain the validated base configuration. Any other field fails
config validation instead of silently changing how or where a phase runs.

The shipped roster pre-seeds the recipes above (they used to be
documentation-only): builder `fix_*`/`fix` at low reasoning (repair rounds act
on concrete failure output), reviewer `ui_check`/`ui_verify` at low (a fixed
rubric is a checklist judgement — the functional `review` keeps full effort),
and the documenter's base `thinking` is `low` (it narrates an existing diff).
Models are never touched by these — which model each agent runs on is always
the engineer's choice (`imp llm` / the Agents tab), on their own plan.

Engines (`coding_agent`):

| Engine | Binary | Model examples | Notes |
| --- | --- | --- | --- |
| `claude_code` | `claude` (override `CLAUDE_PATH`) | `sonnet`, `opus`, `haiku`, `fable`, or full names | Runs on the Claude Pro/Max plan. `effort` sets reasoning depth; system prompt via `--append-system-prompt` (preserves the cacheable prefix). |
| `pi` | `pi` (override `PI_PATH`) | `openai-codex/gpt-5.6-sol`, `openrouter/…`, `xai/…`, `github-copilot/…` | Session continuity via a session FILE; `thinking` sets reasoning; per-agent `tools` and `harness_engineering` (Pi extensions). Subscription providers log in via `/login openai-codex` / `github-copilot`; API-key providers read their env var (`OPENROUTER_API_KEY`, `XAI_API_KEY`, …). |
| `cursor` | `cursor-agent` (override `CURSOR_AGENT_PATH`) | picker ids like `sonnet-4.5`, `gpt-5`, `composer-1` | Cursor subscription; no token usage reported; system prompt is prepended to the first prompt. |
| `grok` | `grok` (override `GROK_PATH`; `~/.grok/bin/grok` is found even off PATH) | `grok-4.6`, `grok-4.5` (`grok models`) | Grok Build on the **xAI subscription** — `grok login` once (OAuth; the OIDC token in `~/.grok/auth.json` refreshes itself, and that file is what the FIA detects). Headless via `-p` + `--output-format streaming-messages-json` (the Claude stream-json dialect, so tool calls show live in the viewer/TUI); `--resume <id>` continues the session; role via `--rules` (append — never `--system-prompt-override`, the cacheable prefix stays); `effort` low\|medium\|high\|xhigh, clamped per model. `XAI_API_KEY` is stripped from the child env (with it the CLI bills per token). The first grok run trusts the project folder once (`~/.grok/trusted_folders.toml`) — untrusted, grok skips the project hooks in silence. |

**One run on another LLM — `--llm`.** Every FDA accepts `--llm "<spec>"`
(repeatable): `[<agent>[,<agent>]=]<model>[ <level>]`. `--llm "grok-4.6 high"`
puts EVERY agent phase of that run on Grok 4.6 at high; `--llm "builder=opus
xhigh"` only the builder; `--llm "reviewer,scout=openai-codex/gpt-5.6-sol"`
keeps each agent's own level, clamped to the new engine's ladder. The roster
on disk is never written: the switch is printed at run start, traced as
`llm_override` (payload: agent, from, to, level_given, spec, source) and saved
in `imp/data/sessions/<fda_id>/llm_override.json`, so `--resume` re-applies it
without the flag (a model that changed mid-run would break the engine session
and the cache); an explicit `--llm` on resume replaces it. An explicit level
applies to every phase of that agent for the run (the roster's
`phase_overrides` are dropped for it); declared `fallbacks` still apply if the
chosen engine is unavailable. Inside Pi: `/task 12 --llm "grok 4.6 high"`.
Same grammar as `imp llm set` (`modules/llm-target.mjs` is the single resolver).

**Fallbacks** (up to 5 per agent) are walked in three stages. At **run start**,
for *hard* unavailability (binary missing; Pi provider with no login and no API
key) — traced as `engine_fallback`. **Mid-run**, when the engine dies inside a
phase (exits without a report, or its binary vanishes): the failure is
classified (`login` | `limit` | `missing` | `crash`), the run switches to the
next viable fallback in place and retries the phase — traced as `engine_error`
+ `engine_relay` (§9.5). On **resume**, the interrupted run's failure markers
arm the chain even when the binary checks pass (skipped under `relay: off`).
`defaults.relay` chooses the policy: `auto` (the default when the key is
absent — switch in-run and on resume), `resume` (fail fast mid-run; the
fallbacks arm only under `--resume`), `off` (never auto-switch, mid-run OR on
resume; the death is still recorded and traced).
Every switch is printed and traced — never silent. The config header repeats
the golden billing rule: Claude INSIDE Pi bills per token as "extra usage" —
always use `coding_agent: claude_code` to stay on the plan.

**Session rotation**: one engine session per agent per run means `build →
fix_1 → … → fix_ui` share one growing conversation — and a resumed session
re-reads its whole prefix on EVERY turn (cache reads are ~10% of the input
price, but on a long run they become ~94% of everything spent). Past
`defaults.session_rotation_context` (default 180000 tokens of live context;
`0` = never), the agent's NEXT phase starts a fresh session seeded with a
compact reseed block on the user prompt: what the run already changed, the
archived transcript path (Pi's session file is renamed
`pi_session.<n>.rotated.jsonl`, never deleted) and the previous envelope that
already rides the prompt template. The decision is taken only at phase start
(corrections inside a phase always continue their session), it stands down
when an engine-death marker targets the phase (the continuation preamble
already reseeds), and each rotation is printed and traced as a
`session_rotation` log event. Cursor reports no usage, so its sessions never
rotate.

**Permissions**: every agent phase snapshots the working tree (`git diff` +
hashed untracked files); writes outside the agent's `writes` allowlist (or in
`protected_files`) are rolled back. A fully-rolled-back breach retries the
same phase once (the agent is told which paths to leave alone); a second
breach, or an unrecoverable path (pre-existing untracked file with no copy
in git), fails the phase as a `PermissionBreach`. Benign build side effects
and OS junk (`AGENTS.md`, `next-env.d.ts`, `**/*.tsbuildinfo`, `.next/`,
`node_modules/`, `coverage/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, … +
your `benign_paths`) are reverted and logged as `external_change` — never
blamed on the agent. Read-only agents deposit their reports in the
git-invisible session dir (`imp/data/sessions/<id>/context_handoff/`),
handed to prompts as `{{context_handoff_dir}}`.

**Prompt material** lives in `imp/data/prompt_engineering/<agent>/{system,
user}.md` — student-editable, never touched by `--update-runtime`. Templates
receive `{{prompt}}`, `{{previous_envelope}}` and `{{context_handoff_dir}}`.
The previous envelope is **trimmed** before injection: only `status`,
`summary`, `artifacts`, `changed_files` and `notes_for_next_agent` survive —
verbose plan text and other fields are stripped to reduce per-turn context.

**Envelopes**: every agent phase must end with a typed Report JSON
(`status`, `summary`, `artifacts`, `notes_for_next_agent`, plus per-type
fields like `changed_files`, `approved`/`findings`/`blocking`,
`document_path`). Gates validate them: `artifactsExist`/`filesNonEmpty` fail
on an empty artifacts list (an agent that produced nothing can no longer
count as a success); `verdictConsistent` refuses an "approved" review with
blocking items.

### 9.4 Quality phases

The code phases run the project's own scripts, sequentially, with verbatim
output tails fed to fix rounds: `npm run test` (600 s), `npm run lint`
(120 s), `npm run typecheck`/`type-check` (180 s), `npm run build` (600 s).
A brief carrying `Kind: foundation` or `Kind: kit` arms `npm run build`
alongside the suite in the test phase (in code, before any reviewer).
`fda_quick` runs lint + typecheck always and the focal test only when the
builder declared a `*.test.*` file — the full suite is deliberately skipped
as disproportionate.

### 9.5 Runtime behavior — failure, recovery, locking and gates

- **A failed FDA prints the exact resume command** (`node imp/fda_<name>.mjs
  --fda-id <id> --resume`) instead of a raw stack trace; pass `--debug` to see
  the full stack. With `--fda-id … --resume` the original prompt is loaded
  from the session database — no need to retype it.
- **Resume replays what already succeeded** — with the right exceptions.
  Deterministic `code` phases (tests, gates) re-run so they verify the
  CURRENT tree; succeeded agent phases are reused. Three deliberate
  exceptions: `ui_verify` always re-runs (a verdict about the current tree
  must not fossilize a rejection); `fda_bug`'s `red_check` replays its saved
  verdict once the fix has been built (a one-way gate — re-running would
  misread the fixed code as "bug not reproduced"); `fda_quick`'s `quicklog`
  reuses the entry it already appended (the append is not idempotent).
- **Agent phases retry once by default** (`retries: 1`) before failing the run.
- **A run may stop ITSELF, on purpose.** Four zero-token limits (repair cap,
  no-progress detector, wall-clock budget, change-breadth ceiling) end a run
  that would only keep spending the plan, and the reason is recorded as a named
  outcome instead of a generic failure — §9.7.
- **An engine that dies mid-phase no longer takes the run with it.** An exit
  without a report, or a binary that vanished, is classified (`login` |
  `limit` | `missing` | `crash`) and written to
  `imp/data/sessions/<fda_id>/<agent>/engine_error.json`; the run then switches
  to the next viable entry of the agent's `fallbacks:` chain **in place** (the
  substitute owns that agent's later phases too) and retries the phase.
  `login`/`limit`/`missing` switch on the first death — waiting cannot renew an
  expired login and a plan limit outlives the run; a `crash` retries the SAME
  engine once (a transient CLI death must not demote the chosen engine) and
  switches on the second consecutive crash. Traced as `engine_error` +
  `engine_relay`, printed as `⚠ <agent>: <engine> died mid-run`.
  `defaults.relay` in `imp/fia.config.yaml` picks the policy: `auto` (default),
  `resume` (fail fast mid-run; the chain arms only on `--resume`) or `off`
  (never auto-switch — the marker is still recorded).
- **Resume prefers the engine that can actually finish**: `--resume --fda-id
  <id>` reads the interrupted run's markers and walks the fallbacks even
  though the binary checks pass — that engine already proved it cannot finish.
  With no viable fallback the resumed run retries the primary out loud instead
  of blocking at the door (limits reset, outages end).
- **The substitute inherits the interrupted attempt.** Whichever engine takes
  over — a fallback, or the same engine retrying cold — gets a continuation
  block prepended to its USER prompt (never the system prompt, which stays
  byte-stable for caching): it points at the dead attempt's transcript
  (`imp/data/sessions/<fda_id>/<agent>/raw_output.jsonl`) as a read-only
  historical record with no authority over it, names the workspace (`git
  status` + the files themselves) as the only authority on current state, and
  requires the new engine to state where the previous attempt stopped and
  continue from there instead of starting from scratch. Exception: Pi taking
  over from Pi resumes its own session file natively (`--session
  pi_session.jsonl`) and skips the preamble. Traced as `engine_continuation`.
  Everything stays inside the subscriptions — no API keys are involved.
- **Marker lifecycle**: markers are per-run (scoped to the `fda_id`, so a fresh
  run never reads them) and are cleared only when the engine that died later
  succeeds again — exact engine+model identity. A success on a fallback KEEPS
  the primary's marker, so a later resume of the same run keeps preferring the
  fallbacks instead of bouncing back onto the dead engine.
- **Seeing the switches**: `npm run fda:sessions` adds a `relayed` count per
  run (run-start fallbacks + mid-run relays); the TUI's run detail prints
  `⚠ agent: engine (model) → engine (model) — kind` lines; the viewer timeline
  shows `engine_error`/`engine_fallback`/`engine_relay`/`engine_continuation`
  (all included under the `error` filter).
- **One FDA at a time per project**: a best-effort `imp/data/.fda.lock`
  (pid + fda_id + runner + started_at) blocks a second concurrent run — the
  permission gates of two parallel runs would revert each other's work.
  Acquisition is atomic and full-content (a complete temp file hard-linked
  into place — a competing reader can never observe a half-written lock), and
  a stale lock is stolen via an exclusive rename, so two runs started in the
  same instant cannot both proceed; a pid that answers EPERM counts as ALIVE
  (it exists under another user), and elapsed time alone never discards a
  lock — only a dead pid does. If a crash leaves a stale lock, deleting the
  file is the recovery.
- **Interactive sessions go read-only while an FDA runs**: the same lock has
  a reader side (`imp/scripts/fda-lock.mjs`, also `npm run fda:status`). A
  Claude session opened in the project during a run gets a READ-ONLY
  notice at session start (SessionStart hook) and a PreToolUse hook blocks
  file edits and write-shaped bash commands (incl. `git commit`/`add`/…)
  aimed inside the repo — an external write mid-run would be attributed to
  the phase agent and rolled back. **Grok Build reads the same
  `.claude/settings.json`**, so both PreToolUse gates (this one and the
  desktop guard) serve two dialects at once: the payload is read as
  `tool_name|toolName` / `tool_input|toolInput`, grok's own tool ids count as
  write/shell surfaces (`search_replace`, `run_terminal_command`), and a block
  answers in both protocols in one object — exit 2 + the reason on stderr
  (Claude Code) plus a stdout JSON carrying `decision: "deny"` and
  `hookSpecificOutput` (grok honors the JSON regardless of the exit code). A
  hook that speaks only one dialect is a **silent no-op** on the other engine,
  which is why grok also needs the project folder trusted — granted
  automatically before the first grok phase (§9.3). Interactive Pi gets the
  same guard via the `.pi/extensions/fda-lock.ts` extension, and Cursor via the
  `.cursor/hooks.json` `beforeShellExecution` hook
  (`.cursor/hooks/fda-lock-cursor.mjs` — Cursor has no before-edit hook, so
  shell commands are the guarded surface; stray agent edits are still swept
  by the run's own gate). The FDA's own child agents are exempt (the runner
  exports `FIA_FDA_RUN` into their environment), writes outside the repo stay
  allowed, everything fails open, and the block lifts the moment the run
  ends.
- **FIA commits are scoped**: FDAs commit only the files declared in the
  agent's envelope (never `git add -A`), so rejected builder changes and your
  own uncommitted work stay out of FIA commits.
- **Run baseline (anti-contamination)**: when a run starts, the runtime takes
  a pre-flight photo of the working tree (content fingerprint per dirty path,
  persisted as `imp/data/sessions/<id>/baseline.json`, reloaded verbatim on
  `--resume`). At commit time, a declared path whose content is identical to
  the baseline is dropped: it was already dirty before the run and the run
  never touched it — an over-declaring builder can no longer sweep another
  session's leftovers into a FIA commit. A pre-dirty file the run DID modify
  stays in. The trace logs `excluded_pre_existing` and
  `changed_by_run_but_uncommitted` so nothing disappears silently.
- **Foundation commits are widened**: a `Kind: foundation` (or `Kind: kit`)
  brief makes the commit phase union the envelope-declared paths with
  everything the run itself changed (baseline-diffed) — a scaffold of
  hundreds of files no envelope can enumerate gets committed whole instead of
  leaking into the tree as permanent dirt.
- **Agents never commit**: the builder/documenter task prompts carry explicit
  git rules — no `git commit`/`add`/`push` (committing is the FDA's own code
  phase, after review), and no declaring files the task did not touch.
- **Spec-coverage gate**: a brief with a `Spec: NNNN (S-1, FR-2)` line makes
  the run grep every promised id against `spec:NNNN covers:…` markers in test
  files — missing ones fail the phase by name. No `Spec:` line → skipped.
- **Checklist gate (C8)**: a brief's checkboxes (Objectives, Acceptance
  Criteria, Quality Checklist) can no longer be left behind by a "finished"
  run. The builder ticks what it verified (`[x]`, or `[x] … — N/A (<reason>)`
  for inapplicable items); after the suite is green, `checklist_1` re-reads
  the brief FROM DISK (the file path survives `--resume` via a session
  marker), one `fix_checklist` builder round repairs a forgotten checklist,
  and `checklist_2` fails the run if any `- [ ]` survives — the gate refuses,
  it never ticks a box itself. The second pass also compares box IDENTITIES
  against the first (`checklistDrift`): rewording, moving or swapping a box
  is refused the same as deleting it — only the tick and the `— N/A
  (<reason>)` annotation are legal edits, and an N/A tick without a
  parenthesized reason fails on its own. In `fda_sdlc` this happens BEFORE
  review, so the reviewer audits the ticks against the diff. Prompts that are
  not brief files, and briefs without checkboxes, skip the gate.
- **UI-conformance gate**: a run that changed frontend component files
  (`.tsx/.jsx/.vue/.svelte/.astro`, plus stylesheet files, vs the run baseline) gets a dedicated audit
  phase before it may close. `ui_scope` (code) decides deterministically
  whether the gate arms: an explicit `Surface:` line without `ui` in the
  brief stands it down, otherwise changed frontend files arm it. `ui_check`
  (reviewer agent) audits ONLY those files against the interaction-pattern
  rubric — field errors inline with the field (never only a banner/toast),
  success/failure toasts after mutations resolve, create/edit in a `Dialog`,
  `AlertDialog` for destructive actions, no native `alert()`/`confirm()`,
  components from the registry, the shared DataTable for record lists,
  semantic components for known-domain fields — with `ai-docs/ui/patterns.md`
  overriding the defaults when the project keeps one. Violations get ONE
  `fix_ui` builder round; `ui_verify` then re-audits ONLY the violations the
  first audit found (the full rubric was already answered — re-sending it
  re-pays the reviewer for settled questions); the final `ui_gate` (code)
  throws if violations survive, and `ui_retest` re-runs the suite (the
  repair touched production code after the test phase). The rubric lives in
  `modules/` (not prompt material), so `--update-runtime` delivers it to
  existing installs.
- **Observability**: every phase, gate verdict, engine call, token count and
  cost lands in `imp/data/fia.db`. `agent_end` events stamp
  `{model, coding_agent, cost, input, output, cache_read, cache_write}` — the per-LLM ledger
  groups by what actually ran, so later roster edits never re-attribute
  spend; a failed phase that burned tokens emits its own `agent_spend` event.

### 9.6 Observability: viewer, TUI and query CLI

**Web viewer** — `npm run fda:viewer` (`node imp/scripts/fia-viewer.mjs
[--port 4600] [--db imp/data/fia.db] [--no-open] [--view plan|agents|pi]
[--ai-docs ai-docs] [--detach]`). A read-only local server on
`http://127.0.0.1:4600` (localhost-only, DNS-rebinding guarded; the page is
self-contained — no CDN). Paths are resolved against the project root, so
the page keeps seeing `imp/data/fia.db` even if something else later changes
`cwd`. If :4600 is already a viewer from **another folder** (typical after
moving the project, or a leftover `--detach`), the next launch walks to
4601+ and opens that URL — it will not reuse a page that cannot see this
project's database. `v` in the TUI passes the absolute `--db` / `--ai-docs`
for the same reason. Four views, each a URL hash that survives reload:

- **FDAs** (default) — run list + drill-down: status/duration/tokens/cost
  KPIs (the Status KPI reads the run's named outcome when the trace carries
  one — `goal met`, `attempt cap`… — with `outcome_reason` as its tooltip, and
  falls back to the old status/staleness label for runs recorded before
  outcomes existed), "tokens per model" chips, a Gantt timeline (one lane per phase owner,
  roster colors, running bars dashed), per-phase detail (engine, model,
  effort/thinking, context gauge, gates with expandable checks, typed
  envelopes with syntax-highlighted JSON, the compiled system/user prompts)
  and a live filtered event stream. A `running` session with no event for
  10 minutes and no live pid is tagged **stale** — it never animates forever.
- **Interactive Pi** — this project's `~/.pi/agent/sessions/` timelines:
  main lane + one lane per subagent run, messages, tool calls, tokens.
- **Plan** (`npm run plan`) — everything `/map`/`/start` created: milestones
  (declared status, resolved task progress), specs with gate logs, the
  example library (license chips flag the GPL family), workflow progress,
  screens/routes, tasks with frontier navigation, the design system
  (component registry, `/ui-components` probe) and every `ai-docs/` document
  rendered, plus an `inbox · N open` badge.
- **Agents** (`npm run agents`) — engine cards with install/login state and
  fix hints per provider (Claude, Pi + its providers, Cursor and Grok Build —
  the grok card shows the subscription login, its model list, whether the
  project folder is trusted yet and a flag when `XAI_API_KEY` is set in the
  environment), the commands → phases → agents map, and the roster
  editor: engine/model/reasoning/fallbacks per agent, curated model pickers
  (live `cursor-agent --list-models` when Cursor is installed, grok's own
  `models_cache.json` when Grok Build is), reasoning pills that follow each
  engine's ladder (grok stops at `xhigh`), a billing
  guard banner for `anthropic/…` models on the Pi engine, and a save that
  edits the YAML **preserving comments**, backs up first
  (`imp/data/backups/fia.config.<stamp>.yaml`) and answers **409** while a
  live (non-stale) FDA runs.

The FDA-side of the same data is `--view pi`-free in the terminal:

**TUI** — `npm run tui` / `imp tui` (`node imp/scripts/fia-tui.mjs [--tab 1-6]
[--once] [--no-alt] [--db] [--ai-docs] [--config]`). Read-only Ink 7
dashboard, six tabs: **1 Home** (tasks/specs/milestone/inbox/all-runs cards +
the current FDA run with per-phase chips and a context gauge, plus a live
strip when an interactive Pi command is running), **2 Work**
(tasks + specs with the traceability table — uncovered requirements in red),
**3 Runs** (table + drill-down with phases, retries, live event tail — the
detail header prints the run's named outcome next to its status when one was
recorded),
**4 Plan**, **5 Agents** (roster + the per-LLM usage ledger, attributed at
spend time), **6 Pi** (live interactive command with tokens in/out, cost and
per-tool phases; full command history since install; a documentation checklist
showing which `ai-docs/` artifacts exist and which `/command` creates each
missing one). Keys: `1-6`/`Tab` tabs · on **Pi**, `Tab` cycles
Live/History/Docs · `↑↓ j k` move · `Enter` open ·
`Esc` back · `t` run the test suite in a pane (disabled while an FDA holds
the lock) · `r` refresh · `v` open the web viewer (detached, matching tab) ·
`q` quit. Mouse: click a tab to switch (no Enter — same as `1-6`), click a
list row to select, click a selected run to open it; wheel scrolls. The
header never lets the FDA badge cover a tab: the project name and then the
badge shrink so all six labels stay hittable. SGR reporting is restored on
exit.
`--once` renders one settled frame and exits (CI/smoke — it also skips the
file watcher); non-TTY without `--once` exits 1 pointing at the query CLI.

Interactive Pi command telemetry is recorded deterministically by the
`.pi/extensions/fia-telemetry.ts` extension (stamped with every project):
each `/idea`, `/stack`, `/map`, `/grill`… run appends to
`imp/data/telemetry/commands.ndjson` and updates `live.json` while it is
active (tokens in/out, cost, tool phases, docs written under `ai-docs/`).
The TUI reads those files read-only — no retroactive history for commands
run before the extension was installed.

**Query CLI** — `node imp/scripts/fia-query.mjs`:

```bash
npm run fda:sessions                      # 20 newest runs (id, status, outcome,
                                          # request, tokens, relayed)
npm run fda:phases -- <fda_id>            # phase list of one run
npm run fda:tail   -- <fda_id>            # last 20 raw JSONL events of a run
npm run fda:cost-report                   # token cost breakdown per phase: fresh
                                          # input vs cache_read vs output (0 tokens)
npm run fda:cost-report -- <fda_id>       # same, filtered to one run
node imp/scripts/fia-query.mjs models     # per-LLM lifetime ledger (engine, model,
                                          # runs, tokens, cost, last used)
node imp/scripts/fia-query.mjs sessions --json   # scripts/Pi consume JSON
```

Runs recorded before the input/output split was introduced keep their real
total/cache values; `fresh`, `output` and `cache_pct` show `null` rather than
guessing an input/output decomposition that was never captured.

The `models` ledger sums what actually ran (`agent_end` + failed-attempt
`agent_spend` events, stamped at spend time) — roster edits never
re-attribute history; tokens recorded before model stamping surface as an
explicit `unattributed` row, never silently dropped.

Every reader **probes** for `sessions.outcome`/`outcome_reason` before naming
them in a SELECT (`hasColumn` in `imp/scripts/fia-tui-data.mjs`, the same
`PRAGMA table_info(sessions)` check in the query CLI and in the viewer's
`/api/sessions`). The trace schema is create-only, so those columns exist only
in a database a current runtime has opened (the Tracer adds them with a guarded
`ALTER TABLE` — best-effort: a locked or read-only db just keeps running
without them). Naming a column that is not there throws, and these readers
answer a throw with an empty shape — which would blank a whole dashboard on an
older project.

**Launch readiness** — `npm run launch:check` (`node
imp/scripts/fia-launch-check.mjs [--json] [--strict] [--dir <p>]`). Read-only
red/green report — it never publishes anything. Detects the current rung
(`local` → `beta` when `.vercel/project.json` exists → `production` only when
the full stack is ready). Clerk + Convex projects need matching
`pk_live_`/`sk_live_`, explicit Convex Production, the production webhook
secret and an own-domain production URL; SQL stacks use the own-domain signal.
The checker runs stack-aware checks across six sections:

- **Versioning**: git repo (blocker), clean tree (blocker), remote, pushed,
  CI green (via `gh`), CI workflow present.
- **Work**: open tasks, `stack_decided` (blocker — pending manifest layers),
  `production_runbooks` (every named `ai-docs/apis/<tech>.md` needs its
  Production section), `test_credentials` (auth stacks need ≥1 filled roster
  row between the credential markers), `quality_scripts`
  (lint/typecheck/test/build present), `docs_sync` (schema-ish files
  committed after `stack.md`/specs), `theme_tokens` (raw hex colors in
  components), `registry_seeded` / `registry_planned` (blind registry,
  planned rows at launch), `wiki_fresh` (repo-wiki pages whose declared
  sources changed since they were stamped — skipped when there is no
  `ai-docs/wiki/` yet, §10), `spec_diagrams` (specs with no ```` ```mermaid ````
  block under `## Flow` — skipped when the project has no spec),
  `qa_evidence` (milestones marked `done` with UI but no passing report in
  `ai-docs/qa/` — warn, suggests `/qa M1`).
- **Secrets**: tracked `.env*` files (blocker — untrack AND rotate),
  `.env.example` present, secret-shaped values in `NEXT_PUBLIC_*` (blocker).
- **Security**: raw `query(`/`mutation(` outside `convex/lib` (use the authed
  wrappers), `dangerous_html` and `security_l1` — both delegated to the L1
  scanner below, so they cover `app/`, `components/`, `src/`, `lib/`, `pages/`
  (and `convex/`) instead of only `app/` + `components/`; `security_l1` fails
  on any HIGH finding and also fails — never passes — when the scan hit its
  file cap, because a partial scan that reports "clean" is the worst failure
  mode there is. Webhook signature verification in `convex/http.ts` (blocker).
- **Production**: Vercel linked, `convex deploy` in the build command, dev
  deployment noted, blocker checks for Clerk live key pair, Convex Production,
  `CLERK_WEBHOOK_SIGNING_SECRET` and final domain, plus the
  `automations_runbook` **blocker** when the manifest declares an external
  automations layer (e.g. Modal) without a Production runbook.
- **Operations**: error monitoring (Sentry), a database backup existing
  (with the "rehearse a RESTORE once" reminder).

`--strict` exits 1 on blockers (CI-friendly); `--json` gives
`{rung, checks[], summary}`. `/launch` (in `pi`) uses this report as its
source of truth and walks you through each fix.

**L1 security scan** — `npm run security:scan` (`node
imp/scripts/security-scan.mjs [--dir <root>] [--json] [--sarif]
[--fail-on high|medium|low]`). Deterministic textual rules over the source
roots (`app/`, `components/`, `src/`, `lib/`, `pages/`; the Convex rule scans
`convex/`), read-only, zero tokens, never a throw — a missing root or an
unreadable file simply gives the scan less ground. Layer 1 only: semantic
review (authorization models, tenant isolation, business-rule bypasses) stays
with the `security` skill. The rule **ids are a public contract** — CI configs
and the launch check key off them, so they are only ever added, never renamed:

| Rule id | Severity | What it catches |
|---|---|---|
| `raw_sql_interpolation` | high | SQL built by `${}` interpolation or `+` concatenation inside a `query(`/`execute(`/`raw(`/`sql(` call (a tagged `` sql`…` `` template never fires). |
| `jwt_decode_without_verify` | high | `jwtDecode(` / `jwt.decode(` in a file that never verifies a signature. |
| `public_env_secret` | high | `NEXT_PUBLIC_`/`VITE_`/`PUBLIC_` variable whose name says SECRET/PRIVATE/TOKEN/PASSWORD, or ends in `_KEY` (except the four public-by-design ones: `PUBLISHABLE_KEY`, `API_KEY`, `ANON_KEY`, `PUBLIC_KEY`). |
| `eval_usage` | high | `eval(` / `new Function(`. |
| `child_process_shell_true` | high | a child process spawned with `shell: true`. |
| `hardcoded_secret_literal` | high | a live-looking secret in a quoted literal (`sk_live_`/`sk_test_`, `whsec_`, `re_`, `sntrys_`, `xai-`, `AKIA…`). |
| `dangerous_html` | medium | `dangerouslySetInnerHTML`. |
| `missing_auth_check` | medium | `route.ts`/`route.tsx`/`+server.ts` exporting POST/PUT/PATCH/DELETE with no auth/session mention anywhere in the file. |
| `convex_missing_args_validator` | medium | a Convex function declared without `args:` (`convex/lib/` and `_generated/` excluded). |
| `http_url` | low | a plaintext `http://` URL (local dev hosts — `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]` — and the w3.org/schema XML namespaces excluded). |

Output: the human report by default, `--json` for the full
`{available, findings[], summary, rules[]}`, and `--sarif` for a SARIF 2.1.0
document (findings become results with `error`/`warning`/`note` levels) piped
straight into a code-scanning upload — `--sarif` wins over `--json` and prints
nothing else. `--fail-on <severity>` exits 1 when a finding at that severity or
worse exists (an unknown severity is a usage error, exit 1); without it the
scan always exits 0. A false positive is treated as worse than a miss, so every
pattern is narrow and the known-legitimate shapes are excluded by name.

**Loop health** — `npm run loop:health` / `imp health` (`node
imp/scripts/loop-health.mjs [--dir <root>] [--json] [--html <path>]
[--strict]`). An evidence-based score of the project's agent work loop, computed
by code from what the harness already produces (the trace db, the `ai-docs/`
documents, the launch check) — never inferred by a model. Five dimensions:

| Dimension | Question it answers |
|---|---|
| `task_understanding` | Did the loop start from a written goal an agent can act on — specs, filled traceability, a task index, a real PRD? |
| `controlled_execution` | Did deterministic FDA runs actually happen, reach their goal, and run against a decided stack? |
| `change_validation` | Was the change proved — the quality commands exist and the test/lint/build gates really passed inside a run? |
| `reliable_delivery` | Is the work delivered as promised — no launch blockers, clean and pushed tree, test users recorded, CI in place? |
| `learning_capture` | Was what the project decided and learned written down — decision logs closed, inbox drained, registry honest? |

The honesty rule: a dimension whose evidence is ABSENT is reported as
**`unknown`**, never as zero. An unknown criterion adds 0 to the score AND 0 to
the maximum, each missing input is named in `gaps`, and every finding ends in
the exact IMPACTUS command that repairs it. Statuses are `strong` (≥ 80% of the
judged criteria), `partial` (≥ 40%), `weak` below that, `unknown` when nothing
could be judged. `--strict` exits 1 when any dimension is `weak`; `--html`
also writes a self-contained report (default `imp/reports/loop-health.html`,
gitignored) and **refuses while an FDA holds `imp/data/.fda.lock`** — that
run's permission gate would roll the write back, so nothing is written and the
command exits 1. Under `--json` stdout stays pure JSON and the HTML notice goes
to stderr.

**System evolution review** — inside Pi, `/evolve --run <fda_id>` reviews one
finished FDA execution, while `/evolve --since <Nd|YYYY-MM-DD>` scans a bounded
history window; both accept an optional `--steer "…"`. A deterministic,
read-only collector normalizes the trace database, session artifacts, command
telemetry and attributable commits into a versioned JSON evidence bundle. The
agent then writes local, gitignored reports under `imp/reports/evolution/`:
run mode produces a factual execution Markdown plus a self-contained system
review HTML; window mode produces an opportunity-scan HTML. Missing or legacy
data becomes an explicit `gap`, messages are bounded and secrets redacted, and
an active FDA blocks report writes. This is system/process review, not code
review: every recommendation needs exact evidence, frequency, impact,
confidence, the smallest durable primitive and a probe, and nothing is ever
applied automatically.

**Undo a run** — `npm run fda:rewind` / `imp rewind` (`node
imp/scripts/rewind.mjs [--dir <root>] [--list]` ·
`… --run <fda_id> [--to <sha>] [--json] [--dry-run] [--yes] [--allow-dirty]`).
An FDA run already leaves everything an undo needs on disk (it commits per
phase and photographs the tree before it starts); this is the way to see and
use those checkpoints. With no `--run` it lists the 20 newest runs from the
trace db with the commits each one made (matched by the run's time window, plus
subject-matching for commits the window missed) and the pre-run HEAD. With
`--run <fda_id>` it prints the exact file impact of undoing that run — per file,
with +added/−deleted counts and a total.

**Restore-only by contract**: it writes files with `git restore --worktree` and
deletes files the run created from the **working tree only**, leaving the index
untouched — so `git status` shows an unstaged deletion you can inspect and undo
with a plain `git restore <path>`, and nothing rides into your next commit. It
never runs `git reset`, never moves HEAD or a branch, never stages, never commits
and never rewrites history — so the rewind is
itself undoable (every commit is still there). The default target is the run's
**baseline commit** (the HEAD when the run started); `--to <sha>` overrides it.
Nothing is touched without `--yes` — the preview is the default, `--dry-run`
stops after it. The plan refuses, naming the reason, when: the run id is not
`[A-Za-z0-9_-]+`; the folder is not a git repository; the run is not in the
trace db (or there is no trace db yet); an FDA is currently running in the tree;
the working tree has uncommitted changes (`--allow-dirty` accepts losing them);
the run has no baseline commit on record (pass an explicit `--to`); or the
commit does not resolve. Exit 0 = listing/preview printed or the restore
succeeded; 1 = blocked, unknown run id, or a restore failed. Nothing is
committed: review with `git status` / `git diff`.

### 9.7 Terminal outcomes and stop conditions

A run used to end as a boolean — `success` / `fail` — and the human reason
survived only as a console line. Now every run that closes records ONE named
**terminal outcome** plus a one-sentence reason. The vocabulary lives in
`imp/modules/outcome.mjs`, shared by the writer and every reader, so an outcome
can never be spelled two ways:

| Outcome | What it means |
|---|---|
| `goal_met` | **The only success**: the phases are green and the run's acceptance criterion was met. |
| `verification_failed` | The work ran but the verification refused it — a red suite, or a reviewer that did not approve. |
| `attempt_cap` | The fix loop spent its `stop.attempt_cap` repair rounds with the suite still red. |
| `no_progress` | The SAME checks failing over a tree the repair did not change, round after round — stopped early on purpose. |
| `budget_exhausted` | A budget was reached: `stop.budget_minutes` (wall-clock), `stop.token_budget` (run lifetime), `stop.phase_token_budget` (one phase), or a phase timeout after real spend. |
| `breadth_exceeded` | The run had already changed more files than `stop.breadth_ceiling`. |
| `blocked_by_gate` | A gate or the permission allowlist refused (`GateFailure`, `PermissionBreach`). |
| `engine_exhausted` | Every engine in the fallback chain died (`EngineFailure`). |
| `stopped_by_request` | The manual stop button (`imp stop`) was armed — the run stopped cleanly before its next phase; nothing is lost and `--resume` continues it after `imp stop --clear`. |
| `aborted` | Ctrl+C / SIGTERM — the signal handler closes the session instead of leaving an eternal `running` orphan. |
| `failed` | An unclassified throw. |

Where it is written:

- **`sessions.outcome` and `sessions.outcome_reason`** — two columns on the
  session row. The schema is create-only (`CREATE TABLE IF NOT EXISTS`), so the
  Tracer adds them to an older project's database with a guarded
  `PRAGMA table_info` + `ALTER TABLE` on open; a locked or read-only db degrades
  and the run continues without them. Readers probe before selecting (§9.6).
- **A closing `run_end` event** — `type: 'run_end'`, `name: <outcome>`, payload
  `{ outcome, reason, accepted, phases, replayed, tokens, cost }`.
- **The end banner** — `══ ACCEPTED (goal met) — <tokens> tokens, $<cost> …`,
  the label coming from the same vocabulary.

Closing a run is **first-writer-wins**: the precise reason (a stop condition, a
gate, a signal) is never overwritten by the vaguer one that follows it up the
stack, and both trace writes are best-effort — a failed write never masks the
real failure. An outcome the caller knows precisely is passed in (`attempt_cap`,
`no_progress`); otherwise it is derived (`goal_met` when accepted,
`verification_failed` when not) or classified from the error.

**Stop conditions** — limits that cost zero tokens to evaluate, so a run
that keeps re-trying the same failing thing stops instead of spending the
student's plan. They live under `stop:` in `imp/fia.config.yaml`:

| Key | Default | What it counts |
|---|---|---|
| `attempt_cap` | `3` | Repair rounds the tested FDAs (`fda_plan_build_test`, `fda_bug`, `fda_build_test` and the `/goal` default `fda_sdlc`) may spend on a red suite (minimum 1 — a value below that is raised). |
| `no_progress_window` | `2` | Consecutive identical rounds after which the run is declared stuck. `0` turns the detector off. |
| `budget_minutes` | `0` (**off**) | Wall-clock ceiling for one run. |
| `breadth_ceiling` | `0` (**off**) | Maximum files one run may touch. Turning it on costs one tree fingerprint per phase, and a `Kind: foundation` run legitimately touches many. |
| `token_budget` | `30000000` (**on**) | Token ceiling for the RUN LIFETIME — every resume of the same `fda_id` counts against it (the baseline is read from `sessions.total_tokens`, failing open). Warned once at 50% and 80% (`budget_warning` log events), stopped at 100% as `budget_exhausted`. Checked between phases AND between sends, and enforced mid-send by the adapters' token cut. `0` = off. |
| `phase_token_budget` | `8000000` (**on**) | Token ceiling for ONE phase — all its sends, corrections and relay legs. The engine child is cut mid-send at the remaining room (SIGTERM, then SIGKILL). Never arms the relay: re-running a budget-killed phase on another engine would re-spend everything. `0` = off. |
| `phase_timeout_minutes` | `50` (**on**) | Wall-clock ceiling for ONE agent send (`code` phases have their own timeouts). A kill with almost no spend (< 500k tokens) is a hung CLI and retries like a crash — same engine once, then the relay chain; a kill after real spend stops the run as `budget_exhausted` instead of re-paying the phase. `0` = off. |

A budget-stopped run never switches engines or retries on its own: it pauses
with a calm panel pointing at the `stop:` knob — raising the limit (or `0`)
and resuming is a human decision. Cursor reports no token usage, so the token
ceilings cannot see cursor phases (the timeout still applies).

**Browser QA** (`/qa`) video retention lives under optional `qa:` in the same file:

| Key | Default | What it controls |
|---|---|---|
| `video` | `retain-on-failure` | Playwright video: `off`, `on`, or `retain-on-failure`. Overridable per run with `--video`. Large artifacts land in gitignored `imp/data/qa/<fda-id>/`; the committed report is `ai-docs/qa/*.md`. |

- **`no_progress`** compares a fingerprint of *where the run is stuck*: the
  names of the FAILING checks plus `path:size,sha1` for every path this run
  changed against its baseline — de-duplicated, sorted and hashed as JSON, so a
  shuffled report never reads as progress. The **content** matters, not the path
  list: a normal brief reports exactly one check (named `test`) whether twelve
  assertions fail or one, and a repair almost always edits files the build phase
  already touched — with paths alone, a run that fixed eleven of twelve failures
  would hash identically to the round before it and be stopped as stuck. So a
  round only counts toward the streak when **the repair before it actually
  ran and changed nothing**:
  - the first test round has no repair behind it and is only a baseline;
  - on `--resume` every `fix_i` is replayed from disk as a no-op while the
    `code`-kind test phases re-execute, and those rounds never count — otherwise
    the documented recovery path would dead-end before a single repair;
  - a green round clears the streak, because a passing suite is never a stall.

  The whole accounting lives in one place (`createRepairTracker` in
  `imp/modules/stop.mjs`) so the two FDAs that drive it cannot drift. Every RED
  test round logs `identical_rounds`, `counted_as_a_round`, `no_progress_window`
  and `stalled` into the trace.
- **`budget_minutes` / `breadth_ceiling`** are run-level and apply to every
  runner. They are checked before a phase is created — so a stopped run never
  leaves a half-started phase in the trace — and only for phases that will
  actually execute (a replayed phase costs nothing).
- **Tolerant by design**: a missing block, a missing key, a typo'd value or a
  negative number all fall back to the default and are printed as a warning at
  the start of the run. Nothing here can throw.

**The manual stop button (`imp stop`)** sits beside the automatic limits: it
arms `imp/data/fia-stop` (a plain file — `touch` works too), and while it is in
place no new run starts (`ensure()` checks it before reading anything else)
and an in-flight run stops before its next phase with outcome
`stopped_by_request`. The reader (`manualStopState` in `imp/modules/stop.mjs`)
**fails closed**: only a clean ENOENT means "keep running" — a stop file that
exists but cannot be read still stops the run, because the obvious polarity
("run unless a readable stop request is found") makes the button work only
while the filesystem does. `imp stop --status` shows the state (and any live
run), `imp stop --clear` disarms and VERIFIES the file is really gone,
`--reason "…"` attaches a note shown wherever the stop is reported. Alias:
`npm run fda:stop`. The button is exercised by the repo's test suite in both
directions — a stop button that has never been used is a stop button nobody
knows works.

**Bounded continuation** — the other half of "how did it end": a run that closed
`verification_failed`, `attempt_cap` or `no_progress` did real work, and `--resume`
already replays every phase that succeeded. What it cannot know is what a reviewer
considers still owed, so a blind resume either repeats accepted work or stops at
the same wall. A **verdict** is that judgement, written down before the resume:

```bash
node imp/scripts/verdict.mjs set <fda_id> \
  --missing "the empty state is not handled" \
  --missing "no test covers the 403 path" \
  --redo review
node imp/fda_sdlc.mjs --fda-id <fda_id> --resume
```

- It lands as `imp/data/sessions/<fda_id>/run_verdict.json` — a sibling of the
  engine-death marker, with the same best-effort IO contract (an unreadable
  verdict reads as "no verdict" and the run proceeds exactly as it would have).
  `outcome` is filled in from the trace automatically; `missing` is capped at 20
  items, because a verdict is a scope and not a backlog.
- `--redo <phase>` names phases whose **saved result must not be replayed**.
  `ensure()` removes those `phase_results/<name>.json` files, so the ordinary
  resume rule ("no saved result → execute") re-runs them — the replay predicate
  in the runner is not special-cased at all. A name that is not
  `[A-Za-z0-9_-]+` is refused, so a verdict can never name a path.
- The phase names are **per-FDA and per-run**: `review` above belongs to
  `fda_sdlc` and does not exist in `fda_plan_build_test`, and a repeated phase is
  counter-suffixed (`test_1`, `fix_1`). `set` therefore checks each name against
  the phases the run actually saved and refuses an unknown one, printing the
  list — an unchecked name would drop nothing, so the phase would replay from
  disk while the run reported it as re-executed.
- Every agent phase of that run is prepended a scope block (user prompt only —
  the system prefix stays byte-stable for prompt caching) listing the missing
  work with three rules: do only what is listed, treat the list as the gap and
  not a design, and say so rather than manufacture a change when an item is
  already satisfied.
- The verdict is **one-shot**: consumed by the run it narrows, so a later resume
  of the same id is unrestricted again. A `bounded_continuation` log event records
  what the scope was, which phases were re-armed (`redo`), what the verdict asked
  for (`redo_requested`) and which of those had no saved result to drop
  (`redo_skipped`) — requested is not applied, and the ledger says so.
- `verdict show <fda_id> [--json]` reads one back, `verdict clear <fda_id>` drops
  it, and `set` refuses while THAT run still holds the FDA lock — a verdict about
  a run in progress is a guess. Alias: `npm run fda:verdict`.
- `set` also enforces the per-run **recovery budget**: at most 4 verdicts per
  run, counted in `verdict_history.json` next to the verdict — a ledger that
  `clear` never resets, because a consumed recovery still spent budget. This is
  the code-enforced ceiling behind goal mode's "recover while making progress"
  rule: the orchestrating agent repairs each NEW gap without asking permission,
  and the refusal here is the STOP it cannot talk its way past. Granting more
  recoveries is a deliberate human act (delete the ledger file by hand), not a
  flag an agent can pass.
- A **bare `--resume`** (no verdict) spends the same budget: every one is
  recorded in `resume_history.json`, and `verdicts + bare resumes >= 8`
  (`RECOVERY_CAP`) refuses further resumes with the instruction to convert the
  remaining gaps into a follow-up task instead — before this ledger existed, a
  bare resume consumed no budget at all, which is how a real run re-ran 16
  build cycles. And a bare resume over a tree **identical** to the one that
  failed is refused outright (the run's failure fingerprint is stamped by
  `settle()` into `last_failure_stamp.json` and compared on the next
  `ensure()`): re-running everything unchanged cannot end differently.
  Exemptions: a pending verdict (bounded continuation), an armed engine-death
  marker (relay recovery), a manual stop / spent budget (deliberate pauses),
  or the explicit `--retry-unchanged` flag. The same unchanged-tree rule now
  also guards the two `replay: false` phases individually: the `/qa` `audit`
  and `ui_verify` refuse to re-judge a tree they already rejected (markers
  `audit-attempts.json` / `ui-verify-attempts.json`; the shared fingerprint
  machinery lives in `imp/modules/tree-guard.mjs`).

**Rollout matters here**: `imp/fia.config.yaml` is student-owned and
`--update-runtime` never rewrites it (§14.2). Every existing project therefore
gets the defaults above from the code, with no edit and no migration — the
template ships the whole block commented out, and a project that never adds it
behaves exactly as documented. Editing the YAML is how you tighten the limits,
never how you get them.

### 9.8 Run notifications (opt-in)

A student starts a long `/goal` and walks away; nothing used to tell them it
finished. `imp/modules/notify.mjs` sends one ping when a run ends, fired from
the runner's CLI wrapper on every termination path (success, failure, stop
condition) — exactly once per run, awaited before the process exits.

**Off by default, and it can never fail a run.** `enabled` must be explicitly
`true` AND at least one valid target must survive validation; anything else
stays off, with the reason reported as a warning. Nothing in the notifier
throws: a malformed config, a dead webhook, a missing `fetch` or a timeout all
degrade into a warning or one line in `failures`.

Configuration comes from two places — the machine file
`~/.impactus-cli/config.json` (key `notify`, §14.6) and the project's
`imp/fia.config.yaml` (key `notify`) — merged **per key, the project winning**.
Both are student-owned and optional:

| Key | Default | Notes |
|---|---|---|
| `enabled` | `false` | Must be literally `true`. |
| `events` | `[run_end]` | `run_end` · `gate_blocked` · `decision_needed`; unknown names are dropped with a warning. Only `run_end` is emitted by a run today; `gate_blocked` and `decision_needed` are **reserved for a future release** — they are accepted by config and sendable with `--test` (which says so), so a target can be verified before the producer exists. |
| `timeout_ms` | `4000` | Per target, clamped to `[500, 20000]` (out-of-range values are clamped with a warning). |
| `targets` | `[]` | `{ kind, url }` entries: `webhook` (posts the JSON payload), `slack` (`{text}`), `discord` (`{content}`), `telegram` (`sendMessage` with `chat_id` — required, and the url works with or without the `/sendMessage` suffix). |

**Only `https://` targets are accepted** — the URL carries a token that must not
cross the network in the clear; `http://` is allowed for `localhost`,
`127.0.0.1` and `[::1]` only, so a student can test against a local receiver.
**A target URL is treated as a secret**: every warning, failure line and report
names a target by kind + HOST only, and fetch/JSON error messages are never
interpolated (undici and V8 quote the offending input back at you, which would
leak the token that was just redacted). Targets are posted in parallel, each
with its own deadline.

Inspect and test it with `imp notify` / `npm run notify` (`node
imp/scripts/notify.mjs [--dir <root>] [--json] [--home <dir>]` ·
`… --test [--event <name>]`):

```bash
imp notify                 # the RESOLVED config: status, events, timeout,
                           # machine + project file paths, targets as kind → host.
                           # When it is off, it prints the exact JSON to paste
                           # into ~/.impactus-cli/config.json. Always exits 0.
imp notify --test          # sends ONE synthetic notification; exit 0 when at
                           # least one target took it, 1 when none did
imp notify --test --event gate_blocked
imp notify --json          # same information as JSON — never contains a URL
```

### 9.9 The gate that measures itself: regression floor, holdout probes, gate probes

Three guards that watch the FACTORY rather than the student's code. All three
follow one rule borrowed from lights-out factory experiments: a check the
builder can read and iterate against is inside its optimization loop — the
numbers that judge the work must live where agents cannot touch them, and the
harness must be able to prove its own checks can fail.

**Regression floor (`imp/modules/floor.mjs`)** — a ratchet with zero slack
under the test suite. After every GREEN full-suite run (`runTestsForBrief`, so
`/task`, `/goal`, `/feature`, `/bug` and the UI-gate retest all pass through
it; `/quick` and `fda_quality` are excluded by construction — they run focal
or non-suite checks) the runtime stamps what it observed into
`imp/data/floor.json`: the count of
`*.test.*`/`*.spec.*` files in the tree, and — when the runner's summary is
recognizable (vitest, jest, node:test TAP, mocha, pytest) — how many tests
passed. The next green run must observe **at least** those numbers: a suite
that went green because tests were deleted or skipped turns RED with a
synthetic `floor` check, and the ordinary repair loop asks the builder to
restore the tests. The passing-test count is the AUTHORITATIVE signal and the
file census only a proxy for it, so when the count holds or grows a smaller
file count reads as a reorganization (two suites merged, a rename) and
re-baselines instead of failing — otherwise an honest refactor would be
blocked by a number the builder is not allowed to touch. Three properties keep
the rest honest:

- **Zero slack**: floors sit equal to what was last observed — the gap between
  observed and floor is exactly the number of tests that can be deleted with
  the gate still green. (The file census is the one number that may also
  re-baseline downward, and only when the passing count confirmed the
  coverage held.)
- **Agents cannot move it**: the file is protected in code
  (`ALWAYS_PROTECTED` in `imp/modules/permissions.mjs`, independent of the
  student's `protected_files` config) — an agent write is rolled back, and a
  deleted one is restored from git. Because only trusted code stamps it, the
  ratchet RISES automatically; the authoritative `tests_passed` floor never
  moves down on its own, and lowering it is a human edit in the student's own
  commit (deleting the file re-baselines on the next green run). The raise
  rides the same FIA commit as the work that earned it.
- **Fail closed**: an unreadable or corrupt floor file is indistinguishable
  from tampering and fails the check, with both recoveries named
  (`git checkout -- imp/data/floor.json`, or delete to re-baseline).
- **Raised by the test phase, not by the merge**: the stamp happens where the
  observation does, so a run that goes green and then fails a later gate
  leaves the higher floor behind as an uncommitted change. That is harmless
  while the work stays (the next run observes the same numbers) and
  `git checkout -- imp/data/floor.json` restores it if the work is reverted —
  the same one-liner the violation message prints.
- An unrecognizable test summary never guesses: the passed-count floor simply
  does not apply then; the file census always does.

**Holdout probes (`imp/data/holdout/`, `imp/modules/holdout.mjs`)** —
acceptance checks OUTSIDE the builder's loop. The task-sequencer seals 1–3
probes when it writes a brief — before the code they will judge exists,
because a scenario written after seeing the implementation is a description
of the implementation. Each probe is a plain Node script run as bare `node
<file>` from the project root (exit 0 = the invariant holds; no bundler, so no
TS path aliases and no `.tsx`), and the FDA runs them in a `holdout` code
phase after the suite goes green. The directory is agent-**write**-protected
and probe contents are never quoted into the brief; reading is not blocked (an
agent holding `bash` cannot be prevented from opening a file), so the
separation rests on the probe existing before the code and on nothing in the
builder's prompt pointing at it. A violation fails the run with **no repair
round** — feeding the probe back to the builder would move it inside the loop
it exists to sit outside of; the output goes to the human, in the trace.
Probes accumulate across tasks as a growing regression holdout. A project
with no probes skips the phase (proportionality) — which is also why the
sequencer **commits** the probes it seals: no FDA commits `imp/data/holdout/`
(their commit is pathspec-limited to what the run produced), so an
uncommitted probe set is lost to a checkout and the gate would then stand
down silently. A project that has adopted holdouts asserts they still exist
with `npm run holdout -- --require`, which fails on an empty directory. CLI:
`npm run holdout` (`--list`, `--require`, `--json`); green emits the literal
marker `HOLDOUT_PASSED scenarios=N`.

Because probes accumulate, a task postponed for a reason outside the code
(missing API keys, a decision the engineer will make later) would leave its
sealed probes failing every later run — and agents cannot touch the
directory. The sanctioned escape hatch is **`imp defer <n>`** (or `/defer`
inside Pi, `imp/scripts/task-defer.mjs`): the ENGINEER's command that renames
the task's probes `NN-*` → `_NN-*` (the runner's "not a probe" prefix —
content untouched), sets the task `deferred` in the issue file and the index,
and ledgers the deferral (`imp/data/deferrals.json` + an inbox note).
`imp defer resume <n>` restores the exact sealed probes and sets the task
`pending`. It refuses inside an FDA phase and while a run is live, asks for
confirmation (or an explicit `--yes`), and the launch check's
`tasks_deferred` warning names every open deferral — so shipping without a
deferred task is always a conscious call, never a forgotten `mv`.

**Gate probes (`imp/scripts/gate-probes.mjs`)** — the self-test of the
harness: deliberate defects (an unchecked brief box, a rubber-stamp `— N/A`,
a swapped checklist item, a ghost artifact, a lowered floor, an approved
verdict with blockers, an unreadable stop file…) injected against throwaway
fixtures in OS temp, each of which must make its gate go RED — plus clean
controls that must pass, so an always-red gate cannot satisfy the test.
Until a defect has been injected and caught there is no evidence a check can
fail at all; a MISSED probe means a class of defect can currently slip
through that project's gates unseen (the fix is `npx impactus
--update-runtime`, never deleting the probe). Run it with
`npm run gates:probe` or `imp doctor --gates`; the repo's own CI runs the
same catalog against the templates. The project tree is never touched.

## 10. The durable planning layer

Shared conventions between the harness (Claude Code/Cursor) and Pi, all under
`ai-docs/`:

- **Specs** — `ai-docs/specs/NNNN-<slug>.md` (4-digit, numbering continues;
  `0000-example.md` is the shipped format reference and never counts).
  Header: `Status: draft | defined | in-progress | done`, created/updated
  dates and the linked task numbers. Sections: Problem & Outcome, Scope
  (In/Out), **Flow** (ONE ```` ```mermaid ```` diagram of the capability — the
  happy path plus where it can refuse; `flowchart TD` for a data/decision flow,
  `sequenceDiagram` when the point is who calls whom), Actors & Permissions,
  Requirements (`FR-1`/`NFR-1`, one
  obligation per ID), Scenarios (BDD, `S-1` — with mandatory classes for
  user-facing mutations: success, validation, authorization, cross-tenant
  isolation and idempotency where they apply), Traceability
  (requirement → scenario → test file), an append-only Gate log
  (`Definition Gate` / `Delivery Gate`) and dated Decisions. Lean on purpose:
  "Not applicable — <why>" is a valid section body. Created by `/feature`
  (delta specs replacing the old mini-PRD), `/spec` (short interview, also
  for work not born from the PRD) and the full mapping.
- **The Flow diagram is checked, not enforced.** Detection is deterministic —
  only a fence OPENED at line start with ```` ```mermaid ```` counts, so a
  quoted example inside another fence and an indented fence do not
  (`specHasDiagram`/`checkSpecDiagram` in `imp/modules/gates.mjs`, twinned with
  `hasDiagram` in `plan-docs.mjs`, which also exposes a `withoutDiagram` count
  per project). The `/spec` Definition Gate requires the diagram before it flips
  `Status: defined`; `npm run launch:check` warns per spec without one
  (`spec_diagrams`, §9.6); and the FDA spec-coverage phase records a missing
  diagram in the trace as `diagram: missing — …` without ever failing the run —
  a documentation gap is not a broken build.
- **Test markers** — a test file proving a spec carries
  `spec:NNNN covers:S-1,S-2,FR-2` (one marker per spec, grep target
  `spec:NNNN`). Tasks/briefs link back with a `Spec: 0003 (S-1, S-4)` line;
  when present, the FDAs run the **spec-coverage gate**
  (`checkSpecCoverage` in `imp/modules/gates.mjs` — `git grep` with a
  recursive fallback): every listed ID must appear in some test's `covers:`
  list, missing ones fail the phase by name. No `Spec:` line → check skipped.
- **Spec delivery close-out** — after a tested task passes its suite, coverage,
  checklist and remaining gates, the FDA runs `spec_close` as code. It treats
  the current roadmap issue as delivered, verifies every other issue on the
  spec's `Tasks:` line is already `done`, appends dated Delivery Gate evidence
  and sets `Status: done` before the implementation commit. Missing Tasks
  metadata, unknown issue files or an unfinished sibling fail closed: the spec
  stays open and the exact reason is recorded in the run trace. Re-running is
  idempotent, so the last task no longer depends on a later agent pass to
  remember the transition.
- **RED validity** — `fda_bug.mjs` writes ONLY the failing reproduction test
  first, then a `red_check` phase runs it and `validateRedReason` classifies
  the failure: an assertion/expectation failure is a valid RED; a passing
  test fails the gate as "bug not reproduced"; module-not-found, syntax,
  command/env errors fail it with the classification (unknown → invalid,
  conservative). Only then does the fix build run.
- **Milestones** — `ai-docs/milestones.md`: 3–6 blocks (`Goal`, verifiable
  `Done when:` list, `Tasks:`, `Status: pending | in-progress | done`), the
  first being the MVP, generated by `/map` (Pi) and `/start` (harness) after
  the task breakdown and fed by the PRD's `## Launch criteria` (captured by
  `/idea`/`/grill`). A milestone is done only when its exit conditions are
  verified — never by task count; the declared Status is never auto-flipped.
- **Inbox** — `ai-docs/inbox.md`:
  `- [ ] YYYY-MM-DD — <one-line idea> (context: …)` appended by `/note` with
  ZERO interview. `/feature`, `/quick` and `/map` check it for related items
  and tick them with a `→ spec 0003` / `→ Q-012` / `→ task 07` annotation.
- **Decision logs** — `ai-docs/decisions/NNN-<command>-<date>.md`: every
  interview command (`/idea`, `/grill`, `/stack`, `/spec`, `/feature`,
  `/theme`, `/design`, `/kit`) records question/recommendation/answer as the
  interview happens, via `imp/scripts/decision-log.mjs` (deterministic: the
  script owns naming, numbering, timestamps and lifecycle; a crash loses
  nothing already answered):

  ```bash
  node imp/scripts/decision-log.mjs open stack --topic "backend choice"
  node imp/scripts/decision-log.mjs log 3 --q "Which database?" --rec "Convex" --a "Convex"
  node imp/scripts/decision-log.mjs log 3 --q "Which database?" --rec "Convex" --accepted
  node imp/scripts/decision-log.mjs note 3 --text "constraint that surfaced mid-talk"
  node imp/scripts/decision-log.mjs close 3 --outcome "Convex + Clerk" --artifact ai-docs/stack.md
  node imp/scripts/decision-log.mjs list [--command theme] [--json]
  node imp/scripts/decision-log.mjs latest [command]
  ```

  `--accepted` is the beginner's exit from an open question: the student takes
  the recommendation instead of typing an answer, and the entry is written as
  `- Answer: <recommendation> (accepted)` — so a later reader can tell a
  deliberate choice from a default that was waved through. It REQUIRES `--rec`
  (there must be something to accept) and refuses a simultaneous `--a`; both
  refusals are usage errors. Every interview command is told to carry a
  recommendation and to offer accepting it — never to invent an acceptance.

  One file per run = versioning: re-running a command opens the next `NNN`;
  a still-open log of the same command becomes `superseded`, closed ones are
  history. Commands read the recent logs before interviewing and never re-ask
  a decided question. The log preserves the interview; the artifact
  (PRD/spec/manifest) stays the source of truth for WHAT was decided.
  `/onboarding` uses the same script as a **resume rail** rather than an
  interview log: `open onboarding` when the tour starts, one
  `note <id> --text "stage <name>: …"` per completed stage, `close` at the
  wrap-up — `latest onboarding --json` finding an `open` log is how an
  interrupted tour resumes from its last stage note (never `open` again
  mid-tour: that would supersede the trail).
- **Stack research** — `ai-docs/research/<tech>.md`: before `/stack` documents
  or equips a technology, it must research FOUR dimensions — docs
  (+ `llms.txt`), agent skills (skills.sh registry), official CLI, official
  MCP — and log each finding with its source:

  ```bash
  node imp/scripts/stack-research.mjs open neon
  node imp/scripts/stack-research.mjs log neon --dim docs  --found "https://neon.com/docs" --source "https://neon.com/docs/llms.txt"
  node imp/scripts/stack-research.mjs log neon --dim mcp   --none --source "web search: neon MCP server"
  node imp/scripts/stack-research.mjs close neon      # REFUSES while any dimension lacks an entry
  node imp/scripts/stack-research.mjs status [neon] [--json]
  ```

  The `close` is the gate: only a closed record lets the tech be marked
  documented in the manifest (and equipped). "I didn't check" is not a
  representable state (`--source` is mandatory). One file per tech,
  script-owned; a re-open discards old findings on purpose (fresh evidence —
  history lives in git). The hardcoded tables (installer catalog, `/stack`
  hint table) are bootstrap hints: research that diverges from them wins, and
  the divergence is reported so the tables get updated.
- **Repo wiki** — `ai-docs/wiki/`: one page per subsystem (`auth.md`,
  `billing.md`, `data-model.md`…), written by `/absorb` and **kept honest by
  code**. The point is not documentation for its own sake: an agent that can
  read a fresh page about `auth` does not have to re-read `src/auth/**` to
  answer a question about it — that is the student's subscription, saved.
  `/absorb` produced only a one-shot snapshot before; the wiki is the
  maintained version of it. Every page opens with frontmatter naming the source
  paths it describes:

  ```markdown
  ---
  updated: 2026-08-17
  sources: src/auth, src/lib/session.ts
  digest: 6b0ffb0223a8f5e4be87c130e40d728c859e940a
  ---
  ```

  `sources:` is the load-bearing field (a comma list, or a YAML `- path` block
  list): a page without it can never be checked and is reported as
  `unverifiable`. `digest:` is a **content digest of those paths** — sha1 over
  every declared file (a directory contributes every file beneath it, sorted, up
  to 8 levels and 2000 files; a source that no longer exists is hashed as
  `missing`, so a DELETION moves the digest instead of being invisible). Text is
  hashed line-ending agnostic — a checkout with `core.autocrlf=true` (the Git for
  Windows default) must not report every page stale without a single content
  change — while a file containing a NUL byte is hashed as raw binary. No git,
  no LLM, no tokens: it cannot be wrong about *whether* the code moved, and it
  deliberately says nothing about whether the prose is still accurate — which is
  what makes `stale` a prompt to reread rather than a verdict. `updated:` is
  free text, reported and never interpreted. Text between
  `<!-- human:start -->` and `<!-- human:end -->` is a human's writing and
  survives every regeneration.

  ```bash
  npm run wiki:check                  # fresh / stale / unverifiable, per page
  npm run wiki:check -- --strict      # exit 1 when any page is stale (CI)
  npm run wiki:check -- --json        # the full report
  node imp/scripts/wiki-check.mjs --stamp   # re-record the digests
  ```

  The checker is read-only with exactly one exception: `--stamp`, which
  re-records `digest:` (and today's `updated:`) on the pages this run found
  stale. It rewrites **only those two frontmatter lines** — the body is sliced
  off and concatenated back byte-for-byte, preserving the page's own line
  endings, so a `<!-- human -->` block cannot be disturbed even in principle —
  and it **refuses entirely while an FDA holds `imp/data/.fda.lock`** (that
  run's permission gate would roll the write back), exiting 1 with the reason.
  Whoever rewrites a page's prose runs `--stamp` afterwards to close the loop:
  computing a rolling sha1 by hand is not a thing an agent can do. `/absorb`
  writes the pages with `digest:` empty, then stamps and shows the result;
  `npm run launch:check` carries the same signal as the `wiki_fresh` warning
  (§9.6). `ai-docs/wiki/README.md` is the shipped page contract and is skipped by
  the checker; the optional `ai-docs/wiki/wiki-plan.yaml` scopes GENERATION only
  (`preset: architecture | product`, `pages`, `include`/`exclude`, `guidance`) so
  a large repo does not turn into fifty shallow pages — delete it and the wiki
  still works. When the plan names pages that have no file on disk, they are
  reported as `summary.plannedMissing` (a promise the wiki has not kept yet); it
  deliberately does not make `passed` false, because an unwritten page is not a
  stale one. A missing wiki, an unreadable page or a mangled plan file all
  degrade into a status, never a crash. `wiki_fresh` in the launch check stays a
  `skip` until the wiki has at least one page: the harness *ships* the directory
  with its README, so directory existence alone would report a green "matches the
  code it describes" for a wiki nobody has written. The seed comes with the
  harness merge (a fresh install, or `--harness-only` on an older project) —
  `--update-runtime` carries `imp/` and `.pi/` only (§14.2), so a project that
  predates the wiki keeps `wiki_fresh` on `skip` until it re-merges the harness
  or `/absorb` writes the first page; the prompts carry the page contract
  themselves, so a missing `README.md` costs nothing.
- **Docs commits** — `imp/scripts/docs-commit.mjs` (alias
  `npm run docs:commit`): pathspec-limited commit for `ai-docs/` artifacts,
  called by the flows that generate durable documents (`/stack`, `/map` and
  `/start`, `/component`, `/design`, `/theme`, decision-log close) right when
  the documents land. Uncommitted docs are a contamination reservoir — the
  next FDA's commit can sweep them into an unrelated change. Guardrails: only
  `ai-docs/` paths are accepted (escapes resolved and refused — code is
  committed by FDAs, never by this script), it refuses while a FIA run is
  active (`imp/data/.fda.lock` with a live pid), and a clean tree exits 0
  with "nothing to commit".

  ```bash
  node imp/scripts/docs-commit.mjs --message "docs(stack): decide backend" [paths…] [--json]
  ```
- **Env preflight** — `imp/scripts/env-preflight.mjs` (alias
  `npm run env:check`): derives, from the layers `ai-docs/stack.md` declares,
  the dev keys the scaffold reads at build/boot time (Convex →
  `NEXT_PUBLIC_CONVEX_URL` + `CONVEX_DEPLOYMENT`; Clerk → publishable +
  secret; SQL → `DATABASE_URL`; Supabase → URL + anon key; Better Auth →
  secret) and checks `.env.local`, printing a copy-pastable fix per missing
  key (exit 1 when keys are missing; `--json` for scripts). The
  task-sequencer runs it BEFORE writing the foundation brief (env gate — the
  twin of the theme gate), so a missing key costs one command, not a full
  scaffold FDA rejected in review because `npm run build` crashed on
  prerender. Two more layers back it up deterministically: foundation briefs
  carry the issue's `Kind: foundation` line, which makes the FDA test phase
  run `npm run build` alongside the suite (in code, before the reviewer), and
  the foundation task's fixed scope demands a hermetic build — `npm run build`
  green with NO `.env.local`, plus a generated `.env.example`. No manifest →
  the preflight passes (it only enforces what the stack declares).
- **Project mode** — `imp/scripts/project-mode.mjs [--json]` classifies the
  project deterministically so `/idea` can branch: `greenfield` (no PRD, or a
  PRD template still carrying `{{placeholders}}` — the starter's code never
  counts), `ideation` (a real PRD but nothing built: re-running `/idea`
  means revising the idea) or `brownfield` (`map.yaml`,
  `todos/task-master.md` or `PRD-as-built.md` exist). In brownfield, `/idea`
  runs in **module mode**: deep interview about the new module and an
  APPENDED `## Module: <name>` chapter in the PRD (never rewriting the rest),
  stack delta only, then `/feature` breaks the chapter into delta specs +
  tasks (`/feature` itself triages size and routes module-sized requests up
  to `/idea`).
- **Guide** — `/guide [goal?]` (Pi): the situational router. Probes the state
  with the same scripts the flows use (`project-mode.mjs`,
  `decision-log.mjs list`, the plan artifacts, `fia-launch-check.mjs` when
  the goal is going live), asks ONE question to confirm the goal, then maps
  goal + state onto the Routing table in `.pi/skills/fia/SKILL.md` (single
  source of truth — the prompt keeps no command list of its own, so a new
  command registered in the table is routable for free) and answers with a
  numbered command sequence: each step, and each skipped rung, carries the
  criterion that decided it. Read-only by design: it opens no decision log
  and never executes the route — at most it offers to start step 1.
- **Quick flow** — `/quick <description>` triages: SIMPLE only when the blast
  radius is ≤ ~3 files with one obvious shape and NO schema/migrations,
  auth/permissions, payments, new dependency, new route/page, new UI
  component or destructive data operation — anything else routes to
  `/feature` or `/bug` with the reason. SIMPLE still enforces the guardrails
  (registry defaults, backend rules, one focal test when testable) and
  appends a `## Q-012` audit entry (files, verification, commit) to
  `ai-docs/todos/quick-log.md`. In Pi it runs `node imp/fda_quick.mjs "…"`
  (build → quality → one fix round → quick-log → commit); quick work never
  touches the task roadmap.
- **Example shelf** — `ai-docs/examples/`: `registry.md` is the index (same
  marker discipline as the component registry — real rows only between
  `<!-- registry:start/end -->`), each entry's detail in
  `<slug>/NOTES.md` with its images in `<slug>/assets/`. Row:
  `| Example | Kind | Tags | Source | What to take | License | Status |`, with
  fixed vocabularies — Kind `repo | code | docs | design`, Status `referenced |
  excerpted | archived`, License an SPDX id (`n/a` for docs/design). Tags are
  the search key (functionality, not technology): the `examples` skill and the
  task briefs match a task's nouns against that column, and NOTES.md carries a
  mandatory, never-empty `## What NOT to take`. Written by `/example` (harness
  and Pi), which reads the source before registering anything and researches
  the license instead of asking. Two rules make it safe: it is a **shelf, not a
  gate** — nothing fails because no example matched, and an empty registry is a
  normal state — and examples teach shape, so the default is to reimplement in
  this project's conventions; `AGPL-3.0`, any `GPL-*` and `unknown` are never
  copied verbatim, and any verbatim copy is called out in the task summary with
  its license. The `0000-*` entry is a format reference and never counts.
  **Planning follow-through is required after adding an example:** before
  `/task` or `/goal`, run `/grill ai-docs/PRD.md` and explicitly cite the
  relevant `ai-docs/examples/<slug>/NOTES.md`. Approve which findings should
  become requirements, then run `/map` with an explicit instruction to
  reconcile the plan with those approved findings and update the open specs
  and tasks with what entered the PRD. `/example` itself never changes product
  scope, and rejected findings stay optional prior art.
- **Test credentials** — the convention every auth flow feeds:
  ONE dev test user per profile/role, created by the auth task via the
  provider's native mechanism (Clerk dev instances: any `+clerk_test` email
  verifies with the fixed code `424242`, no real email sent; Better Auth: a
  dev-only seed script with the password in `TEST_USER_PASSWORD`), recorded
  in the `ai-docs/test-credentials.md` roster (env var names, never real
  passwords). `/test-ui` reads the roster to sign in; `launch:check` warns
  when an auth stack has no filled roster row.

Observability follows along: the viewer's **Plan tab** (§9.6) renders
milestones, specs, the inbox badge and the example library; the **TUI**'s
Work tab shows the spec traceability table with uncovered requirements in
red; and `npm run launch:check` adds the read-only **docs sync** warning when
schema-ish files changed more recently than `ai-docs/stack.md`/`ai-docs/specs/`.

## 11. The design-system layer

The problem this layer kills: components being created **on demand**, by
whichever task first needs one — the app reaches task 5 and grows its first
(hand-rolled) table, task 9 grows a second, different one. Three pieces make
the design system deterministic instead:

- **The registry** (`ai-docs/components/registry.md`) is the source of truth
  the task briefs enforce: every UI need in a brief maps to a registry row,
  creating a component the registry already covers is forbidden (variations
  are props/composition), and the living `/ui-components` page renders
  everything in it. Two components for the same need carry roles — exactly
  one `default`, the rest `alternative`, used only on explicit request.
- **The UI contract** (`ai-docs/ui/contract.json`, created by `/ui-contract`)
  deterministically separates the non-waivable quality floor from product
  capabilities **and from implementation choice**. The confirmed profile resolves application shell,
  breadcrumb, System/Light/Dark switcher, DataTable/advanced controls and
  Kanban to `required`, `optional`, `not_applicable` or a scoped `waived`;
  each capability boolean records real activation, so `optional` + `false`
  stays dormant while `optional` + `true` is built only after approval.
  Enabling `dataTables` atomically enables professional advanced controls by
  default; compact/base-only mode exists only after the explicit follow-up
  decision `advancedDataTableControls=false`. Reasserting an already-enabled
  base DataTable is idempotent and does not erase that compact opt-out.
  Independently, each surface resolves to an existing library, a specified
  library, a custom project path, or the `fia-universal` fallback. Explicit
  user/project choices always win and keep the same behavioral/quality
  contract; canonical package names and props are required only for a
  canonical selection. Planning, materialization, FDA gates, QA and launch
  consume the same reasoned decision. Schema-v1/v2 artifacts migrate only
  through the explicit migration command; ambiguous global alternatives fail
  closed, and a missing per-surface library entrypoint must be supplied through
  `--entrypoint <surface=project-relative-path>` instead of being guessed.
- **The core kit** (design-system skill, `references/core-kit.md`) is the
  universal behavioral reference — only contract-applicable rows are seeded
  and built up front. The optional `ai-docs/examples/` shelf remains prior art,
  never this authority. The design-system skill also ships a versioned,
  checksummed executable adapter for the canonical Next/React/shadcn stack;
  `.agents/scripts/ui-kit.mjs plan → install → verify` materializes it without
  reading `live1`/`live2`, writes `ai-docs/ui/kit-receipt.json`, is idempotent,
  and fails before writes on source/dependency/stack conflicts. A selected
  library/custom surface is recorded as a deterministic materialization skip,
  not replaced. The catalog includes buttons/fields/overlays needed by the data
  model plus full professional contracts for selected complex components. For
  the canonical adapter, the DataTable contract uses TanStack Table; when
  advanced controls apply, ordinary grouping through three levels stays there, and
  a REUI/licensed `alternative` is limited to an explicitly requested
  pivot/tree/sub-grid/Excel-like surface. The professional base contract includes
  global fuzzy multi-word search with yellow match highlights unless a scoped
  approved waiver records why search is inapplicable, one Filter control, a
  header menu from a visible button/left-click, right-click, Shift+F10 or the
  Context Menu key (compatible sort/hide/reset/filter), per-column
  filters adapted to the column type (text/enum-facet/date-range/number-range)
  reached from the header or a single Filter control — never a toolbar row
  of per-column buttons — compact removable active-filter chips with an x +
  clear-all, column
  visibility, pagination/count, row selection + bulk-actions bar, row-click
  edit, skeleton/empty/no-results/error/long-content states. When
  `data_table.advanced_controls`
  separately applies, canonical-adapter call sites omit `advancedControls` or pass
  `true`; the optional prop defaults to true. A base-only call site passes
  `advancedControls={false}` explicitly. Explicit false exposes no grouping, pinning,
  move/reorder, sizing/density, persistence/Restore or sticky-header UI while
  retaining base header sort/filter/hide/clear. The opt-in adds the ordered grouping lane, truthful leaf-record
  counts, pinning, sizing/density, default-on versioned view persistence scoped
  by stable table/user/tenant identity (with stale-state sanitization, session
  fallback when browser storage is unavailable, and full Restore defaults
  across reload), optional accessible header drag reorder, and sticky header.
  The remote scale contract sends sorting/filtering/grouping/expanded/pagination
  state to the backend; grouped mode requires a backend-provided hierarchy and
  truthful leaf counts, otherwise grouping is unavailable rather than page-local.
  Cross-cutting interaction contracts
  (pointer cursor, yellow `<mark>` on any typed search, Combobox popover as
  wide as the trigger, calendar caption that jumps month and year,
  `/ui-components` one-component-per-card) live in
  `references/interaction.md`.
- **Greenfield**: Task 01 is always the fixed Foundation scaffold and Task
  02 the contract-selected **Core component kit** (`Kind: kit`), blocked by 01 and
  blocking every feature task — sequenced after the `/theme` checkpoint, so
  the demos render with the approved identity. Enforcement is code, not
  prose: before a kit builder runs, the executable plan resolves the selected
  implementation per surface. Completion requires an installer receipt whose
  files/checksums still verify plus the real project typecheck/build; a registry
  row that merely says `installed` is not evidence. `Kind: kit` arms `npm run build` in the FDA test phase
  (`isFoundationBrief` in `imp/modules/gates.mjs`), the issue carries one
  checkbox per applicable component (the checklist gate refuses to close with
  an open box), and the UI gate filters named rules through the same contract.
  A game or art-directed surface may therefore skip enterprise chrome without
  losing responsive containment, keyboard/focus quality or error recovery.

**Semantic fields** ride along: known-domain data (state/UF, country,
address/CEP, phone, documents, money, dates, timezone, fixed categories)
never ships as a free-text input — the canonical catalog lives in the
design-system skill (`references/semantic-fields.md`), the sequencer adds a
Semantic fields table to briefs that touch such data, and both the C8
quality checklist and the UI gate's rubric audit it.

**Interaction contracts** ride along the same way: pointer cursor on every
clickable control, yellow `<mark>` on any typed search or filter, Combobox
popover at least as wide as the trigger, calendar caption that jumps month
and year, DataTable filters as header / one Filter control + chips (never a
toolbar row of per-column buttons), and `/ui-components` isolating one
registry component per card. The catalog is `references/interaction.md`;
the UI gate and `/qa` audit it; `/kit` gap-reports against it.

**The theme checkpoint**: on greenfield paths, after the Foundation task the
sequencer refuses to hand out any other task until a **closed `theme`
decision log** exists — either `/theme` ran (interview → side-by-side
preview → explicit approval) or the engineer consciously accepted the stack
default (`/theme accept`, recorded open+close in one breath). Any closed
theme log passes, whatever its outcome; the check uses `decision-log.mjs
list` (never `latest` — an abandoned re-run must not cancel an earlier
approval).

**Existing code** gets the same layer through `/kit` (the brownfield
counterpart of Task 02): as-built inventory (`installed` rows with real
paths — no `planned` promises invented), the `/ui-components` page, then a
**gap report** against core-kit.md — missing needs, below-contract items
(with file/line evidence), duplicates without roles — an interview where the
engineer approves what improves (recorded in the `kit` decision log;
"nothing approved" is a valid outcome), and finally design-only tasks via a
delta spec: `Kind: kit` build/upgrade tasks with one checkbox per contract
item, expand–contract migrations per screen batch, duplicate removal last.
The command itself changes no component and no screen. `/absorb` recommends
`/kit` whenever the as-built registry comes out empty or duplicated, and
`npm run launch:check` backs it with two warnings: `registry_seeded` (a
BLIND registry — reusable component files in the code, zero registry rows)
and `registry_planned` (a row still `planned` at launch — a promise nobody
built). Both templates ship the layer pre-filled: as-built registry + living
`/ui-components` page committed in their own repos (the harness merge never
overwrites an existing file, so the template's registry wins).

## 12. Pi command reference

The `.pi/` package the CLI stamps (from `pi-templates/.pi/`) makes Pi the
FIA's interactive cockpit. `imp` (or `pi`) opens it in the project.
`settings.json` sets the subagent defaults (`openai-codex/gpt-5.6-sol`,
thinking `high`); `APPEND_SYSTEM.md` appends the FIA persona to every session
(prefer FDAs for repeatable work, pi-subagents for ad-hoc recon, never touch
the protected machinery); and `.pi/skills/fia/SKILL.md` carries the hard
rules + the **Routing table — the single source of truth for the command
catalog** (`/guide` routes exclusively from it; a command absent there "does
not exist"). Deep procedures live in 18 cookbooks
(`.pi/skills/fia/cookbooks/`): fia_overview, harness_bridge, install,
run_fda, create_fda, observability, evolution, architecture, decision-log,
stack, specs, components, theme, design, examples, launch, qa and
update_roster.

### 12.1 The 28 commands (`.pi/prompts/`)

| Command | Arguments | What it does |
|---|---|---|
| `/fia` | — | Factory overview: FDA table, task counts, last run, command list. Read-only. |
| `/guide` | `[goal?]` | Situational router: probes the state with the deterministic scripts, asks ONE confirming question, answers with a numbered command route (each step carries the criterion that decided it). Suggests, never executes — at most offers to run step 1. |
| `/idea` | `[topic?]` | Interview → PRD + stack. Separates evidence from assumptions, records JTBD/non-users, a falsifiable right/wrong hypothesis, measurable signals and the thinnest end-to-end MVP. Branches on `project-mode.mjs`: greenfield, ideation, or brownfield **module mode** without rewriting the rest. Preserves semantic field types and `## Launch criteria`. |
| `/stack` | `[tech\|layer?]` | Decide pending layers + the 4-dimension research gate + `ai-docs/apis/<tech>.md` docs + equip (skills/CLI/MCP). |
| `/grill` | `[doc\|topic?]` | Stress-test the PRD one question at a time; decisions recorded and written back. |
| `/prd` | `[focus?]` | Quick reviewer opinion on the PRD — never edits it. |
| `/map` | `[notes?]` | Runs a conditional architecture checkpoint before planning; consequential decisions land in optional `architecture.md`, while simple plans skip it. Then PRD → `map.yaml` + screens-routes + issues/task-master + specs + registry seed + `/ui-components` + milestones; ends by opening the Plan page. |
| `/task` | `[number\|description?] [--llm "<spec>"]` | ONE task: the task-sequencer writes the brief (enforcing the theme and env gates); exact `Mode: prototype` → `fda_prototype`, otherwise `fda_plan_build_test` (bigger/riskier normal work → `fda_sdlc`). On first failure: one automatic recovery (re-run / repair once); if that also fails: `npm run fda:phases -- <id>`, resume with `--fda-id <id> --resume`. `--llm "grok 4.6 high"` (or plain words — "on opus xhigh", "builder on codex") is passed through to the FDA as the run-scoped override (§9.3); the roster is never edited for it. |
| `/goal` | `[limit?] [--light] [--llm "<spec>"]` | All unblocked tasks to done, one FDA per task (never batched), gates inside the loop, human-only steps handled MID-goal; `Mode: prototype` selects `fda_prototype` per brief, otherwise `--light` selects `fda_plan_build_test` and the default is `fda_sdlc`; on failure it recovers automatically while each failure names a NEW gap (the per-run recovery budget is capped in code by `verdict.mjs`), stopping only on a repeated violation, a terminal outcome or a spent budget — always with its recommended fix, which a plain "continue" from the engineer authorizes; every completed milestone automatically runs blocking `fda_qa`, drains docs with one `fda_document` and — when other milestones remain — ends the loop at the boundary with a 5-line handoff (one milestone per session: state is durable in `ai-docs/`, and a fresh session drops the orchestrator's accumulated context); ends with the app RUNNING + "How to test", then `/launch`. |
| `/feature` | `"request"` | Delta on an existing mapped system: size triage (module-sized routes UP to `/idea`), delta mini-grill, delta spec, DELTA tasks, approval before executing. Requires `map.yaml` (`/absorb` first otherwise). |
| `/bug` | `"symptom"` | Classifies `direct` vs `rca`; ambiguous/risky defects get a versioned investigation and critical/sensitive/low-confidence RCAs require approval before claim. Then `fda_bug` enforces an assertion-failing reproduction before any fix. |
| `/quick` | `"small change"` | Triage; SIMPLE runs `node imp/fda_quick.mjs` + the `Q-NNN` quick-log entry; COMPLEX routes to `/feature`/`/bug` naming the failed criterion. |
| `/note` | `"idea"` | One line into `ai-docs/inbox.md`, zero questions. |
| `/spec` | `"capability"\|NNNN` | Create/update a durable spec, `## Flow` mermaid diagram included; the Definition Gate (requirements + scenarios + diagram, no open P1) flips `Status: defined`; ticks related inbox items. |
| `/launch` | `[beta\|production?]` | Go live by rungs, `fia-launch-check.mjs --json` as the fact source; confirms before every irreversible step; secrets never in chat. Warns when `qa_evidence` is missing for done milestones. |
| `/qa` | `[M1\|NNNN\|NN] [--video]` | Browser QA: `node imp/fda_qa.mjs` — contract-filtered Playwright e2e at 360/768/1440 plus 100/125/200% zoom, table/Kanban geometry and accessibility audit, report in `ai-docs/qa/`. Runs automatically at goal milestone boundaries; may also be invoked directly. |
| `/component` | `name + URL/cmd or custom entrypoint \| list \| sync` | Design-system entry path (contract-first for closed surfaces; dedupe → research/inspect → install/create → register → isolated `/ui-components` card). |
| `/theme` | `[hint\|accept?]` | Identity interview → FDA-built side-by-side preview in the project-native component catalog → explicit approval through the UI contract's selected theme implementation. `accept` records "keep the default" (satisfies the theme gate) with zero app changes. Canonical Next files/APIs apply only to canonical `fia-universal`; AA contrast remains a blocker everywhere. |
| `/ui-contract` | `[profile\|show\|review]` | Schema-v3 UI applicability plus implementation precedence: explicit per-surface library/custom choices with concrete local entrypoints win, while canonical remains the default for untouched surfaces; confirmed booleans use atomic `capability --name <capability> --enabled true\|false`; writes only after confirmation and migrates v1/v2 explicitly. |
| `/design` | `images + scope` | Layout redesign from references — structure from the image, identity from OUR system. |
| `/example` | `URL [notes] \| list` | Register an external reference on the shelf (license researched, `What NOT to take` mandatory). After adding one, cite its NOTES in `/grill ai-docs/PRD.md`, then run `/map` to reconcile approved PRD additions into open specs/tasks before implementation. |
| `/agents` | — | Opens the viewer's Agents tab (`npm run agents -- --detach`) to edit engines/models/fallbacks; Pi is forbidden from editing `imp/fia.config.yaml` itself. |
| `/llm` | `["1 → fable"?]` | Numbered list of the FDA agents with the LLM each one runs on (phases included); the student answers by number or name and the switch is applied via `imp/scripts/fia-llm.mjs set` — the same comment-preserving, backed-up, run-locked write path as the Agents tab. Engines: `claude_code`, `pi` (Codex/any provider), `cursor`, `grok` (Grok Build — `grok-4.6`/`grok-4.5`). A model asked for "just this task" is NOT a roster change: that is `--llm` on the run (§9.3). Terminal twin: `imp llm` / `npm run llm`. |
| `/defer` | `[n \| resume n]` | Postpone a task that cannot proceed right now (missing API keys, a paid account for later, a pending decision) — via `imp/scripts/task-defer.mjs`, never by hand: status → `deferred` in issue + index, its sealed holdout probes renamed `NN-*` → `_NN-*` (content untouched, reversible), deferral ledgered in `imp/data/deferrals.json` + noted in the inbox. `resume n` restores everything and sets `pending`. Refuses while an FDA run is live; the launch check warns about every open deferral. Terminal twin: `imp defer` / `npm run defer`. |
| `/onboarding` | `[focus?] [--report-only]` | First command on an EXISTING system: chains `/absorb` → `/stack` → `/kit` in one guided pass (each stage's own prompt is the law; stages whose artifacts already exist can be kept and skipped), then hands over explaining the split — `/idea` for a MODULE-sized addition vs `/feature` for a one-sentence delta. The tour keeps a **resume rail** in the decision log (`open onboarding` → one stage note each → `close`): an interrupted session resumes from its last stage note instead of restarting. `--report-only` is the express path — the `/kit` stage presents its gap report and defers the design decisions to a later `/kit` run. |
| `/absorb` | `[focus?]` | Brownfield onboarding (as-built PRD/map/conventions/registry, maintained wiki + digest stamp, and one canonical project skill in `.agents/skills/project/` with a Claude symlink; never `.pi` or `.cursor` copies). Divergent legacy copies in any engine stop for an explicit choice. |
| `/kit` | `[focus?] [--report-only]` | Brownfield design-system audit → gap report vs core-kit + `interaction.md` → approved design-only tasks. |
| `/status` | — | Read-only progress: tasks, milestones (status as declared), specs, inbox, latest runs and failed phases. |
| `/evolve` | `--run <id> \| --since <Nd\|date> [--steer "…"]` | Evidence-backed review of one finished FDA run or a bounded history window. Writes only local Markdown/HTML under `imp/reports/evolution/`; never changes rules, prompts, skills, gates or code. |

### 12.2 The interactive subagents, chains and extensions

**14 pi-subagents** (`.pi/agents/*.md`, all with
`fallbackModels: openai-codex/gpt-5.5` and `inheritProjectContext`): the
interactive twins of the FDA roster (`scout`, `planner`, `builder`,
`reviewer`, `documenter`) plus the planning specialists shared with the
harness (`task-sequencer`, `task-master-generator`, `start-mapper`,
`start-scaffolding`, `screen-routes-generator`, `component-architect`,
`ui-component-page`, `ui-component-researcher`, `api-docs-researcher`). The
two researchers carry real web tools (`web_search`, `fetch_content`,
`get_search_content`) provided by the **pi-web-access** package — without it
the packaged researcher hard-fails; the installer (and `imp update`) installs
and exact-pins the three Pi packages (`pi-subagents`, `pi-mcp-adapter`,
`pi-web-access`); the exact pin is also what suppresses Pi's "Package Updates
Available" panel.

**Chains** (`.pi/chains/`): `scout-planner.chain.md` — scout surveys the
codebase for `{task}`, its `context.md` output feeds the planner.

**Extensions** (`.pi/extensions/`):

- `fda-lock.ts` — interactive Pi goes read-only while an FDA runs (§9.5).
- `fia-guard.ts` — FIA-protected paths (`imp/modules/**`,
  `imp/fia.config.yaml`, `imp/fda_*.mjs`, incl. `rm -rf imp`) are never
  agent-writable in interactive sessions — the extension-side twin of the
  FDA permission gate. Block message: "…is FIA infrastructure (protected).
  Ask the engineer to change it manually or via impactus."
- `fia-branding.ts` — the `FIA · IAI Cursos` status-line slot.

## 13. The web UI (`--ui`)

`npx impactus --ui` (alias `--web`) starts a **local server** (default port
4599, walking forward up to 20 ports on conflict; bound to `127.0.0.1` only,
with a Host/Origin DNS-rebinding guard) that serves one self-contained page
where the installation is **assembled by clicking**. Execution does NOT
happen in the browser: at the end the page highlights the ready
`npx impactus …` command; the student copies it and runs it in the terminal
(an "Open the terminal for me" button opens the OS terminal app). The
terminal wizard remains the default entry point — `--ui` is opt-in;
`--terminal`/`--no-ui` are accepted for compatibility.

What the page offers, top to bottom:

1. **Project folder** — prefilled with the server's cwd, with a native OS
   folder dialog (AppleScript / PowerShell / zenity–kdialog; in-page modal
   fallback) and a live "folder already has files" warning. There is no name
   field: the project name is the folder's basename.
2. **What to install** — "Harness + template" vs "Harness only". The
   harness-only card has a "Your stack" section: "Decide by talking with Pi"
   (→ `--stack depois`) or layer-by-layer selects driven by the stack catalog
   (→ `--stack cat=opt,…`, with explicit `cat=depois` entries so the terminal
   wizard doesn't re-ask a deliberately-pending layer).
3. **Template, preset and addon groups** — cards from the catalogs; picking a
   preset materializes every group flag, editing a group clears the preset.
4. **Services** — storage pills, GitHub push + visibility, Vercel deploy
   toggles (tri-state: unchecked emits `--no-push`/`--no-deploy` — an
   unchecked box is a decision, so the preflight never prepares gh/vercel
   logins for nothing).
5. **Service keys (optional)** — per relevant service, the AI-assisted path:
   "Copy instructions for the AI" (the same prompt catalog as the terminal —
   paste it into a browser-automation agent, e.g. Claude in Chrome), a paste
   box that parses the returned `KEY=value` block and fills the regex-validated
   fields, and a collapsed manual path with the dashboard link. Keys autosave
   to `~/.impactus-cli/keys/<slug>.env` (mode 600, machine-local; a project
   rename deletes the old slug's file; the command references the path via
   `--keys` — no secret ever appears in the command or leaves the machine).
   Fully-automatic services (Clerk, Convex) are listed as "nothing to do".
6. **Sign-in** — the access bar checks `~/.impactus-cli/auth.json` against the
   community API and, when needed, runs the whole device flow **server-side**
   (the browser only sees the code/link; the token never travels to the page).
   An inactive subscription is reported as such — a fresh sign-in won't fix
   it.
7. **Run the installation** — the live command (assembled by
   `src/lib/command.js`; full mode always carries `--mode full
   --template-id <id>`, so a guest running the copied command gets the clear
   sign-in error), copy button, open-terminal button, and the 3-step run
   instructions.

Example generated commands:

```bash
# Full mode, page defaults:
npx impactus --dir /Users/ana/my-app --mode full --template-id live1 --preset padrao \
  --addons commitlint,knip,analyzer --observability sentry --analytics none \
  --security csp,rate-limit --emails none --platform none --payments none \
  --storage convex --no-push --no-deploy

# Harness only, "decide with Pi":
npx impactus --dir /Users/ana/my-app --stack depois

# Harness only, layer by layer (Convex hides database/ORM):
npx impactus --dir /Users/ana/my-app --stack frontend=nextjs,backend=convex,auth=clerk,blob=r2,automations=none,deploy=vercel

# With pasted keys:
npx impactus --dir /Users/ana/my-app --mode full --template-id live1 … --keys /Users/ana/.impactus-cli/keys/my-app.env
```

Endpoints, for the curious: `GET /` (the page), `GET /api/catalog`,
`GET /api/browse` + `GET /api/dir-info` + `POST /api/pick-folder`,
`POST /api/keys`, `POST /api/command`, `GET /api/auth`, `POST /api/login`
(NDJSON stream), `POST /api/open-terminal`. Bodies are capped at 1 MB;
everything degrades gracefully.

## 14. Maintenance: `imp doctor`, `imp fix`, `--verify`, `--update-runtime`, `imp update`

The maintenance ladder — cheapest first, each rung reporting what the next
one repairs:

| The question | The command |
|---|---|
| "what is broken?" | `imp doctor` — read-only checkup of the machine AND the install (§14.4) |
| "put back what disappeared" | `imp fix` — restore-only, plan + one y/N (§14.5) |
| "my `imp/` + `.pi/` came from an older CLI" | `npx impactus --update-runtime --dir .` (§14.2) |
| "audit this install in CI" | `npx impactus --verify --dir . --json` (§14.1) |
| "update the CLI itself, Pi and the extensions" | `imp update` (§14.3) |
| "is my agent loop actually working?" | `imp health` — the evidence-based loop-health report (§9.6) |
| "undo what that FDA run did" | `imp rewind` — checkpoints, preview, restore-only (§9.6) |
| "stop the running FDA / don't let another one start" | `imp stop` — fails closed, `--clear` disarms (§9.7) |
| "do the quality gates actually work?" | `npm run gates:probe` / `imp doctor --gates` — injected defects must go red (§9.9) |
| "where does this setting come from?" | `imp settings` — read-only view of the machine config (§14.6) |

The split is deliberate: **doctor never writes, fix never overwrites**. A
checkup is therefore always safe to run, and the one command that can change
your files only ever *adds back* what is missing — everything that exists but
differs is reported, never touched.

### 14.1 Post-install audit (`--verify`)

`npx impactus --verify --dir <folder>` audits an already-installed project
without touching anything (`src/steps/verify.js`). Exit 0 = no errors;
exit 1 = errors found — usable in the student's CI. `--json` replaces the
human report with `{ ok, errors, warnings }` on stdout (same exit code).
Also reachable as `imp init --verify --dir .`.

The audit first detects the install type: **harness-only** projects (no
addons config, no `convex/`, but a harness footprint) skip the template
checks with explicit "skip" lines instead of false errors. The checks:

| Finding | Level |
|---|---|
| `package.json` missing/invalid (full install — short-circuits the audit) | error |
| `package.json` missing/invalid (harness-only) / without `name` | warn |
| addons config missing (project from an older CLI) | warn |
| `template.addons.json` still present (pruning did not run) | error |
| orphan `live1:addon` markers anywhere in the tree | error |
| `.env.local` missing | error |
| core env keys empty/missing (`NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`) | error |
| chosen-addon service keys missing (everything degrades gracefully) | warn |
| `node_modules` / `convex/_generated` missing | warn |
| `skills-lock.json` invalid | warn |
| a locked skill missing from `.agents/skills/` (Cursor/Pi blind to it) | warn |
| a locked skill DUPLICATED in `.pi/skills/` (Pi "Skill conflicts" panel — fix with `imp init --update-runtime` or delete the copy) | warn |

```bash
npx impactus --verify --dir my-saas          # human report
npx impactus --verify --dir . --json | jq .ok   # CI gate
```

### 14.2 Runtime updates (`--update-runtime`)

`npx impactus --update-runtime --dir <folder>` re-stamps the FIA/Pi RUNTIME of
an already-installed project from the impactus version currently running
(`src/steps/update-runtime.js`) — new FDAs, gates and prompts without a
re-install. The contract:

- **Manifest** — `setupFia` records `imp/.runtime-manifest.json`
  (`{ impactus, stamped_at, files: { <relpath>: <sha1> } }`) covering every
  file stamped from both template trees. The shas are the TEMPLATE's: the
  stamp skips pre-existing files, so a file that differs from the template was
  never written by us and stays "modified" (consent + backup before any
  overwrite).
- **Updatable paths only** (`FIA.runtimeUpdatablePaths`): `imp/modules/`,
  `imp/fda_*.mjs`, `imp/scripts/`, `imp/package.json`, `.pi/skills/fia/`,
  `.pi/prompts/`, `.pi/extensions/`. Never touched: `imp/fia.config.yaml`,
  `imp/data/`, `imp/node_modules/`, anything outside the template trees.
  Files the template no longer ships are LEFT in place — additive + replace,
  never delete.
- **The harness half is NOT in scope** and there is no `--update-harness`: the
  slash commands (`.claude/commands/`, `.cursor/commands/`), the specialist
  agents, the skills and the `ai-docs/` scaffold come from the harness repo, so
  a feature that lands on both sides (a new `ai-docs/` seed plus the prompt that
  reads it — `ai-docs/wiki/` is the current example) only half-arrives through
  `--update-runtime`. To refresh that half, re-run the installer in the project:
  `npx impactus --dir . --harness-only` merges every harness file the project is
  MISSING (new `ai-docs/` seeds land; nothing existing is overwritten), and
  `npx impactus --dir . --harness-only --agent-files replace` also brings the
  UPDATED command/agent/skill files, moving the current ones to
  `.agents-backup-<date>/` first (§4.6 — that policy covers `.pi/` too, which
  the FIA step then re-stamps). Prompts are written so a seed that never arrived
  degrades instead of dangling.
- **Per file**: missing → add; byte-identical → skip; differs with the disk
  sha matching the manifest (unmodified since the stamp) → overwrite; differs
  otherwise (edited locally, or no manifest) → interactive runs ask per file —
  Yes / **Yes to all** / No / **No to all**, the *-to-all answers stick for
  the rest of the run — after one loud warning; non-interactive runs (`--yes`
  or `--json`) skip and report unless `--force` (= yes to everything). Every
  overwrite is backed up to `imp/.runtime-backup-<YYYYMMDD-HHmmss>/<relpath>`
  first (gitignored).
- **It also**: runs `migrateLegacyFiaLayout` first (see below); runs
  `npm install` in `imp/` when `imp/package.json` changed (the ONLY failure
  that makes it exit 1 after a successful plan); re-pins the three Pi
  packages (student-customized entries skipped and reported); prunes stale
  `.pi/skills/` copies; ensures the FIA gitignore entries; merges new
  `FIA.npmScripts` (never clobbering yours — conflicts land as
  `<name>:fia`); rewrites the manifest — overwritten files move to the new
  baseline while skipped-modified ones KEEP the stamp sha, so the next run
  still flags them.
- `--json` report: `{ ok, dir, impactus, added[], updated[],
  skippedModified[], unchanged (a count), backupDir, npmScriptsAdded[],
  warnings[] }`.

```bash
npx impactus --update-runtime --dir .            # interactive per-file consent
npx impactus --update-runtime --dir . --force    # overwrite everything (backed up)
npx impactus --update-runtime --json --force     # CI: JSON report, no prompts
imp init --update-runtime                        # same, via the launcher
```

**Legacy layout migration** (`migrateLegacyFiaLayout` — runs at the start of
BOTH the update and the install stamp; idempotent, crash-resumable via a
`.fia-migration-pending` marker): projects from older versions kept the
runtime at `fia/` and `HARNESS.md`/`iai.config.json` at the root. The
migration renames/merges `fia/` → `imp/`, moves the root files into `imp/`,
rewrites `fia/…` runtime paths across `imp/`, `.pi/`, `.claude/`, `.cursor/`,
package.json scripts and `.gitignore` (surgical — `.pi/skills/fia/` and
unrelated `fia`-named folders are untouched), patches the fia-guard
extension's literals, and updates the manifest keys so OUR path fix never
shows up as a student edit.

### 14.3 `imp update` and the launcher

The `imp` launcher (installed globally by the FIA stamp, or `npm i -g
impactus`) is a thin brand wrapper over the real `pi` binary — NOT a fork:

| Invocation | Behavior |
|---|---|
| `imp` | Starts Pi in the current folder (installs Pi on demand). Banner only on a TTY; **piped output is byte-identical to `pi`'s**. |
| `imp init [flags]` | The full impactus installer in place — every flag works (`imp init --harness-only -y`, `imp init --verify`, …). |
| `imp update` | `npm install -g impactus@latest` + `pi update` (or install) + re-pin of the three Pi extension packages. Exit code keyed to the impactus self-update; the extension refresh is best-effort. |
| `imp tui [args]` | Runs the project-stamped `imp/scripts/fia-tui.mjs` (errors with a `imp init` hint when the runtime is absent); `imp tui --once` passes through. |
| `imp doctor [--json] [--gates]` | Read-only checkup of the machine and, inside a project, of the install — detection only, fixes nothing. `--gates` adds the gate self-test (§9.9): it spawns the PROJECT's stamped `imp/scripts/gate-probes.mjs`, so version drift in the runtime is exactly what the section detects, and the probes only write to OS temp. Full reference: §14.4. |
| `imp fix [flags]` | The remediating sibling of doctor — restore-only, plan → one y/N → apply. Full reference: §14.5. |
| `imp handoff [args]` | Runs the project-stamped `imp/scripts/handoff.mjs`: hands the newest interactive Pi conversation to the `claude` CLI with a continuation prompt pointing at the session transcript (same preamble the FDA relay uses). Works while Codex is down — that is the point. `--list` picks a session, `--session <id>` targets one, `--full` asks for a full transcript read, `--print` prints the prompt without launching. Also `npm run handoff`. |
| `imp health [args]` | Runs the project-stamped `imp/scripts/loop-health.mjs` — the five-dimension loop-health report (`--json`, `--html [path]`, `--strict`; §9.6). |
| `imp rewind [args]` | Runs the project-stamped `imp/scripts/rewind.mjs` — checkpoints of an FDA run, preview, restore-only apply (`--list`, `--run <id>`, `--to <sha>`, `--dry-run`, `--yes`, `--allow-dirty`, `--json`; §9.6). |
| `imp notify [args]` | Runs the project-stamped `imp/scripts/notify.mjs` — the resolved notification config, or `--test` to send one (`--event <name>`, `--json`; §9.8). |
| `imp stop [args]` | Runs the project-stamped `imp/scripts/fia-stop.mjs` — the stop button (§9.7). Bare arms it, `--status` reports, `--clear` disarms, `--reason "…"` attaches a note, `--json` for machine output. Fails closed. Also `npm run fda:stop`. |
| `imp settings [--json] [--path]` | Read-only report of where every machine-level setting comes from (§14.6). The verb is `settings`, **never `config`**: unknown verbs fall through to Pi and `pi config` is a real Pi command that must keep working. |
| `imp help` / `imp --version` | Help / bare version. |
| anything else | Straight through to `pi` (e.g. `imp -p "prompt"`, `imp --continue`). |

`health`, `rewind` and `notify` follow the same contract as `imp tui`/`imp
handoff`: the script comes from the project's own `imp/scripts/` (so it
version-matches the runtime readers it imports) and every argument is passed
through untouched. Outside a stamped project they exit 1 pointing at `imp init`
— or `npx impactus --update-runtime` on an install that predates the script.

Version-notice choreography: imp launches Pi with `PI_SKIP_VERSION_CHECK=1`
(suppressing Pi's pi-branded update banner), probes npm in the background
during the session (TTY only), and prints ONE imp-branded "Updates available
… Run `imp update`" block AFTER Pi exits (racing a 400 ms timeout so a quick
one-shot session is never held hostage). Opt-outs: `IMP_SKIP_VERSION_CHECK`,
`PI_OFFLINE`. The three Pi packages are exact-pinned precisely so Pi's own
"Package Updates Available — run pi update --extensions" panel never shows;
`imp update` re-pins them.

### 14.4 The checkup (`imp doctor`)

`imp doctor` (`src/steps/doctor.js`) answers one question — *what is wrong
here?* — and nothing else. **Detection only by contract:** it never installs,
never opens a login, never rewrites a file. Every finding ends in the exact
command that repairs it, and the repairs live in their own commands, each
with its own consent flow (`imp fix`, `imp update`, `imp init`, `npx impactus
--update-runtime`).

Four sections (five with `--gates`):

| Section | What it checks |
|---|---|
| **Engines (subscriptions)** | `claude` on PATH, the Codex login inside Pi (`~/.pi/agent/auth.json`), the Cursor CLI, and Grok Build (`grok` on PATH or `~/.grok/bin/grok`, plus the subscription login in `~/.grok/auth.json`). **Informative, never an error** — which subscriptions to use is the professional's call. There is deliberately no `claude` login probe: no heuristic is reliable and `claude` walks the user through login on first run (same rationale as the preflight, §3.2). |
| **Core CLIs** | node (the >= 22.12 floor), git and npm as required; gh and vercel as optional. |
| **Pi & imp** | Pi installed + version, the three exact-pinned extension packages, and the same update probe the launcher prints after a session — timeboxed at 4 s, so offline or a slow registry just drops those rows instead of holding the report. |
| **Project** (only when the folder looks like an IAI project) | FIA runtime present (`imp/scripts` + `imp/fia.config.yaml`); `.mcp.json` hygiene; the harness stamp state; a summarized `--verify` audit (capped at 8 rows — the full report stays in `npx impactus --verify`). |
| **Gates (self-test)** — only with `--gates` | Spawns the project's stamped `imp/scripts/gate-probes.mjs` (§9.9): deliberate defects that must make each gate go red, plus clean controls that must pass. A missed probe is an **error** — a class of defect can currently slip through this project's gates unseen, and the repair is `npx impactus --update-runtime`. Probes write only to OS temp, so the detection-only contract holds. A self-test that cannot run is reported as an error too, never as a silent skip. |

Two project checks are worth spelling out:

- **`.mcp.json` hygiene.** Every npx-launched MCP server needs `-y`. With a
  cold npx cache the "Ok to proceed?" prompt lands on the MCP stdio channel
  and the server dies before the handshake — the classic "Connection closed"
  on a first run (Windows especially). doctor warns per offending server;
  `imp fix` adds the flag. A `.mcp.json` that no longer parses is an error:
  no MCP server loads at all until it does.
- **The harness stamp.** Compared against `imp/.harness-manifest.json` (§8),
  each stamped path classifies as *pristine* / *modified* (your edits or a
  template-owned variant — left alone) / *missing* (restorable). A project
  from an older CLI has no manifest; doctor says so and the next harness
  stamp records one.

```bash
imp doctor                       # human report, anywhere
imp doctor --json | jq .ok       # machine output: { ok, sections }, no banner
```

Exit code: 0 when no **error**-level finding exists (warnings and info do not
fail it), 1 otherwise.

### 14.5 Restore-only repair (`imp fix`)

`imp fix` (`src/steps/fix.js`) is doctor's remediating sibling. It follows
the contract every professional CLI converged on (cargo fix, ng update, expo
install, copier):

- **Never writes blind.** A bare run computes the plan, prints it, and asks
  ONE y/N. `--yes` skips the ask; with no TTY and no `--yes` it prints the
  plan and exits 1 instead of hanging (CI-safe).
- **`--dry-run` and `--json` stop after the plan, always** — machine-readable
  output never mutates the project.
- **Git is the undo.** Fixes that touch the project tree require a clean git
  tree; `--allow-dirty` is the named escape hatch and `--commit` makes one
  commit per applied fix. Machine-level fixes (the Pi packages) skip the gate.
- **Restore-only tier.** Every fix recreates something missing or adds a
  flag. It NEVER overwrites a file that exists with different content — those
  become *notes* in the report. Updating outdated-but-present runtime files
  stays with `npx impactus --update-runtime` (which has its own per-file
  consent); adopting the harness version of a file you changed stays with
  `--agent-files replace`.
- **Idempotent, and it proves it.** After applying, fix re-plans: exit 0 only
  when nothing is left.

What it knows how to repair:

| Fix | Tier | What it does |
|---|---|---|
| `pi-packages` | machine | Reinstalls missing Pi extension packages — the exact-pinned install `imp update` does. |
| `mcp-npx-yes` | project | Adds `-y` to npx MCP servers in `.mcp.json`. |
| `skills-missing` | project | Restores agent skills that `skills-lock.json` records but `.agents/skills/` lost. |
| `pi-skill-dupes` | project | Deletes skill copies duplicated into `.pi/skills/` (the "Skill conflicts" panel at every Pi launch — §6.2). |
| `runtime-missing` | project | Restores FIA runtime files the stamp manifest recorded and the disk no longer has — **plus any runtime module they import**. The manifest belongs to the version that stamped the project, so trusting it alone can restore a file whose imports were added in a later runtime: the siblings would never be restored and the file could not be loaded at all (`ERR_MODULE_NOT_FOUND` on every FDA) while this command reported success. `imp/modules/`, `imp/scripts/` and `imp/fda_*.mjs` are therefore completed from the bundled templates; prose (`.pi/prompts/`, `.pi/skills/`) is not — it has no import graph and belongs to `--update-runtime`. |
| `harness-missing` | project | Re-downloads the harness from the community API and copies back ONLY the paths `imp/.harness-manifest.json` lists as missing. Dangling symlinks are re-pointed at the stamped target (or materialized as a copy where the OS denies links — §8); a path the current harness no longer ships is reported, not invented. |
| `agents-md-block` | project | Re-appends the harness block to `AGENTS.md` (or recreates the file) via the same idempotent marker merge the installer uses — your own content is kept. |

```bash
imp fix --dry-run                # the plan, nothing else
imp fix                          # plan → y/N → apply
imp fix --yes --commit           # unattended, one git commit per fix
imp fix --json | jq .pending     # { ok, pending, notes } — never mutates
```

Exit code: 0 = nothing pending (and, in apply mode, nothing failed); 1 =
fixes pending, a fix failed, or findings remain.

### 14.6 Machine configuration (`imp settings`)

Until now the state folder held only the login (`auth.json`), the keys pasted
in the web UI (`keys/`) and the run logs (`logs/`) — every other knob was an env
var, which nobody can discover and nobody can persist.
**`~/.impactus-cli/config.json`** is the home for machine-wide preferences
(today: notifications). You create it by hand — no command writes it for you,
and the CLI's own writer (`src/lib/config-file.js`) keeps the permissions the
rest of the folder uses: directory `700`, file `600`.

```json
{
  "version": 1,
  "notify": {
    "enabled": true,
    "events": ["run_end"],
    "targets": [{ "kind": "slack", "url": "https://hooks.slack.com/services/…" }]
  }
}
```

The file is **hand-editable and optional**, so it is read tolerantly: a missing
file is not an error (the code defaults win); a key this CLI does not recognize
is a **warning**, never fatal, and is kept in the file verbatim (a newer CLI may
have written it — downgrading must not brick the machine); a `version` higher
than the one this CLI understands warns and points at `imp update`. Only a file
that exists and cannot be parsed — or an invalid *recognized* value — is
reported as a problem. Every message names a bad target by its index, never by
its URL, and a JSON parse error keeps only the position hint (the parser's own
message quotes the offending line, tokens included).

`imp settings` is **read-only by contract**: it never writes, never creates the
file and never migrates anything. It answers three questions and stops — where
the machine config is and whether it exists; which sources are in play (the
machine file, the project's `imp/fia.config.yaml`, the env vars that override
behaviour: `IMPACTUS_API`, `IMPACTUS_TOKEN`, `PI_OFFLINE`,
`IMP_SKIP_VERSION_CHECK`); and, per effective value, what it is and WHERE it
came from — `[default] < [machine] < [project] < [env]`. Anything that needs
changing you change in an editor, and when the file does not exist yet the
report ends with the exact JSON to paste.

Every printed value goes through the redaction in `src/lib/config-file.js`, and
it redacts by VALUE as well as by key name: a key ending in
`url`/`token`/`key`/`secret`/`chat_id` is never echoed, **any** string that looks
like a URL collapses to `<host> (path hidden)` whatever its key is called, and
every field of a `notify.targets[N]` entry except `kind` is sensitive by default.
So a webhook pasted under a mistyped key still cannot leak. That is deliberate:
this output is exactly what students paste into a support channel.

`imp settings` also enforces the same three rules the notifier does, so it can
never bless a config the runtime silently drops: a target URL must be `https:`
(`http:` only for `localhost`/`127.0.0.1`/`[::1]`), an event name must be one of
`run_end`/`gate_blocked`/`decision_needed`, and a `timeout_ms` outside
`[500, 20000]` is reported as **clamped** rather than as effective. The
duplication is deliberate (`src/` never imports the stamped runtime) and a test
asserts the two tables agree key by key.

```bash
imp settings                 # human report (banner, sources, effective values)
imp settings --json          # the same report as JSON
imp settings --path          # just the path — scriptable, like `git rev-parse`
```

Exit code: 0 when nothing is invalid, 1 when the machine config has problems
(the defaults are used until it is fixed).

## 15. Recipes — worked examples

### 15.1 From zero, WITHOUT the template (own stack; works as guest)

```bash
npx impactus                 # pick "Build my own stack" (or "Not sure yet")
cd my-app
imp                          # open Pi
/login openai-codex          # one time only (never Anthropic inside Pi)
/idea                        # interview → PRD + the best stack (ai-docs/)
/stack                       # research + docs per tech + CLIs/MCPs/skills

# If you add an external example, this follow-through is required:
/example <url> <what-liked>  # when using prior art: research + register it
/grill ai-docs/PRD.md using ai-docs/examples/<slug>/NOTES.md
                             # approve what the example adds to the PRD
/map "Reconcile the plan with the approved example findings and update open specs and tasks"

# Without an external example, use these two lines instead:
/grill                       # stress-test the PRD before building
/map                         # PRD → screens, tasks, milestones (opens the plan)

/task                        # Task 01 (Foundation) via FDA
/theme                       # the greenfield checkpoint (or `/theme accept`)
/goal                        # every remaining task, one FDA each
npm run tui                  # follow along in another terminal
```

Fully scripted variant (no prompts, guest-friendly):

```bash
npx impactus my-app --yes --stack backend=hono,db=neon,orm=drizzle,auth=clerk,blob=r2,frontend=nextjs,deploy=vercel,automations=none
```

### 15.2 From zero, WITH the ready-made template (signed-in students)

```bash
npx impactus                 # sign in; pick "Recommended stack (ready-made template)"
# the CLI provisions everything: Convex + Clerk + JWT + keys (+ webhook/GitHub/deploy if chosen)
cd my-app
npm run dev:convex           # terminal 1 — backend (watch + codegen)
npm run dev                  # terminal 2 — Next.js → http://localhost:3000

# the app already runs — now shape it into YOUR product:
imp
/grill                       # sharpen the PRD (template features are the baseline)
/map                         # plan screens + tasks on top of the template
/goal                        # FDAs build it — or /dev in Claude Code, task by task
```

Non-interactive full install (CI or a second machine):

```bash
IMPACTUS_TOKEN=<token> npx impactus my-saas --yes --preset saas --payments asaas --storage r2 --keys ~/.impactus-cli/keys/my-saas.env
```

### 15.3 An EXISTING web app (brownfield)

```bash
cd my-app
npx impactus --dir .         # detects the project → harness + FIA only; nothing overwritten
imp
/onboarding                  # guided pass: /absorb (as-built PRD + map + conventions +
                             #   stack manifest + registry) → /stack (docs + tooling)
                             #   → /kit (design-system audit → approved tasks)
/feature "CSV export on the reports page"   # delta spec + tasks, approved before running
/bug "login loops after logout"             # proven RED, then the fix
/quick "rename the Save button"             # small change, one audit line
/task                        # execute — or /goal for everything approved
```

### 15.4 A failed FDA run — diagnose and resume

```bash
npm run fda:sessions                     # find the run id + HOW it ended (outcome)
npm run fda:phases -- 3fa9c21b           # which phase failed
npm run fda:cost-report -- 3fa9c21b      # per phase: fresh input/cache/output
npm run fda:tail   -- 3fa9c21b           # last events (raw JSONL)
npm run fda:viewer                       # or drill down in the browser

node imp/fda_plan_build_test.mjs --fda-id 3fa9c21b --resume
# succeeded agent phases replay from saved results; tests re-run against the
# CURRENT tree — you can fix code by hand first and the resume re-tests it.
```

Read the outcome before re-running (§9.7): `no_progress` means a repair round
changed nothing and the same checks kept failing, so a blind resume will stall
again — fix what it named first. `attempt_cap` means the repair rounds ran out (raise
`stop.attempt_cap`, or take the last failure by hand). To walk the run back
instead:

```bash
imp rewind                               # the runs and the commits each one made
imp rewind --run 3fa9c21b --dry-run      # exactly which files an undo touches
imp rewind --run 3fa9c21b --yes          # restore them (no reset, nothing committed)
```

### 15.5 Change which LLM each agent uses

```bash
npm run agents               # opens the viewer's Agents tab (or /agents inside pi)
# pick engine (claude_code | pi | cursor | grok), model, reasoning and a fallback
# chain per agent; Save preserves the YAML comments and backs the file up.
# Locked while an FDA runs; applies from the next run.
imp llm                      # numbered list; `imp llm set builder grok-4.6 --effort high`
# ONE run only, roster untouched (saved with the run, so --resume keeps it):
node imp/fda_sdlc.mjs ai-docs/actual-todo/<brief>.md --llm "grok-4.6 high"
node imp/fda_sdlc.mjs ai-docs/actual-todo/<brief>.md --llm "builder=opus xhigh" --llm "reviewer=grok-4.5"
```

Or edit `imp/fia.config.yaml` by hand — remember the billing rule: Claude
agents use `coding_agent: claude_code` (the plan); Claude INSIDE Pi bills per
token as extra usage. Grok Build (`coding_agent: grok`) is recognized
automatically once `grok login` has been done — never set `XAI_API_KEY` for
it (that is the per-token API route; the FIA strips the variable from grok
runs).

### 15.6 Activate a service key later

```bash
# example: Stripe, after the install
npx convex env set STRIPE_SECRET_KEY sk_test_...
npx convex env set STRIPE_PRICE_ID price_...
# the webhook: dashboard.stripe.com (Test mode) → Developers → Webhooks →
# Add endpoint → https://<deployment>.convex.site/stripe-webhook, then:
npx convex env set STRIPE_WEBHOOK_SECRET whsec_...
```

Every addon degrades gracefully until its keys exist — the final install
summary and `--verify` both list what is still pending, and the web UI's AI
prompts (§6.1) fetch keys for you.

### 15.7 Keep an installed project current

```bash
imp doctor                        # read-only checkup: subscriptions, CLIs, Pi, project
imp fix                           # restore missing harness/runtime/skills files (plan + consent)
imp update                        # impactus + Pi + the pinned extension packages
npx impactus --update-runtime --dir .   # new FDAs/gates/prompts into imp/ + .pi/
npx impactus --verify --dir .           # audit that everything is still intact
imp health --html                       # how well the agent loop is working (+ HTML report)
npm run wiki:check                      # which wiki pages the code has outgrown
npm run security:scan                   # the L1 pattern scan over the whole source tree
```

### 15.8 Go live

```bash
npm run launch:check              # read-only readiness (blockers/warnings, rung)
imp                               # then, inside pi:
/launch                           # Ready gate → Safe gate → BETA → PRODUCTION
```

## 16. Flag reference

```
npx impactus [name] [options]

Project
  --name <name>            Name (same as the 1st positional argument)
  --dir <path>             Target folder ("." = current folder)
  --mode <value>           harness (harness only) | full (harness + template)
  --harness-only           Shortcut for --mode harness (does not install the template)
  --stack <value>          recomendada | propria | depois | category=option pairs
                           (e.g. backend=hono,db=neon,orm=drizzle; categories:
                           frontend, backend, database, orm, auth, blob,
                           automations, deploy — anything missing stays "decide
                           later"; aliases: db/banco, storage/arquivos,
                           autenticacao, jobs/automacoes)
  --agent-files <mode>     Folder already has agent files (.claude, CLAUDE.md…):
                           add (default, only what's missing) | replace (backup + replace)
  --template-id <id>       Catalog template: live1 (default) | live2
  --template-ref <branch>  Template branch/tag for the gated download

Stack (whatever is not chosen is REMOVED from the generated code)
  --preset <name>          minimo | padrao | saas (completo = deprecated alias of saas)
  --addons <list>          commitlint,knip,analyzer | none | all
  --observability <list>   sentry,logging | none
  --analytics <value>      none | posthog | vercel-analytics
  --security <list>        csp,rate-limit | none
  --emails <value>         none | resend
  --platform <list>        notifications | none | all
  --payments <value>       none | stripe | asaas | clerk-billing

Customization
  --update-deps <mode>     none | safe (patch/minor — there is no "latest" mode:
                           the template is tested with the pinned versions)
  --shadcn-preset <val>    Preset from ui.shadcn.com/create
  --shadcn-block <blocks>  shadcn blocks (comma-separated) or "none"
  --skip-shadcn            Skips the shadcn step

Services
  --keys <file>            .env file with service keys (generated by the --ui
                           web UI in ~/.impactus-cli/keys/; machine-local, mode 600)
  --tenancy <value>        single (Live 1, default) | multi (Live 2: your app's
                           own organizations in Convex — per-organization
                           data/billing, roles/permissions, /admin with org
                           management)
  --clerk-app <app_id>     Reuse/link this exact Clerk application
  --new-clerk-app          Force a new Clerk application (mutually exclusive
                           with --clerk-app)
  --skip-webhook           No Clerk → Convex webhook (there is no positive
                           --webhook flag: it needs a dashboard action, so it
                           can only be turned on interactively)
  --storage <value>        convex | r2
  --skip-storage           Stays on Convex Storage without asking
  --repo <name>            GitHub repo name (default: slug)
  --public | --private     Visibility (default: private)
  --push | --no-push       Create remote repo and push (or not)
  --skip-github            Not even a local commit in that step
  --deploy | --no-deploy   Vercel Preview deploy at the end
  --skip-deploy            Same as --no-deploy
  --no-harness             (full mode only) template WITHOUT the harness
  --skip-harness           Same as --no-harness

FIA and design
  --fia | --no-fia         Install (default) or skip FIA (Pi + FDAs + skill);
  --skip-fia               --skip-fia = --no-fia
  --impeccable             Impeccable design skill (impeccable.style) — free,
                           no API key; default on. Requires Node >= 22.12
  --no-impeccable          Skips Impeccable (--skip-impeccable is the same)

Access (sign-in is optional: it unlocks the templates + their automation;
without it the installer delivers the harness + agent only — see §2)
  --login                  Authenticates this computer (browser) and exits
  --logout                 Removes/revokes the CLI token and exits
  --whoami                 Shows subscription status and exits
  --api <url>              Community API base (dev/testing; or IMPACTUS_API)

General
  --ui, --web              Opens the local web UI to build the install command
  --terminal, --no-ui      Accepted for compatibility (terminal is the default)
  --port <n>               UI server port (default: 4599)
  --verify                 Audits an ALREADY-installed project (--dir) and exits
  --update-runtime         Re-stamps the FIA/Pi runtime of an installed project
                           (--dir) from this impactus version and exits (§14.2);
                           config/data/local edits preserved, backups always
  --force                  With --update-runtime: overwrite locally modified
                           runtime files too (after the backup)
  --json                   With --verify / --update-runtime: JSON report on stdout
  -y, --yes                No prompts (safe defaults; full mode, addons = padrao preset)
  -v, --version | -h, --help
```

`--yes` semantics: `full` mode, `padrao` addon preset (change with
`--preset`/groups), default shadcn block, no webhook/deploy, storage `convex`
(EXCEPT `--storage r2` with all four `R2_*` keys in `--keys`, which
configures R2 non-interactively), **harness installed**, local commit without
a remote repo, no integration-CLI logins, FIA + Impeccable on. For harness
only without prompts: `--harness-only` (or `--mode harness`). Without a valid
login (or `IMPACTUS_TOKEN`), `--yes` continues as **guest** — harness +
agent only — and `--mode full`/`--stack recomendada` error out instead of
silently downgrading.

## 17. Environment variables

Recognized by the installer:

| Variable | Effect |
| --- | --- |
| `IMPACTUS_TOKEN` | CI/automation access token — the non-interactive way to run a full install. An invalid token fails loudly (never a silent guest downgrade). Legacy `CREATE_IAI_TOKEN` is still accepted. |
| `IMPACTUS_API` | Community API base override (same as `--api`; a custom base warns once — the token is sent to that host). Legacy `CREATE_IAI_API` is still accepted. |
| `GH_TOKEN` / `GITHUB_TOKEN` | Accepted by the gh preflight as authentication (no `gh auth login` needed). |
| `VERCEL_TOKEN` | Accepted by the vercel preflight as authentication. |
| `LEFTHOOK=0` | The documented one-time escape hatch when the template's pre-commit lint blocks the initial commit. |

Recognized by the FIA runtime inside a project:

| Variable | Effect |
| --- | --- |
| `FIA_DB` | Trace database path (default `imp/data/fia.db`) — fia-query, viewer, TUI, `imp rewind`. |
| `FIA_CONFIG` | Agent roster path (default `imp/fia.config.yaml`) — viewer, TUI, and the project side of `imp notify`. |
| `FIA_AI_DOCS` | `ai-docs/` dir override — viewer/TUI Plan views, launch-check, env-preflight, quick-log, wiki-check, the spec-diagram check. |
| `FIA_TELEMETRY_DIR` | Interactive Pi command telemetry dir (default `imp/data/telemetry`) — TUI Pi tab. |
| `FIA_BACKUPS_DIR` | Backup folder the loop-health report looks for instead of the one under the home directory (`imp health`; machine-friendly and testable). |
| `FIA_PROJECT_ROOT` | Project root override for the viewer. |
| `FIA_DEBUG` | Same as `--debug` on any FDA (full stack traces). |
| `FIA_FDA_RUN` | Exported BY the runner into its child agents — makes the fda-lock hooks/extension silent for the run's own process tree. Never set it yourself. |
| `ENGINEER_NAME` | Engineer identity stamped in the trace (fallback: `git config user.name` → `$USER`). |
| `PI_PATH` / `CLAUDE_PATH` / `CURSOR_AGENT_PATH` / `GROK_PATH` | Engine binary overrides (`pi` / `claude` / `cursor-agent` / `grok`). |
| `XAI_API_KEY` (as seen by the `grok` engine) | Never read by the grok engine — REMOVED from every grok child env, because the CLI would switch to per-token API billing. It remains the key of the Pi `xai/…` provider (row below). |
| `PI_SESSIONS_DIR` | Override for the viewer's interactive-Pi session dir (`~/.pi/agent/sessions/<slug>`). |
| `IAI_DECISION_LOG_NOW` | Fixed timestamp for decision-log/stack-research, the loop-health report and the `updated:` line `wiki-check.mjs --stamp` writes (tests). |
| `OPENROUTER_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `FIREWORKS_API_KEY`, `DEEPSEEK_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Pi API-key providers (per-token billing — the subscription providers `openai-codex`/`github-copilot` log in via `/login` instead). |

Recognized by the `imp` launcher:

| Variable | Effect |
| --- | --- |
| `PI_SKIP_VERSION_CHECK=1` | Set by imp on every passthrough — suppresses Pi's own pi-branded update notice (imp prints its own after the session). |
| `IMP_SKIP_VERSION_CHECK` / `PI_OFFLINE` | Skip imp's post-session update probe entirely. |

State on disk, outside projects: `~/.impactus-cli/` (auth token, web-UI keys
files, run logs — §2) and `~/.pi/agent/` (Pi's own credential store,
settings and session logs; never imported from `~/.claude`/`~/.codex` —
rotating refresh tokens invalidate each other).

## 18. Extending: a new addon, a new template

### 18.1 How to add a new addon

1. **In the template (`live1`)**: implement the complete feature; wrap
   snippets in shared files with `live1:addon:<id>:start/:end`; add the entry
   to `template.addons.json` (files/deps/scripts); document the envs in
   `.env.example` (inside markers). Run `npm run type-check`,
   `npm run test` and the build with everything on.
2. **In the CLI**: add the option to the right group in `ADDON_GROUPS`
   (`src/config.js`); if there is official tooling, register it in
   `ADDON_TOOLING`; if it needs a post-install instruction, `ADDON_NOTES`;
   if it needs keys, a `SERVICES` entry (envs + AI prompt).
   Validate the value in `src/lib/args.js` if it belongs to a `single` group.
3. **Test**: `npm test` in the CLI; apply the addon to a copy of the template
   (`node -e "import('./src/steps/addons.js').then(m => m.applyAddons({dir, addons:[...]}))"`)
   and run type-check/test/build there.

### 18.2 How to add a new template

A new `TEMPLATES` entry in `src/config.js` (id, repo, label/badge/hint/
description, `available`, `strip`, `requires` capabilities, `tenancy`) + the
repo on the community backend's allowlist (`cli-paid-gate.md`, private
`impactus-internal-docs` repo) + `TEMPLATE_GITHUB_TOKEN` scope. The
template's own `template.addons.json` may declare `groups`/`presets` — then
its catalog wins after the download (§4.4) and it can expose new addon
options without a CLI release. Capability steps the template does not
declare in `requires` are skipped with a stable step counter.

### 18.3 How to add a new stack technology

One entry in `src/stack-catalog.js` (label/hint/role, docs + llms.txt,
`skills` source, `cli` spec, `mcp` argv or `mcpNote`, `envs` dev×prod,
optional `onlyWhen`/`forcedBy`/`testUsers`) — the wizard, the manifest
renderer and the tooling step pick it up with no logic changes. The `/stack`
research ledger later re-verifies the entry against reality (the catalog is
the bootstrap, research wins).

### 18.4 A new student-facing command

Must be registered everywhere it is listed: the `.pi/prompts/<name>.md`
prompt file, the Routing table in `.pi/skills/fia/SKILL.md` (the single
source `/guide` routes from), the harness command file(s)
(`.claude/commands/` + `.cursor/commands/` mirror), the `finish.js` final
panels, the README and this DOCS.

## 19. CLI development

```bash
node bin/create-iai.js my-test            # runs the installer locally
npm test                                    # node --test (CLI unit tests)
npm run lint && npm run format
npm run sync:skills                         # regenerate harness/.cursor/skills
npm run sync:commands                       # regenerate harness/.cursor/commands
```

Two source-only experiment tools live under `scripts/` and are deliberately
excluded from the npm package and stamped projects:

```bash
node scripts/ai-layer-map.mjs --dir <repo> --json
node scripts/ai-layer-ablate.mjs --dir <repo> --task <file> --runner-bin <bin> \
  --runner-arg <arg> --runs 2 --execute
```

The mapper inventories always-loaded, on-demand and enforcement surfaces per
engine without emitting their contents. Ablation is dry-run unless
`--execute` is present, refuses a dirty source by default, preserves every
enforcement file, runs control versus always-loaded-stripped arms in detached
temporary worktrees, and writes blinded diffs outside the source tree. It
never grades, merges, edits `.gitignore` or removes a rule automatically.

**Mirror rule (single source of truth):** shared skills are edited ONLY in
`harness/.claude/skills/` — `harness/.cursor/skills/` is GENERATED by
`npm run sync:skills` (Cursor-only skills like `project-workflow` and
`workflow-*` are untouched). `harness/.agents/skills/<name>` is a directory
symlink to that Cursor tree — **that** is what Cursor and Pi resolve in a
stamped project; Claude reads the canonical `harness/.claude/skills/` tree.
`test/consistency.test.js` fails on skill drift and `sync:skills:check`
reports it without writing. Agents are the other way around: edit
`harness/.claude/agents/`; `.cursor/agents/` and `.agents/agents/` are
file symlinks to it. Shared commands are edited ONLY in
`harness/.claude/commands/` — `harness/.cursor/commands/` is GENERATED by
`npm run sync:commands` from `scripts/command-overlays.yaml` (Cursor
frontmatter plus intentional patchlets like `AskQuestion`, `bugbot`, and
`.claude→.cursor` skill paths); `.agents/commands/` links at the Cursor
copy. Pi harness agents (`.pi/agents/<name>.md` for the nine start/kit
roster entries) are thin wrappers: FIA frontmatter + a pointer to
`.claude/agents/<name>.md` — the rehearsal lives in one place. FIA-only
agents (planner, builder, scout, reviewer, documenter) stay self-contained.
`test/sync-commands.test.js` is the tripwire for command drift and Pi
pointer regressions. Cross-runtime knowledge follows the same principle: one
canonical file + pointers (the semantic-fields catalog and the interaction
catalog in the design-system skill; `test/semantic-fields.test.js` and
`test/interaction-contracts.test.js` are the tripwires that no runtime —
including the `.agents/` path Cursor actually opens — loses its pointer).

Structure: `bin/` (entrypoints: `create-iai.js` = `npx impactus`, `imp.js` =
the launcher) · `src/main.js` (pipeline) · `src/config.js` (catalogs:
community, template, harness, FIA, addons, tooling, services, shadcn, MCPs) ·
`src/stack-catalog.js` (the stack layers) · `src/lib/` (args, addons/stripper,
auth-client, stack, skills, keys, clerk, command, ui, proc, log,
harness-manifest, util…) ·
`src/steps/` (one file per step) · `fia-templates/` + `pi-templates/` (the
runtime stamped into projects) · `test/` (node:test). The local checkouts
`live1/`, `live2/` and `harness/` are gitignored — each piece has its own
repo. `lessons.md` (local-only, gitignored) is the living log of recurring
problems; internal planning docs live in the private `impactus-internal-docs`
repo — never add them back here (this repo is public).

Publishing to npm: bump `version` in `package.json` + `npm publish` (the
package ships `bin/`, `src/`, `fia-templates/`, `pi-templates/` and
`README.md` — the FIA/Pi templates are stamped into projects by the CLI
itself; only the SaaS template and the harness come from the community API).
