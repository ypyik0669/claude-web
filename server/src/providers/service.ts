import os from 'node:os';
import { CLAUDE_PROVIDER_ID, type Provider, type ProviderType, type RuntimeKind } from '../protocol.js';
import type { MetaStore } from '../meta/store.js';
import { resolveEngine, runClaudeCli } from '../claude-exe.js';
import type { SecretService } from '../secrets/service.js';
import { CODEX_KEY_ENV, codexGatewayArgs, geminiApiKeyEnv } from '../gateway/agents.js';

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
      env.OPENAI_BASE_URL = p.baseUrl;
      env.OPENAI_API_KEY = p.apiKey;
      env.CLAUDE_CODE_USE_OPENAI = '1';
      if (p.defaultModel) env.OPENAI_MODEL = p.defaultModel;
      if (m.haiku) { env.OPENAI_DEFAULT_HAIKU_MODEL = m.haiku; env.OPENAI_SMALL_FAST_MODEL = m.haiku; }
      if (m.sonnet) env.OPENAI_DEFAULT_SONNET_MODEL = m.sonnet;
      if (m.opus) env.OPENAI_DEFAULT_OPUS_MODEL = m.opus;
      break;
    case 'gemini':
      if (p.baseUrl) env.GEMINI_BASE_URL = p.baseUrl;
      env.GEMINI_API_KEY = p.apiKey;
      if (p.defaultModel) env.GEMINI_MODEL = p.defaultModel;
      if (m.haiku) { env.GEMINI_DEFAULT_HAIKU_MODEL = m.haiku; env.GEMINI_SMALL_FAST_MODEL = m.haiku; }
      if (m.sonnet) env.GEMINI_DEFAULT_SONNET_MODEL = m.sonnet;
      if (m.opus) env.GEMINI_DEFAULT_OPUS_MODEL = m.opus;
      break;
    case 'grok':
      if (p.baseUrl) env.GROK_BASE_URL = p.baseUrl;
      env.XAI_API_KEY = p.apiKey;
      if (p.defaultModel) env.GROK_MODEL = p.defaultModel;
      break;
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

function modelsUrl(type: ProviderType, baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  if (type === 'gemini') return `${b || 'https://generativelanguage.googleapis.com'}/v1beta/models`;
  if (type === 'grok') return `${b || 'https://api.x.ai'}/v1/models`;
  if (type === 'openai') return /\/v\d+$/.test(b) ? `${b}/models` : `${b}/v1/models`;
  return /\/v\d+$/.test(b) ? `${b}/models` : `${b}/v1/models`;
}

export interface ChatProbe { ok: boolean; runtime: RuntimeKind; model: string; error?: string; ms: number; switched?: boolean }
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
  const err = (out?.result ?? out?.error ?? r.stderr ?? r.stdout).toString().replace(/\s+/g, ' ').trim().slice(0, 300) || `exit ${r.code}`;
  return { ok: false, runtime: kind, model, error: err, ms };
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
    if (!r.ok) return { ok: false, status: r.status, models: [], error: j?.error?.message ?? j?.message ?? text.slice(0, 300) ?? `HTTP ${r.status}`, ms: Date.now() - t0 };
    const raw: any[] = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
    const models = raw.map((m) => String(m.id ?? m.name ?? m).replace(/^models\//, '')).filter(Boolean).sort();
    if (!models.length && !j) return { ok: false, status: r.status, models: [], error: '返回不是 JSON 模型列表', ms: Date.now() - t0 };
    return { ok: true, status: r.status, models, ms: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, models: [], error: e?.name === 'AbortError' ? '连接超时（20s）' : e?.cause?.message ?? e?.message ?? String(e), ms: Date.now() - t0 };
  }
}

export class ProviderService {
  private revealed = new Map<string, string>(); // stored (possibly encrypted) value -> plaintext
  /** Set by the server once the model gateway is up: group id → local endpoint + gateway key (null = unavailable). */
  gatewayEndpoint: ((groupId: string) => { baseUrl: string; key: string; runtime?: RuntimeKind } | null) | null = null;
  constructor(private meta: MetaStore, private secrets?: SecretService) {
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
  /** Extra env + global args for a non-Claude agent session that picked a gateway profile (nothing for any other type). */
  agentLaunch(id: string | undefined, agent: 'codex' | 'acp'): { env: Record<string, string>; args: string[] } {
    if (!id || id === CLAUDE_PROVIDER_ID || this.meta.provider(id)?.type !== 'gateway') return { env: {}, args: [] };
    const p = this.forSession(id)!;
    const env = providerEnv(p, agent);
    // account logins must not win over the gateway: Codex gets its own provider, Gemini CLI a forced auth type
    if (agent === 'codex') return { env, args: codexGatewayArgs(p.baseUrl) };
    return { env: { ...env, ...geminiApiKeyEnv() }, args: [] };
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
    if (r.ok && saved && r.models.length) await this.meta.upsertProvider({ id: saved.id, models: r.models });
    if (!r.ok || (p.type !== 'anthropic' && p.type !== 'openai')) return r;
    // Real chat check, with automatic fallback to the official binary when the endpoint rejects ccb.
    const full: Provider = { id: saved?.id ?? 'draft', name: draft?.name ?? saved?.name ?? 'draft', createdAt: 0, ...saved, ...p, defaultModel: draft?.defaultModel ?? saved?.defaultModel, modelMap: draft?.modelMap ?? saved?.modelMap };
    const model = full.defaultModel || r.models.find((m) => /haiku/i.test(m)) || r.models[0] || 'haiku';
    const explicit = (draft?.runtime ?? saved?.runtime) as RuntimeKind | undefined;
    let chat = await chatProbe(full, explicit, model);
    if (!chat.ok && chat.runtime === 'ccb' && !explicit) {
      const again = await chatProbe(full, 'claude', model);
      if (again.ok) {
        chat = { ...again, switched: true };
        if (saved) await this.meta.upsertProvider({ id: saved.id, runtime: 'claude' });
      } else chat = { ...again, error: `ccb: ${chat.error} · 官方: ${again.error}` };
    }
    return { ...r, ok: chat.ok, chat, error: chat.ok ? undefined : chat.error };
  }
}
