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

/** Variables that pick the endpoint, the credentials or the models — the ones a provider conversation must not inherit. */
export const ROUTING_ENV = /^((ANTHROPIC|OPENAI|GEMINI|GROK|XAI)_|CLAUDE_CODE_USE_)/;

/** The `env` of each settings file the CLI reads for a conversation in `cwd` (settingSources user, project, local). */
export function settingsEnvs(cwd?: string): Record<string, unknown>[] {
  const files = [path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'settings.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    try {
      const env = JSON.parse(readFileSync(f, 'utf8'))?.env;
      if (env && typeof env === 'object' && !Array.isArray(env)) out.push(env);
    } catch { /* none, or not JSON: the CLI ignores it too */ }
  }
  return out;
}

/**
 * What a provider conversation's CLI has to be given through `--settings` (the flag tier, above user / project /
 * local). Both engines apply those files' `env` over the environment they were started with, so a relay's token or
 * base URL left in ~/.claude/settings.json (cc-switch and the like write it there) replaced the provider's: the model
 * list, fetched by us with the provider's key, worked; every turn went out with the old token and got 401, retried ten
 * times (2026-10-07, a user's friend on super-nb; reproduced against fake relays on both engines). For each key a file
 * sets, ours wins; a routing key a file sets and ours does not is blanked ('' counts as unset for the CLI: no stray
 * x-api-key, the CLI's own default model). Null: no file sets anything that matters.
 */
export function settingsOverride(ours: Record<string, string>, cwd?: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const env of settingsEnvs(cwd)) {
    for (const k of Object.keys(env)) {
      if (k in ours) out[k] = ours[k];
      else if (ROUTING_ENV.test(k)) out[k] = '';
    }
  }
  return Object.keys(out).length ? out : null;
}
