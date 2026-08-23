import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FAILURE_STAMP_FILE,
  clearAttempt,
  clearFailureStamp,
  readAttempt,
  readFailureStamp,
  recordAttemptFailure,
  repoStamp,
  unchangedSinceFailure,
  writeFailureStamp,
} from '../fia-templates/modules/tree-guard.mjs';
import { readE2eAttempt, recordE2eFailure, clearE2eAttempt, repoStamp as reExported } from '../fia-templates/modules/qa-playwright.mjs';
import { RECOVERY_CAP, appendResumeHistory, readResumeHistory, recoveryLedger, writeRunVerdict } from '../fia-templates/modules/continuation.mjs';
import { OUTCOMES } from '../fia-templates/modules/outcome.mjs';
import { ensure } from '../fia-templates/modules/session.mjs';

function initGitRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fia@test.dev'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'FIA TreeGuard'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# guard\n');
  writeFileSync(join(root, '.gitignore'), 'imp/\n');
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

test('generic attempt markers: count rides the stamp, a new stamp resets, clear removes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tree-guard-'));
  assert.equal(readAttempt(dir, 'audit'), null);
  assert.equal(recordAttemptFailure(dir, 'audit', null), null, 'no fingerprint records nothing');
  recordAttemptFailure(dir, 'audit', 'aaa');
  recordAttemptFailure(dir, 'audit', 'aaa');
  assert.equal(readAttempt(dir, 'audit').count, 2);
  recordAttemptFailure(dir, 'audit', 'bbb');
  assert.equal(readAttempt(dir, 'audit').count, 1, 'a new stamp restarts the count');
  // Independent names never collide.
  recordAttemptFailure(dir, 'ui-verify', 'ccc');
  assert.equal(readAttempt(dir, 'audit').stamp, 'bbb');
  clearAttempt(dir, 'audit');
  assert.equal(readAttempt(dir, 'audit'), null);
  assert.equal(readAttempt(dir, 'ui-verify').stamp, 'ccc');
});

test('unchangedSinceFailure: fires only on an identical stamp with no override', () => {
  const prior = { stamp: 'aaa', count: 1 };
  assert.equal(unchangedSinceFailure({ prior, stamp: 'aaa' }), true);
  assert.equal(unchangedSinceFailure({ prior, stamp: 'aaa', override: true }), false);
  assert.equal(unchangedSinceFailure({ prior, stamp: 'bbb' }), false);
  assert.equal(unchangedSinceFailure({ prior: null, stamp: 'aaa' }), false);
  assert.equal(unchangedSinceFailure({ prior, stamp: null }), false, 'no git = fail open');
});

test('qa-playwright keeps its e2e wrapper surface (marker file name included)', () => {
  assert.equal(reExported, repoStamp, 'repoStamp is re-exported, one implementation');
  const dir = mkdtempSync(join(tmpdir(), 'tree-guard-e2e-'));
  recordE2eFailure(dir, 'aaa');
  assert.ok(existsSync(join(dir, 'e2e-attempts.json')), 'the historical marker name survives the extraction');
  assert.equal(readE2eAttempt(dir).stamp, 'aaa');
  clearE2eAttempt(dir);
  assert.equal(readE2eAttempt(dir), null);
});

test('repoStamp: stable under noise paths, moved by a real edit, null without git', () => {
  const root = mkdtempSync(join(tmpdir(), 'tree-guard-repo-'));
  initGitRepo(root);
  const before = repoStamp(root);
  assert.ok(before, 'a git repo yields a stamp');
  mkdirSync(join(root, 'imp', 'data'), { recursive: true });
  writeFileSync(join(root, 'imp', 'data', 'junk.json'), '{}');
  writeFileSync(join(root, '.DS_Store'), 'x');
  assert.equal(repoStamp(root), before, 'run side effects never move the stamp');
  writeFileSync(join(root, 'README.md'), '# guard — edited\n');
  assert.notEqual(repoStamp(root), before, 'a real edit moves the stamp');
  assert.equal(repoStamp(mkdtempSync(join(tmpdir(), 'no-git-'))), null);
});

test('failure stamp: written on failure outcomes, cleared on success, absent for deliberate pauses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tree-guard-stamp-'));
  writeFailureStamp(dir, { stamp: 'aaa', outcome: 'failed' });
  assert.equal(readFailureStamp(dir).stamp, 'aaa');
  writeFailureStamp(dir, { stamp: null, outcome: 'failed' });
  assert.equal(readFailureStamp(dir).stamp, 'aaa', 'no fingerprint never overwrites a real one');
  clearFailureStamp(dir);
  assert.equal(readFailureStamp(dir), null);
  // The runner writes/clears it inside settle() — pinned at the source level
  // (the Run/Tracer integration is exercised by the ensure() tests below).
  const runner = readFileSync(new URL('../fia-templates/modules/runner.mjs', import.meta.url), 'utf8');
  assert.match(runner, /if \(accepted\) clearFailureStamp\(this\.sessionDir\);/);
  assert.match(runner, /writeFailureStamp\(this\.sessionDir, \{ stamp: repoStamp\(this\.repoRoot\), outcome \}\)/);
  assert.match(runner, /OUTCOMES\.STOPPED_BY_REQUEST, OUTCOMES\.ABORTED, OUTCOMES\.BUDGET_EXHAUSTED/);
});

// ── the bare-resume guard, end to end through ensure() ──────────────────────

function guardSetup() {
  const root = mkdtempSync(join(tmpdir(), 'tree-guard-ensure-'));
  initGitRepo(root);
  process.chdir(root);
  const cfg = {
    defaults: { data_dir: join(root, 'imp/data') },
    observability: { db: join(root, 'imp/data/fia.db') },
    agents: [],
  };
  return { root, cfg };
}

