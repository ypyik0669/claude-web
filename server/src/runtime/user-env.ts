import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompactSource } from '../protocol.js';

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

/**
 * Each settings file the CLI reads for a conversation in `cwd` (settingSources user, project, local), parsed. `home`:
 * the home folder whose `.claude` holds the user's (default: this user's); CLAUDE_CONFIG_DIR goes over it, as for the CLI.
 */
export function settingsDocs(cwd?: string, home?: string): Record<string, unknown>[] {
  const files = [path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(home ?? os.homedir(), '.claude'), 'settings.json')];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    try {
      const doc = JSON.parse(readFileSync(f, 'utf8'));
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) out.push(doc);
    } catch { /* none, or not JSON: the CLI ignores it too */ }
  }
  return out;
}

/** The `env` of each of those files. */
export function settingsEnvs(cwd?: string, home?: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const doc of settingsDocs(cwd, home)) {
    const env = doc.env;
    if (env && typeof env === 'object' && !Array.isArray(env)) out.push(env as Record<string, unknown>);
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

/**
 * The account (no provider): what we set for it goes over the same keys in the user's settings files — only those keys
 * (the rest of those files is the account's own setup). Used for the subagents' model picked in the composer
 * (`CLAUDE_CODE_SUBAGENT_MODEL`) and, when they run on another provider's model, the split route's base URL over the
 * user's own relay (`ANTHROPIC_BASE_URL`). Null: no file sets any of them.
 */
export function ownOverride(ours: Record<string, string>, cwd?: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const env of settingsEnvs(cwd)) for (const k of Object.keys(ours)) if (k in env) out[k] = ours[k];
  return Object.keys(out).length ? out : null;
}

/**
 * The Anthropic base URL the account's CLI really sends to: the settings files' `env` (user, then project, then local:
 * the later one wins) over this process's environment — where a relay the user set up there points. Undefined: none
 * (claude.ai itself). '' counts as unset, as it does for the CLI.
 */
export function ownAnthropicBase(cwd?: string): string | undefined {
  let v = process.env.ANTHROPIC_BASE_URL;
  for (const env of settingsEnvs(cwd)) if (typeof env.ANTHROPIC_BASE_URL === 'string') v = env.ANTHROPIC_BASE_URL;
  return v?.trim() || undefined;
}

/**
 * The `CLAUDE_CODE_AUTO_COMPACT_WINDOW` a conversation's CLI ends up with — the engine caps the context window at it
 * (it only ever lowers the window) and compacts below it. Layered as the CLI sees it: this server's environment, then
 * `ours` (the conversation's own env: the runner's official-binary cap, 本机环境变量, the session's), then the settings
 * files' `env` (user, project, local: the later wins) over both — except that a provider / account conversation puts
 * what `ours` sets back on top through the flag tier (`settingsOverride`; `oursWins`). Blank, zero or not a number on
 * the winning layer: no cap (the CLI's parseInt). Undefined: no cap.
 */
export function compactCap(ours: Record<string, string>, cwd: string | undefined, oursWins: boolean, model?: string): number | undefined {
  const K = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
  let v: unknown = process.env[K];
  let set = K in process.env;
  if (K in ours) { v = ours[K]; set = true; }
  for (const env of settingsEnvs(cwd)) if (K in env) { v = env[K]; set = true; }
  if (oursWins && K in ours) v = ours[K];
  // no variable anywhere: the point the official CLI's /autocompact keeps in settings.json (it ranks under the variable)
  return set ? compactWindow(v) : autoCompactSetting(model, cwd);
}

/** Whether CLAUDE_CODE_AUTO_COMPACT_WINDOW is set at all — this server's environment or a settings file's `env` (blank counts). */
export function compactVarSet(cwd?: string): boolean {
  const K = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
  return K in process.env || settingsEnvs(cwd).some((env) => K in env);
}

/**
 * The compaction point the official CLI (2.1.3xx) keeps in settings.json: `/autocompact 300k` writes it under
 * `modelSettings.<model>.autoCompactWindow`, and a top-level `autoCompactWindow` holds for every model — a token count,
 * or 'auto' (the model's own window). The CLI takes it only when no CLAUDE_CODE_AUTO_COMPACT_WINDOW is set, and never
 * past the window. claude-web-engine does not read it, so the runner hands it over as that variable (2026-11-19, user
 * reports of auto-compaction 「是不是因为 Claude Code 加了 /autocompact」: a point set there held on the official binary
 * only, and the composer's ring knew of it nowhere). The later settings file wins, as the CLI merges them; a model's own
 * entry wins over the top level ('auto' there too). Undefined: none, or 'auto'.
 */
export function autoCompactSetting(model: string | undefined, cwd?: string, home?: string): number | undefined {
  const want = settingsModelKey(model);
  let top: unknown;
  let mine: unknown;
  for (const doc of settingsDocs(cwd, home)) {
    if ('autoCompactWindow' in doc) top = doc.autoCompactWindow;
    const per = doc.modelSettings;
    if (!want || !per || typeof per !== 'object' || Array.isArray(per)) continue;
    for (const [k, v] of Object.entries(per as Record<string, unknown>)) {
      if (settingsModelKey(k) === want && v && typeof v === 'object' && 'autoCompactWindow' in v) mine = (v as { autoCompactWindow: unknown }).autoCompactWindow;
    }
  }
  return compactSize(mine !== undefined ? mine : top);
}

/** A model id as `modelSettings` keys it (the CLI's canonical id): compared without case, `[1m]` or a date suffix. */
const settingsModelKey = (m: string | undefined) => (m ? m.trim().toLowerCase().replace(/\[1m\]$/, '').replace(/-\d{8}$/, '') : '');

/**
 * A compaction size as the official CLI takes one: a number, or text like 500k / 1m / 200000 — a bare number under
 * 1000 in text is thousands (200 = 200K, its shorthand); 'auto' and anything else: none. Kept within 100K–1M, the
 * range `/autocompact` accepts.
 */
export function compactSize(v: unknown): number | undefined {
  let n: number | undefined;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(v);
    if (m) { const x = Number(m[1]); n = x * (m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2] || x < 1000 ? 1_000 : 1); }
  }
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(Math.min(1_000_000, Math.max(100_000, n)));
}

/** A CLAUDE_CODE_AUTO_COMPACT_WINDOW value as the CLI reads it (parseInt): a positive number, or undefined for no cap. */
function compactWindow(v: unknown): number | undefined {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Where the compaction point in effect for the user comes from, for the edit page (「现在：700K（来自你的 settings.json）」,
 * request `config.compactSource`): the user-level settings.json `env` (not a project's: the page is not tied to one),
 * else this server's environment, else none. As for the CLI (and `compactCap`), the settings file wins as soon as it has
 * the key: a blank, `0` or `abc` there means no cap, even with a value in the environment. `home`: as for `settingsDocs`.
 */
export function userCompactSource(home?: string): CompactSource {
  const K = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
  let inSettings = false;
  let v: unknown;
  for (const env of settingsEnvs(undefined, home)) if (K in env) { inSettings = true; v = env[K]; }
  if (!inSettings) v = process.env[K];
  const value = compactWindow(v);
  if (value) return { value, source: inSettings ? 'settings' : 'env' };
  // no variable at all: the top-level point the official CLI's /autocompact setting keeps (a model's own is per model)
  const set = !inSettings && !(K in process.env) ? autoCompactSetting(undefined, undefined, home) : undefined;
  return set ? { value: set, source: 'settings' } : { source: 'none' };
}
