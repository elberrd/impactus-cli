import { phaseParams } from './fda-cli.mjs';
import { artifactsExist, verdictConsistent, parseSurfaceLine } from './gates.mjs';
import { runTestsForBrief } from './quality.mjs';
import * as git from './git-helper.mjs';
import { verifyUiKitReceipt } from './ui-kit-receipt.mjs';
import {
  loadUiContract,
  resolveUiImplementation,
  resolveUiRuleApplicability,
  UI_RULES,
} from '../scripts/ui-contract.mjs';

/** Component/page files — the surfaces the UI-conformance rubric applies to. */
export const FRONTEND_FILE = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less)$/i;

/**
 * The default UI-conformance contract, mirrored from the harness's
 * `ai-docs/ui/patterns.md`. It lives in CODE (not in prompt_engineering/)
 * deliberately: modules/ reach existing installs via --update-runtime, the
 * prompt material does not. patterns.md, when the project keeps one,
 * overrides these defaults — the rubric says so.
 */
const UI_RUBRIC = [
  {
    ruleId: 'quality.error_recovery',
    requirement:
      "Field validation errors render INLINE with the field: a short, specific message below/beside the field (the form library's message slot), an error border, aria-invalid + aria-describedby, and focus moving to the first invalid field on submit. A top-of-page banner, a card-header message, or a toast as the ONLY display of a field error is a violation.",
  },
  {
    ruleId: 'quality.focus_visibility',
    requirement:
      'Validation runs on blur and on submit, the error clears once the value becomes valid, labels are persistent (a placeholder is never the label), and keyboard focus remains visible.',
  },
  {
    ruleId: 'quality.error_recovery',
    requirement:
      "Every mutation/submit announces its outcome — success AND failure — through the project's toast system, fired only AFTER the operation resolves. A silent failure, or success shown before the operation resolved, is a violation.",
  },
  {
    ruleId: 'quality.keyboard_access',
    requirement:
      "Create/edit flows follow the project's interaction pattern: by default an explicit button (or row click) opens a modal Dialog holding the form, and destructive actions confirm through an AlertDialog-style dialog. Native alert()/confirm()/prompt() are forbidden and every flow is keyboard operable.",
  },
  {
    ruleId: 'quality.keyboard_access',
    requirement:
      'UI components come from the project registry when it keeps one — no ad-hoc duplicate. Every clickable control is semantic, keyboard operable, visibly focusable, and shows the pointer cursor. The `/ui-components` page gives each registry component one isolated card; a kitchen-sink form repeated across sibling cards is a violation.',
  },
  {
    ruleId: 'components.data_table',
    requirement:
      "Lists of records render through the registry's selected shared table/data-grid implementation, with semantic accessible table or grid structure. Its professional base includes global search unless a scoped approved waiver records why search is inapplicable; one Filter control; per-column filters from an accessible header menu opened by a visible header button/left-click, right-click, and Shift+F10 or the Context Menu key; compact removable filter chips plus Clear filters; compatible sort, hide, and reset actions; column visibility; pagination with a truthful count summary; and loading, empty, no-results, error, and long-content states. Base call sites expose no advanced-only UI and retain header sort/filter/hide/clear. A toolbar row of per-column filter buttons, an inaccessible hand-rolled table, bare primitive composition, or a second per-screen table implementation is a violation.",
  },
  {
    ruleId: 'data_table.advanced_controls',
    requirement:
      "Advanced actions appear only when this rule applies and are activated through the selected implementation's explicit advanced configuration; when the rule is skipped, none leak into the base surface. The ordered grouping lane exposes removable/reorderable chips and + Level to a maximum of three; semantic aria-expanded groups and summaries use truthful leaf-record counts, never expanded DOM leaves. The accessible header menu adds compatible group/ungroup, pin/unpin, move, sizing and density actions. Versioned per-user view persistence is default-on for professional tables, uses stable table/user/tenant scope, covers search/filter/sort/grouping/visibility/order/width/pinning/density/page size, tolerates unavailable browser storage, and Restore defaults survives reload. Optional header reorder uses a dedicated column-drag handle, insertion indicator, cancel/rollback and menu/keyboard fallback. A sticky header remains contained. Large/unknown data uses server-side sorting, filtering, and pagination with backend totals; remote grouping additionally requires grouping/expanded query state plus a backend-provided hierarchy and truthful leaf counts, and is unavailable without that adapter. Virtualization is only for many already-loaded rows.",
  },
  {
    ruleId: 'quality.error_recovery',
    requirement:
      'Fields with a known domain or normalizable format use their semantic component and canonical stored code, with masks/validation where appropriate. Submit buttons disable while submitting; async views have explicit loading, empty and recoverable error states.',
  },
  {
    ruleId: 'quality.overflow_containment',
    requirement:
      'Every component owns its geometry: long content, menus, tables, boards and actions remain inside their card/container or an explicit internal scroller. No child, transform, overlay or toolbar widens the page or escapes its owning border.',
  },
  {
    ruleId: 'quality.responsive_layout',
    requirement:
      'The changed surface remains usable on narrow/mobile, tablet and desktop layouts and at 200% zoom, with responsive actions and no page-level horizontal overflow.',
  },
  {
    ruleId: 'shell.app_shell',
    requirement:
      'Routed application surfaces reuse the project-selected shared AppShell and PageHeader implementation; the shell owns sidebar/header/main geometry with min-width: 0 and screen pages do not recreate that chrome.',
  },
  {
    ruleId: 'navigation.breadcrumb',
    requirement:
      'Nested routes expose the real parent hierarchy through the project-selected accessible Breadcrumb implementation. Tabs switch views and never substitute for route hierarchy.',
  },
  {
    ruleId: 'theme.user_switcher',
    requirement:
      'System, light and dark appearance choices use semantic theme tokens, default to system, persist the user choice and keep content readable in every mode.',
  },
  {
    ruleId: 'components.kanban',
    requirement:
      'Kanban uses the project-selected shared board implementation: one card root contains title, metadata, handle and actions; columns have stable minimum width, empty columns remain valid targets, and horizontal scrolling belongs to the board.',
  },
  {
    ruleId: 'quality.drag_geometry',
    requirement:
      'Drag listeners live on an internal dedicated handle. A single measured overlay preserves the source bounding box and pointer pickup offset through scroll and zoom without teleporting or rotation; cancel/error restores the captured state.',
  },
  {
    ruleId: 'quality.drag_alternative',
    requirement:
      'Every drag operation also exposes localized keyboard/single-pointer alternatives such as Move to…, Move up and Move down; dragging is never the only way to perform the action.',
  },
];

