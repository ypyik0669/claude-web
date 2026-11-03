import os from 'node:os';
import { sameBase } from '../import/service.js';
import { CLAUDE_PROVIDER_ID, type AgentKind, type ModelRefreshResult, type Provider, type ProviderType, type RuntimeKind } from '../protocol.js';
import type { MetaStore } from '../meta/store.js';
import { resolveEngine, runClaudeCli } from '../claude-exe.js';
import type { SecretService } from '../secrets/service.js';
import { contextWindowFor, listedContext } from '../models/context-window.js';
import { CODEX_KEY_ENV, codexGatewayArgs, codexProviderArgs, geminiApiKeyEnv } from '../gateway/agents.js';
import { memberKey } from '../gateway/types.js';
import { claudeFamilyMap, isChatModel, modelsFor, pickChatModel, preferredRuntime, profileFitError } from '../models/catalog.js';
import { wantsResponses } from '../gateway/shim.js';
import { settingsOverride } from '../runtime/user-env.js';
import { writeFlagSettings, type FlagSettings } from '../runtime/flag-settings.js';
import { tr } from '../i18n/index.js';
import { anthropicBase, authHeaders } from './endpoint.js';
import { privacyRoute, viaPrivacy } from '../privacy/route.js';
import { ownLoginLaunch } from '../privacy/agents.js';

/** Vendors' default bases (what the clients use when the profile names none) — the privacy relay needs them spelled out. */
const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROK_DEFAULT_BASE = 'https://api.x.ai/v1';
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';

/** Mask an API key for the wire: keep prefix + last 4 chars. */
export function maskKey(k: string | undefined): string {
  if (!k) return '';
  if (k.length <= 8) return '…';
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

export function publicProvider(p: Provider): Provider {
  return { ...p, apiKey: p.apiKey?.startsWith('enc:') ? '…' + (p.apiKey.split(':')[1] ?? '') : maskKey(p.apiKey) };
}

/**
 * A profile resolved for one session (plaintext key). `shim`: openai / grok profiles whose Claude sessions go
 * through the local prompt-cache shim (gateway/shim.ts) — its base (the session key is appended) and the
 * internal key that replaces the real one in the child's env.
 */
export type SessionProvider = Provider & {
  shim?: { base: string; key: string };
  /** the gateway group is all Gemini-web / WorkBuddy: a smaller tool set keeps the prompt under the sidecar's byte wall */
  leanTools?: boolean;
};

/**
 * `<shim base>/k/<cache key>[/s/<session id>]/v1` — what ccb's OpenAI-SDK clients use as their base URL. The cache
 * key routes the prompt cache (a fork keeps its parent's); the session id, when it differs, names the ledger rows.
 */
export const shimBaseUrl = (s: { base: string }, sessionKey?: string, sessionId?: string) =>
  `${s.base}${sessionKey ? `/k/${encodeURIComponent(sessionKey)}` : ''}${sessionKey && sessionId && sessionId !== sessionKey ? `/s/${encodeURIComponent(sessionId)}` : ''}/v1`;

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

/**
 * NO_PROXY / no_proxy with the loopback hosts added, when a base URL in `env` is local (the cache shim, the model
 * gateway). The CLI honours HTTP(S)_PROXY for every API call; a proxy from the user's environment (common where
 * the relay needs one) would otherwise get our 127.0.0.1 requests — a remote proxy cannot reach them and the turn
 * hangs. What the user already listed is kept. Nothing to add → `{}`.
 */
export function loopbackNoProxy(env: Record<string, string | undefined>): Record<string, string> {
  const local = ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GROK_BASE_URL', 'GEMINI_BASE_URL'].some((k) => {
    try { return LOOPBACK.includes(new URL(env[k] ?? '').hostname.replace(/^\[|\]$/g, '')); } catch { return false; }
  });
  if (!local) return {};
  const have = [env.NO_PROXY, env.no_proxy].flatMap((v) => (v ?? '').split(',')).map((s) => s.trim()).filter(Boolean);
  const all = [...new Set([...have, ...LOOPBACK])].join(',');
  return { NO_PROXY: all, no_proxy: all };
}

/**
 * Map a provider profile to the env the runtime reads. Only what the CLI needs — the profile itself never
 * touches ~/.claude/settings.json, so the claude.ai login keeps working for sessions without a provider.
 * `sessionKey` (the session id; a fork's parent id) keys the cache shim's routes for openai / grok profiles,
 * `sessionId` (when known up front) is the session its ledger rows belong to.
 */
