import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SDLC_DEFAULTS, sdlcPolicyOf, briefIsSelfContained, briefWantsPlanner } from '../fia-templates/modules/sdlc-policy.mjs';
import { BUILDER_RESULT_FILES, builderDeclaredFiles } from '../fia-templates/modules/utils.mjs';

const SEQUENCER_BRIEF = [
  '# Task 07: Tags CRUD',
  'Spec: 0004 (S-1, S-2)',
  '## Overview',
  'Build the tags CRUD.',
  '## Objectives',
  '- [ ] Create tag',
  '- [ ] Delete tag',
  '## Key Files to Examine',
  '- convex/tags.ts',
].join('\n');

test('sdlcPolicyOf: an absent config or an absent sdlc block is exactly the defaults', () => {
  for (const cfg of [undefined, null, {}, { sdlc: null }, { sdlc: 'per_task' }]) {
    const policy = sdlcPolicyOf(cfg);
    assert.equal(policy.plan, SDLC_DEFAULTS.plan);
    assert.equal(policy.document, SDLC_DEFAULTS.document);
    assert.deepEqual(policy.warnings, []);
  }
  assert.equal(SDLC_DEFAULTS.plan, 'auto');
  assert.equal(SDLC_DEFAULTS.document, 'per_milestone');
});

test('sdlcPolicyOf: overrides win and are normalized case/space-insensitively', () => {
  const policy = sdlcPolicyOf({ sdlc: { plan: ' Never ', document: 'PER_TASK' } });
  assert.equal(policy.plan, 'never');
  assert.equal(policy.document, 'per_task');
  assert.deepEqual(policy.warnings, []);
});

test('sdlcPolicyOf: a bad value keeps the default and warns in English, naming key and value', () => {
  const policy = sdlcPolicyOf({ sdlc: { plan: 'sometimes', document: 42 } });
  assert.equal(policy.plan, 'auto');
  assert.equal(policy.document, 'per_milestone');
  assert.equal(policy.warnings.length, 2);
  assert.match(policy.warnings[0], /sdlc\.plan: "sometimes" is not one of auto \| always \| never/);
  assert.match(policy.warnings[1], /sdlc\.document: 42 is not one of per_milestone \| per_task/);
});

test('briefIsSelfContained: sequencer-shaped briefs pass, hand-typed requests do not', () => {
  assert.equal(briefIsSelfContained(SEQUENCER_BRIEF), true);
  assert.equal(briefIsSelfContained('add a /health endpoint returning 200'), false);
  // Sections without a checklist are not a plan the gates can audit.
  assert.equal(briefIsSelfContained('## Overview\nJust prose.'), false);
  // A checklist without sections is a todo list, not a brief.
  assert.equal(briefIsSelfContained('- [ ] do the thing'), false);
  assert.equal(briefIsSelfContained(''), false);
  assert.equal(briefIsSelfContained(null), false);
});

test('briefWantsPlanner: auto skips self-contained briefs and keeps the planner everywhere it matters', () => {
  // The measured waste: a planner re-planning a sequencer brief.
  assert.equal(briefWantsPlanner(SEQUENCER_BRIEF, 'auto'), false);
  // Unstructured requests still get a plan.
  assert.equal(briefWantsPlanner('add a /health endpoint', 'auto'), true);
  // Architecture-bearing briefs always plan, however self-contained.
  assert.equal(briefWantsPlanner(`Kind: foundation\n${SEQUENCER_BRIEF}`, 'auto'), true);
  assert.equal(briefWantsPlanner(`Kind: kit\n${SEQUENCER_BRIEF}`, 'auto'), true);
  // Explicit per-brief opt-in.
  assert.equal(briefWantsPlanner(`Planning: full\n${SEQUENCER_BRIEF}`, 'auto'), true);
  // Human overrides beat everything.
  assert.equal(briefWantsPlanner('one-liner', 'never'), false);
  assert.equal(briefWantsPlanner(SEQUENCER_BRIEF, 'always'), true);
  // The default mode is auto.
  assert.equal(briefWantsPlanner(SEQUENCER_BRIEF), false);
});

