import os from 'node:os';
import { sameBase } from '../import/service.js';
import { CLAUDE_PROVIDER_ID, type AgentKind, type ModelRefreshResult, type Provider } from '../protocol.js';
import type { MetaStore } from '../meta/store.js';
import { runClaudeCli } from '../claude-exe.js';
import type { SecretService } from '../secrets/service.js';
import { listedContext } from '../models/context-window.js';
import { claudeFamilyMap, isChatModel, modelsFor, profileFitError } from '../models/catalog.js';
import { settingsOverride } from '../runtime/user-env.js';
import { writeFlagSettings, type FlagSettings } from '../runtime/flag-settings.js';
import { tr } from '../i18n/index.js';
import { anthropicBase, authHeaders } from './endpoint.js';
import { privacyRoute, viaPrivacy } from '../privacy/route.js';

/** The vendor's default base (what the CLI uses when nothing names one) — the privacy relay needs it spelled out. */
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

/** A profile resolved for one session (plaintext key). */
export type SessionProvider = Provider;

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

/**
 * NO_PROXY / no_proxy with the loopback hosts added, when the base URL in `env` is local (the privacy relay, a relay
 * of the user's on this machine). The CLI honours HTTP(S)_PROXY for every API call; a proxy from the user's environment (common where
 * the relay needs one) would otherwise get our 127.0.0.1 requests — a remote proxy cannot reach them and the turn
 * hangs. What the user already listed is kept. Nothing to add → `{}`.
 */
export function loopbackNoProxy(env: Record<string, string | undefined>): Record<string, string> {
  let local = false;
  try { local = LOOPBACK.includes(new URL(env.ANTHROPIC_BASE_URL ?? '').hostname.replace(/^\[|\]$/g, '')); } catch { /* not a URL */ }
  if (!local) return {};
  const have = [env.NO_PROXY, env.no_proxy].flatMap((v) => (v ?? '').split(',')).map((s) => s.trim()).filter(Boolean);
  const all = [...new Set([...have, ...LOOPBACK])].join(',');
  return { NO_PROXY: all, no_proxy: all };
}

/**
 * Map a provider profile to the env the runtime reads. Only what the CLI needs — the profile itself never
 * touches ~/.claude/settings.json, so the claude.ai login keeps working for sessions without a provider.
 */
