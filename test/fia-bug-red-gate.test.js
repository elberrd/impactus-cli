// fda_bug's red_check is a ONE-WAY gate: the reproduction is proven RED once,
// before any fix, and once the fix is on disk the reproduction PASSES — so
// re-validating on --resume closes the run as "bug not reproduced", a dead
// end that spends a recovery for zero tokens. A real run hit it TWICE (2 of
// its 4 recoveries): once after a builder round that applied the fix and then
// reported status=fail (no build.json saved), once after a verdict
// `--redo build` (build.json deleted on purpose). Both cases share one root
// cause — the gate keyed its replay on build.json existing. These tests drive
// the real runner through the same phase sequence as fda_bug.mjs, with the
// same helpers, and pin the contract: the proof binds to the REPRODUCTION.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';
import { phaseParams } from '../fia-templates/modules/fda-cli.mjs';
import { replayableRedProof } from '../fia-templates/modules/gates.mjs';
import { savedPhaseKey } from '../fia-templates/modules/utils.mjs';

function makeRun(root, id, opts) {
  const cfg = { defaults: { data_dir: root }, observability: { db: join(root, 'fia.db') } };
  const tracer = new Tracer(cfg.observability.db, join(root, 'sessions', id, 'events.jsonl'));
  tracer.sessionStart(id, 'Tester', 'fda_bug');
  return new Run(cfg, id, tracer, 'Tester', opts);
}

function savedPhaseResult(run, name) {
  try {
    return JSON.parse(readFileSync(join(run.phaseResultsDir, `${name}.json`), 'utf8')).result ?? null;
  } catch {
    return null;
  }
}

/**
 * The fda_bug phase sequence up to `build`, byte-for-byte the same gate logic
 * as the runner script (which is a top-level script and cannot be imported).
 * `world.fixed` stands for "the fix is on disk": the focal run then PASSES.
 */
async function bugRun(root, id, world, { resume = false, buildFails = false } = {}) {
  const run = makeRun(root, id, { resume });
  const trace = [];
  const replayedBeforeRed = run.replayed;
  await run.runPhase(phaseParams('red_test', 'agent', 'builder', 'Write the failing reproduction'), async () => {
    trace.push('red_test');
    return { changed_files: ['repro.test.ts'], summary: `reproduction #${world.reproductions++}` };
  });
  const redReplayed = run.replayed > replayedBeforeRed;
  const redKey = savedPhaseKey(run, 'red_test');
  const redCheck = await run.runPhase(
    phaseParams('red_check', 'code', 'quality', 'Prove the reproduction fails'),
    async () => {
      if (!redReplayed) rmSync(join(run.phaseResultsDir, 'red_check.json'), { force: true });
      const proof = replayableRedProof({ redReplayed, proof: savedPhaseResult(run, 'red_check'), redKey });
      if (proof) {
        trace.push('red_check:replayed');
        return proof;
      }
      trace.push('red_check:validated');
      if (world.fixed) throw new Error('bug not reproduced — the reproduction test PASSED on the current code');
      return { passed: false, checks: [], red: { valid: true, classification: 'assertion' }, proof_of: redKey };
    },
  );
  const build = await run.runPhase(phaseParams('build', 'agent', 'builder', 'Fix the defect'), async () => {
    trace.push('build');
    world.fixed = true; // the builder applies the fix to the tree…
    if (buildFails) throw new Error('builder reported status=fail: implemented, but unrelated E2E failures remain');
    return { changed_files: ['src.ts'], summary: 'fixed' };
  });
  return { run, trace, redCheck, build };
}

test('a builder round that applied the fix and then failed does not dead-end the resume at red_check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-red-gate-'));
  const world = { fixed: false, reproductions: 1 };

  // Attempt 1: RED proven, then the builder applies the fix and reports fail.
  await assert.rejects(bugRun(root, 'r1', world, { buildFails: true }), /status=fail/);
  assert.equal(world.fixed, true, 'the fix is on disk although the phase failed');
  assert.equal(existsSync(join(root, 'sessions', 'r1', 'phase_results', 'build.json')), false, 'a failed phase saves nothing');
  assert.ok(existsSync(join(root, 'sessions', 'r1', 'phase_results', 'red_check.json')), 'the proof was saved');

  // Attempt 2 (bare resume, or a verdict without --redo): the reproduction is
  // replayed, so its proof is replayed too — and build executes again.
  const { trace, redCheck } = await bugRun(root, 'r1', world, { resume: true });
  assert.deepEqual(trace, ['red_check:replayed', 'build']);
  assert.equal(redCheck.red.classification, 'assertion');
});