test('ensure: a bare resume over an identical tree is refused; a changed tree proceeds and is counted', () => {
  const { root, cfg } = guardSetup();
  const run = ensure(cfg);
  run.settle(OUTCOMES.FAILED, 'boom');
  const sessionDir = run.sessionDir;
  assert.ok(readFailureStamp(sessionDir), 'settle stamped the failed tree');

  assert.throws(
    () => ensure(cfg, run.fdaId, { resume: true }),
    /nothing changed in the repository since run .* failed/,
    'identical tree = refusal with instructions',
  );
  assert.throws(() => ensure(cfg, run.fdaId, { resume: true }), /verdict\.mjs set/, 'the refusal names the bounded path');

  // The override proceeds — and is recorded as such.
  const overridden = ensure(cfg, run.fdaId, { resume: true, retryUnchanged: true });
  overridden.settle(OUTCOMES.FAILED, 'boom again');
  let history = readResumeHistory(sessionDir);
  assert.equal(history.length, 1);
  assert.equal(history[0].overridden, true);

  // A real edit unlocks the resume; the bare resume still spends budget.
  writeFileSync(join(root, 'README.md'), '# guard — fixed by hand\n');
  const resumed = ensure(cfg, run.fdaId, { resume: true });
  resumed.settle(OUTCOMES.FAILED, 'still failing');
  history = readResumeHistory(sessionDir);
  assert.equal(history.length, 2);
  assert.equal(history[1].unchanged, false);
});

test('ensure: a pending verdict exempts the unchanged-tree refusal (bounded continuation)', () => {
  const { cfg } = guardSetup();
  const run = ensure(cfg);
  run.settle(OUTCOMES.FAILED, 'boom');
  writeRunVerdict(run.sessionDir, { fda_id: run.fdaId, missing: ['the empty state'], redo: [] });
  const resumed = ensure(cfg, run.fdaId, { resume: true });
  assert.ok(resumed, 'verdict-driven resume proceeds on an identical tree');
  assert.deepEqual(readResumeHistory(run.sessionDir), [], 'a bounded resume is not a bare one');
});

test('ensure: the combined recovery budget refuses further bare resumes with the follow-up-task instruction', () => {
  const { root, cfg } = guardSetup();
  const run = ensure(cfg);
  run.settle(OUTCOMES.FAILED, 'boom');
  for (let i = 0; i < RECOVERY_CAP; i++) appendResumeHistory(run.sessionDir, { at: 'x', bare: true });
  assert.equal(recoveryLedger(run.sessionDir).total, RECOVERY_CAP);
  writeFileSync(join(root, 'README.md'), '# changed — but the budget is spent\n');
  assert.throws(
    () => ensure(cfg, run.fdaId, { resume: true }),
    /combined recovery budget[\s\S]*follow-up task/i,
    'past the cap even a changed tree hands the decision to a human',
  );
});

// ── the two replay:false phases carry the guard ──────────────────────────────

test('fda_qa source: the audit refuses a tree it already rejected, records on rejection, clears on approval', () => {
  const source = readFileSync(new URL('../fia-templates/fda_qa.mjs', import.meta.url), 'utf8');
  assert.match(source, /readAttempt\(artifactAbsDir, 'audit'\)/);
  assert.match(source, /unchangedSinceFailure\(\{ prior, stamp: auditStamp, override: cli\.retryUnchanged \|\| run\.retryUnchanged \}\)/);
  assert.match(source, /if \(verdict\.approved\) clearAttempt\(artifactAbsDir, 'audit'\);/);
  assert.match(source, /else recordAttemptFailure\(artifactAbsDir, 'audit', auditStamp\);/);
  assert.ok(source.indexOf("readAttempt(artifactAbsDir, 'audit')") > source.indexOf('if (e2e.passed)'), 'the guard lives inside the green-e2e branch');
});

test('ui-gate source: ui_verify refuses a tree it already rejected', () => {
  const source = readFileSync(new URL('../fia-templates/modules/ui-gate.mjs', import.meta.url), 'utf8');
  assert.match(source, /readAttempt\(run\.sessionDir, 'ui-verify'\)/);
  assert.match(source, /unchangedSinceFailure\(\{ prior, stamp, override: run\.retryUnchanged \}\)/);
  assert.match(source, /if \(verdict\.approved\) clearAttempt\(run\.sessionDir, 'ui-verify'\);/);
});

test('the orchestrator prompts align with the runtime guard', () => {
  const goal = readFileSync(new URL('../pi-templates/.pi/prompts/goal.md', import.meta.url), 'utf8');
  assert.match(goal, /runner now REFUSES a bare resume/);
  assert.match(goal, /--retry-unchanged/);
  assert.match(goal, /FOLLOW-UP brief via the task-sequencer/);
  const bridge = readFileSync(new URL('../pi-templates/.pi/skills/fia/cookbooks/harness_bridge.md', import.meta.url), 'utf8');
  assert.match(bridge, /counts every bare resume/);
  assert.match(bridge, /FOLLOW-UP brief via the task-sequencer/);
  const verdict = readFileSync(new URL('../fia-templates/scripts/verdict.mjs', import.meta.url), 'utf8');
  assert.match(verdict, /convert the remaining gaps into a FOLLOW-UP task brief/);
  assert.ok(existsSync(new URL(`../fia-templates/modules/tree-guard.mjs`, import.meta.url)));
  assert.equal(FAILURE_STAMP_FILE, 'last_failure_stamp.json');
});