export function providerEnv(p: SessionProvider, agent: 'claude' | 'codex' | 'acp' = 'claude', opts: { sessionKey?: string; sessionId?: string } = {}): Record<string, string> {
  if (p.type === 'gateway' && agent !== 'claude') return gatewayAgentEnv(p, agent);
  // Relays that fingerprint Claude Code (super-nb & co.) reject the `agent-sdk/x.y.z` User-Agent suffix the SDK
  // makes the CLI add. spawnClaude() strips that env when this marker is present, so the request looks like `claude -p`.
  // Same for the entrypoint tag: such relays accept the CLI's own default (`cli`) and reject `sdk-ts`.
  const env: Record<string, string> = { CLAUDE_WEB_PLAIN_UA: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const m = p.modelMap ?? {};
  switch (p.type) {
    // the gateway speaks Anthropic to Claude Code and passes it through to Anthropic-type members unchanged,
    // so the same fingerprint env (plain UA, entrypoint cli) matters here too
    case 'gateway':
    case 'anthropic':
      // without a trailing /v1: the CLI appends /v1/messages itself (a pasted `…/v1` became /v1/v1/messages)
      // 隐私保护 on: through the local privacy relay (privacy/route.ts; a gateway profile is behind the gateway already)
      env.ANTHROPIC_BASE_URL = p.type === 'anthropic' ? viaPrivacy(anthropicBase(p.baseUrl)) : p.baseUrl;
      // Bearer by default — what relays like super-nb expect; official API keys work through it too. authStyle
      // x-api-key → ANTHROPIC_API_KEY only ('' counts as unset for the CLI); both → both variables.
      if (p.type === 'anthropic' && p.authStyle === 'x-api-key') { env.ANTHROPIC_API_KEY = p.apiKey; env.ANTHROPIC_AUTH_TOKEN = ''; }
      else {
        env.ANTHROPIC_AUTH_TOKEN = p.apiKey;
        if (p.type === 'anthropic' && p.authStyle === 'both') env.ANTHROPIC_API_KEY = p.apiKey;
      }
      if (p.defaultModel) env.ANTHROPIC_MODEL = p.defaultModel;
      if (m.haiku) { env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku; env.ANTHROPIC_SMALL_FAST_MODEL = m.haiku; }
      if (m.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet;
      if (m.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus;
      // official binary: 1-hour cache TTL on every breakpoint (2x base write price instead of 1.25x); opt-in per profile
      if (p.type === 'anthropic' && p.cache1h) env.ENABLE_PROMPT_CACHING_1H = '1';
      break;
    case 'openai':
      // through the cache shim unless the profile turned it off: the real key never reaches the child
      env.OPENAI_BASE_URL = p.shim ? shimBaseUrl(p.shim, opts.sessionKey, opts.sessionId) : viaPrivacy(openaiBase(p.baseUrl));
      env.OPENAI_API_KEY = p.shim ? p.shim.key : p.apiKey;
      env.CLAUDE_CODE_USE_OPENAI = '1';
      // NOT OPENAI_MODEL: ccb's OpenAI client returns it for every request (dist `ge()`), so the session's model
      // (the menu pick, else the profile default — SessionRunner) and the family map below would be ignored.
      // Without it a model id passes through unchanged and a haiku / sonnet / opus one (ccb's own background
      // calls) is mapped here; every family gets a value, otherwise ccb falls back to its claude → gpt-4o / o3 table.
      // Such ids the relay lists itself (a relay that serves claude-sonnet-5 in OpenAI format) go out unchanged:
      // our engine (claude-web-engine cw.2+) skips the family mapping for CLAUDE_WEB_SERVED_MODELS.
      {
        const fallback = p.defaultModel || pickChatModel(p.models ?? []) || p.models?.[0];
        const fam = { HAIKU: m.haiku || fallback, SONNET: m.sonnet || fallback, OPUS: m.opus || fallback };
        for (const [k, v] of Object.entries(fam)) if (v) env[`OPENAI_DEFAULT_${k}_MODEL`] = v;
        if (fam.HAIKU) env.OPENAI_SMALL_FAST_MODEL = fam.HAIKU;
        const served = (p.models ?? []).filter((id) => /haiku|sonnet|opus/i.test(id));
        if (served.length) env.CLAUDE_WEB_SERVED_MODELS = JSON.stringify(served);
      }
      break;
    // ccb (claude-code-best) picks its API provider in `getAPIProvider()`: settings `modelType`, then
    // CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY / OPENAI / GEMINI / GROK, else first-party Anthropic. Without the
    // switch a gemini / grok profile silently talks to the Anthropic default. Variable names below are the ones
    // ccb's Gemini / Grok clients read (dist, 2026-09). GEMINI_MODEL / GROK_MODEL are deliberately NOT set: ccb
    // returns them for every request, so an in-session model switch would do nothing. Model ids without a
    // haiku / sonnet / opus family pass through unchanged; the family ones are mapped here.
    case 'gemini': {
      env.CLAUDE_CODE_USE_GEMINI = '1';
      env.GEMINI_API_KEY = p.apiKey;
      // requests go to `<base>/models/<id>:streamGenerateContent`; 隐私保护 on: the vendor default spelled out, through the relay
      {
        const gb = p.baseUrl ? geminiBase(p.baseUrl) : undefined;
        const routed = privacyRoute(gb ?? GEMINI_DEFAULT_BASE);
        if (routed ?? gb) env.GEMINI_BASE_URL = (routed ?? gb)!;
      }
      // the Gemini client throws for a family model it cannot map, so all three get a value
      const fallback = p.defaultModel || pickChatModel(p.models ?? []) || p.models?.[0];
      const fam = { HAIKU: m.haiku || fallback, SONNET: m.sonnet || fallback, OPUS: m.opus || fallback };
      for (const [k, v] of Object.entries(fam)) if (v) env[`GEMINI_DEFAULT_${k}_MODEL`] = v;
      break;
    }
    // another Claude account: the CLI's own way to run on a subscription token, the rest exactly as on the account
    // (the runner takes the account path for it). A relay's token / base URL in this process's environment would win
    // over the OAuth token: blanked ('' counts as unset for the CLI)
    case 'claude-account':
      env.CLAUDE_CODE_OAUTH_TOKEN = p.apiKey;
      env.ANTHROPIC_AUTH_TOKEN = '';
      env.ANTHROPIC_API_KEY = '';
      // 隐私保护 on: the CLI sends its OAuth token to whatever base it is given (the subagent split route relies on the
      // same), so the account's traffic goes through the relay to api.anthropic.com
      env.ANTHROPIC_BASE_URL = privacyRoute(ANTHROPIC_DEFAULT_BASE) ?? '';
      break;
    case 'grok': {
      env.CLAUDE_CODE_USE_GROK = '1';
      env.GROK_API_KEY = p.shim ? p.shim.key : p.apiKey; // ccb: GROK_API_KEY || XAI_API_KEY
      if (p.shim) env.GROK_BASE_URL = shimBaseUrl(p.shim, opts.sessionKey, opts.sessionId);
      else {
        // an OpenAI SDK client: the base ends in /v1; 隐私保护 on: the vendor default spelled out, through the relay
        const gb = p.baseUrl ? openaiBase(p.baseUrl) : undefined;
        const routed = privacyRoute(gb ?? GROK_DEFAULT_BASE);
        if (routed ?? gb) env.GROK_BASE_URL = (routed ?? gb)!;
      }
      // unmapped families fall back to ccb's own grok defaults, so only what the profile says is set
      const fam = { HAIKU: m.haiku || p.defaultModel, SONNET: m.sonnet || p.defaultModel, OPUS: m.opus || p.defaultModel };
      for (const [k, v] of Object.entries(fam)) if (v) env[`GROK_DEFAULT_${k}_MODEL`] = v;
      break;
    }
  }
  return env;
}

/**
 * A gateway profile for a non-Claude agent (baseUrl / apiKey already resolved by forSession): Codex talks the
 * Responses API under `<group>/v1`; ACP agents get both the Gemini variables (Gemini CLI) and the OpenAI ones
 * (Qwen Code and other OpenAI-compatible CLIs).
 */
function gatewayAgentEnv(p: Provider, agent: 'codex' | 'acp'): Record<string, string> {
  const env: Record<string, string> = { OPENAI_BASE_URL: `${p.baseUrl}/v1`, OPENAI_API_KEY: p.apiKey };
  if (agent === 'codex') env[CODEX_KEY_ENV] = p.apiKey; // read by the -c provider override (agentLaunch)
  if (agent === 'acp') { env.GOOGLE_GEMINI_BASE_URL = p.baseUrl; env.GEMINI_API_KEY = p.apiKey; }
  if (p.defaultModel) { env.OPENAI_MODEL = p.defaultModel; if (agent === 'acp') env.GEMINI_MODEL = p.defaultModel; }
  return env;
}

/**
 * OpenAI-compatible clients (ccb's OpenAI mode, the OpenAI SDK) append `/chat/completions` to the base URL,
 * so it has to end in the version segment. Users paste the relay's bare host (`https://relay.example/`), which
 * the model-list probe tolerated but real sessions did not — every such profile failed at the first turn.
 */
export function openaiBase(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  return !b || /\/v\d+[a-z]*$/.test(b) ? b : `${b}/v1`;
}

/** Gemini REST base with its version segment (`/v1beta` unless one is given) — what ccb's Gemini client expects. */
export function geminiBase(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  return !b || /\/v\d+[a-z]*$/.test(b) ? b : `${b}/v1beta`;
}

function modelsUrl(type: ProviderType, baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  // same base the session will use, so a URL that probes fine also works in the session
  if (type === 'gemini') return `${geminiBase(b || 'https://generativelanguage.googleapis.com')}/models`;
  if (type === 'grok') return `${openaiBase(b || 'https://api.x.ai')}/models`;
  if (type === 'openai') return /\/v\d+$/.test(b) ? `${b}/models` : `${b}/v1/models`;
  return `${anthropicBase(b)}/v1/models`;
}

export interface ChatProbe { ok: boolean; runtime: RuntimeKind | 'api'; model: string; error?: string; ms: number; switched?: boolean; status?: number }
/** `responses`: openai profiles whose default model is gpt-* — the /v1/responses check the cache shim relies on. */
export interface ProbeResult { ok: boolean; status?: number; models: string[]; modelNames?: Record<string, string>; modelEfforts?: Provider['modelEfforts']; modelContext?: Provider['modelContext']; error?: string; ms: number; chat?: ChatProbe; responses?: ChatProbe }

/**
 * A model list's ids and the display names it gives where they differ from the id (DeepSeek / OpenRouter `name`,
 * Anthropic `display_name`, Gemini `displayName` — whose `name` is the `models/…` id itself).
 */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORT_ORDER)[number];
const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORT_ORDER as readonly string[]).includes(v);

/** A list entry's declared levels (official DeepSeek `effort: {supported_levels, default_level}`); unknown values dropped. */
function effortOf(m: any): { levels: Effort[]; default?: Effort } | undefined {
  const e = m?.effort;
  if (!e || typeof e !== 'object' || !Array.isArray(e.supported_levels)) return undefined;
  const have = new Set(e.supported_levels.filter(isEffort));
  const levels = EFFORT_ORDER.filter((l) => have.has(l));
  if (!levels.length) return undefined;
  return { levels, ...(isEffort(e.default_level) && have.has(e.default_level) ? { default: e.default_level } : {}) };
}

export function parseModelList(raw: unknown[]): { models: string[]; modelNames?: Record<string, string>; modelEfforts?: Provider['modelEfforts']; modelContext?: Provider['modelContext'] } {
  const names: Record<string, string> = {};
  const context: Record<string, number> = {};
  const efforts: NonNullable<Provider['modelEfforts']> = {};
  const ids = raw.map((m: any) => {
    const id = String(m?.id ?? m?.name ?? m).replace(/^models\//, '');
    if (m && typeof m === 'object') {
      const label = [m.display_name, m.displayName, m.id !== undefined ? m.name : undefined].find((x) => typeof x === 'string' && x.trim());
      if (id && label && label.trim() !== id) names[id] = label.trim().slice(0, 80);
      const effort = effortOf(m);
      if (id && effort) efforts[id] = effort;
      const ctx = listedContext(m);
      if (id && ctx) context[id] = ctx;
    }
    return id;
  }).filter(Boolean);
  return {
    models: [...new Set(ids)].sort(),
    ...(Object.keys(names).length ? { modelNames: names } : {}),
    ...(Object.keys(efforts).length ? { modelEfforts: efforts } : {}),
    ...(Object.keys(context).length ? { modelContext: context } : {}),
  };
}

/**
 * `--no-session-persistence`: without it every 测试连接 left a "Reply with exactly: ok" conversation in the CLI's
 * transcripts (cwd = the temp folder), which then filled the sidebar's 其它文件夹 › Temp and made the temp folder the
 * welcome page's default project (2026-10-01, both engines support the flag).
 */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Whether the official binary is worth a second try after ccb failed the chat check. A relay that fingerprints the
 * client refuses ccb's request with a 4xx; a relay that is down, out of accounts or out of balance (5xx, 429, 余额) or
 * that never answered fails the official binary just the same — and the retry doubled the wait (242 s on a relay
 * returning 503 "No available accounts", 2026-10-01).
 */
export function worthOfficialRetry(error: string | undefined): boolean {
  const e = error ?? '';
  return !/超时|timed out|API Error: (?:5\d\d|429)\b|\b(?:5\d\d|429) (?:status code|Too Many|Service|Bad Gateway|Gateway|Internal)|insufficient(?:[_ ]\w+)?[_ ](?:balance|quota|funds|credit)|no available accounts|余额|额度/i.test(e);
}

/** What a Claude account profile lists: the account's models (the catalog), named as the account names them. */
export function accountModels(): { models: string[]; modelNames: Record<string, string> } {
  const list = modelsFor('claude');
  return { models: list.map((m) => m.value), modelNames: Object.fromEntries(list.map((m) => [m.value, m.displayName])) };
}

/** A long-lived token from `claude setup-token` (what the account dialog takes, or reads off the terminal). */
export const OAUTH_TOKEN = /\bsk-ant-oat\d{2}-[A-Za-z0-9_-]{40,}/;

export function chatProbeArgs(model: string): string[] {
  return ['-p', 'Reply with exactly: ok', '--no-session-persistence', '--model', model, '--output-format', 'json', '--max-turns', '1'];
}

/**
 * One real one-shot turn through the CLI (`-p`), exactly the way a session will talk to the endpoint. The model list
 * alone cannot tell whether a relay accepts this client: some (super-nb) fingerprint the official Claude Code build
 * and reject ccb's request shape. Cheap (a few tokens) and definitive.
 */
export async function chatProbe(p: Provider, runtime: RuntimeKind | undefined, model: string): Promise<ChatProbe> {
  const t0 = Date.now();
  const kind = resolveEngine(runtime).kind;
  // one retry, not the CLI's ten: a relay answering 5xx kept 测试连接 spinning for 4 minutes, then said "exit 1"
  const env: Record<string, string> = { ...providerEnv(p), CLAUDE_CODE_MAX_RETRIES: '1' };
  // the privacy relay is on 127.0.0.1: a system proxy must not get that request
  Object.assign(env, loopbackNoProxy({ ...env, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }));
  delete env.CLAUDE_WEB_PLAIN_UA; // not spawned through the SDK: the CLI already sends its plain User-Agent
  // a token / base URL in the user's settings.json would otherwise be tested instead of this provider's (user-env)
  const override = settingsOverride(env, os.tmpdir());
  let flag: FlagSettings | null = null;
  try { flag = override ? writeFlagSettings(override) : null; } catch { /* tested as the session would run without it */ }
  const r = await runClaudeCli([...chatProbeArgs(model), ...(flag ? ['--settings', flag.file] : [])], { cwd: os.tmpdir(), timeoutMs: PROBE_TIMEOUT_MS, runtime, env }).finally(() => flag?.dispose());
  const ms = Date.now() - t0;
  let out: any = null;
  try { out = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? ''); } catch { /* not json */ }
  if (out && out.type === 'result' && !out.is_error) return { ok: true, runtime: kind, model, ms };
  if (r.timedOut && !out) return { ok: false, runtime: kind, model, error: tr('超时：{PROBE_TIMEOUT_MS} 秒内没有收到回答（中转没有回应，或一直在报错重试）', { PROBE_TIMEOUT_MS: PROBE_TIMEOUT_MS / 1000 }), ms };
  // an error result carries `errors` / `subtype` rather than `result`; stderr is often just a warning line
  const stderr = r.stderr.split('\n').filter((l) => l.trim() && !/^Warning: no stdin data/.test(l)).join(' ');
  const err = (out?.result ?? (Array.isArray(out?.errors) && out.errors.length ? out.errors.join('; ') : undefined) ?? out?.error ?? (out?.is_error ? out.subtype : undefined) ?? (stderr || r.stdout)).toString().replace(/\s+/g, ' ').trim().slice(0, 300) || `exit ${r.code}`;
  return { ok: false, runtime: kind, model, error: err, ms };
}

/** One minimal `/chat/completions` request (a few tokens) — the chat check for OpenAI-compatible profiles. */
export async function openaiChatProbe(p: Pick<Provider, 'baseUrl' | 'apiKey' | 'authStyle'>, model: string): Promise<ChatProbe> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${viaPrivacy(openaiBase(p.baseUrl))}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(p.authStyle, p.apiKey, 'bearer') },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly: ok' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    if (r.ok && Array.isArray(j?.choices)) return { ok: true, runtime: 'api', model, ms: Date.now() - t0 };
    const err = String(j?.error?.message ?? j?.message ?? text ?? `HTTP ${r.status}`).replace(/\s+/g, ' ').trim().slice(0, 300);
    return { ok: false, runtime: 'api', model, error: `HTTP ${r.status} ${err}`, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, runtime: 'api', model, error: e?.message ?? String(e), ms: Date.now() - t0 };
  }
}

