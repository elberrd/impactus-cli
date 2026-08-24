// Grok Build as a FIA engine (fia-templates/modules/engines.mjs +
// agent-grok.mjs): subscription detection from ~/.grok/auth.json, folder
// trust parsing (grok skips project hooks in silence without it), the models
// cache, the headless argv contract verified against grok 1.0.5, and the
// stream parser fed by a fake `grok` binary — no real CLI is ever spawned.
//
// HOME is pointed at a temp dir BEFORE the dynamic import (the module resolves
// ~/.grok paths once at load time), same pattern as fia-engines.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fakeHome = mkdtempSync(join(tmpdir(), 'fia-grok-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const grokDir = join(fakeHome, '.grok');
mkdirSync(join(grokDir, 'bin'), { recursive: true });
mkdirSync(join(fakeHome, '.pi', 'agent'), { recursive: true });

const engines = await import('../fia-templates/modules/engines.mjs');
const { buildGrokArgs, grokEffortOf, grokEnv, runGrok } = await import('../fia-templates/modules/agent-grok.mjs');
const { validate } = await import('../fia-templates/modules/agents.mjs');
const { classifyEngineFailure } = await import('../fia-templates/modules/continuation.mjs');

const {
  ENGINE_NAMES,
  GROK_EFFORTS,
  engineIssue,
  ensureGrokTrust,
  grokBinary,
  grokFolderTrusted,
  grokLoggedIn,
  grokModels,
  isGrokModelId,
  readGrokAuth,
  checkEngines,
  apiKeyProvider,
} = engines;

// The real auth.json shape (grok 1.0.5): one entry per OIDC issuer::client id.
const AUTH_ENTRY = {
  'https://auth.x.ai::client-id': {
    key: 'eyJ…bearer',
    auth_mode: 'oidc',
    refresh_token: 'rjKo…',
    expires_at: '2026-08-23T00:00:00Z', // already expired — the CLI refreshes it
    email: 'someone@example.com',
  },
};

test('grok is a registered engine with a shorter effort ladder than claude', () => {
  assert.ok(ENGINE_NAMES.includes('grok'));
  assert.deepEqual(GROK_EFFORTS, ['low', 'medium', 'high', 'xhigh']);
  assert.ok(!GROK_EFFORTS.includes('max'), 'grok has no max');
});

test('grokLoggedIn: any OIDC entry with a refresh token or key counts, expiry does not log out', () => {
  assert.equal(grokLoggedIn(AUTH_ENTRY), true);
  assert.equal(grokLoggedIn({ 'x::y': { key: 'k' } }), true);
  assert.equal(grokLoggedIn({ 'x::y': { auth_mode: 'oidc' } }), false, 'entry without any token');
  assert.equal(grokLoggedIn({}), false);
  assert.equal(grokLoggedIn(null), false);
  assert.equal(grokLoggedIn('nope'), false);
});

test('readGrokAuth: missing and corrupt auth.json both yield null', () => {
  assert.equal(readGrokAuth(join(fakeHome, 'absent.json')), null);
  const corrupt = join(fakeHome, 'corrupt.json');
  writeFileSync(corrupt, '{not json');
  assert.equal(readGrokAuth(corrupt), null);
});

test('isGrokModelId: bare grok-<version> ids only', () => {
  assert.equal(isGrokModelId('grok-4.6'), true);
  assert.equal(isGrokModelId('grok-4.5'), true);
  assert.equal(isGrokModelId('xai/grok-4.5'), false, 'that is the Pi (API key) route');
  assert.equal(isGrokModelId('grok'), false);
  assert.equal(isGrokModelId('opus'), false);
});

