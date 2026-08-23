/**
 * Policy for the SDLC runner's optional agent phases, from the student-owned
 * `sdlc:` block in imp/fia.config.yaml. Same contract as `stop:`
 * (modules/stop.mjs): every key has a code default here, an absent block
 * behaves exactly like the defaults, and a bad value degrades to the default
 * with a warning — never a throw.
 *
 * Why these knobs exist (measured on a real project ledger): the planner
 * re-reading the repository to re-plan a brief the task-sequencer had already
 * written cost millions of tokens per run, and a documenter call per task
 * writes prose that reads better written once per milestone.
 */
import { isFoundationBrief } from './gates.mjs';

export const SDLC_DEFAULTS = Object.freeze({ plan: 'auto', document: 'per_milestone' });

const CHOICES = Object.freeze({
  plan: ['auto', 'always', 'never'],
  document: ['per_milestone', 'per_task'],
});

/**
 * The sdlc policy from the student's config, normalized. Tolerant by design:
 * a missing block, a missing key or a typo'd value all degrade to the default
 * and are reported through `warnings` — never thrown.
 */
export function sdlcPolicyOf(cfg) {
  const raw = cfg?.sdlc && typeof cfg.sdlc === 'object' ? cfg.sdlc : {};
  const policy = { ...SDLC_DEFAULTS, warnings: [] };
  for (const key of Object.keys(SDLC_DEFAULTS)) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const value = String(raw[key]).trim().toLowerCase();
    if (!CHOICES[key].includes(value)) {
      policy.warnings.push(
        `sdlc.${key}: ${JSON.stringify(raw[key])} is not one of ${CHOICES[key].join(' | ')} — ` +
          `keeping the default "${SDLC_DEFAULTS[key]}".`,
      );
      continue;
    }
    policy[key] = value;
  }
  return policy;
}

/**
 * A sequencer brief IS the plan: markdown sections (scope, spec scenarios,
 * seams, key files) plus an acceptance checklist. The structural test is
 * deliberately dumb and cheap — a hand-typed one-line request has neither a
 * `## ` heading nor a checkbox, and gets the planner.
 */
export function briefIsSelfContained(text) {
  const body = String(text || '');
  return /^##\s+\S/m.test(body) && /^[-*]\s+\[[ xX]\]\s+\S/m.test(body);
}

/**
 * Does this brief still need a planner pass?
 *
 * `always` / `never` are the human overrides. In `auto` (the default) the
 * planner runs for foundation briefs (architecture choices deserve a plan),
 * for briefs that opt in with a `Planning: full` line, and for unstructured
 * requests — a self-contained sequencer brief skips it, because re-planning
 * it from the repository re-spends a full planner session on work the
 * sequencer already did.
 */
export function briefWantsPlanner(prompt, mode = SDLC_DEFAULTS.plan) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (isFoundationBrief(prompt)) return true;
  if (/^planning:\s*full\b/im.test(String(prompt || ''))) return true;
  return !briefIsSelfContained(prompt);
}
