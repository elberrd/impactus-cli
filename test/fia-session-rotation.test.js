import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Tracer } from '../fia-templates/modules/tracer.mjs';
import { Run } from '../fia-templates/modules/runner.mjs';
import { engineAdapters, execute } from '../fia-templates/modules/agents.mjs';
import {
  SESSION_ROTATION_DEFAULT,
  buildRotationPreamble,
  sessionRotationCapOf,
} from '../fia-templates/modules/continuation.mjs';

// Rotation runs against IN-PROCESS engine fakes swapped into the exported
// engineAdapters dispatch table — no CLI is ever spawned (same harness as
// test/fia-relay.test.js). git is only used by the permission snapshots.

function initGitRepo(root) {
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fia@test.dev'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'FIA Rotation'], { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# rotation\n');
  writeFileSync(join(root, '.gitignore'), 'imp/\npe/\n');
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root, stdio: 'ignore' });
}

function makeSetup({ codingAgent = 'claude_code', rotationCap } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fia-rotation-'));
  initGitRepo(root);
  process.chdir(root);
  const promptsDir = join(root, 'pe');
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, 'system.md'), 'You are the builder.');
  writeFileSync(join(promptsDir, 'user.md'), 'Task: {{prompt}}\nPrevious: {{previous_envelope}}');
  const cfg = {
    defaults: {
      data_dir: join(root, 'imp/data'),
      ...(rotationCap === undefined ? {} : { session_rotation_context: rotationCap }),
    },
    observability: { db: join(root, 'imp/data/fia.db') },
    agents: [
      {
        name: 'builder',
        coding_agent: codingAgent,
        model: codingAgent === 'pi' ? 'openai-codex/gpt-5.6-sol' : 'sonnet',
        writes: [],
        tools: ['read'],
        prompt_engineering: { system: join(promptsDir, 'system.md'), user: join(promptsDir, 'user.md') },
      },
    ],
  };
  const tracer = new Tracer(cfg.observability.db, join(cfg.defaults.data_dir, 'sessions', 'run1', 'events.jsonl'));
  tracer.sessionStart('run1', 'Tester', 'fda_test');
  const run = new Run(cfg, 'run1', tracer, 'Tester');
  const phaseOf = (name) => ({
    phase_id: `run1_${name}`,
    fda_id: 'run1',
    params: { name, owner: 'builder', kind: 'agent' },
  });
  const call = { prompt: 'build the thing', outputType: 'GenericOutput', gates: [] };
  return { root, cfg, run, phaseOf, call };
}

async function withAdapters(fakes, fn) {
  const saved = { ...engineAdapters };
  Object.assign(engineAdapters, fakes);
  try {
    return await fn();
  } finally {
    Object.assign(engineAdapters, saved);
  }
}

const okResult = (extra = {}) => ({
  text: JSON.stringify({ status: 'success', summary: 'done' }),
  returncode: 0,
  tokens: 100,
  cost: 0,
  input_tokens: 80,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  session_id: 'sess-1',
  context_tokens: 0,
  context_window: 0,
  ...extra,
});