/**
 * One minimal `/v1/responses` request (a few tokens): whether the endpoint has the Responses API the cache shim
 * sends gpt-* to. `status` lets the caller tell "no such endpoint" (404 / 405 / 501) from a model error or an outage.
 */
export async function openaiResponsesProbe(p: Pick<Provider, 'baseUrl' | 'apiKey' | 'authStyle'>, model: string): Promise<ChatProbe> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${viaPrivacy(openaiBase(p.baseUrl))}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(p.authStyle, p.apiKey, 'bearer') },
      body: JSON.stringify({ model, input: 'Reply with exactly: ok', max_output_tokens: 16, store: false }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    if (r.ok && (j?.object === 'response' || Array.isArray(j?.output))) return { ok: true, runtime: 'api', model, ms: Date.now() - t0, status: r.status };
    const err = String(j?.error?.message ?? j?.message ?? (text || `HTTP ${r.status}`)).replace(/\s+/g, ' ').trim().slice(0, 300);
    return { ok: false, runtime: 'api', model, error: `HTTP ${r.status} ${err}${j?.error?.code ? ` (${j.error.code})` : ''}`, ms: Date.now() - t0, status: r.status };
  } catch (e: any) {
    return { ok: false, runtime: 'api', model, error: e?.message ?? String(e), ms: Date.now() - t0 };
  }
}

