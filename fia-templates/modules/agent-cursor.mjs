/**
 * Cursor engine — runs the Cursor Agent CLI headless on the user's Cursor
 * subscription (login once: `cursor-agent login`).
 *
 * Contract mirrors agent-pi/agent-claude: stream-json events are parsed for
 * tool calls (via onEvent) and the final `result` event carries the canonical
 * answer plus the chat id used for `--resume`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { armLimits } from './agent-limits.mjs';

const CURSOR_BIN = process.env.CURSOR_AGENT_PATH || 'cursor-agent';
const FALLBACK_BIN = 'agent';

export function buildCursorArgs(request) {
  const args = ['-p', '--force', '--output-format', 'stream-json'];
  if (request.model) args.push('--model', request.model);
  if (request.sessionId) args.push('--resume', request.sessionId);
  // cursor-agent has no system prompt flag — the agent role
  // (rendered system.md) is prepended to the FIRST prompt of the session.
  // On resumes (--resume) it is already in the history; repeating it would only
  // inflate the context and change the prefix.
  const prompt =
    request.systemPrompt && !request.sessionId
      ? `${request.systemPrompt}\n\n---\n\n${request.prompt}`
      : request.prompt;
  args.push(prompt);
  return args;
}

export async function runCursor(request, { onEvent, onSpawn, onExit } = {}) {
  mkdirSync(dirname(request.rawOutputPath), { recursive: true });
  return spawnOnce(CURSOR_BIN, request, { onEvent, onSpawn, onExit }).then((r) => {
    // Older installs ship only `cursor-agent`, newer ones also `agent` — try both.
    if (r.returncode === 127 && CURSOR_BIN === 'cursor-agent') {
      return spawnOnce(FALLBACK_BIN, request, { onEvent, onSpawn, onExit });
    }
    return r;
  });
}

function spawnOnce(bin, request, { onEvent, onSpawn, onExit }) {
  return new Promise((resolve) => {
    const child = spawn(bin, buildCursorArgs(request), {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onSpawn?.(child.pid);
    // No token usage in Cursor's stream — only the wall-clock timeout applies.
    const limiter = armLimits(child, request.limits);

    let text = '';
    let assistantText = '';
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
          if (event.session_id) sessionId = event.session_id;
          if (event.chat_id) sessionId = event.chat_id;
          if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
            for (const block of event.message.content) {
              if (block.type === 'text') assistantText += block.text || '';
            }
          }
          // `result` is the canonical, deduplicated final answer.
          if (event.type === 'result' && typeof event.result === 'string') text = event.result;
        } catch {
          /* non-json line */
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => appendFileSync(request.rawOutputPath, `[stderr] ${d}`));

    child.on('close', (code) => {
      onExit?.(child.pid);
      resolve({
        text: text || assistantText,
        returncode: code ?? 1,
        session_id: sessionId,
        // The Cursor CLI does not report token usage in stream-json.
        tokens: 0,
        cost: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        context_tokens: 0,
        context_window: 0,
        terminated: limiter.finish(),
      });
    });

    child.on('error', (err) => {
      onExit?.(child.pid);
      const hint =
        err.code === 'ENOENT'
          ? `Cursor CLI not found (${bin}). Install it: curl https://cursor.com/install -fsS | bash — then log in: cursor-agent login`
          : String(err.message || err);
      resolve({
        text: `Error: ${hint}`,
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
