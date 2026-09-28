import os from 'node:os';
import { CLAUDE_PROVIDER_ID, type AgentKind, type ModelRefreshResult, type Provider, type ProviderType, type RuntimeKind } from '../protocol.js';
import type { MetaStore } from '../meta/store.js';
import { resolveEngine, runClaudeCli } from '../claude-exe.js';
import type { SecretService } from '../secrets/service.js';
import { CODEX_KEY_ENV, codexGatewayArgs, codexProviderArgs, geminiApiKeyEnv } from '../gateway/agents.js';
import { profileFitError } from '../models/catalog.js';

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
 * Map a provider profile to the env the runtime reads. Only what the CLI needs — the profile itself never
 * touches ~/.claude/settings.json, so the claude.ai login keeps working for sessions without a provider.
 */
export function providerEnv(p: Provider, agent: 'claude' | 'codex' | 'acp' = 'claude'): Record<string, string> {
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
      env.ANTHROPIC_BASE_URL = p.baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = p.apiKey; // Bearer — what relays like super-nb expect; official API keys work through it too
      if (p.defaultModel) env.ANTHROPIC_MODEL = p.defaultModel;
      if (m.haiku) { env.ANTHROPIC_DEFAULT_HAIKU_MODEL = m.haiku; env.ANTHROPIC_SMALL_FAST_MODEL = m.haiku; }
      if (m.sonnet) env.ANTHROPIC_DEFAULT_SONNET_MODEL = m.sonnet;
      if (m.opus) env.ANTHROPIC_DEFAULT_OPUS_MODEL = m.opus;
      break;
    case 'openai':
      env.OPENAI_BASE_URL = openaiBase(p.baseUrl);
      env.OPENAI_API_KEY = p.apiKey;
      env.CLAUDE_CODE_USE_OPENAI = '1';
      if (p.defaultModel) env.OPENAI_MODEL = p.defaultModel;
      if (m.haiku) { env.OPENAI_DEFAULT_HAIKU_MODEL = m.haiku; env.OPENAI_SMALL_FAST_MODEL = m.haiku; }
      if (m.sonnet) env.OPENAI_DEFAULT_SONNET_MODEL = m.sonnet;
      if (m.opus) env.OPENAI_DEFAULT_OPUS_MODEL = m.opus;
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
      if (p.baseUrl) env.GEMINI_BASE_URL = geminiBase(p.baseUrl); // requests go to `<base>/models/<id>:streamGenerateContent`
      // the Gemini client throws for a family model it cannot map, so all three get a value
      const fallback = p.defaultModel || p.models?.[0];
      const fam = { HAIKU: m.haiku || fallback, SONNET: m.sonnet || fallback, OPUS: m.opus || fallback };
      for (const [k, v] of Object.entries(fam)) if (v) env[`GEMINI_DEFAULT_${k}_MODEL`] = v;
      break;
    }
    case 'grok': {
      env.CLAUDE_CODE_USE_GROK = '1';
      env.GROK_API_KEY = p.apiKey; // ccb: GROK_API_KEY || XAI_API_KEY
      if (p.baseUrl) env.GROK_BASE_URL = openaiBase(p.baseUrl); // an OpenAI SDK client: the base ends in /v1
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
  return /\/v\d+$/.test(b) ? `${b}/models` : `${b}/v1/models`;
}

export interface ChatProbe { ok: boolean; runtime: RuntimeKind | 'api'; model: string; error?: string; ms: number; switched?: boolean }
export interface ProbeResult { ok: boolean; status?: number; models: string[]; error?: string; ms: number; chat?: ChatProbe }

/**
 * One real one-shot turn through the CLI (`-p`), exactly the way a session will talk to the endpoint. The model list
 * alone cannot tell whether a relay accepts this client: some (super-nb) fingerprint the official Claude Code build
 * and reject ccb's request shape. Cheap (a few tokens) and definitive.
 */
