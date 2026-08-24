---
description: List the FDA agents (phase owners) with the LLM each one runs on — then switch any of them by number or name
argument-hint: "[e.g. \"1 fable\" or \"builder → opus\" — empty just lists]"
---
Show me the LLM roster and let me switch models conversationally. $@

1. Run `node imp/scripts/fia-llm.mjs --json` and present a NUMBERED list, one
   line per agent, exactly in this shape (current engine · model, then the run
   phases it owns):

   1. planner — claude_code · opus (effort high) — phases: plan
   2. builder — pi · openai-codex/gpt-5.6-sol (thinking medium) — phases: build, fix_*, …

   Append any `engine_issue` as a ⚠ on that agent's line. Close with one line:
   "Say the change like: `1 → fable` or `builder → openai-codex/gpt-5.6`."
   If I already asked for a change in my message (arguments above), skip the
   waiting and apply it directly (step 2).

2. When I answer (any phrasing, any language — "number 1 to fable", "switch
   the builder to opus", "2 → cursor sonnet-4.5-thinking"), apply it with the
   script — NEVER edit `imp/fia.config.yaml` yourself:

   `node imp/scripts/fia-llm.mjs set <number|name> <model> [--engine claude_code|pi|cursor|grok] [--effort …] [--thinking …]`

   Model resolution the script already does (don't second-guess it): claude
   aliases (sonnet|opus|haiku|fable) and `claude-*` ids → `claude_code`;
   `grok-4.6`/`grok-4.5` (or "grok 4.6") → `grok` (Grok Build, xAI
   subscription — effort low|medium|high|xhigh); `provider/id` → `pi`; bare
   cursor ids need `--engine cursor` (or say "cursor <id>"). `anthropic/*` on
   pi is refused by design — extra usage.

   If instead I ask for a model "just for this task / this run" ("run task 12
   on grok 4.6 high"), that is NOT a roster change: tell me to say it on the
   command (`/task 12 --llm "grok 4.6 high"`, `/goal --llm "builder=opus
   xhigh"`) — or run it that way yourself when the task is clear — and leave
   the roster alone.

3. Report back exactly what the script printed: the `old → new` line, every ⚠
   warning verbatim (API-key billing, engine not logged in), and that the
   change applies from the NEXT run. Then re-run step 1's listing so I see the
   updated roster. If the script refuses because an FDA run is active, relay
   its message (wait or `imp stop`) and change nothing.

4. If I ask for fallback chains, per-phase effort tuning or a full visual
   overview, point me to `/agents` (the visual editor) instead of improvising.