export function providerEnv(p: SessionProvider): Record<string, string> {
  // Relays that fingerprint Claude Code (super-nb & co.) reject the `agent-sdk/x.y.z` User-Agent suffix the SDK
  // makes the CLI add. spawnClaude() strips that env when this marker is present, so the request looks like `claude -p`.
  // Same for the entrypoint tag: such relays accept the CLI's own default (`cli`) and reject `sdk-ts`.
  const env: Record<string, string> = { CLAUDE_WEB_PLAIN_UA: '1', CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const m = p.modelMap ?? {};
  switch (p.type) {
    case 'anthropic':
      // without a trailing /v1: the CLI appends /v1/messages itself (a pasted `…/v1` became /v1/v1/messages)
      // 隐私保护 on: through the local privacy relay (privacy/route.ts)
      env.ANTHROPIC_BASE_URL = viaPrivacy(anthropicBase(p.baseUrl));
      // Bearer by default — what relays like super-nb expect; official API keys work through it too. authStyle
      // x-api-key → ANTHROPIC_API_KEY only ('' counts as unset for the CLI); both → both variables.
      if (p.authStyle === 'x-api-key') { env.ANTHROPIC_API_KEY = p.apiKey; env.ANTHROPIC_AUTH_TOKEN = ''; }
      else {
        env.ANTHROPIC_AUTH_TOKEN = p.apiKey;
        if (p.authStyle === 'both') env.ANTHROPIC_API_KEY = p.apiKey;
      }
      if (p.defaultModel) env.ANTHROPIC_MODEL = p.defaultModel;
      if (m.haiku) { env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku; env.ANTHROPIC_SMALL_FAST_MODEL = m.haiku; }
      if (m.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet;
      if (m.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus;
      // 1-hour cache TTL on every breakpoint (2x base write price instead of 1.25x); opt-in per profile
      if (p.cache1h) env.ENABLE_PROMPT_CACHING_1H = '1';
      break;
    // another Claude account: the CLI's own way to run on a subscription token, the rest exactly as on the account
    // (the runner takes the account path for it). A relay's token / base URL in this process's environment would win
    // over the OAuth token: blanked ('' counts as unset for the CLI)
    case 'claude-account':
      env.CLAUDE_CODE_OAUTH_TOKEN = p.apiKey;
      env.ANTHROPIC_AUTH_TOKEN = '';
      env.ANTHROPIC_API_KEY = '';
      // 隐私保护 on: the CLI sends its OAuth token to whatever base it is given,
      // so the account's traffic goes through the relay to api.anthropic.com
      env.ANTHROPIC_BASE_URL = privacyRoute(ANTHROPIC_DEFAULT_BASE) ?? '';
      break;
  }
  return env;
}

/** Same base the session will use, so a URL that probes fine also works in the session. */
const modelsUrl = (baseUrl: string) => `${anthropicBase(baseUrl.replace(/\/+$/, ''))}/v1/models`;

export interface ChatProbe { ok: boolean; model: string; error?: string; ms: number; status?: number }
export interface ProbeResult { ok: boolean; status?: number; models: string[]; modelNames?: Record<string, string>; modelEfforts?: Provider['modelEfforts']; modelContext?: Provider['modelContext']; error?: string; ms: number; chat?: ChatProbe }

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
 * welcome page's default project (2026-10-01).
 */
const PROBE_TIMEOUT_MS = 120_000;

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
 * alone cannot tell whether a relay accepts this client: some (super-nb) fingerprint the official Claude Code build.
 * Cheap (a few tokens) and definitive.
 */
export async function chatProbe(p: Provider, model: string): Promise<ChatProbe> {
  const t0 = Date.now();
  // one retry, not the CLI's ten: a relay answering 5xx kept 测试连接 spinning for 4 minutes, then said "exit 1"
  const env: Record<string, string> = { ...providerEnv(p), CLAUDE_CODE_MAX_RETRIES: '1' };
  // the privacy relay is on 127.0.0.1: a system proxy must not get that request
  Object.assign(env, loopbackNoProxy({ ...env, NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy }));
  delete env.CLAUDE_WEB_PLAIN_UA; // not spawned through the SDK: the CLI already sends its plain User-Agent
  // a token / base URL in the user's settings.json would otherwise be tested instead of this provider's (user-env)
  const override = settingsOverride(env, os.tmpdir());
  let flag: FlagSettings | null = null;
  try { flag = override ? writeFlagSettings(override) : null; } catch { /* tested as the session would run without it */ }
  const r = await runClaudeCli([...chatProbeArgs(model), ...(flag ? ['--settings', flag.file] : [])], { cwd: os.tmpdir(), timeoutMs: PROBE_TIMEOUT_MS, env }).finally(() => flag?.dispose());
  const ms = Date.now() - t0;
  let out: any = null;
  try { out = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? ''); } catch { /* not json */ }
  if (out && out.type === 'result' && !out.is_error) return { ok: true, model, ms };
  if (r.timedOut && !out) return { ok: false, model, error: tr('超时：{PROBE_TIMEOUT_MS} 秒内没有收到回答（中转没有回应，或一直在报错重试）', { PROBE_TIMEOUT_MS: PROBE_TIMEOUT_MS / 1000 }), ms };
  // an error result carries `errors` / `subtype` rather than `result`; stderr is often just a warning line
  const stderr = r.stderr.split('\n').filter((l) => l.trim() && !/^Warning: no stdin data/.test(l)).join(' ');
  const err = (out?.result ?? (Array.isArray(out?.errors) && out.errors.length ? out.errors.join('; ') : undefined) ?? out?.error ?? (out?.is_error ? out.subtype : undefined) ?? (stderr || r.stdout)).toString().replace(/\s+/g, ' ').trim().slice(0, 300) || `exit ${r.code}`;
  return { ok: false, model, error: err, ms };
}

/**
 * Connectivity + auth check via the model list endpoint. We deliberately do not send a /messages request:
 * relays that only accept Claude Code clients reject anything else, and the list is enough to verify the key.
 */
export async function probeProvider(p: Pick<Provider, 'baseUrl' | 'apiKey' | 'authStyle'>, retryMs = 1000): Promise<ProbeResult> {
  const r = await listModels(p);
  // the request never got an answer (connection reset, connect timeout on a flaky route — seen on real relays): once
  // more before telling the user the address is wrong. An HTTP answer, or our own 20 s timeout, is final.
  if (r.ok || r.status !== undefined || r.error === LIST_TIMEOUT) return r;
  await new Promise((res) => setTimeout(res, retryMs));
  const again = await listModels(p);
  return { ...again, ms: (again.ms ?? 0) + (r.ms ?? 0) + retryMs };
}

const LIST_TIMEOUT = tr('连接超时（20s）');

async function listModels(p: Pick<Provider, 'baseUrl' | 'apiKey' | 'authStyle'>): Promise<ProbeResult> {
  const t0 = Date.now();
  const url = modelsUrl(p.baseUrl);
  // the profile's style; unset = what this probe always sent (both headers)
  const headers: Record<string, string> = { accept: 'application/json', 'anthropic-version': '2023-06-01', ...authHeaders(p.authStyle, p.apiKey, 'both') };
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

/** Startup auto refresh: a keyed profile whose list was never pulled or is older than a day. */
export function needsModelRefresh(p: Provider, now = Date.now(), maxAge = MODEL_REFRESH_MAX_AGE): boolean {
  if (!p.apiKey) return false;
  return !p.modelsAt || now - p.modelsAt > maxAge;
}

export class ProviderService {
  private revealed = new Map<string, string>(); // stored (possibly encrypted) value -> plaintext
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
  secretsStatus(): import('../protocol.js').SecretsStatus {
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
    if (!p.baseUrl && p.type === 'anthropic') throw new Error(tr('供应商「{name}」没有 Base URL', { name: p.name }));
    if (!p.apiKey) throw new Error(tr('供应商「{name}」没有 API Key', { name: p.name }));
    return { ...p, apiKey: this.plainKey(p) };
  }
  /**
   * Pull the model list (`/v1/models` or the type's equivalent) of many profiles at once — the same request
   * as the probe's first half, never a chat request, so it costs nothing. Success stores `models` + `modelsAt`
   * and clears `modelsError`; a failure records `modelsError` and keeps the previous list (a relay that is
   * down for an hour must not empty the picker).
   */
  async refreshModels(ids?: string[]): Promise<ModelRefreshResult[]> {
    const all = this.meta.providers();
    const targets: (Provider | string)[] = ids ? ids.map((id) => all.find((p) => p.id === id) ?? id) : all;
    const out: ModelRefreshResult[] = new Array(targets.length);
    const one = async (t: Provider | string): Promise<ModelRefreshResult> => {
      if (typeof t === 'string') return { id: t, name: t, ok: false, count: 0, error: tr('没有这个供应商档案'), ms: 0 };
      const base = { id: t.id, name: t.name };
      // a Claude account's models are the account's (the catalog), not a list to pull
      if (t.type === 'claude-account') {
        if (!(await this.meta.upsertProvider({ id: t.id, ...accountModels(), modelsAt: Date.now(), modelsError: null as unknown as undefined }, { mustExist: true }))) return { ...base, ok: false, count: 0, error: tr('这个账号已移除'), ms: 0 };
        return { ...base, ok: true, count: accountModels().models.length, ms: 0 };
      }
      let key = '';
      try { key = this.plainKey(t); } catch (e) { return { ...base, ok: false, count: 0, error: (e as Error).message, ms: 0 }; }
      if (!key) return { ...base, ok: false, count: 0, error: tr('没有 API Key'), ms: 0 };
      const r = await probeProvider({ baseUrl: t.baseUrl, apiKey: key, authStyle: t.authStyle });
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
      if (!(await this.meta.upsertProvider({ id: t.id, models: r.models, modelNames: (r.modelNames ?? null) as unknown as undefined, modelEfforts: (r.modelEfforts ?? null) as unknown as undefined, modelContext: (r.modelContext ?? null) as unknown as undefined, modelsAt: Date.now(), modelsError: null as unknown as undefined }, { mustExist: true }))) return gone;
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
  /** Why profile `id` cannot drive `agent` (null = it can). */
  fitError(id: string | undefined, agent: AgentKind): string | null {
    if (!id || id === CLAUDE_PROVIDER_ID) return null;
    const p = this.meta.provider(id);
    if (!p) return tr('供应商不存在：{id}', { id });
    return profileFitError(agent, p.type);
  }
  async upsert(p: Partial<Provider> & { id?: string }) {
    const type = p.type ?? (p.id ? this.meta.provider(p.id)?.type : undefined);
    // another Claude account: no endpoint of its own, the account's models
    if (type === 'claude-account') p = { ...p, baseUrl: '', ...accountModels(), modelsAt: Date.now() };
    // one base rule for every path: an Anthropic base is stored without its /v1 (the CLI appends /v1/messages)
    if (type === 'anthropic' && typeof p.baseUrl === 'string') p = { ...p, baseUrl: anthropicBase(p.baseUrl) };
    return publicProvider(await this.meta.upsertProvider(p));
  }
  async remove(id: string) {
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
    const key = draft?.apiKey && !draft.apiKey.includes('…') ? draft.apiKey : saved ? this.plainKey(saved) : '';
    const p = { type: 'anthropic', baseUrl: (draft?.baseUrl ?? saved?.baseUrl ?? '').trim(), apiKey: key.trim(), authStyle: draft?.authStyle ?? saved?.authStyle } as Pick<Provider, 'type' | 'baseUrl' | 'apiKey' | 'authStyle'>;
    if (!p.apiKey) return { ok: false, models: [], error: tr('没有 API Key'), ms: 0 };
    const r = await probeProvider(p);
    if (r.ok && saved && r.models.length) await this.meta.upsertProvider({ id: saved.id, models: r.models, modelNames: (r.modelNames ?? null) as unknown as undefined, modelEfforts: (r.modelEfforts ?? null) as unknown as undefined, modelContext: (r.modelContext ?? null) as unknown as undefined, modelsAt: Date.now(), modelsError: null as unknown as undefined }, { mustExist: true });
    if (opts.listOnly || !r.ok) return r;
    // the real chat check: one CLI turn
    const full: Provider = { id: saved?.id ?? 'draft', name: draft?.name ?? saved?.name ?? 'draft', createdAt: 0, ...saved, ...p, defaultModel: draft?.defaultModel ?? saved?.defaultModel, modelMap: draft?.modelMap ?? saved?.modelMap };
    // a haiku (the check runs a whole CLI turn); a key whose list has nothing to talk to (an image-only key: gpt-image-2 …) says so, instead of a chat check on an image model
    if (!full.defaultModel && r.models.length && !r.models.some(isChatModel)) return { ...r, ok: false, error: tr('列表里没有聊天模型（只有 {models}{v}）：这个 Key 不能用来对话', { models: r.models.slice(0, 3).join('、'), v: r.models.length > 3 ? tr(' 等') : '' }) };
    const model = full.defaultModel || claudeFamilyMap(r.models).haiku || r.models.find(isChatModel) || r.models[0] || 'haiku';
    const chat = await chatProbe(full, model);
    return { ...r, ok: chat.ok, chat, error: chat.ok ? undefined : chat.error };
  }

  /**
   * Another Claude account: no model list to pull (the account's are the catalog's) — one real turn on haiku with its
   * token, the way a conversation on it runs (`listOnly`: the token's shape only, nothing sent).
   */
  private async probeAccount(saved: Provider | undefined, draft: Partial<Provider> | undefined, opts: { listOnly?: boolean }): Promise<ProbeResult> {
    const key = (draft?.apiKey && !draft.apiKey.includes('…') ? draft.apiKey : saved ? this.plainKey(saved) : '').trim();
    const { models, modelNames } = accountModels();
    if (!key) return { ok: false, models: [], error: tr('没有令牌'), ms: 0 };
    if (!OAUTH_TOKEN.test(key)) return { ok: false, models: [], error: tr('这不像 claude setup-token 打出来的令牌（应该以 sk-ant-oat 开头）'), ms: 0 };
    if (opts.listOnly) return { ok: true, models, modelNames, ms: 0 };
    const full: Provider = { id: saved?.id ?? 'draft', name: draft?.name ?? saved?.name ?? 'draft', createdAt: 0, ...saved, type: 'claude-account', baseUrl: '', apiKey: key };
    const chat = await chatProbe(full, 'haiku');
    return { ok: chat.ok, models, modelNames, ms: chat.ms, chat, error: chat.ok ? undefined : chat.error };
  }
}