test('grokFolderTrusted: parses the TOML store, cascades to subdirectories, case-safe on the header', () => {
  const store = join(fakeHome, 'trusted_folders.toml');
  const trustedRoot = mkdtempSync(join(tmpdir(), 'fia-grok-trusted-'));
  const untrusted = mkdtempSync(join(tmpdir(), 'fia-grok-untrusted-'));
  const escaped = trustedRoot.replace(/\\/g, '\\\\');
  writeFileSync(
    store,
    `[folders."${escaped}"]\ntrusted = true\ndecided_at = 1787536860\n\n[folders."${untrusted.replace(/\\/g, '\\\\')}"]\ntrusted = false\ndecided_at = 1\n\n[other]\ntrusted = true\n`,
  );
  assert.equal(grokFolderTrusted(trustedRoot, store), true);
  assert.equal(grokFolderTrusted(join(trustedRoot, 'apps', 'web'), store), true, 'trust cascades down');
  assert.equal(grokFolderTrusted(untrusted, store), false, 'trusted = false is not trust');
  assert.equal(grokFolderTrusted(tmpdir(), store), false, 'a parent of a trusted folder is not trusted');
  assert.equal(grokFolderTrusted(trustedRoot, join(fakeHome, 'no-such.toml')), false, 'no store → untrusted');
});

test('grokModels: reads ids + advertised efforts from the cache, ships a default list without it', () => {
  const cache = join(fakeHome, 'models_cache.json');
  writeFileSync(
    cache,
    JSON.stringify({
      models: {
        'grok-4.6': {
          info: {
            id: 'grok-4.6',
            name: 'Grok 4.6',
            context_window: 500000,
            reasoning_effort: 'high',
            reasoning_efforts: [{ id: 'xhigh' }, { id: 'high' }, { id: 'medium' }, { id: 'low' }],
          },
        },
        'grok-4.5': { info: { id: 'grok-4.5', reasoning_efforts: [{ value: 'high' }, { value: 'medium' }, { value: 'low' }] } },
        hidden: { info: { id: 'grok-secret', hidden: true } },
      },
    }),
  );
  const models = grokModels(cache);
  assert.deepEqual(
    models.map((m) => [m.id, m.efforts.join('/'), m.context_window]),
    [
      ['grok-4.6', 'xhigh/high/medium/low', 500000],
      ['grok-4.5', 'high/medium/low', 0],
    ],
  );
  const shipped = grokModels(join(fakeHome, 'absent-cache.json'));
  assert.deepEqual(
    shipped.map((m) => m.id),
    ['grok-4.6', 'grok-4.5'],
  );
  assert.deepEqual(shipped[0].efforts, GROK_EFFORTS);
});

test('engineIssue: grok needs the binary AND the subscription login; never an API key', () => {
  const offline = { grok: { installed: false, logged: false } };
  const noLogin = { grok: { installed: true, logged: false } };
  const ready = { grok: { installed: true, logged: true } };
  const agent = { coding_agent: 'grok', model: 'grok-4.6' };
  assert.match(engineIssue(agent, offline), /grok CLI .*not found/);
  assert.match(engineIssue(agent, offline), /grok\.com\/install\.sh/, 'the exact install command');
  assert.match(engineIssue(agent, noLogin), /grok login/);
  assert.match(engineIssue(agent, noLogin), /never set XAI_API_KEY/, 'the billing trap is named');
  assert.equal(engineIssue(agent, ready), null);
  // Subscription engine → never flagged as per-token billing.
  assert.equal(apiKeyProvider(agent), null);
});