test('a verdict `--redo build` (build.json dropped) replays the proof and re-executes only build', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-red-gate-'));
  const world = { fixed: false, reproductions: 1 };
  const first = await bugRun(root, 'r2', world);
  assert.deepEqual(first.trace, ['red_test', 'red_check:validated', 'build']);

  // Exactly what session.mjs does for a verdict naming `build`.
  rmSync(join(root, 'sessions', 'r2', 'phase_results', 'build.json'));

  const second = await bugRun(root, 'r2', world, { resume: true });
  assert.deepEqual(second.trace, ['red_check:replayed', 'build']);
  assert.equal(second.redCheck.proof_of, first.redCheck.proof_of, 'the same proof, bound to the same reproduction');
});

test('a verdict `--redo red_test` writes a NEW reproduction: it is validated, and the stale proof is gone for good', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-red-gate-'));
  const world = { fixed: false, reproductions: 1 };
  await bugRun(root, 'r3', world);
  const staleProof = join(root, 'sessions', 'r3', 'phase_results', 'red_check.json');
  assert.ok(existsSync(staleProof));

  // The verdict drops red_test; the fix is on disk, so a fresh reproduction
  // that does not fail is correctly refused — never rubber-stamped by the
  // proof of the reproduction it replaced.
  rmSync(join(root, 'sessions', 'r3', 'phase_results', 'red_test.json'));
  await assert.rejects(bugRun(root, 'r3', world, { resume: true }), /bug not reproduced/);
  assert.equal(existsSync(staleProof), false, 'the stale proof was dropped before validating');

  // A later bare resume replays that new reproduction — with NO proof to lean
  // on, it is validated again rather than waved through.
  await assert.rejects(bugRun(root, 'r3', world, { resume: true }), /bug not reproduced/);
});

test('a proof written for another reproduction is never replayed, even when red_test is reused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-red-gate-'));
  const world = { fixed: false, reproductions: 1 };
  await bugRun(root, 'r4', world);
  const results = join(root, 'sessions', 'r4', 'phase_results');
  // Simulate a proof whose binding does not match the reproduction on disk.
  const proof = JSON.parse(readFileSync(join(results, 'red_check.json'), 'utf8'));
  proof.result.proof_of = 'deadbeef';
  writeFileSync(join(results, 'red_check.json'), JSON.stringify(proof));
  rmSync(join(results, 'build.json'));

  await assert.rejects(bugRun(root, 'r4', world, { resume: true }), /bug not reproduced/);
});

test('replayableRedProof: the decision table', () => {
  const proof = { red: { valid: true, classification: 'assertion' }, proof_of: 'k1' };
  assert.equal(replayableRedProof({ redReplayed: false, proof, redKey: 'k1' }), null, 'an executed red_test is validated');
  assert.equal(replayableRedProof({ redReplayed: true, proof, redKey: 'k1' }), proof, 'replayed + matching proof');
  assert.equal(replayableRedProof({ redReplayed: true, proof, redKey: 'k2' }), null, 'replayed + proof of another reproduction');
  assert.equal(replayableRedProof({ redReplayed: true, proof: null, redKey: 'k1' }), null, 'no proof → validate');
  assert.equal(
    replayableRedProof({ redReplayed: true, proof: { red: { valid: false } }, redKey: 'k1' }),
    null,
    'a proof that never became valid is not a proof',
  );
  const legacy = { red: { valid: true, classification: 'assertion' } };
  assert.equal(
    replayableRedProof({ redReplayed: true, proof: legacy, redKey: 'k1' }),
    legacy,
    'a proof from an older runtime (no binding) is accepted on a replayed reproduction',
  );
  assert.equal(replayableRedProof(), null);
});

test('savedPhaseKey: stable across reads, changes with the file, null when absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'fia-red-gate-'));
  const run = { phaseResultsDir: join(root, 'phase_results') };
  assert.equal(savedPhaseKey(run, 'red_test'), null);
  mkdirSync(run.phaseResultsDir);
  const file = join(run.phaseResultsDir, 'red_test.json');
  writeFileSync(file, JSON.stringify({ status: 'success', result: { changed_files: ['a.test.ts'] } }));
  const a = savedPhaseKey(run, 'red_test');
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.equal(savedPhaseKey(run, 'red_test'), a);
  writeFileSync(file, JSON.stringify({ status: 'success', result: { changed_files: ['b.test.ts'] } }));
  assert.notEqual(savedPhaseKey(run, 'red_test'), a);
});