export async function chatProbe(p: Provider, runtime: RuntimeKind | undefined, model: string): Promise<ChatProbe> {
  const t0 = Date.now();
  const kind = resolveEngine(runtime).kind;
  const env = { ...providerEnv(p) };
  delete env.CLAUDE_WEB_PLAIN_UA; // not spawned through the SDK: the CLI already sends its plain User-Agent
  const r = await runClaudeCli(['-p', 'Reply with exactly: ok', '--model', model, '--output-format', 'json', '--max-turns', '1'], { cwd: os.tmpdir(), timeoutMs: 120_000, runtime, env });
  const ms = Date.now() - t0;
  let out: any = null;
  try { out = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop() ?? ''); } catch { /* not json */ }
  if (out && out.type === 'result' && !out.is_error) return { ok: true, runtime: kind, model, ms };
  // an error result carries `errors` / `subtype` rather than `result`; stderr is often just a warning line
  const stderr = r.stderr.split('\n').filter((l) => l.trim() && !/^Warning: no stdin data/.test(l)).join(' ');
  const err = (out?.result ?? (Array.isArray(out?.errors) && out.errors.length ? out.errors.join('; ') : undefined) ?? out?.error ?? (out?.is_error ? out.subtype : undefined) ?? (stderr || r.stdout)).toString().replace(/\s+/g, ' ').trim().slice(0, 300) || `exit ${r.code}`;
  return { ok: false, runtime: kind, model, error: err, ms };
}

