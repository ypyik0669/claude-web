import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'] as const;

/**
 * The Anthropic variables an account session's CLI will see from the user's own setup: this process's environment and
 * the `env` of `<config>/settings.json` (where relay users put their base URL and token; the CLI applies it itself, so
 * `claude auth status` says logged in). `relay`: the account is really such a relay, not claude.ai.
 */
export function userAnthropicEnv(): { env: Partial<Record<(typeof KEYS)[number], string>>; relay: boolean } {
  let settings: Record<string, unknown> = {};
  try {
    const file = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json');
    const env = JSON.parse(readFileSync(file, 'utf8'))?.env;
    if (env && typeof env === 'object') settings = env;
  } catch { /* none, or not JSON: the CLI ignores it too */ }
  const env: Partial<Record<(typeof KEYS)[number], string>> = {};
  for (const k of KEYS) {
    const v = process.env[k] ?? (typeof settings[k] === 'string' ? (settings[k] as string) : undefined);
    if (v) env[k] = v;
  }
  const base = env.ANTHROPIC_BASE_URL?.trim();
  const relay = !!(env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || (base && !/^https:\/\/api\.anthropic\.com\/?$/i.test(base)));
  return { env, relay };
}