/**
 * Connectivity + auth check via the model list endpoint. We deliberately do not send a /messages request:
 * relays that only accept Claude Code clients reject anything else, and the list is enough to verify the key.
 */
export async function probeProvider(p: Pick<Provider, 'type' | 'baseUrl' | 'apiKey' | 'authStyle'>, retryMs = 1000): Promise<ProbeResult> {
  const r = await listModels(p);
  // the request never got an answer (connection reset, connect timeout on a flaky route — seen on real relays): once
  // more before telling the user the address is wrong. An HTTP answer, or our own 20 s timeout, is final.
  if (r.ok || r.status !== undefined || r.error === LIST_TIMEOUT) return r;
  await new Promise((res) => setTimeout(res, retryMs));
  const again = await listModels(p);
  return { ...again, ms: (again.ms ?? 0) + (r.ms ?? 0) + retryMs };
}

const LIST_TIMEOUT = tr('连接超时（20s）');

async function listModels(p: Pick<Provider, 'type' | 'baseUrl' | 'apiKey' | 'authStyle'>): Promise<ProbeResult> {
  const t0 = Date.now();
  const url = modelsUrl(p.type, p.baseUrl);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (p.type === 'gemini') headers['x-goog-api-key'] = p.apiKey;
  else {
    // the profile's style; unset = what this probe always sent (Anthropic both headers, the rest Bearer)
    Object.assign(headers, authHeaders(p.authStyle, p.apiKey, p.type === 'anthropic' ? 'both' : 'bearer'));
    if (p.type === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  }
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 20_000);
    // 隐私保护 on: the list request takes the same relay as the conversation (nothing to redact in a GET, same path)
    const r = await fetch(viaPrivacy(url), { headers, signal: ac.signal });
    const text = await r.text(); // still under the timeout: a relay that sends headers then stalls the body would hang the probe
    clearTimeout(to);
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    // `||`: an empty body is an empty string, which would otherwise become the whole error message
    if (!r.ok) return { ok: false, status: r.status, models: [], error: j?.error?.message || j?.message || text.slice(0, 300) || `HTTP ${r.status}`, ms: Date.now() - t0 };
    const raw: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
    const { models, modelNames, modelEfforts, modelContext } = parseModelList(raw);
    if (!models.length && !j) return { ok: false, status: r.status, models: [], error: tr('返回不是 JSON 模型列表'), ms: Date.now() - t0 };
    return { ok: true, status: r.status, models, ...(modelNames ? { modelNames } : {}), ...(modelEfforts ? { modelEfforts } : {}), ...(modelContext ? { modelContext } : {}), ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, models: [], error: e?.name === 'AbortError' ? LIST_TIMEOUT : e?.cause?.message ?? e?.message ?? String(e), ms: Date.now() - t0 };
  }
}