function routeDepthFromBrief(prompt) {
  const match = /^Route depth:\s*(\d+)\s*$/im.exec(String(prompt || ''));
  return match ? Number(match[1]) : undefined;
}

/** Resolve applicability only. The reviewer still proves actual compliance. */
export function uiGateRulePlan(contract, prompt = '') {
  const routeDepth = routeDepthFromBrief(prompt);
  return Object.keys(UI_RULES).map((ruleId) => resolveUiRuleApplicability(contract, ruleId, { routeDepth }));
}

const IMPLEMENTATION_SURFACES = Object.freeze(['app_shell', 'breadcrumb', 'theme', 'data_table', 'kanban']);

function selectedImplementationLine(contract, surface) {
  const selection = resolveUiImplementation(contract, surface);
  if (selection.isCanonical) {
    return `- ${surface}: canonical fallback preset ${selection.preset}`;
  }
  const target = selection.package || selection.path || '(project-defined)';
  return `- ${surface}: ${selection.mode} ${target} — explicit project/user choice; do not replace it with the canonical fallback`;
}

function canonicalSpecificRequirements(contract, decisions) {
  const requirements = [];
  const table = resolveUiImplementation(contract, 'data_table');
  if (decisions.get('components.data_table')?.applicable && table.isCanonical) {
    requirements.push(
      '[rule id: components.data_table] Canonical preset receipt: the shared DataTable uses the FIA canonical TanStack implementation. A base-only call site passes advancedControls={false}; the professional default is true.',
    );
  }
  if (decisions.get('data_table.advanced_controls')?.applicable && table.isCanonical) {
    requirements.push(
      '[rule id: data_table.advanced_controls] Canonical preset receipt: applicable professional call sites omit advancedControls (default true) or pass true; base-only call sites pass false.',
    );
  }
  return requirements;
}

