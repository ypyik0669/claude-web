// How a non-Claude agent is pointed at the gateway without touching its own config files, and so that
// an account login (ChatGPT for Codex, Google for Gemini CLI) cannot take precedence over the gateway.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../files/service.js';

/** Env var our Codex provider reads its key from (`env_key`). */
export const CODEX_KEY_ENV = 'CW_GATEWAY_KEY';

/**
 * Codex: env `OPENAI_BASE_URL` / `OPENAI_API_KEY` are ignored once the user is logged in with ChatGPT, so
 * define our own provider with `-c` overrides and select it (`model_provider`). Keys per the Codex config
 * reference: `model_providers.<id>.{name, base_url, env_key, wire_api}`; `wire_api` "responses".
 * Values are TOML, hence JSON quoting. Global flags: they go before the `app-server` subcommand.
 */
export function codexGatewayArgs(groupBaseUrl: string): string[] {
  return [
    '-c', `model_providers.cwgw.name=${JSON.stringify('claude-web gateway')}`,
    '-c', `model_providers.cwgw.base_url=${JSON.stringify(`${groupBaseUrl}/v1`)}`,
    '-c', `model_providers.cwgw.env_key=${JSON.stringify(CODEX_KEY_ENV)}`,
    '-c', 'model_providers.cwgw.wire_api="responses"',
    '-c', 'model_provider="cwgw"',
  ];
}

/** Splice global flags in front of `app-server`; an argv without it (custom command / test double) is left alone. */
export function beforeAppServer(args: string[], extra: string[]): string[] {
  const at = args.indexOf('app-server');
  if (at < 0 || !extra.length) return args;
  return [...args.slice(0, at), ...extra, ...args.slice(at)];
}

function systemSettingsDefault(): string {
  if (process.platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json';
  if (process.platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json';
  return '/etc/gemini-cli/settings.json';
}

/**
 * Gemini CLI: a cached Google login (`security.auth.selectedType` in the user's settings) wins over
 * `GEMINI_API_KEY`, and ACP `authenticate` would rewrite the user's settings and clear the cached
 * credentials. System settings override user settings and their path can be pointed elsewhere with
 * `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, so we hand the process a copy of the system settings (if any) with
 * the auth type forced to the API key. Returns the env to add.
 */
export function geminiApiKeyEnv(): Record<string, string> {
  const src = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || systemSettingsDefault();
  let base: any = {};
  try { base = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { /* none / unreadable: start empty */ }
  if (!base || typeof base !== 'object') base = {};
  base.security = { ...(base.security ?? {}), auth: { ...(base.security?.auth ?? {}), selectedType: 'gemini-api-key' } };
  const out = path.join(dataDir(), 'gateway', 'gemini-system-settings.json');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(base, null, 2), 'utf8');
  } catch {
    return {};
  }
  return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: out };
}