test('grokBinary + checkEngines: ~/.grok/bin/grok counts even off PATH; login from auth.json', () => {
  const savedPath = process.env.PATH;
  const savedGrokPath = process.env.GROK_PATH;
  delete process.env.GROK_PATH;
  try {
    process.env.PATH = mkdtempSync(join(tmpdir(), 'fia-grok-emptypath-'));
    assert.equal(grokBinary(), null, 'nothing installed yet');
    let snap = checkEngines();
    assert.deepEqual(snap.grok, { installed: false, logged: false, trusted: false, api_key_env: false });

    const local = join(grokDir, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
    writeFileSync(local, '#!/bin/sh\n');
    assert.equal(grokBinary(), local, "the installer's own bin dir is found");
    snap = checkEngines();
    assert.equal(snap.grok.installed, true);
    assert.equal(snap.grok.logged, false, 'no auth.json yet');
    assert.match(engineIssue({ coding_agent: 'grok', model: 'grok-4.6' }, snap), /grok login/);

    writeFileSync(join(grokDir, 'auth.json'), JSON.stringify(AUTH_ENTRY));
    snap = checkEngines();
    assert.equal(snap.grok.logged, true, 'the subscription login is recognized automatically');
    assert.equal(engineIssue({ coding_agent: 'grok', model: 'grok-4.6' }, snap), null);

    process.env.GROK_PATH = '/custom/grok';
    assert.equal(grokBinary(), '/custom/grok', 'GROK_PATH wins');
  } finally {
    process.env.PATH = savedPath;
    if (savedGrokPath === undefined) delete process.env.GROK_PATH;
    else process.env.GROK_PATH = savedGrokPath;
  }
});

test('ensureGrokTrust: already-trusted is a no-op; no binary is a clear error, never a throw', () => {
  const store = join(grokDir, 'trusted_folders.toml');
  const root = mkdtempSync(join(tmpdir(), 'fia-grok-root-'));
  writeFileSync(store, `[folders."${root.replace(/\\/g, '\\\\')}"]\ntrusted = true\n`);
  assert.deepEqual(ensureGrokTrust(root), { trusted: true, granted: false });
  const other = mkdtempSync(join(tmpdir(), 'fia-grok-root2-'));
  const r = ensureGrokTrust(other, { bin: null });
  assert.equal(r.trusted, false);
  assert.match(r.error, /not found/);
});

test('validate: grok is an accepted coding_agent for agents and fallbacks', () => {
  const SYSTEM = new URL('../fia-templates/data/prompt_engineering/scout/system.md', import.meta.url).pathname;
  const USER = new URL('../fia-templates/data/prompt_engineering/scout/user.md', import.meta.url).pathname;
  const cfg = {
    agents: [
      {
        name: 'scout',
        coding_agent: 'grok',
        model: 'grok-4.6',
        effort: 'high',
        fallbacks: [{ coding_agent: 'grok', model: 'grok-4.5' }],
        prompt_engineering: { system: SYSTEM, user: USER },
      },
    ],
  };
  assert.doesNotThrow(() => validate(cfg, ['scout']));
  cfg.agents[0].coding_agent = 'xai';
  assert.throws(() => validate(cfg, ['scout']), /coding_agent xai not supported \(claude_code\|pi\|cursor\|grok\)/);
});

// ── agent-grok: argv contract ────────────────────────────────────────────────

test('buildGrokArgs: prompt in -p, stream-json dialect, rules APPEND the role, resume by session id', () => {
  const args = buildGrokArgs({ prompt: 'do X', model: 'grok-4.6', effort: 'high', systemPrompt: '# Scout' });
  assert.equal(args[0], '-p');
  assert.equal(args[1], 'do X', 'the prompt is the value of -p, never a positional');
  assert.equal(args[args.indexOf('--output-format') + 1], 'streaming-messages-json');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(args[args.indexOf('--model') + 1], 'grok-4.6');
  assert.equal(args[args.indexOf('--reasoning-effort') + 1], 'high');
  assert.equal(args[args.indexOf('--rules') + 1], '# Scout', 'append, never --system-prompt-override');
  assert.ok(!args.includes('--system-prompt-override'));
  assert.ok(!args.includes('--resume'));

  const resumed = buildGrokArgs({ prompt: 'fix', model: 'grok-4.6', systemPrompt: '# Scout', sessionId: 'sess-1' });
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'sess-1');
  assert.equal(resumed[resumed.indexOf('--rules') + 1], '# Scout', 'the role rides EVERY invocation (stable prefix)');
});