function checkPrompt(files, rulePlan, contract) {
  const decisions = new Map(rulePlan.map((result) => [result.ruleId, result]));
  const applicable = UI_RUBRIC.filter((item) => decisions.get(item.ruleId)?.applicable);
  const canonicalSpecific = canonicalSpecificRequirements(contract, decisions);
  const applied = rulePlan.filter((result) => result.applicable);
  const skipped = rulePlan.filter((result) => !result.applicable);
  return [
    'Audit ONLY the UI conformance of the frontend files listed below — the functional review happens elsewhere; do not re-review the task.',
    'Read validated `ai-docs/ui/contract.json`, `ai-docs/ui/patterns.md`, `ai-docs/components/registry.md`, `.claude/skills/design-system/references/interaction.md`, and `.claude/skills/design-system/references/semantic-fields.md` first when they exist. The UI contract owns applicability; the catalogs refine applicable interaction and semantic-field defaults but cannot waive quality invariants.',
    '',
    'Frontend files this run changed:',
    ...files.map((f) => `- ${f}`),
    '',
    'Deterministic implementation selections (an explicit library/custom/project choice wins; the canonical preset is fallback only):',
    ...IMPLEMENTATION_SURFACES.map((surface) => selectedImplementationLine(contract, surface)),
    '',
    'Deterministic contract decisions retained by this gate:',
    ...applied.map((result) => `- ${result.label} ${result.ruleId} — ${result.status} (${result.reason})`),
    ...skipped.map((result) => `- ${result.label} ${result.ruleId} — ${result.reason}`),
    '',
    'Applicable rubric — emit ONE finding per item ({requirement, met, evidence}, evidence citing file/line or the concrete gap). Keep the rule id in the requirement/evidence:',
    ...applicable.map((item, i) => `${i + 1}. [rule id: ${item.ruleId}] ${item.requirement}`),
    ...canonicalSpecific.map((item, i) => `${applicable.length + i + 1}. ${item}`),
    '',
    'Scope discipline: judge only what these files implement. Files with no user-facing form or flow (pure types, tests, config) satisfy every item — say so in the evidence. Never demand work beyond the rubric. Set approved=true ONLY when every applicable item is met; otherwise list exactly what must change in `blocking`.',
  ].join('\n');
}

/**
 * The re-audit after the repair round is scoped to the VIOLATIONS the first
 * audit found — that audit already covered the full rubric and its other
 * items passed; re-sending the whole rubric re-pays the reviewer for
 * questions that were already answered (measured: the verify pass was the
 * single largest UI-reviewer line on a real project).
 */
function verifyPrompt(files, problems) {
  return [
    'Re-audit ONLY the violations listed below. The first audit already covered the full UI rubric and every other item passed — do not re-judge them and do not raise new findings outside this list.',
    'The UI contract (`ai-docs/ui/contract.json`) and the project catalogs still govern any violation that cites them.',
    '',
    'Files touched by the repair round:',
    ...files.map((f) => `- ${f}`),
    '',
    'Violations to verify — emit ONE finding per item ({requirement, met, evidence}, evidence citing file/line):',
    ...problems.map((p, i) => `${i + 1}. ${p}`),
    '',
    'Set approved=true ONLY when every violation above is fixed; otherwise list exactly what still fails in `blocking`.',
  ].join('\n');
}

/**
 * Deterministic UI-conformance close-out, same shape as the checklist gate:
 * audit → one builder repair round when violations were found → re-audit,
 * failing the run if violations survive. The audit is an agent (a form that
 * hides its errors in a banner is not grep-detectable), but the REFUSAL is
 * code — the gate throws, no prompt can talk it out of that.
 *
 * Arms itself: an explicit `Surface:` line without `ui` stands it down;
 * otherwise any run that changed frontend component files is audited (briefs
 * predating the `Surface:` convention still get the check).
 *
 * Returns the repair envelope (for commit-path inclusion), or null when the
 * gate was skipped or the first audit approved.
 */
