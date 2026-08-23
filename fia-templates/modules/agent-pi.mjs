import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { armLimits } from './agent-limits.mjs';

const PI_BIN = process.env.PI_PATH || 'pi';

const tokenCount = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function piUsageOf(usage = {}) {
  const input = tokenCount(usage.input ?? usage.input_tokens);
  const output = tokenCount(usage.output ?? usage.output_tokens);
  const cacheRead = tokenCount(usage.cacheRead ?? usage.cache_read);
  const cacheWrite = tokenCount(usage.cacheWrite ?? usage.cache_write);
  const componentTotal = input + output + cacheRead + cacheWrite;
  const reportedTotal = tokenCount(usage.totalTokens ?? usage.total_tokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: reportedTotal || componentTotal,
  };
}

export function buildPiArgs(request) {
  const args = [
    '-p',
    '--mode',
    'json',
    '--session',
    request.sessionFile,
    '--model',
    request.model,
    '--thinking',
    request.thinking || 'medium',
  ];
  // Agent role (rendered system.md) via APPEND — preserves Pi's default system
  // prompt (tools + instructions), which is the foundation of prompt caching.
  // Sent on EVERY invocation: resuming the session needs the SAME system to
  // keep the prefix stable (changing it invalidates the cache and changes behavior).
  if (request.systemPrompt) args.push('--append-system-prompt', request.systemPrompt);
  if (request.tools?.length) args.push('--tools', request.tools.join(','));
  for (const ext of request.extensions || []) args.push('-e', ext);
  args.push(request.prompt);
  return args;
}

export async function runPi(request, { onEvent, onSpawn, onExit } = {}) {
  const args = buildPiArgs(request);

  mkdirSync(dirname(request.rawOutputPath), { recursive: true });
  mkdirSync(dirname(request.sessionFile), { recursive: true });

  return new Promise((resolve) => {
    const child = spawn(PI_BIN, args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onSpawn?.(child.pid);
    const limiter = armLimits(child, request.limits);

    let text = '';
    let tokens = 0;
    let input = 0;
    let output = 0;
    let cost = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let contextTokens = 0;
    let contextWindow = 0;
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
          if (event.type === 'message_end' && event.message?.role === 'assistant') {
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                if (part.type === 'text') text += part.text || '';
              }
            }
            const usage = event.message.usage || event.usage || {};
            const parts = piUsageOf(usage);
            tokens += parts.total;
            input += parts.input;
            output += parts.output;
            cost += usage.cost?.total || 0;
            cacheRead += parts.cacheRead;
            cacheWrite += parts.cacheWrite;
            if (usage.contextSize) contextTokens = usage.contextSize;
            if (usage.contextWindow) contextWindow = usage.contextWindow;
            limiter.noteTokens(tokens);
          }
          if (event.type === 'agent_end' && event.text) text = event.text;
        } catch {
          /* non-json line */
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      appendFileSync(request.rawOutputPath, `[stderr] ${d}`);
    });

    child.on('close', (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          onEvent?.(event);
          if (event.text) text = event.text;
        } catch {
          text += buffer;
        }
      }
      onExit?.(child.pid);
      resolve({
        text,
        returncode: code ?? 1,
        session_id: request.sessionFile,
        tokens,
        cost,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        context_tokens: contextTokens || tokens,
        context_window: contextWindow,
        terminated: limiter.finish(),
      });
    });

    child.on('error', (err) => {
      onExit?.(child.pid);
      resolve({
        text: `Error: ${err.message}`,
        returncode: 127,
        session_id: request.sessionFile,
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

export function resolveModel(_pattern) {
  return _pattern;
}