test('grokEffortOf: grok ladder passes, claude/pi-only tiers clamp, per-model ladders clamp further', () => {
  assert.equal(grokEffortOf('high'), 'high');
  assert.equal(grokEffortOf('max'), 'xhigh');
  assert.equal(grokEffortOf('ultracode'), 'xhigh');
  assert.equal(grokEffortOf('minimal'), 'low');
  assert.equal(grokEffortOf(''), null);
  assert.equal(grokEffortOf('bogus'), null);
  const models = [
    { id: 'grok-4.6', efforts: ['xhigh', 'high', 'medium', 'low'] },
    { id: 'grok-4.5', efforts: ['high', 'medium', 'low'] },
  ];
  assert.equal(grokEffortOf('xhigh', 'grok-4.6', models), 'xhigh');
  assert.equal(grokEffortOf('xhigh', 'grok-4.5', models), 'high', 'grok-4.5 advertises no xhigh');
  assert.equal(grokEffortOf('max', 'grok-4.5', models), 'high');
  assert.equal(grokEffortOf('high', 'grok-9.9', models), 'high', 'unknown model → no per-model clamp');
  // Thinking (pi field) is accepted as the level source too.
  assert.equal(buildGrokArgs({ prompt: 'x', thinking: 'medium' }).at(-1), 'medium');
});

test('grokEnv: XAI_API_KEY never reaches the child (subscription only)', () => {
  const env = grokEnv({ PATH: '/bin', XAI_API_KEY: 'sk-xai' }, { FIA_FDA_RUN: 'abc' });
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.FIA_FDA_RUN, 'abc');
});

test('classifyEngineFailure: grok\'s "You are not authenticated" is a login death', () => {
  assert.equal(classifyEngineFailure('Error: You are not authenticated. Run `grok login`.'), 'login');
  assert.equal(classifyEngineFailure('error: unknown model id "grok-9"'), 'crash');
});

// ── agent-grok: stream parsing through a fake binary ────────────────────────

/** A fake `grok` that prints `lines` to stdout (and `stderr`), exits `code`. */
function fakeGrok(lines, { code = 0, stderr = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fia-grok-fakebin-'));
  const script = join(dir, 'grok.mjs');
  writeFileSync(
    script,
    `const out = ${JSON.stringify(lines)};\nfor (const l of out) process.stdout.write(l + '\\n');\n` +
      `if (${JSON.stringify(stderr)}) process.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${code});\n`,
  );
  const bin = join(dir, 'grok');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

const STREAM = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-42', apiKeySource: 'oauth', model: 'grok-4.6' }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'sess-42',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { target_file: 'hello.txt' } }],
      usage: { input_tokens: 21000, output_tokens: 40, cache_read_input_tokens: 128, cache_creation_input_tokens: 0 },
    },
  }),
  JSON.stringify({
    type: 'user',
    session_id: 'sess-42',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'hello' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    session_id: 'sess-42',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '{"status":"success","summary":"ok"}' }],
      usage: { input_tokens: 82, output_tokens: 24, cache_read_input_tokens: 21248, cache_creation_input_tokens: 0 },
    },
  }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: '{"status":"success","summary":"ok"}',
    total_cost_usd: 0.0091,
    usage: { input_tokens: 21082, output_tokens: 64, cache_read_input_tokens: 21376, cache_creation_input_tokens: 0 },
    session_id: 'sess-42',
  }),
];