/** A profile's model list older than this is pulled again in the background at startup. */
export const MODEL_REFRESH_MAX_AGE = 24 * 3600_000;
/** How many model-list requests run at once (a user may have many relays behind one slow network). */
const MODEL_REFRESH_CONCURRENCY = 4;

/** Startup auto refresh: a keyed, non-gateway profile whose list was never pulled or is older than a day. */
export function needsModelRefresh(p: Provider, now = Date.now(), maxAge = MODEL_REFRESH_MAX_AGE): boolean {
  if (p.type === 'gateway' || !p.apiKey) return false;
  return !p.modelsAt || now - p.modelsAt > maxAge;
}

export class ProviderService {
  private revealed = new Map<string, string>(); // stored (possibly encrypted) value -> plaintext
  /** Set by the server once the model gateway is up: group id → local endpoint + gateway key (null = unavailable). */
  gatewayEndpoint: ((groupId: string) => { baseUrl: string; key: string; runtime?: RuntimeKind; leanTools?: boolean } | null) | null = null;
  /** Set by the server: the prompt-cache shim for an openai / grok profile (null = not listening yet). */
  shimEndpoint: ((providerId: string) => { base: string; key: string } | null) | null = null;
  /** Set by the channel service: a free-only source keeps only its free models from the pulled list (channels/catalog.ts). */
  modelFilter: ((providerId: string, models: string[]) => string[]) | null = null;
  private keepModels(id: string, models: string[]): string[] { return this.modelFilter ? this.modelFilter(id, models) : models; }
  constructor(readonly meta: MetaStore, private secrets?: SecretService) {
    if (secrets) meta.secretCodec = { protect: async (plain, id) => { const enc = await secrets.protect(plain, id); this.revealed.set(enc, plain); return enc; } };
  }
  /** Decrypt every stored key once (startup) so session spawns stay synchronous. */
  async warm() {
    for (const p of this.meta.providers()) {
      if (!p.apiKey) continue;
      try { this.revealed.set(p.apiKey, this.secrets ? await this.secrets.reveal(p.apiKey) : p.apiKey); } catch (e) { console.error(`[providers] cannot decrypt key of ${p.name}:`, (e as Error).message); }
    }
  }
  private plainKey(p: Provider): string {
    if (!p.apiKey) return '';
    const hit = this.revealed.get(p.apiKey);
    if (hit !== undefined) return hit;
    if (!p.apiKey.startsWith('enc:')) return p.apiKey;
    throw new Error(tr('供应商「{name}」的密钥无法解密（换了用户或机器？请重新输入）', { name: p.name }));
  }
  secretsStatus() {
    const all = this.meta.providers();
    return { scheme: this.secrets?.scheme ?? 'plain', total: all.filter((p) => p.apiKey).length, protected: all.filter((p) => p.apiKey?.startsWith('enc:')).length };
  }
  /** Re-protect legacy plaintext keys with the platform scheme. */
  async migrateSecrets() {
    if (!this.secrets) return;
    for (const p of this.meta.providers()) if (p.apiKey && !p.apiKey.startsWith('enc:')) await this.meta.upsertProvider({ id: p.id, apiKey: p.apiKey });
  }

