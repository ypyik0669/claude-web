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
export function codexGatewayArgs(groupBaseUrl: string, model?: string): string[] {
  return codexProviderArgs(`${groupBaseUrl}/v1`, 'claude-web gateway', model);
}

/** Same override for any OpenAI-compatible endpoint (`baseV1` already ends in its version segment). */
export function codexProviderArgs(baseV1: string, name: string, model?: string): string[] {
  return [
    // the profile's default model: whatever the user's config.toml names is a ChatGPT model the gateway may not route
    ...(model?.trim() ? ['-c', `model=${JSON.stringify(model.trim())}`] : []),
    '-c', `model_providers.cwgw.name=${JSON.stringify(name)}`,
    '-c', `model_providers.cwgw.base_url=${JSON.stringify(baseV1)}`,
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

/**
 * Write-then-rename, so a Gemini process starting concurrently never reads a half-written file. On Windows
 * the rename fails with EPERM / EBUSY / EACCES while another process has the target open: retry briefly.
 */
export function writeAtomic(file: string, text: string, tries = 10) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e: any) {
      if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } throw e; }
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* short synchronous back-off: this runs once per session start */ }
    }
  }
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
    writeAtomic(out, JSON.stringify(base, null, 2));
  } catch {
    return {};
  }
  return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: out };
}