test('runGrok: parses the stream-json dialect — text, session id, totals, live context, tool events', { skip: process.platform === 'win32' }, async () => {
  const { bin } = fakeGrok(STREAM);
  const saved = process.env.GROK_PATH;
  process.env.GROK_PATH = bin;
  const rawOutputPath = join(mkdtempSync(join(tmpdir(), 'fia-grok-raw-')), 'raw_output.jsonl');
  const events = [];
  try {
    const r = await runGrok(
      { prompt: 'x', model: 'grok-4.6', effort: 'low', rawOutputPath, cwd: tmpdir(), env: {} },
      { onEvent: (e) => events.push(e.type) },
    );
    assert.equal(r.returncode, 0);
    assert.equal(r.text, '{"status":"success","summary":"ok"}', 'the result event is the canonical text');
    assert.equal(r.session_id, 'sess-42');
    assert.equal(r.tokens, 21082 + 64 + 21376, 'the result usage replaces the per-message sum');
    assert.equal(r.cache_read_tokens, 21376);
    assert.equal(r.cost, 0.0091);
    assert.equal(r.context_tokens, 82 + 21248, 'live context = the LAST model call, not the sum');
    assert.deepEqual(events, ['system', 'assistant', 'user', 'assistant', 'result'], 'every event reaches the recorder');
  } finally {
    if (saved === undefined) delete process.env.GROK_PATH;
    else process.env.GROK_PATH = saved;
  }
});

test('runGrok: a whole-stdout JSON object (--output-format json shape) still yields text + usage', { skip: process.platform === 'win32' }, async () => {
  const pretty = JSON.stringify(
    {
      text: '{"status":"success"}',
      stopReason: 'end_turn',
      sessionId: 'sess-7',
      usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 0, output_tokens: 10, total_tokens: 160 },
      total_cost_usd: 0.002,
    },
    null,
    2,
  ).split('\n');
  const { bin } = fakeGrok(pretty);
  const saved = process.env.GROK_PATH;
  process.env.GROK_PATH = bin;
  const rawOutputPath = join(mkdtempSync(join(tmpdir(), 'fia-grok-raw2-')), 'raw_output.jsonl');
  try {
    const r = await runGrok({ prompt: 'x', model: 'grok-4.6', rawOutputPath, cwd: tmpdir(), env: {} });
    assert.equal(r.text, '{"status":"success"}');
    assert.equal(r.session_id, 'sess-7');
    assert.equal(r.tokens, 160);
    assert.equal(r.context_tokens, 150);
    assert.equal(r.cost, 0.002);
  } finally {
    if (saved === undefined) delete process.env.GROK_PATH;
    else process.env.GROK_PATH = saved;
  }
});

test('runGrok: a logged-out death surfaces the exit code and stderr for the classifier', { skip: process.platform === 'win32' }, async () => {
  const { bin } = fakeGrok([], { code: 1, stderr: 'Error: You are not authenticated. Run grok login.\n' });
  const saved = process.env.GROK_PATH;
  process.env.GROK_PATH = bin;
  const rawOutputPath = join(mkdtempSync(join(tmpdir(), 'fia-grok-raw3-')), 'raw_output.jsonl');
  try {
    const r = await runGrok({ prompt: 'x', model: 'grok-4.6', rawOutputPath, cwd: tmpdir(), env: {} });
    assert.equal(r.returncode, 1);
    assert.equal(r.tokens, 0);
    const { readFileSync } = await import('node:fs');
    assert.match(readFileSync(rawOutputPath, 'utf8'), /\[stderr\] Error: You are not authenticated/);
  } finally {
    if (saved === undefined) delete process.env.GROK_PATH;
    else process.env.GROK_PATH = saved;
  }
});

test('runGrok: a missing binary is rc 127 with the install command', async () => {
  const saved = process.env.GROK_PATH;
  process.env.GROK_PATH = join(fakeHome, 'definitely-not-grok');
  const rawOutputPath = join(mkdtempSync(join(tmpdir(), 'fia-grok-raw4-')), 'raw_output.jsonl');
  try {
    const r = await runGrok({ prompt: 'x', model: 'grok-4.6', rawOutputPath, cwd: tmpdir(), env: {} });
    assert.equal(r.returncode, 127);
    assert.match(r.text, /grok\.com\/install\.sh/);
    assert.match(r.text, /grok login/);
  } finally {
    if (saved === undefined) delete process.env.GROK_PATH;
    else process.env.GROK_PATH = saved;
  }
});
