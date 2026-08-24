# Update the roster

The roster lives in `imp/fia.config.yaml` (FDAs) and `.pi/agents/*.md` (interactive pi-subagents). Keep the two aligned: same names, same `writes`, same purpose.

## The quick way — /llm (switch one model in one sentence)

`/llm` (inside `pi`) or `imp llm` (terminal) lists the FDA agents NUMBERED,
each with the engine + model it runs on and the run phases it owns. The
student answers "1 → fable" (or "builder → openai-codex/gpt-5.6") and the
change is applied by `node imp/scripts/fia-llm.mjs set <n|name> <model>` —
the SAME write path as the Agents tab: comments preserved, backup under
`imp/data/backups/`, atomic write, refused while an FDA run is live. Claude
aliases route to `claude_code`, `grok-<version>` ids (or "grok 4.6") route to
`grok`, `provider/id` routes to `pi` (`anthropic/*` is refused — extra usage),
cursor ids need `--engine cursor`. Pi must never edit `imp/fia.config.yaml`
directly — the script owns the write.

## One run only — `--llm` (the roster stays as it is)

When the engineer wants a DIFFERENT LLM for just this task ("run this one on
grok 4.6 high", "do it with opus xhigh", `/task 12 --llm "grok 4.6 high"`),
do NOT touch the roster: pass the words through to the FDA as
`--llm "<what they said>"` — every `node imp/fda_*.mjs` accepts it, repeatable:

```bash
node imp/fda_sdlc.mjs ai-docs/actual-todo/<brief>.md --llm "grok 4.6 high"        # every agent of this run
node imp/fda_sdlc.mjs ai-docs/actual-todo/<brief>.md --llm "builder=opus xhigh"   # only the builder
node imp/fda_quick.mjs "rename the button" --llm "reviewer,scout=openai-codex/gpt-5.6-sol"
```

Grammar: `[<agent>[,<agent>]=]<model>[ <level>]` — the script normalizes
spellings (`grok 4.6` → `grok-4.6`, `max` on grok → `xhigh`), refuses
ambiguous ids with the exact fix, prints every switch at run start, traces it
(`llm_override`) and saves it with the run so `--resume` keeps the same LLM.
Report the printed `old → new` line to the engineer. Never "remember" the
choice by editing the YAML — a durable change is `/llm`, not `--llm`.

## The visual way — /agents (recommended for fallbacks and overviews)

`/agents` (inside `pi`) or `npm run agents` opens the FIA viewer's "Agents" tab
(http://127.0.0.1:4600#agents). There the student sees the engine login status
(claude/pi/cursor/grok), changes each FDA agent's engine, model and reasoning, and
edits an optional `fallbacks:` chain — no YAML by hand. Save writes
`imp/fia.config.yaml` preserving comments (a backup is kept; saving is locked
while an FDA runs). Recommend it first; the manual edit below covers the same
ground and the fields' meaning.

## Engines — every agent picks its own engine + model

FDAs never name models — they name agents. The engine/model pair lives ONLY in `imp/fia.config.yaml`:

| `coding_agent` | Runs on | Login/keys | `model` format |
|---|---|---|---|
| `claude_code` | official `claude` CLI | `claude` once (Pro/Max plan limits) | alias `sonnet`/`opus`/`haiku`/`fable` or full name; `effort: low\|medium\|high\|xhigh\|max\|ultracode` |
| `pi` | Pi headless | subscriptions: `pi` → `/login openai-codex` or `github-copilot`; API keys via env | `provider/model-id`; `thinking: minimal\|low\|medium\|high` (Codex reasoning effort) |
| `cursor` | Cursor Agent CLI | `cursor-agent login` (Cursor subscription) | id from `cursor-agent --list-models`; effort variants live in the id (e.g. `sonnet-4.5-thinking`) |
| `grok` | Grok Build (`grok` CLI, headless) | `grok login` once (xAI subscription; `curl -fsSL https://grok.com/install.sh \| bash` installs it). Detected from `~/.grok/auth.json` — NEVER `XAI_API_KEY` (per-token API; the FIA strips it) | `grok-4.6` / `grok-4.5` (`grok models`); `effort: low\|medium\|high\|xhigh` (no max). The first grok run trusts the project folder once so the FIA hooks apply |

Pi API-key providers (any of them, per agent): `openrouter/…` (OPENROUTER_API_KEY — one key, every model), `xai/…` (XAI_API_KEY — Grok through the API, per token; the subscription route is the `grok` engine above), `groq/…`, `google/…` (GEMINI_API_KEY), `fireworks/…`, `deepseek/…`, `mistral/…` and more (see Pi providers doc). List models inside `pi` with `/model`.

Rule of thumb: heavy reasoning (planner, reviewer) on a frontier model; volume work (builder, scout, documenter) on a fast/cheap one — different providers in the SAME run is the point.

Cost reality check (measured on a real project ledger): the planner on a
top-tier model averaged **US$3.55 per call** and 15% of ALL tokens; the same
role on the mid-tier model of the same plan costs roughly a fifth for briefs
that are already self-contained. The model is ALWAYS the engineer's choice —
their plan, their subscription — so never switch it silently: show the ledger
(`npm run fda:cost-report`, or the Agents tab) and offer the one-liner
(`/llm set planner <model>` swaps it in seconds). The shipped roster already
carries `phase_overrides` that drop reasoning (never the model) on repair and
UI-verify phases — keep them when editing an agent by hand.

WARNING: Claude INSIDE Pi bills as per-token "extra usage" — to spend plan limits, always use `coding_agent: claude_code`.

## Fallbacks — per-agent `fallbacks:` chain

Each agent may declare an ordered `fallbacks:` list of up to 5 entries
(engine/model, same fields as the primary). The chain is walked in three stages:

1. **Run start** — the primary engine is unavailable: binary missing, or
   provider without login/key. Traced as `engine_fallback`.
2. **Mid-run** — the engine dies inside a phase (exits with no report, binary
   gone). The death is classified (`login`|`limit`|`missing`|`crash`) and
   recorded under `imp/data/sessions/<fda_id>/<agent>/engine_error.json`; the
   run switches to the next viable fallback in place and retries the phase.
   `login`/`limit`/`missing` switch on the first death; a `crash` retries the
   same engine once and switches on the second. Traced as `engine_error` +
   `engine_relay`. The substitute receives the interrupted attempt's transcript
   as a handover, so it continues instead of restarting.
3. **Resume** — `--resume --fda-id <id>` reads that run's markers and walks the
   chain even when the binary checks pass (that engine already proved it cannot
   finish); with no viable fallback it retries the primary out loud.

`defaults.relay` in `imp/fia.config.yaml` sets the policy: `auto` (default —
switch mid-run and on resume), `resume` (fail fast mid-run; fallbacks arm only
on `--resume`), `off` (never auto-switch; deaths are still recorded). Every
switch is printed and traced — never silent. Edit the chain visually in
`/agents` or by hand in `imp/fia.config.yaml`.

The interactive twin: when the Codex provider is down (so Pi itself cannot
answer), `imp handoff` in a terminal — outside Pi — continues the newest Pi
conversation in the `claude` CLI with the same continuation handover
(`--list` picks a session, `--print` shows the prompt without launching).

## Add or change an agent (FDAs)

1. Edit `imp/fia.config.yaml` — the file is protected for agents; the ENGINEER edits it (or uses `/agents`):
   - `coding_agent: claude_code | pi | cursor` (table above)
   - `model`, `thinking` (`low|medium|high`)
   - `fallbacks:` — optional ordered chain (section above)
   - `writes:` allowlist — `[]` = read-only; omitted = anything except `protected_files`
   - `prompt_engineering.system/user` — paths under `imp/data/prompt_engineering/<name>/`
2. Create `system.md` (role + Report JSON contract matching the zod schema) and `user.md` (placeholders `{{prompt}}`, `{{previous_envelope}}`, `{{context_handoff_dir}}`). Copy an existing agent's pair as base.
3. Validate: any FDA run calls `validate(cfg, [...])` and fails fast on missing prompts or bad `coding_agent`. A missing API key does NOT fail at startup — it fails when that agent runs, and an engine that dies at that point (or later, mid-phase) hands the work to the agent's `fallbacks:` chain via the mid-run relay, when one is declared.

## Mirror in interactive Pi (optional)

Add `.pi/agents/<name>.md` with pi-subagents frontmatter so the orchestrator can delegate ad hoc. Interactive subagents run as Pi children — use Codex/Copilot/API-key models there; route Claude work through FDAs (it bills on the plan only via the official CLI).

## Never

- Don't point two engines at the same credential store, and don't import tokens from `~/.claude` / `~/.codex` — rotating refresh tokens invalidate each other. Each engine logs in through its own product.
