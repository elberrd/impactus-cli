/**
 * Grok Build (the `grok` CLI, xAI subscription) — installer-side detection.
 * Status only: the installer never runs an agent and never logs anyone in.
 *
 * Same signals the FIA runtime uses (fia-templates/modules/engines.mjs):
 *   - installed: `grok` on PATH, or the installer's own ~/.grok/bin/grok
 *     (install.sh drops it there and only appends to the shell rc);
 *   - logged in: ~/.grok/auth.json holds an OIDC entry with a refresh token
 *     (the CLI refreshes it itself — an expired `expires_at` is not a logout).
 * XAI_API_KEY is deliberately NOT a signal: it means per-token API billing,
 * outside the subscription — the FIA strips it from grok runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { which } from './proc.js';

export const GROK_INSTALL_HINT = 'curl -fsSL https://grok.com/install.sh | bash';
const GROK_HOME = join(homedir(), '.grok');

export async function hasGrok() {
  if (await which('grok')) return true;
  return existsSync(join(GROK_HOME, 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok'));
}

export function readGrokAuth() {
  const path = join(GROK_HOME, 'auth.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function grokLoggedIn() {
  const auth = readGrokAuth();
  if (!auth || typeof auth !== 'object') return false;
  return Object.values(auth).some(
    (entry) => entry && typeof entry === 'object' && Boolean(entry.refresh_token || entry.key || entry.access_token),
  );
}

/** One human line for the engines panels (preflight, doctor, finish). */
export async function grokStatusLine({ okMark = '✅', pendingMark = '○' } = {}) {
  if (!(await hasGrok())) {
    return `${pendingMark} Grok Build (xAI subscription) — not installed (optional).\n   Install:  ${GROK_INSTALL_HINT}\n   Then run \`grok login\`.`;
  }
  return grokLoggedIn()
    ? `${okMark} Grok Build (xAI subscription) — installed and logged in. Use it: \`imp llm set builder grok-4.6\` (or one run: --llm "grok-4.6 high").`
    : `${pendingMark} Grok Build (xAI subscription) — installed, login pending.\n   Log in:  grok login   (never set XAI_API_KEY — that bills per token).`;
}