export async function runUiGate(run, prompt) {
  const scope = await run.runPhase(
    phaseParams(
      'ui_scope',
      'code',
      'quality',
      'Decide whether the run changed frontend files that need the UI-conformance audit',
    ),
    async (ph) => {
      const surface = parseSurfaceLine(prompt);
      if (surface && !surface.includes('ui')) {
        ph.log({ skipped: `the brief declares Surface: ${surface.join(', ')} — ui is not in it` });
        return { skip: true };
      }
      const uiFiles = git.runChangedPaths(run.repoRoot, run.baseline).filter((f) => FRONTEND_FILE.test(f));
      if (!uiFiles.length) {
        ph.log({ skipped: 'the run changed no frontend component files' });
        return { skip: true };
      }
      // The greenfield Foundation task (Kind: foundation) runs BEFORE /theme,
      // the UI contract and the Task 02 kit install — its scaffold .tsx files
      // must not deadlock on a contract/receipt that only later tasks create.
      // (Kind: kit stays audited: that run writes the receipt itself.)
      if (/^Kind:\s*foundation\b/im.test(String(prompt || ''))) {
        ph.log({ skipped: 'Kind: foundation brief — the UI contract and kit receipt land in later sequence steps' });
        return { skip: true };
      }
      const contract = loadUiContract(run.repoRoot, { required: true });
      const kitReceipt = verifyUiKitReceipt(run.repoRoot, contract);
      if (kitReceipt.required && !kitReceipt.ok) {
        const codes = kitReceipt.errors.map((error) => error.code).join(', ');
        throw new Error(
          `ui kit receipt incomplete: ${codes}\n` +
            'Recover: `node .agents/scripts/ui-kit.mjs verify --target . --json` re-inspects the selected implementations and re-stamps ai-docs/ui/kit-receipt.json (legitimate edits to an alternate entrypoint need exactly this); a missing receipt means the kit was never installed — run `node .agents/scripts/ui-kit.mjs install --target . --json` (brownfield: /kit) first.',
        );
      }
      const rulePlan = uiGateRulePlan(contract, prompt);
      for (const result of rulePlan.filter((item) => !item.applicable)) {
        ph.log({ skipped_rule: `${result.label} ${result.ruleId} — ${result.reason}` });
      }
      ph.log({
        ui_files: uiFiles.length,
        contract_profile: contract.profile,
        ui_kit_receipt: kitReceipt.outcome,
      });
      return { skip: false, uiFiles, rulePlan, contract, kitReceipt };
    },
  );
  if (scope.skip) return null;

  const check = await run.runPhase(
    phaseParams('ui_check', 'agent', 'reviewer', 'Audit the changed frontend files against the UI-conformance rubric', {
      retries: 1,
    }),
    async (ph) =>
      ph.call({
        outputType: 'ReviewOutput',
        prompt: checkPrompt(scope.uiFiles, scope.rulePlan, scope.contract),
        gates: [verdictConsistent],
      }),
  );
  if (check.approved) return null;

  const problems = [
    ...(check.blocking || []),
    ...(check.findings || [])
      .filter((f) => !f.met)
      .map((f) => `${f.requirement}${f.evidence ? ` — ${f.evidence}` : ''}`),
  ];
  const fix = await run.runPhase(
    phaseParams(
      'fix_ui',
      'agent',
      'builder',
      'Repair the UI-conformance violations found in the changed frontend files',
      { retries: 1 },
    ),
    async (ph) =>
      ph.call({
        outputType: 'BuildOutput',
        prompt: [
          "The implementation works and the tests are green, but the frontend files this run changed violate the project's interaction patterns (`ai-docs/ui/patterns.md`; the audit below cites the defaults). Fix ONLY these violations — no scope expansion, no refactors beyond them:",
          ...problems.map((p) => `- ${p}`),
          '',
          'Declare every file you touch in `changed_files`.',
        ].join('\n'),
        previous: check,
        gates: [artifactsExist],
      }),
  );

  const verify = await run.runPhase(
    // replay: false — this verdict is about the CURRENT tree. Replaying a
    // rejecting envelope on --resume would make a failed gate a permanent
    // dead end (the engineer's hand-fix could never be seen); re-auditing
    // costs one reviewer call and keeps resume honest.
    phaseParams('ui_verify', 'agent', 'reviewer', 'Re-audit the frontend files after the repair round', {
      retries: 1,
      replay: false,
    }),
    async (ph) =>
      ph.call({
        outputType: 'ReviewOutput',
        prompt: verifyPrompt(
          [...new Set([...scope.uiFiles, ...(fix.changed_files || []).filter((f) => FRONTEND_FILE.test(f))])],
          problems,
        ),
        previous: fix,
        gates: [verdictConsistent],
      }),
  );

  await run.runPhase(
    phaseParams('ui_gate', 'code', 'quality', 'Refuse to close the run while UI-conformance violations remain'),
    async (ph) => {
      if (!verify.approved) {
        const remaining = [
          ...(verify.blocking || []),
          ...(verify.findings || []).filter((f) => !f.met).map((f) => f.requirement),
        ];
        throw new Error(`ui conformance incomplete:\n- ${remaining.join('\n- ')}`);
      }
      ph.log({ ui: 'conformance verified' });
    },
  );

  // The repair round rewrote production code AFTER the run's test phase — the
  // suite must be green on the tree that will actually be committed, so re-run
  // it here, in code, before the gate lets the run proceed.
  await run.runPhase(
    phaseParams('ui_retest', 'code', 'quality', 'Re-run the suite after the UI repair round touched production code'),
    async (ph) => {
      const result = await runTestsForBrief(run, prompt);
      ph.log({ passed: result.passed, checks: result.checks.map((c) => c.name).join('+') });
      if (!result.passed) {
        throw new Error(`the suite went red after the UI repair round:\n${result.failures.join('\n')}`);
      }
    },
  );
  return fix;
}