const readEvents = (run) =>
  readFileSync(join(run.sessionDir, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('sessionRotationCapOf: absent/invalid values keep the default, 0 turns rotation off, overrides win', () => {
  assert.equal(SESSION_ROTATION_DEFAULT, 180000);
  assert.equal(sessionRotationCapOf(undefined), SESSION_ROTATION_DEFAULT);
  assert.equal(sessionRotationCapOf({}), SESSION_ROTATION_DEFAULT);
  assert.equal(sessionRotationCapOf({ defaults: {} }), SESSION_ROTATION_DEFAULT);
  assert.equal(sessionRotationCapOf({ defaults: { session_rotation_context: 'lots' } }), SESSION_ROTATION_DEFAULT);
  assert.equal(sessionRotationCapOf({ defaults: { session_rotation_context: -5 } }), SESSION_ROTATION_DEFAULT);
  assert.equal(sessionRotationCapOf({ defaults: { session_rotation_context: 0 } }), 0);
  assert.equal(sessionRotationCapOf({ defaults: { session_rotation_context: 250000.7 } }), 250000);
});

test('buildRotationPreamble: compact reseed with capped path list and read-only transcript rules', () => {
  const manyPaths = Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`);
  const text = buildRotationPreamble({
    contextTokens: 200000,
    cap: 180000,
    changedPaths: manyPaths,
    archivedTranscripts: ['imp/data/sessions/run1/builder/pi_session.1.rotated.jsonl'],
  });
  assert.match(text, /## Session rotation \(automatic\)/);
  assert.match(text, /200000 tokens >= 180000/);
  assert.match(text, /do NOT start from scratch/);
  assert.match(text, /- src\/file-0\.ts/);
  assert.match(text, /- src\/file-49\.ts/);
  assert.ok(!text.includes('src/file-50.ts'), 'the path list is capped at 50 entries');
  assert.match(text, /\(\+10 more/);
  assert.match(text, /pi_session\.1\.rotated\.jsonl/);
  assert.match(text, /WORKSPACE is the authority/);
  assert.match(text, /never re-read the whole file/);
  // No paths and no transcripts: the sections disappear instead of rendering empty.
  const bare = buildRotationPreamble({ contextTokens: 1, cap: 1 });
  assert.ok(!bare.includes('Files this run has already changed'));
  assert.ok(!bare.includes('Archived transcript'));
});

test('rotation: past the cap the next phase starts a fresh session with the reseed preamble', async () => {
  const { run, phaseOf, call } = makeSetup();
  const requests = [];
  await withAdapters(
    {
      claude_code: async (request) => {
        requests.push(request);
        // First phase ends with the live context already past the default cap.
        return okResult({ context_tokens: 200000, session_id: 'sess-1' });
      },
    },
    async () => {
      await execute(run, phaseOf('build'), call);
      assert.equal(run.agentMap.builder.session_id, 'sess-1');
      assert.equal(run.agentMap.builder.context_tokens, 200000);

      await execute(run, phaseOf('fix_1'), call);
    },
  );
  assert.equal(requests.length, 2);
  // First phase: no session to resume, no preamble.
  assert.equal(requests[0].sessionId, null);
  assert.ok(!requests[0].prompt.includes('## Session rotation'));
  // Second phase: rotated — fresh session, reseed preamble, byte-stable system.
  assert.equal(requests[1].sessionId, null, 'a rotated phase must not resume the giant session');
  assert.match(requests[1].prompt, /## Session rotation \(automatic\)/);
  assert.match(requests[1].prompt, /200000 tokens >= 180000/);
  assert.equal(requests[0].systemPrompt, requests[1].systemPrompt, 'rotation must never touch the system prompt');
  const rotationEvents = readEvents(run).filter((e) => e.type === 'log' && e.name === 'session_rotation');
  assert.equal(rotationEvents.length, 1);
  assert.equal(rotationEvents[0].payload.context_tokens, 200000);
  assert.equal(rotationEvents[0].payload.cap, 180000);
});

test('rotation: below the cap the session is resumed; 0 turns rotation off entirely', async () => {
  for (const { cap, context } of [
    { cap: undefined, context: 50000 },
    { cap: 0, context: 900000 },
  ]) {
    const { run, phaseOf, call } = makeSetup({ rotationCap: cap });
    const requests = [];
    await withAdapters(
      {
        claude_code: async (request) => {
          requests.push(request);
          return okResult({ context_tokens: context, session_id: 'sess-1' });
        },
      },
      async () => {
        await execute(run, phaseOf('build'), call);
        await execute(run, phaseOf('fix_1'), call);
      },
    );
    assert.equal(requests[1].sessionId, 'sess-1', `cap=${cap}: the session must be resumed`);
    assert.ok(!requests[1].prompt.includes('## Session rotation'));
  }
});

test('rotation: a Pi session file is archived aside, never deleted', async () => {
  const { run, phaseOf, call } = makeSetup({ codingAgent: 'pi' });
  const agentDir = join(run.sessionDir, 'builder');
  const sessionFile = join(agentDir, 'pi_session.jsonl');
  const requests = [];
  await withAdapters(
    {
      pi: async (request) => {
        requests.push(request);
        // The real adapter writes the session file; the fake simulates it.
        mkdirSync(agentDir, { recursive: true });
        if (!existsSync(sessionFile)) writeFileSync(sessionFile, '{"turn":1}\n');
        return okResult({ context_tokens: 500000, session_id: sessionFile });
      },
    },
    async () => {
      await execute(run, phaseOf('build'), call);
      assert.ok(existsSync(sessionFile));
      await execute(run, phaseOf('fix_1'), call);
    },
  );
  const archived = join(agentDir, 'pi_session.1.rotated.jsonl');
  assert.ok(existsSync(archived), 'the old Pi session must be archived, not deleted');
  assert.equal(readFileSync(archived, 'utf8'), '{"turn":1}\n');
  assert.match(requests[1].prompt, /pi_session\.1\.rotated\.jsonl/);
});
