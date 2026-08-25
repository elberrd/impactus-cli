// The commit phases collect the run's files from persisted builder envelopes —
// and the runner persists a phase result on SUCCESS only. A builder that
// applied its work and then reported status=fail (a real run: "implemented
// all planned repairs, but 5 unrelated E2E failures remain") left 10 files in
// the tree that no later round declared, so the run that finally went green
// committed its own 9 files and left the other 10 as permanent dirt — which
// the orchestrator then tried to "reconcile" with a verdict, spending its last
// recovery. The session ledger keeps EVERY round's declaration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DECLARED_FILES_FILE,
  builderDeclaredFiles,
  readDeclaredFiles,
  recordDeclaredFiles,
} from '../fia-templates/modules/utils.mjs';

function session() {
  const sessionDir = mkdtempSync(join(tmpdir(), 'fia-declared-'));
  const phaseResultsDir = join(sessionDir, 'phase_results');
  mkdirSync(phaseResultsDir);
  return { sessionDir, phaseResultsDir };
}

test('recordDeclaredFiles appends one entry per envelope, normalized, and readDeclaredFiles reads them back', () => {
  const run = session();
  assert.deepEqual(readDeclaredFiles(run.sessionDir), [], 'no ledger yet reads as empty');

  const first = recordDeclaredFiles(run, {
    phase: 'build',
    phase_id: 'r1_07_build',
    agent: 'builder',
    status: 'fail',
    changed_files: ['a.ts', 'a.ts', '', 42, 'b.ts'],
    artifacts: null,
  });
  assert.deepEqual(first.changed_files, ['a.ts', 'b.ts']);
  assert.deepEqual(first.artifacts, []);
  assert.equal(first.status, 'fail');
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);

  recordDeclaredFiles(run, { phase: 'build', phase_id: 'r1_11_build', agent: 'builder', status: 'success', changed_files: ['c.ts'] });
  const entries = readDeclaredFiles(run.sessionDir);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.phase_id), ['r1_07_build', 'r1_11_build']);
  assert.ok(readFileSync(join(run.sessionDir, DECLARED_FILES_FILE), 'utf8').includes('"r1_07_build"'));
});

test('recordDeclaredFiles is a no-op without a phase name or a session dir, and never throws', () => {
  const run = session();
  assert.equal(recordDeclaredFiles(run, { phase: '', changed_files: ['x.ts'] }), null);
  assert.equal(recordDeclaredFiles({}, { phase: 'build', changed_files: ['x.ts'] }), null);
  assert.deepEqual(readDeclaredFiles(run.sessionDir), []);
  // A corrupt ledger reads as empty and is replaced, not crashed on.
  writeFileSync(join(run.sessionDir, DECLARED_FILES_FILE), '{not json');
  assert.deepEqual(readDeclaredFiles(run.sessionDir), []);
  assert.ok(recordDeclaredFiles(run, { phase: 'build', changed_files: ['y.ts'] }));
  assert.equal(readDeclaredFiles(run.sessionDir).length, 1);
});

test('builderDeclaredFiles unions the ledger with phase_results: a failed round’s files reach the commit', () => {
  const run = session();
  const write = (name, result) => writeFileSync(join(run.phaseResultsDir, `${name}.json`), JSON.stringify({ result }));
  // The round that finally succeeded declares only what IT touched…
  write('build', { changed_files: ['lib/qa/server.test.ts', 'scripts/server.mjs'] });
  // …while the earlier, failed round's declaration lives only in the ledger.
  recordDeclaredFiles(run, {
    phase: 'build',
    phase_id: 'r1_07_build',
    agent: 'builder',
    status: 'fail',
    changed_files: ['.gitignore', 'e2e/task-06.spec.ts', 'scripts/server.mjs'],
    artifacts: ['ai-docs/milestones.md'],
  });
  // Non-builder phases never feed the commit, whatever they declared.
  recordDeclaredFiles(run, { phase: 'review', agent: 'reviewer', status: 'success', changed_files: ['never.md'] });
  recordDeclaredFiles(run, { phase: 'red_test', agent: 'builder', status: 'success', changed_files: ['repro.test.ts'] });

  const files = builderDeclaredFiles(run);
  for (const f of ['lib/qa/server.test.ts', 'scripts/server.mjs', '.gitignore', 'e2e/task-06.spec.ts', 'ai-docs/milestones.md']) {
    assert.ok(files.includes(f), `${f} must be committed`);
  }
  assert.ok(!files.includes('never.md'), 'reviewer declarations stay out');
  assert.ok(!files.includes('repro.test.ts'), 'red_test is outside the default pattern');

  // A custom pattern (fda_bug) applies to the ledger the same way it applies to phase_results.
  const withRed = builderDeclaredFiles(run, /^(red_test|build|fix_\d+|fix_checklist|fix_ui)\.json$/);
  assert.ok(withRed.includes('repro.test.ts'));
  assert.ok(!withRed.includes('never.md'));

  // A run object that only knows phase_results (older callers, tests) still finds the ledger next to it.
  assert.ok(builderDeclaredFiles({ phaseResultsDir: run.phaseResultsDir }).includes('.gitignore'));
});

// Source pin: the ledger is written by the ONE place every envelope passes
// through, on both exits that used to lose the declaration.
const agentsSource = readFileSync(new URL('../fia-templates/modules/agents.mjs', import.meta.url), 'utf8');

test('agents.execute records the declaration before the status=fail throw and before a gate failure', () => {
  assert.match(agentsSource, /import \{ recordDeclaredFiles \} from '\.\/utils\.mjs'/);
  const record = agentsSource.indexOf('noteDeclaration(envelope);');
  const gateThrow = agentsSource.indexOf('throw new GateFailure(');
  const statusThrow = agentsSource.indexOf("if (envelope.status !== 'success')");
  assert.ok(record > -1 && gateThrow > -1 && statusThrow > -1);
  assert.ok(record < gateThrow, 'a gate failure keeps the declaration');
  const afterEnforce = agentsSource.indexOf('noteDeclaration(envelope);', agentsSource.indexOf('permissions.enforce(run, phase, agent, treeBefore);'));
  assert.ok(afterEnforce > -1 && afterEnforce < statusThrow, 'a status=fail round keeps the declaration');
});