test('builderDeclaredFiles: unions every persisted builder round, honors a custom pattern, degrades to empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fia-sdlc-'));
  const phaseResultsDir = join(dir, 'phase_results');
  mkdirSync(phaseResultsDir);
  const write = (name, result) => writeFileSync(join(phaseResultsDir, `${name}.json`), JSON.stringify({ result }));
  write('build', { changed_files: ['a.ts'], artifacts: ['b.ts'] });
  write('fix_1', { changed_files: ['c.ts'] });
  write('fix_ui', { artifacts: ['d.css'] });
  write('red_test', { changed_files: ['repro.test.ts'] });
  write('review', { changed_files: ['never-a-builder-file.md'] });
  writeFileSync(join(phaseResultsDir, 'broken.json'), '{not json');
  const run = { phaseResultsDir };

  const defaults = builderDeclaredFiles(run);
  assert.deepEqual(defaults.sort(), ['a.ts', 'b.ts', 'c.ts', 'd.css']);
  assert.equal(BUILDER_RESULT_FILES.test('red_test.json'), false);

  const withRed = builderDeclaredFiles(run, /^(red_test|build|fix_\d+|fix_checklist|fix_ui)\.json$/);
  assert.ok(withRed.includes('repro.test.ts'));
  assert.ok(!withRed.includes('never-a-builder-file.md'));

  assert.deepEqual(builderDeclaredFiles({ phaseResultsDir: join(dir, 'missing') }), []);
});

// The runner's shape is asserted at the source level, the same way the /qa
// guards are pinned (test/fia-qa.test.js): the expensive phases must sit
// behind the results that justify them, or the US$13-audit-loop class of bug
// comes back silently.
const sdlcSource = readFileSync(new URL('../fia-templates/fda_sdlc.mjs', import.meta.url), 'utf8');

test('fda_sdlc source: the repair loop exists and is bounded by the shared tracker', () => {
  assert.match(sdlcSource, /createRepairTracker\(run\.stop\)/);
  assert.match(sdlcSource, /repair\.noteRound\(/);
  assert.match(sdlcSource, /i <= repair\.cap && !test\.passed && !repair\.stalled/);
  assert.match(sdlcSource, /repairExecuted: run\.replayed === replayedBefore/);
  assert.match(sdlcSource, /OUTCOMES\.NO_PROGRESS/);
  assert.match(sdlcSource, /OUTCOMES\.ATTEMPT_CAP/);
});

test('fda_sdlc source: review is gated on a green suite, with the free review_skip phase', () => {
  assert.match(sdlcSource, /review_skip/);
  const reviewCall = sdlcSource.indexOf("phaseParams('review', 'agent'");
  const greenGuard = sdlcSource.indexOf('if (test.passed) {', sdlcSource.indexOf('let review'));
  assert.ok(reviewCall > -1 && greenGuard > -1 && greenGuard < reviewCall, 'the reviewer call must sit inside the test.passed branch');
});

test('fda_sdlc source: planner and documenter are conditional on the sdlc policy', () => {
  assert.match(sdlcSource, /briefWantsPlanner\(prompt, sdlc\.plan\)/);
  assert.match(sdlcSource, /plan_skip/);
  assert.match(sdlcSource, /sdlc\.document === 'per_task'/);
  assert.match(sdlcSource, /document_skip/);
  const documentCall = sdlcSource.indexOf("phaseParams('document', 'agent'");
  const perTaskGuard = sdlcSource.indexOf("sdlc.document === 'per_task'");
  assert.ok(documentCall > -1 && perTaskGuard > -1 && perTaskGuard < documentCall, 'the documenter call must sit inside the per_task branch');
});

test('fda_sdlc source: commits collect every builder round from phase_results', () => {
  assert.match(sdlcSource, /builderDeclaredFiles\(run\)/);
});

test('the shipped config template documents the sdlc block and /goal drains milestone docs', () => {
  const template = readFileSync(new URL('../fia-templates/fia.config.yaml', import.meta.url), 'utf8');
  assert.match(template, /# sdlc — optional agent phases/);
  assert.match(template, /#\s+plan: auto/);
  assert.match(template, /#\s+document: per_milestone/);
  const goal = readFileSync(new URL('../pi-templates/.pi/prompts/goal.md', import.meta.url), 'utf8');
  assert.match(goal, /node imp\/fda_document\.mjs "Document milestone/);
  assert.match(goal, /sdlc\.document: per_milestone/);
});

test('the goal loop is milestone-scoped and token-disciplined', () => {
  const goal = readFileSync(new URL('../pi-templates/.pi/prompts/goal.md', import.meta.url), 'utf8');
  assert.match(goal, /Token discipline/);
  assert.match(goal, /Never paste briefs, reports or FDA output/);
  assert.match(goal, /END THIS LOOP at the milestone\s+boundary/);
  assert.match(goal, /run `\/goal` again in a NEW\s+session/);
  const bridge = readFileSync(new URL('../pi-templates/.pi/skills/fia/cookbooks/harness_bridge.md', import.meta.url), 'utf8');
  assert.match(bridge, /END the goal loop at this boundary/);
  assert.match(bridge, /fresh session per milestone/);
});
