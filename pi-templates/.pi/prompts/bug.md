---
description: Fix a defect — reproduction first, FDA second
argument-hint: "\"the symptom\""
---
Read `.pi/skills/fia/SKILL.md`. You fix NOTHING — the FDA fixes it.

Symptom: $@

1. **Collect evidence first** (objective questions, one at a time, only the
   necessary ones): how to reproduce, expected vs observed, since when/what
   changed. Inspect the code, logs, tests and relevant git history yourself;
   never ask for something the repository can answer.
2. **Choose the proportional investigation path before implementation.** Use
   `direct` only when ALL are true: the reproduction is deterministic at one
   clear seam; the cause and smallest fix are localized with HIGH confidence;
   the defect is not recurring; severity is not CRITICAL; and it touches none
   of security/auth/permissions, privacy, payments, destructive data,
   schema/migrations or a public contract. Use `rca` when ANY of those
   conditions is false, when the bug is
   intermittent, when competing hypotheses remain, or when several subsystems,
   an integration or concurrency are involved. Do not force exactly five
   whys: follow `why → because` only until the specific fixable cause, with
   evidence for every link.
3. Record the path-free issue in
   `ai-docs/todos/issues/NN-bug-<slug>.md` (continue the existing numbering)
   with the reproduction, pending `Status:`, and these plain metadata lines:

   ```text
   Investigation: direct | rca
   Severity: critical | high | medium | low
   Confidence: high | medium | low
   RCA: ai-docs/investigations/NN-bug-<slug>.md | not-required
   RCA review: pending | approved | not-required
   ```

   Give severity and confidence a one-line evidence-based reason. A direct bug
   is necessarily high-confidence and uses `RCA: not-required` /
   `RCA review: not-required`.

4. **RCA path only:** create
   `ai-docs/investigations/NN-bug-<slug>.md` and record: issue + base commit;
   verified reproduction; expected/actual; severity, complexity (1–10) and
   confidence with reasons; affected components with `file:line`; the evidence
   chain; regression/long-standing/original/unknown history; blast radius,
   workaround and data/security risk; smallest fix, rejected alternatives,
   risks, exact tests/commands, unknowns and out-of-scope. This is a historical
   investigation snapshot, not another issue file.
5. **Human-attention gate.** Set `RCA review: pending` when confidence is LOW,
   severity is CRITICAL, or security/auth/permissions, privacy, payments,
   destructive data or migrations are involved. Show the evidence and WAIT for
   explicit approval; never approve it yourself. After approval, change the
   issue and RCA to `approved`. Other RCA cases use `not-required`.
6. Delegate to the `task-sequencer` → brief in `ai-docs/actual-todo/`. It must
   carry the investigation metadata and concise root-cause evidence, and must
   require reproducing the bug with a RED test before any fix. If available,
   make the captured docs durable BEFORE the FDA:

   ```bash
   node imp/scripts/docs-commit.mjs --message "docs(bug): capture <slug>" \
     ai-docs/todos/issues/NN-bug-<slug>.md \
     ai-docs/actual-todo/<brief>.md \
     ai-docs/investigations/NN-bug-<slug>.md
   ```

   Omit the investigation path for a direct bug. Never run this while an FDA
   is active; without the script, continue without inventing a replacement.

7. Run `node imp/fda_bug.mjs ai-docs/actual-todo/<brief>.md` and follow along
   (an LLM named in my request for this run — `--llm "…"`, "on grok 4.6 high"
   — goes on that command as `--llm "<my words>"`; never into the roster).
   Tell me, in one line, that the FDA gates the RED for validity: the
   reproduction test must fail on a real assertion — a passing test means "bug
   not reproduced", and a module/syntax/env failure doesn't count as proof.
8. exit 0 → report phases/tokens/commit and close with "How to test" the fix.
   exit != 0 → ONE automatic recovery first (re-run / repair once per the
   cookbook). If that also fails, stop and show me the evidence; further
   re-runs use `--fda-id <id> --resume` (phases that passed don't run again).