  list(): Provider[] {
    return this.meta.providers().map(publicProvider);
  }
  /** A saved provider of this kind on this endpoint with this key (an import does not add it twice). */
  hasSame(type: Provider['type'], baseUrl: string, apiKey: string): boolean {
    return this.meta.providers().some((p) => {
      if (p.type !== type || !sameBase(p.baseUrl, baseUrl)) return false;
      try { return this.plainKey(p) === apiKey; } catch { return false; }
    });
  }
  /** Resolve for a session: undefined = claude.ai login. */
  forSession(id: string | undefined): SessionProvider | undefined {
    if (!id || id === CLAUDE_PROVIDER_ID) return undefined;
    const p = this.meta.provider(id);
    if (!p) throw new Error(tr('供应商不存在：{id}', { id }));
    if (p.type === 'gateway') {
      const ep = this.gatewayEndpoint?.(p.gatewayGroupId ?? '');
      if (!ep) throw new Error(tr('供应商「{name}」走模型网关，但网关没有启用或组不存在（设置 → 模型网关）', { name: p.name }));
      // runtime: the profile's explicit choice, else what the group's relays need (GatewayService.needsOfficialClient)
      return { ...p, baseUrl: ep.baseUrl, apiKey: ep.key, runtime: p.runtime ?? ep.runtime, leanTools: ep.leanTools };
    }
    if (!p.baseUrl && (p.type === 'anthropic' || p.type === 'openai')) throw new Error(tr('供应商「{name}」没有 Base URL', { name: p.name }));
    if (!p.apiKey) throw new Error(tr('供应商「{name}」没有 API Key', { name: p.name }));
    const out: SessionProvider = { ...p, apiKey: this.plainKey(p) };
    // OpenAI-compatible profiles: through the local cache shim (profile switch cacheShim, default on)
    if ((p.type === 'openai' || p.type === 'grok') && p.cacheShim !== false) {
      const s = this.shimEndpoint?.(p.id);
      if (s) out.shim = s;
    }
    return out;
  }
  /** A profile a subagent pick names (gateway/split.ts): its kind, another account's token; null when missing / unreadable. */
  subagentTarget(id: string): { type: Provider['type']; token?: string; groupId?: string } | null {
    const p = this.meta.provider(id);
    if (!p) return null;
    if (p.type === 'gateway') return p.gatewayGroupId ? { type: p.type, groupId: p.gatewayGroupId } : null;
    if (p.type !== 'claude-account') return { type: p.type };
    try { return { type: p.type, token: this.plainKey(p) }; } catch { return null; }
  }
  /** A gateway member: the profile with its plaintext key, or null when missing / undecryptable / itself a gateway. */
  member(id: string): Provider | null {
    const p = this.meta.provider(id);
    // a Claude account profile is a member too: the gateway sends it as an Anthropic login (Bearer + oauth beta)
    if (!p || p.type === 'gateway') return null;
    try { return { ...p, apiKey: this.plainKey(p) }; } catch { return null; }
  }
  /**
   * Extra env + global args for a non-Claude agent session that picked a gateway or OpenAI-compatible profile
   * (nothing for any other type). Without this Codex ignores the profile and talks to api.openai.com.
   */
  agentLaunch(id: string | undefined, agent: 'codex' | 'acp', kind?: string, sessionId?: string): { env: Record<string, string>; args: string[] } {
    // its own login (no profile): 隐私保护 reaches Codex / Gemini CLI through their endpoint overrides (privacy/agents.ts)
    if (!id || id === CLAUDE_PROVIDER_ID) return ownLoginLaunch(kind ?? (agent === 'codex' ? 'codex' : undefined), (t) => privacyRoute(t));
    const type = this.meta.provider(id)?.type;
    if (type === 'openai') {
      const p = this.forSession(id)!;
      if (agent === 'codex') {
        // Codex only speaks /v1/responses: through the cache shim (when on), which forwards that as it is and turns
        // it into chat/completions for relays without the Responses API (most of them) — direct, those 404
        const base = p.shim ? shimBaseUrl(p.shim, sessionId) : viaPrivacy(openaiBase(p.baseUrl));
        const key = p.shim ? p.shim.key : p.apiKey;
        // the default model's context window (Codex assumes its own for a model it does not know)
        const window = p.defaultModel ? contextWindowFor(p, p.defaultModel) : undefined;
        return { env: { OPENAI_BASE_URL: base, OPENAI_API_KEY: key, [CODEX_KEY_ENV]: key }, args: [...codexProviderArgs(base, p.name, p.defaultModel), ...(window ? ['-c', `model_context_window=${window}`] : [])] };
      }
      const env: Record<string, string> = { OPENAI_BASE_URL: viaPrivacy(openaiBase(p.baseUrl)), OPENAI_API_KEY: p.apiKey };
      if (p.defaultModel) env.OPENAI_MODEL = p.defaultModel;
      return { env, args: [] };
    }
    // a Gemini API profile for Gemini CLI: its own key variables, with the API-key auth type forced over a cached Google login
    if (type === 'gemini' && kind === 'gemini') {
      const p = this.forSession(id)!;
      const env: Record<string, string> = { GEMINI_API_KEY: p.apiKey, ...geminiApiKeyEnv() };
      // Gemini CLI's SDK appends `/v1beta/models/…` to this host; 隐私保护 on → through the relay
      const routed = privacyRoute(p.baseUrl || 'https://generativelanguage.googleapis.com');
      if (routed ?? p.baseUrl) env.GOOGLE_GEMINI_BASE_URL = (routed ?? p.baseUrl)!;
      if (p.defaultModel) env.GEMINI_MODEL = p.defaultModel;
      return { env, args: [] };
    }
    if (type !== 'gateway') return { env: {}, args: [] };
    const p = this.forSession(id)!;
    const env = providerEnv(p, agent);
    // account logins must not win over the gateway: Codex gets its own provider, Gemini CLI a forced auth type
    if (agent === 'codex') return { env, args: codexGatewayArgs(p.baseUrl, p.defaultModel) };
    // the settings override is Gemini CLI's own mechanism; other ACP agents (Qwen Code…) only get the env
    return { env: kind === 'gemini' ? { ...env, ...geminiApiKeyEnv() } : env, args: [] };
  }
  /**
   * Pull the model list (`/v1/models` or the type's equivalent) of many profiles at once — the same request
   * as the probe's first half, never a chat request, so it costs nothing. Success stores `models` + `modelsAt`
   * and clears `modelsError`; a failure records `modelsError` and keeps the previous list (a relay that is
   * down for an hour must not empty the picker). Gateway profiles are skipped: their models are the union of
   * their group's members, computed where they are shown.
   */
  async refreshModels(ids?: string[]): Promise<ModelRefreshResult[]> {
    const all = this.meta.providers();
    const targets: (Provider | string)[] = ids ? ids.map((id) => all.find((p) => p.id === id) ?? id) : all.filter((p) => p.type !== 'gateway');
    const out: ModelRefreshResult[] = new Array(targets.length);
    const one = async (t: Provider | string): Promise<ModelRefreshResult> => {
      if (typeof t === 'string') return { id: t, name: t, ok: false, count: 0, error: tr('没有这个供应商档案'), ms: 0 };
      const base = { id: t.id, name: t.name };
      if (t.type === 'gateway') return { ...base, ok: false, count: 0, error: tr('模型网关档案的模型来自组成员'), ms: 0 };
      // a Claude account's models are the account's (the catalog), not a list to pull
      if (t.type === 'claude-account') {
        if (!(await this.meta.upsertProvider({ id: t.id, ...accountModels(), modelsAt: Date.now(), modelsError: null as unknown as undefined }, { mustExist: true }))) return { ...base, ok: false, count: 0, error: tr('这个账号已移除'), ms: 0 };
        return { ...base, ok: true, count: accountModels().models.length, ms: 0 };
      }
      let key = '';
      try { key = this.plainKey(t); } catch (e) { return { ...base, ok: false, count: 0, error: (e as Error).message, ms: 0 }; }
      if (!key) return { ...base, ok: false, count: 0, error: tr('没有 API Key'), ms: 0 };
      const r = await probeProvider({ type: t.type, baseUrl: t.baseUrl, apiKey: key, authStyle: t.authStyle });
      // the profile may have been deleted while the request was out: write back only onto one that still exists
      const gone = { ...base, ok: false, count: 0, error: tr('供应商已删除'), ms: r.ms };
      if (!r.ok) {
        const error = r.error || `HTTP ${r.status ?? '?'}`;
        if (!(await this.meta.upsertProvider({ id: t.id, modelsError: error }, { mustExist: true }))) return gone;
        return { ...base, ok: false, count: 0, error, ms: r.ms };
      }
      // a relay answering 200 with nothing (maintenance, a broken proxy) must not empty a list that worked yesterday
      if (!r.models.length && this.meta.provider(t.id)?.models?.length) {
        const error = tr('返回空列表（保留原列表）');
        if (!(await this.meta.upsertProvider({ id: t.id, modelsError: error }, { mustExist: true }))) return gone;
        return { ...base, ok: false, count: 0, error, ms: r.ms };
      }
      // null clears the field (upsertProvider drops null-valued optional keys)
      if (!(await this.meta.upsertProvider({ id: t.id, models: this.keepModels(t.id, r.models), modelNames: (r.modelNames ?? null) as unknown as undefined, modelEfforts: (r.modelEfforts ?? null) as unknown as undefined, modelContext: (r.modelContext ?? null) as unknown as undefined, modelsAt: Date.now(), modelsError: null as unknown as undefined }, { mustExist: true }))) return gone;
      return { ...base, ok: true, count: r.models.length, ms: r.ms };
    };
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const i = next++;
        out[i] = await one(targets[i]).catch((e) => ({ id: typeof targets[i] === 'string' ? targets[i] as string : (targets[i] as Provider).id, name: '', ok: false, count: 0, error: (e as Error).message, ms: 0 }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(MODEL_REFRESH_CONCURRENCY, targets.length) }, worker));
    return out;
  }
  /**
   * Background refresh after startup: every profile whose list is missing or older than a day. The timer is
   * unref'd so it never holds the process open; failures only land in `modelsError`.
   */
  autoRefreshModels(delayMs = 5000): Promise<ModelRefreshResult[]> {
    // off switch for test servers (scripts/e2e.mjs): a background pull would race the checks' request counts
    if (process.env.CW_NO_MODEL_REFRESH) return Promise.resolve([]);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const due = this.meta.providers().filter((p) => needsModelRefresh(p)).map((p) => p.id);
        (due.length ? this.refreshModels(due) : Promise.resolve([])).then(resolve, (e) => { console.error('[providers] model refresh failed:', (e as Error).message); resolve([]); });
      }, delayMs);
      t.unref?.();
    });
  }
  /** Why profile `id` cannot drive `agent` (null = it can); for Claude the engine it would actually run on counts. */
  fitError(id: string | undefined, agent: AgentKind): string | null {
    if (!id || id === CLAUDE_PROVIDER_ID) return null;
    const p = this.meta.provider(id);
    if (!p) return tr('供应商不存在：{id}', { id });
    return profileFitError(agent, p.type, agent === 'claude' && p.type !== 'gateway' ? resolveEngine(preferredRuntime(p)).kind : undefined);
  }
  async upsert(p: Partial<Provider> & { id?: string }) {
    const type = p.type ?? (p.id ? this.meta.provider(p.id)?.type : undefined);
    // another Claude account: no endpoint of its own, the account's models
    if (type === 'claude-account') p = { ...p, baseUrl: '', ...accountModels(), modelsAt: Date.now() };
    // one base rule for every path: an Anthropic base is stored without its /v1 (the CLI appends /v1/messages)
    if (type === 'anthropic' && typeof p.baseUrl === 'string') p = { ...p, baseUrl: anthropicBase(p.baseUrl) };
    // the user added a group's profile by hand: the auto-creation is welcome again if they delete this one
    if (type === 'gateway' && p.gatewayGroupId) {
      const cfg = this.meta.gatewayConfig();
      if (cfg.dismissedProfiles?.includes(p.gatewayGroupId)) {
        cfg.dismissedProfiles = cfg.dismissedProfiles.filter((x) => x !== p.gatewayGroupId);
        await this.meta.saveGateway();
      }
    }
    return publicProvider(await this.meta.upsertProvider(p));
  }
  async remove(id: string) {
    // a group's auto profile: deleting it says "I do not want this group in the menu", so it is not recreated
    const p = this.meta.provider(id);
    if (p?.type === 'gateway' && p.gatewayGroupId) {
      const cfg = this.meta.gatewayConfig();
      const list = new Set(cfg.dismissedProfiles ?? []);
      list.add(p.gatewayGroupId);
      cfg.dismissedProfiles = [...list];
      // who was in it then: an account added to it later brings it back (gateway/service.ts syncProfiles)
      const g = this.meta.gatewayGroups().find((x) => x.id === p.gatewayGroupId);
      cfg.dismissedMembers = { ...cfg.dismissedMembers, [p.gatewayGroupId]: (g?.members ?? []).map(memberKey) };
      await this.meta.saveGateway();
    }
    await this.meta.removeProvider(id);
  }
  /**
   * Probe a saved profile (by id, keeps the stored key) or an unsaved draft; saves the model list on success.
   * `listOnly`: the model list and nothing else (no chat request, no tokens) — the quick connect uses it to decide the
   * format and the model before the real check.
   */
  async probe(id?: string, draft?: Partial<Provider>, opts: { listOnly?: boolean } = {}): Promise<ProbeResult> {
    const saved = id ? this.meta.provider(id) : undefined;
    if ((draft?.type ?? saved?.type) === 'claude-account') return this.probeAccount(saved, draft, opts);
    if ((draft?.type ?? saved?.type) === 'gateway') return { ok: false, models: [], error: tr('走模型网关的供应商请在「设置 → 模型网关」里用组的「测试」按钮'), ms: 0 };
    const key = draft?.apiKey && !draft.apiKey.includes('…') ? draft.apiKey : saved ? this.plainKey(saved) : '';
    const p = { type: draft?.type ?? saved?.type ?? 'anthropic', baseUrl: (draft?.baseUrl ?? saved?.baseUrl ?? '').trim(), apiKey: key.trim(), authStyle: draft?.authStyle ?? saved?.authStyle } as Pick<Provider, 'type' | 'baseUrl' | 'apiKey' | 'authStyle'>;
    if (!p.apiKey) return { ok: false, models: [], error: tr('没有 API Key'), ms: 0 };
    const r = await probeProvider(p);
    if (r.ok && saved && r.models.length) await this.meta.upsertProvider({ id: saved.id, models: this.keepModels(saved.id, r.models), modelNames: (r.modelNames ?? null) as unknown as undefined, modelEfforts: (r.modelEfforts ?? null) as unknown as undefined, modelContext: (r.modelContext ?? null) as unknown as undefined, modelsAt: Date.now(), modelsError: null as unknown as undefined }, { mustExist: true });
    if (opts.listOnly || !r.ok || (p.type !== 'anthropic' && p.type !== 'openai')) return r;
    // Real chat check, with automatic fallback to the official binary when the endpoint rejects ccb.
    const full: Provider = { id: saved?.id ?? 'draft', name: draft?.name ?? saved?.name ?? 'draft', createdAt: 0, ...saved, ...p, defaultModel: draft?.defaultModel ?? saved?.defaultModel, modelMap: draft?.modelMap ?? saved?.modelMap };
    // Anthropic endpoints: a haiku (the check runs a whole CLI turn); OpenAI-compatible ones: a real chat model — the
    // list is sorted by name, and its first entry is as often an embedding or image model as anything
    // a key whose list has nothing to talk to (an image-only key: gpt-image-2 …) says so, instead of a chat check on an image model
    if (!full.defaultModel && r.models.length && !r.models.some(isChatModel)) return { ...r, ok: false, error: tr('列表里没有聊天模型（只有 {models}{v}）：这个 Key 不能用来对话', { models: r.models.slice(0, 3).join('、'), v: r.models.length > 3 ? tr(' 等') : '' }) };
    const model = full.defaultModel || (p.type === 'anthropic' ? claudeFamilyMap(r.models).haiku ?? r.models.find(isChatModel) : pickChatModel(r.models)) || r.models[0] || 'haiku';
    // OpenAI-compatible relays don't fingerprint the client, so one tiny chat request proves the key; a CLI
    // round would cost a whole Claude Code system prompt (~50k tokens) per click.
    if (p.type === 'openai') {
      const chat = await openaiChatProbe(full, model);
      // the cache shim sends gpt-* to /v1/responses (unless switched off): check that path too, and record what it
      // proves — works → clear a stale "no Responses API"; no such endpoint while chat works → remember it
      const shimResponses = (draft?.cacheShim ?? saved?.cacheShim) !== false && (draft?.responsesApi ?? saved?.responsesApi) !== false;
      let responses: ChatProbe | undefined;
      if (shimResponses && wantsResponses(model)) {
        responses = await openaiResponsesProbe(full, model);
        const missing = !responses.ok && [404, 405, 501].includes(responses.status ?? 0) && !/model/i.test(responses.error ?? '');
        if (saved && (responses.ok || (missing && chat.ok))) await this.meta.upsertProvider({ id: saved.id, noResponsesApi: responses.ok ? (null as unknown as undefined) : true }, { mustExist: true });
      }
      return { ...r, ok: chat.ok, chat, ...(responses ? { responses } : {}), error: chat.ok ? undefined : chat.error };
    }
    const explicit = (draft?.runtime ?? saved?.runtime) as RuntimeKind | undefined;
    let chat = await chatProbe(full, explicit, model);
    if (!chat.ok && chat.runtime === 'ccb' && !explicit && worthOfficialRetry(chat.error)) {
      const again = await chatProbe(full, 'claude', model);
      if (again.ok) {
        chat = { ...again, switched: true };
        if (saved) await this.meta.upsertProvider({ id: saved.id, runtime: 'claude' }, { mustExist: true });
      } else chat = { ...again, error: tr('ccb: {error} · 官方: {error2}', { error: chat.error, error2: again.error }) };
    }
    return { ...r, ok: chat.ok, chat, error: chat.ok ? undefined : chat.error };
  }

  /**
   * Another Claude account: no model list to pull (the account's are the catalog's) — one real turn on haiku with its
   * token, through the engine a conversation on it would use (`listOnly`: the token's shape only, nothing sent).
   */
  private async probeAccount(saved: Provider | undefined, draft: Partial<Provider> | undefined, opts: { listOnly?: boolean }): Promise<ProbeResult> {
    const key = (draft?.apiKey && !draft.apiKey.includes('…') ? draft.apiKey : saved ? this.plainKey(saved) : '').trim();
    const { models, modelNames } = accountModels();
    if (!key) return { ok: false, models: [], error: tr('没有令牌'), ms: 0 };
    if (!OAUTH_TOKEN.test(key)) return { ok: false, models: [], error: tr('这不像 claude setup-token 打出来的令牌（应该以 sk-ant-oat 开头）'), ms: 0 };
    if (opts.listOnly) return { ok: true, models, modelNames, ms: 0 };
    const full: Provider = { id: saved?.id ?? 'draft', name: draft?.name ?? saved?.name ?? 'draft', createdAt: 0, ...saved, type: 'claude-account', baseUrl: '', apiKey: key };
    const chat = await chatProbe(full, (draft?.runtime ?? saved?.runtime) as RuntimeKind | undefined, 'haiku');
    return { ok: chat.ok, models, modelNames, ms: chat.ms, chat, error: chat.ok ? undefined : chat.error };
  }
}
