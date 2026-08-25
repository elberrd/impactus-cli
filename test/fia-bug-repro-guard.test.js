// The /bug FDA's reproduction test is its whole premise, and the regression
// floor structurally cannot defend it: the floor only ratchets on a GREEN
// suite, while the reproduction exists precisely while the suite is RED. A
// repair round that deletes the repro therefore produces a green suite whose
// counts match the old floor exactly. These tests lock the code-side guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FDA_BUG = readFileSync(join(import.meta.dirname, '..', 'fia-templates', 'fda_bug.mjs'), 'utf8');

test('the test phase verifies the reproduction survived, on every green round', () => {
  // Structural assertions: the guard must sit inside runTestPhase's green
  // branch, check the files exist AND still pass, and route the failure into
  // the ordinary repair loop rather than throwing the run away.
  assert.match(FDA_BUG, /if \(result\.passed\) \{[\s\S]*?redFiles\.filter\(/, 'the check runs only on a green suite');
  assert.match(FDA_BUG, /existsSync\(resolve\(run\.repoRoot, f\)\)/, 'a deleted reproduction is detected on disk');
  assert.match(FDA_BUG, /await runFocalTests\(run, redFiles\)/, 'the surviving reproduction must still PASS');
  assert.match(FDA_BUG, /name: 'repro'/, 'the violation is a synthetic check, so the repair loop can act on it');
  assert.match(FDA_BUG, /failures: \[\.\.\.result\.failures, `repro: \$\{why\}`\]/, 'the reason reaches the builder');
});

test('the guard is not a prompt promise — the prose instruction alone is not the mechanism', () => {
  // The prompt still asks nicely, but the refusal is code. If this ever
  // becomes the ONLY protection again, this test fails.
  assert.match(FDA_BUG, /Do NOT weaken, skip or delete the reproduction test/, 'the prompt still says it');
  const guardIndex = FDA_BUG.indexOf("name: 'repro'");
  assert.ok(guardIndex > 0, 'and code enforces it');
});

test('the reproduction check cannot run on a red suite (no double-charging the focal run)', () => {
  const phase = FDA_BUG.slice(FDA_BUG.indexOf('const runTestPhase'), FDA_BUG.indexOf('// Every fix is followed'));
  const green = phase.indexOf('if (result.passed) {');
  const focal = phase.indexOf('runFocalTests(run, redFiles)');
  assert.ok(green > -1 && focal > green, 'the focal re-run happens inside the green branch only');
});

test('the RED gate replays its proof by reproduction identity — never by whether build.json exists', () => {
  // A saved `build` result is the wrong key: a builder round that reports
  // status=fail after applying the fix saves nothing, and a verdict
  // `--redo build` deletes it on purpose. Both used to dead-end the resume
  // as "bug not reproduced" (a real run spent 2 of its 4 recoveries on it).
  assert.doesNotMatch(FDA_BUG, /phaseAlreadyRan\(run, 'build'\)/, 'build.json must not gate the replay');
  assert.match(FDA_BUG, /const redReplayed = run\.replayed > replayedBeforeRed;/, 'the key is whether red_test was replayed');
  assert.match(FDA_BUG, /replayableRedProof\(\{ redReplayed, proof: savedPhaseResult\(run, 'red_check'\), redKey \}\)/);
  assert.match(FDA_BUG, /return \{ \.\.\.result, red: reason, proof_of: redKey \};/, 'the proof is bound to the reproduction');
  assert.match(
    FDA_BUG,
    /if \(!redReplayed\) rmSync\(join\(run\.phaseResultsDir, 'red_check\.json'\), \{ force: true \}\);/,
    'a fresh reproduction drops the stale proof before validating',
  );
});

test('the commit names what the run changed but did not commit, like the other tested FDAs', () => {
  assert.match(FDA_BUG, /changed_by_run_but_uncommitted/);
});
