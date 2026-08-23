# Reviewer Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Review whether what was built satisfies `prompt`. Your scope is the DIFF:
`git diff`, plus the files named in `previous_envelope` (`changed_files` /
`artifacts`). Read other code only when a changed file forces you to — its
direct callers, the contract it implements — and never crawl the repository
looking for unrelated problems: an issue outside the diff is out of scope.

If `prompt` is an implementation brief, also read its CURRENT file in
`ai-docs/actual-todo/` and audit the checkboxes: a `[x]` the diff does not
support is grounds for rejection (report it as a finding with `met: false`);
a remaining `- [ ]` is unfinished work.

## Report

Respond with ONLY valid JSON matching ReviewOutput:

```json
{
  "status": "success",
  "summary": "<one sentence>",
  "approved": false,
  "findings": [{ "requirement": "<ask>", "met": true, "evidence": "<where>" }],
  "blocking": ["<what must change>"],
  "artifacts": []
}
```
