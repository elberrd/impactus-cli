import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { armLimits } from './agent-limits.mjs';

const CLAUDE_BIN = process.env.CLAUDE_PATH || 'claude';
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

const tokenCount = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function claudeUsageOf(usage = {}) {
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

export function buildClaudeArgs(request) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (request.model) args.push('--model', request.model);
  const effort = request.effort || request.thinking;
  if (effort && EFFORT_LEVELS.includes(effort)) args.push('--effort', effort);
  // Agent role (rendered system.md) via APPEND — never --system-prompt:
  // the CLI's default prefix (tools + context) is what the cache leverages.
  // Sent on EVERY invocation (including --resume): omitting it on a resume would
  // change the system prompt mid-session — invalidating the cache and changing behavior.
  if (request.systemPrompt) args.push('--append-system-prompt', request.systemPrompt);
  if (request.sessionId) args.push('--resume', request.sessionId);
  args.push(request.prompt);
  return args;
}

/**
 * Run Claude Code headless (subscription billing via official CLI — t3code pattern).
 * Uses stream-json output and session resume for correction loops.
 * `model` takes an alias (sonnet, opus, haiku, fable) or a full model name;
 * `effort`/`thinking` maps to --effort (low…ultracode).
 */
export async function runClaude(request, { onEvent, onSpawn, onExit } = {}) {
  const args = buildClaudeArgs(request);

  mkdirSync(dirname(request.rawOutputPath), { recursive: true });

  return new Promise((resolve) => {
    const child = spawn(
      CLAUDE_BIN,
      args,
      {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    onSpawn?.(child.pid);
    const limiter = armLimits(child, request.limits);

    let text = '';
    let tokens = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    // Live context ≈ what the LAST turn processed (fresh input + the cached
    // prefix it re-read) — NOT the invocation-accumulated sum, which grows
    // with every turn and would make the session-rotation cap fire on any
    // long phase regardless of actual context size.
    let lastContext = 0;
    // Subscription billing: no dollar cost unless the CLI reports one (result event).
    let cost = 0;
    let sessionId = request.sessionId || '';
    let buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        appendFileSync(request.rawOutputPath, line + '\n');
        try {
          const event = JSON.parse(line);
          onEvent?.(event);
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') text += block.text || '';
            }
          }
          if (event.type === 'result' && event.result) text = event.result;
          if (event.type === 'result' && typeof event.total_cost_usd === 'number') cost = event.total_cost_usd;
          if (event.session_id) sessionId = event.session_id;
          if (event.usage) {
            // Cache read/creation make up most of the input in an agentic session —
            // without them the viewer undercounts and the hit rate becomes invisible.
            const usage = claudeUsageOf(event.usage);
            tokens += usage.total;
            input += usage.input;
            output += usage.output;
            cacheRead += usage.cacheRead;
            cacheWrite += usage.cacheWrite;
            lastContext = usage.input + usage.cacheRead + usage.cacheWrite;
            limiter.noteTokens(tokens);
          }
        } catch {
          text += line;
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => appendFileSync(request.rawOutputPath, `[stderr] ${d}`));

    child.on('close', (code) => {
      onExit?.(child.pid);
      resolve({
        text,
        returncode: code ?? 1,
        session_id: sessionId,
        tokens,
        cost,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        context_tokens: lastContext,
        context_window: 0,
        terminated: limiter.finish(),
      });
    });

    child.on('error', (err) => {
      onExit?.(child.pid);
      resolve({
        text: `Error: ${err.message}`,
        returncode: 127,
        session_id: sessionId,
        tokens: 0,
        cost: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        terminated: limiter.finish(),
      });
    });
  });
}