/** One minimal `/chat/completions` request (a few tokens) — the chat check for OpenAI-compatible profiles. */
export async function openaiChatProbe(p: Pick<Provider, 'baseUrl' | 'apiKey'>, model: string): Promise<ChatProbe> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${openaiBase(p.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
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
 * Connectivity + auth check via the model list endpoint. We deliberately do not send a /messages request:
 * relays that only accept Claude Code clients reject anything else, and the list is enough to verify the key.
 */
export async function probeProvider(p: Pick<Provider, 'type' | 'baseUrl' | 'apiKey'>): Promise<ProbeResult> {
  const t0 = Date.now();
  const url = modelsUrl(p.type, p.baseUrl);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (p.type === 'gemini') headers['x-goog-api-key'] = p.apiKey;
  else {
    headers.authorization = `Bearer ${p.apiKey}`;
    if (p.type === 'anthropic') { headers['x-api-key'] = p.apiKey; headers['anthropic-version'] = '2023-06-01'; }
  }
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 20_000);
    const r = await fetch(url, { headers, signal: ac.signal });
    const text = await r.text(); // still under the timeout: a relay that sends headers then stalls the body would hang the probe
    clearTimeout(to);
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* not json */ }
    // `||`: an empty body is an empty string, which would otherwise become the whole error message
    if (!r.ok) return { ok: false, status: r.status, models: [], error: j?.error?.message || j?.message || text.slice(0, 300) || `HTTP ${r.status}`, ms: Date.now() - t0 };
    const raw: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
    const models = raw.map((m) => String(m.id ?? m.name ?? m).replace(/^models\//, '')).filter(Boolean).sort();
    if (!models.length && !j) return { ok: false, status: r.status, models: [], error: '返回不是 JSON 模型列表', ms: Date.now() - t0 };
    return { ok: true, status: r.status, models, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, models: [], error: e?.name === 'AbortError' ? '连接超时（20s）' : e?.cause?.message ?? e?.message ?? String(e), ms: Date.now() - t0 };
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
  gatewayEndpoint: ((groupId: string) => { baseUrl: string; key: string; runtime?: RuntimeKind } | null) | null = null;
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
    throw new Error(`供应商「${p.name}」的密钥无法解密（换了用户或机器？请重新输入）`);
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
  /** Resolve for a session: undefined = claude.ai login. */
  forSession(id: string | undefined): Provider | undefined {
    if (!id || id === CLAUDE_PROVIDER_ID) return undefined;
    const p = this.meta.provider(id);
    if (!p) throw new Error(`供应商档案不存在：${id}`);
    if (p.type === 'gateway') {
      const ep = this.gatewayEndpoint?.(p.gatewayGroupId ?? '');
      if (!ep) throw new Error(`供应商「${p.name}」走模型网关，但网关没有启用或组不存在（设置 → 模型网关）`);
      // runtime: the profile's explicit choice, else what the group's relays need (GatewayService.needsOfficialClient)
      return { ...p, baseUrl: ep.baseUrl, apiKey: ep.key, runtime: p.runtime ?? ep.runtime };
    }
    if (!p.baseUrl && (p.type === 'anthropic' || p.type === 'openai')) throw new Error(`供应商「${p.name}」没有 Base URL`);
    if (!p.apiKey) throw new Error(`供应商「${p.name}」没有 API Key`);
    return { ...p, apiKey: this.plainKey(p) };
  }
  /** A gateway member: the profile with its plaintext key, or null when missing / undecryptable / itself a gateway. */
  member(id: string): Provider | null {
    const p = this.meta.provider(id);
    if (!p || p.type === 'gateway') return null;
    try { return { ...p, apiKey: this.plainKey(p) }; } catch { return null; }
  }
  /**
   * Extra env + global args for a non-Claude agent session that picked a gateway or OpenAI-compatible profile
   * (nothing for any other type). Without this Codex ignores the profile and talks to api.openai.com.
   */
  agentLaunch(id: string | undefined, agent: 'codex' | 'acp', kind?: string): { env: Record<string, string>; args: string[] } {
    const type = id && id !== CLAUDE_PROVIDER_ID ? this.meta.provider(id)?.type : undefined;
    if (type === 'openai') {
      const p = this.forSession(id)!;
      const base = openaiBase(p.baseUrl);
      const env: Record<string, string> = { OPENAI_BASE_URL: base, OPENAI_API_KEY: p.apiKey };
      if (p.defaultModel) env.OPENAI_MODEL = p.defaultModel;
      if (agent === 'codex') return { env: { ...env, [CODEX_KEY_ENV]: p.apiKey }, args: codexProviderArgs(base, p.name, p.defaultModel) };
      return { env, args: [] };
    }
    // a Gemini API profile for Gemini CLI: its own key variables, with the API-key auth type forced over a cached Google login
    if (type === 'gemini' && kind === 'gemini') {
      const p = this.forSession(id)!;
      const env: Record<string, string> = { GEMINI_API_KEY: p.apiKey, ...geminiApiKeyEnv() };
      if (p.baseUrl) env.GOOGLE_GEMINI_BASE_URL = p.baseUrl;
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
      if (typeof t === 'string') return { id: t, name: t, ok: false, count: 0, error: '没有这个供应商档案', ms: 0 };
      const base = { id: t.id, name: t.name };
      if (t.type === 'gateway') return { ...base, ok: false, count: 0, error: '模型网关档案的模型来自组成员', ms: 0 };
      let key = '';
      try { key = this.plainKey(t); } catch (e) { return { ...base, ok: false, count: 0, error: (e as Error).message, ms: 0 }; }
      if (!key) return { ...base, ok: false, count: 0, error: '没有 API Key', ms: 0 };
      const r = await probeProvider({ type: t.type, baseUrl: t.baseUrl, apiKey: key });
      // the profile may have been deleted while the request was out: write back only onto one that still exists
      const gone = { ...base, ok: false, count: 0, error: '档案已删除', ms: r.ms };
      if (!r.ok) {
        const error = r.error || `HTTP ${r.status ?? '?'}`;
        if (!(await this.meta.upsertProvider({ id: t.id, modelsError: error }, { mustExist: true }))) return gone;
        return { ...base, ok: false, count: 0, error, ms: r.ms };
      }
      // a relay answering 200 with nothing (maintenance, a broken proxy) must not empty a list that worked yesterday
      if (!r.models.length && this.meta.provider(t.id)?.models?.length) {
        const error = '返回空列表（保留原列表）';
        if (!(await this.meta.upsertProvider({ id: t.id, modelsError: error }, { mustExist: true }))) return gone;
        return { ...base, ok: false, count: 0, error, ms: r.ms };
      }
      // null clears the field (upsertProvider drops null-valued optional keys)
      if (!(await this.meta.upsertProvider({ id: t.id, models: r.models, modelsAt: Date.now(), modelsError: null as unknown as undefined }, { mustExist: true }))) return gone;
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
    if (!p) return `供应商档案不存在：${id}`;
    return profileFitError(agent, p.type, agent === 'claude' && p.type !== 'gateway' ? resolveEngine(p.runtime).kind : undefined);
  }
  async upsert(p: Partial<Provider> & { id?: string }) {
    return publicProvider(await this.meta.upsertProvider(p));
  }
  async remove(id: string) {
    await this.meta.removeProvider(id);
  }
  /** Probe a saved profile (by id, keeps the stored key) or an unsaved draft; saves the model list on success. */
  async probe(id?: string, draft?: Partial<Provider>): Promise<ProbeResult> {
    const saved = id ? this.meta.provider(id) : undefined;
    if ((draft?.type ?? saved?.type) === 'gateway') return { ok: false, models: [], error: '模型网关档案请在「设置 → 模型网关」里用组的「测试」按钮', ms: 0 };
    const key = draft?.apiKey && !draft.apiKey.includes('…') ? draft.apiKey : saved ? this.plainKey(saved) : '';
    const p = { type: draft?.type ?? saved?.type ?? 'anthropic', baseUrl: (draft?.baseUrl ?? saved?.baseUrl ?? '').trim(), apiKey: key.trim() } as Pick<Provider, 'type' | 'baseUrl' | 'apiKey'>;
    if (!p.apiKey) return { ok: false, models: [], error: '没有 API Key', ms: 0 };
    const r = await probeProvider(p);
    if (r.ok && saved && r.models.length) await this.meta.upsertProvider({ id: saved.id, models: r.models, modelsAt: Date.now(), modelsError: null as unknown as undefined }, { mustExist: true });
    if (!r.ok || (p.type !== 'anthropic' && p.type !== 'openai')) return r;
    // Real chat check, with automatic fallback to the official binary when the endpoint rejects ccb.
    const full: Provider = { id: saved?.id ?? 'draft', name: draft?.name ?? saved?.name ?? 'draft', createdAt: 0, ...saved, ...p, defaultModel: draft?.defaultModel ?? saved?.defaultModel, modelMap: draft?.modelMap ?? saved?.modelMap };
    const model = full.defaultModel || r.models.find((m) => /haiku/i.test(m)) || r.models[0] || 'haiku';
    // OpenAI-compatible relays don't fingerprint the client, so one tiny chat request proves the key; a CLI
    // round would cost a whole Claude Code system prompt (~50k tokens) per click.
    if (p.type === 'openai') {
      const chat = await openaiChatProbe(full, model);
      return { ...r, ok: chat.ok, chat, error: chat.ok ? undefined : chat.error };
    }
    const explicit = (draft?.runtime ?? saved?.runtime) as RuntimeKind | undefined;
    let chat = await chatProbe(full, explicit, model);
    if (!chat.ok && chat.runtime === 'ccb' && !explicit) {
      const again = await chatProbe(full, 'claude', model);
      if (again.ok) {
        chat = { ...again, switched: true };
        if (saved) await this.meta.upsertProvider({ id: saved.id, runtime: 'claude' }, { mustExist: true });
      } else chat = { ...again, error: `ccb: ${chat.error} · 官方: ${again.error}` };
    }
    return { ...r, ok: chat.ok, chat, error: chat.ok ? undefined : chat.error };
  }
}
