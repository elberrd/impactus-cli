---
description: Small change, fast lane — triage first; simple stays simple, one FDA
argument-hint: "\"what to change\""
---
Read `.pi/skills/fia/SKILL.md`. You implement NOTHING — the FDA does the work.

Request: $@

1. **Triage** (silent — inspect the code yourself, no interview). SIMPLE only if ALL hold:
   - blast radius ≤ ~3 files, one obvious shape;
   - NO schema/migrations, auth/permissions, payments/billing, new dependency,
     new route/page, new UI component (a registry equivalent exists),
     destructive data operation;
   - no new spec needed — the behavior change is local and self-evident.
2. SIMPLE → run `node imp/fda_quick.mjs "<description>"`. The FDA enforces the
   guardrails (design-system registry, backend rules, one focal test when the
   change is testable behavior) and appends the audit entry to
   `ai-docs/todos/quick-log.md` — no issue, no roadmap noise. If my request
   names an LLM for this run (`--llm "…"`, "on grok 4.6 low"), append
   `--llm "<my words>"` to that command — never edit the roster for it.
3. COMPLEX → do NOT push through. Route me in one line — new behavior →
   /feature, defect → /bug — and name the triage criterion that failed.
4. Check `ai-docs/inbox.md`: an unchecked item this run resolves gets ticked
   `- [x] … → Q-NNN`.
5. exit 0 → report files, verification and the Q-NNN entry. exit != 0 →
   ONE automatic recovery first (re-run / repair once per the cookbook).
   If that also fails, stop and show me the evidence; further re-runs use
   `--fda-id <id> --resume`.
