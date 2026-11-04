// The add-source catalog (spec 2026-10-26 §5.3, §6). Three layers, later wins: the built-in baseline below (works
// offline), a signed remote catalog (data only, off unless the user turns it on), and the user's own overrides /
// hidden entries. The live /models of a configured source is the fourth layer, applied where the source is projected.
//
// Every value below comes from research_notes/免费模型来源深度调研 (B_official_free_tiers.md, A_keyless_pools.md)
// or research_notes/可反代的模型上游调研 (cherry-studio.md: the 34 Anthropic-compatible endpoints of Cherry Studio's
// providers.json). Where the notes did not have a value, the field is left out rather than guessed.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../files/service.js';
import { tr, trAs } from '../i18n/index.js';
import type { CatalogEntry, CatalogSummary, ChannelCatalogOverride, RemoteCatalogState } from './types.js';
import { pluginSourceDefs } from '../plugins/declarative.js';
import { isEd25519PublicKey } from '../plugins/market.js';
import { guardedFetch, type FetchFn, type LookupAll } from '../net/netguard.js';
import type { DeclarativeSource } from '../plugins/protocol.js';

// FREE_NOTES = research_notes/免费模型来源深度调研/B_official_free_tiers.md; CHERRY = research_notes/可反代的模型上游调研/cherry-studio.md;
// KEYLESS = …/免费模型来源深度调研/A_keyless_pools.md; engines: …/可反代的模型上游调研/cliproxyapi.md, magpie.md
const FREE_NOTES = 'notes:free-tiers/B_official_free_tiers.md';
const CHERRY = 'notes:upstreams/cherry-studio.md (Cherry Studio providers.json)';

/** An Anthropic-compatible endpoint from Cherry Studio's list: a key, a base URL, nothing else known. */
// authStyle: OpenAI-compatible entries are Bearer; Anthropic's own API x-api-key; third-party Anthropic endpoints whose
// Claude Code setup uses ANTHROPIC_AUTH_TOKEN Bearer; left out where unknown (unset = both headers, as before).
const anthropicPreset = (id: string, name: string, baseUrl: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, name, category: 'api', needs: 'key', protocol: 'anthropic', baseUrl, driver: 'provider', source: CHERRY, ...extra,
});

export const BASELINE: CatalogEntry[] = [
  // ---- free, no key ----
  {
    id: 'kilo', name: 'Kilo', category: 'free', needs: 'none', protocol: 'openai', authStyle: 'none',
    // the gateway answers anonymously (probe 2026-10-26: no header and a placeholder Bearer both 200)
    baseUrl: 'https://api.kilo.ai/api/gateway/v1', free: true, mayTrain: true,
    // the list has every model (paid ones answer PAID_MODEL_AUTH_REQUIRED without a sign-in): keep the free slice
    modelFilter: '(:free|/free)$',
    models: [
      { id: 'kilo-auto/free', free: true },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', free: true },
      { id: 'poolside/laguna-s-2.1:free', free: true },
    ],
    limits: '200 requests/hour per IP (aggregator)', notes: ['logged'], driver: 'provider',
    source: 'notes:free-tiers/A_keyless_pools.md §2',
  },
  // ---- free, the user's own free key ----
  {
    id: 'openrouter-free', name: 'OpenRouter (:free)', category: 'free', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://openrouter.ai/api/v1', signupUrl: 'https://openrouter.ai/keys', free: true, mayTrain: true,
    modelFilter: '(:free|^openrouter/free)$',
    models: [
      { id: 'openrouter/free', free: true },
      { id: 'poolside/laguna-s-2.1:free', free: true },
      { id: 'cohere/north-mini-code:free', free: true },
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', free: true },
      { id: 'qwen/qwen3.8-27b:free', free: true },
    ],
    limits: '20 RPM; 50 RPD per model (1,000 RPD after a one-time $10 purchase)', notes: ['logged', 'paid-credit-raises-limit'],
    driver: 'provider', source: FREE_NOTES,
  },
  {
    id: 'nvidia-nim', name: 'NVIDIA NIM', category: 'free', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://integrate.api.nvidia.com/v1', signupUrl: 'https://build.nvidia.com', free: true, mayTrain: true,
    models: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', free: true },
      { id: 'nvidia/nemotron-3-super-120b-a12b', free: true, contextWindow: 1_000_000 },
    ],
    limits: '40 RPM, 10,000 RPD (aggregator)', notes: ['logged', 'parallel-tools-off'], driver: 'provider', source: FREE_NOTES,
  },
  {
    id: 'google-ai-studio', name: 'Google AI Studio', category: 'free', needs: 'key', protocol: 'gemini',
    baseUrl: '', signupUrl: 'https://aistudio.google.com/apikey', free: 'some', mayTrain: true,
    // Google no longer publishes per-model free limits
    notes: ['region'], driver: 'provider', source: FREE_NOTES,
  },
  {
    id: 'glm-flash', name: 'Zhipu GLM-4.7-Flash', category: 'free', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys', free: 'some',
    modelFilter: '^glm-[\\d.]+v?-flash$',
    models: [{ id: 'glm-4.7-flash', free: true, contextWindow: 200_000, capabilities: { reasoning: true } }],
    limits: 'permanently free, 1 concurrent request', notes: ['one-concurrent'], driver: 'provider', source: FREE_NOTES,
  },
  {
    id: 'zai-glm-flash', name: 'Z.ai GLM-4.7-Flash', category: 'free', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://api.z.ai/api/paas/v4', free: 'some',
    modelFilter: '^glm-[\\d.]+v?-flash$',
    models: [{ id: 'glm-4.7-flash', free: true, contextWindow: 200_000, capabilities: { reasoning: true } }],
    limits: 'permanently free, 1 concurrent request', notes: ['one-concurrent'], driver: 'provider', source: FREE_NOTES,
  },
  {
    id: 'modelscope', name: 'ModelScope', category: 'free', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://api-inference.modelscope.cn/v1', signupUrl: 'https://modelscope.cn', free: true,
    limits: '2,000 RPD total, at most 500 RPD per model', notes: ['real-name', 'list-any-key'], driver: 'provider', source: FREE_NOTES,
  },
  {
    id: 'groq', name: 'Groq', category: 'free', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://api.groq.com/openai/v1', signupUrl: 'https://console.groq.com', free: true,
    models: [
      { id: 'openai/gpt-oss-120b', free: true, contextWindow: 131_000 },
      { id: 'openai/gpt-oss-20b', free: true, contextWindow: 131_000 },
      { id: 'qwen/qwen3.8-27b', free: true, contextWindow: 131_000 },
    ],
    limits: '30 RPM, 1,000 RPD per chat model (aggregator)', driver: 'provider', source: FREE_NOTES,
  },
  {
    id: 'cerebras', name: 'Cerebras', category: 'free', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://api.cerebras.ai/v1', free: true,
    models: [{ id: 'gpt-oss-120b', free: true }, { id: 'qwen-3.8-27b', free: true }],
    limits: '5 RPM, 30K uncached TPM, 1M TPD', driver: 'provider', source: FREE_NOTES,
  },
  {
    id: 'siliconflow-free', name: 'SiliconFlow (free models)', category: 'free', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://api.siliconflow.cn/v1', signupUrl: 'https://cloud.siliconflow.cn/account/ak', free: 'some',
    notes: ['real-name'], driver: 'provider', source: FREE_NOTES,
  },
  {
    id: 'mistral-free', name: 'Mistral', category: 'free', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://api.mistral.ai/v1', free: true, mayTrain: true,
    limits: '~$10/month of credits', driver: 'provider', source: FREE_NOTES,
  },
  // ---- official OpenAI-compatible endpoints (the API-key presets people look for first) ----
  {
    id: 'openai', name: 'OpenAI', category: 'api', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://api.openai.com/v1', signupUrl: 'https://platform.openai.com/api-keys', driver: 'provider',
  },
  {
    id: 'xai', name: 'xAI', category: 'api', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://api.x.ai/v1', signupUrl: 'https://console.x.ai/', driver: 'provider',
  },
  {
    id: 'together', name: 'Together AI', category: 'api', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    baseUrl: 'https://api.together.xyz/v1', signupUrl: 'https://api.together.ai/settings/api-keys', driver: 'provider',
  },
  // ---- official Anthropic-compatible endpoints (Cherry Studio's list) ----
  anthropicPreset('anthropic', 'Anthropic', 'https://api.anthropic.com', { authStyle: 'x-api-key' }),
  anthropicPreset('deepseek', 'DeepSeek', 'https://api.deepseek.com/anthropic', { authStyle: 'bearer',
    signupUrl: 'https://platform.deepseek.com/api_keys', models: [{ id: 'deepseek-v4-pro', capabilities: { tools: true, reasoning: true } }],
    source: 'DeepSeek Anthropic API docs (B_official_free_tiers.md Q2)',
  }),
  anthropicPreset('zhipu', 'Zhipu GLM', 'https://open.bigmodel.cn/api/anthropic', { authStyle: 'bearer', signupUrl: 'https://open.bigmodel.cn/usercenter/apikeys' }),
  anthropicPreset('zai', 'Z.ai', 'https://api.z.ai/api/anthropic', { authStyle: 'bearer' }),
  anthropicPreset('moonshot', 'Kimi', 'https://api.moonshot.cn/anthropic', { authStyle: 'bearer', signupUrl: 'https://platform.moonshot.cn/console/api-keys' }),
  anthropicPreset('moonshot-global', 'Kimi (Global)', 'https://api.moonshot.ai/anthropic', { authStyle: 'bearer' }),
  anthropicPreset('minimax', 'MiniMax', 'https://api.minimaxi.com/anthropic', { authStyle: 'bearer' }),
  anthropicPreset('minimax-global', 'MiniMax (Global)', 'https://api.minimax.io/anthropic', { authStyle: 'bearer' }),
  anthropicPreset('dashscope', 'Alibaba Bailian', 'https://dashscope.aliyuncs.com/apps/anthropic', { authStyle: 'bearer', signupUrl: 'https://bailian.console.aliyun.com/' }),
  anthropicPreset('stepfun', 'StepFun', 'https://api.stepfun.com'),
  anthropicPreset('longcat', 'Meituan LongCat', 'https://api.longcat.chat/anthropic', { free: 'some', limits: 'daily free quota' }),
  anthropicPreset('mimo', 'Xiaomi MiMo', 'https://api.xiaomimimo.com/anthropic'),
  anthropicPreset('modelscope-anthropic', 'ModelScope (Anthropic)', 'https://api-inference.modelscope.cn', { free: true, notes: ['real-name'] }),
  anthropicPreset('qiniu', 'Qiniu', 'https://api.qnaigc.com'),
  anthropicPreset('fireworks', 'Fireworks', 'https://api.fireworks.ai/inference'),
  anthropicPreset('siliconflow', 'SiliconFlow', 'https://api.siliconflow.cn', { signupUrl: 'https://cloud.siliconflow.cn/account/ak' }),
  anthropicPreset('302ai', '302.AI', 'https://api.302.ai'),
  anthropicPreset('openrouter', 'OpenRouter', 'https://openrouter.ai/api', { authStyle: 'bearer', signupUrl: 'https://openrouter.ai/keys' }),
  anthropicPreset('poe', 'Poe', 'https://api.poe.com'),
  // Cherry lists `https://router.huggingface.co/v1/`; the CLI appends /v1/messages itself
  anthropicPreset('huggingface', 'Hugging Face', 'https://router.huggingface.co'),
  anthropicPreset('cherryin', 'CherryIN', 'https://open.cherryin.net'),
  anthropicPreset('aihubmix', 'AiHubMix', 'https://aihubmix.com'),
  anthropicPreset('dmxapi', 'DMXAPI', 'https://www.dmxapi.cn'),
  anthropicPreset('tokendance', 'TokenDance', 'https://tokendance.space/gateway'),
  anthropicPreset('tokenhub', 'Tencent TokenHub', 'https://tokenhub.tencentmaas.com'),
  anthropicPreset('ollama', 'Ollama', 'http://localhost:11434', { needs: 'none', authStyle: 'none', category: 'local-engine' }),
  anthropicPreset('lmstudio', 'LM Studio', 'http://localhost:1234', { needs: 'none', authStyle: 'none', category: 'local-engine' }),
  anthropicPreset('omlx', 'oMLX', 'http://localhost:8000', { needs: 'none', authStyle: 'none', category: 'local-engine' }),
  // ---- local engines we install and run (engines/manifests) ----
  {
    id: 'cliproxyapi', name: 'CLIProxyAPI', category: 'local-engine', needs: 'engine', protocol: 'anthropic',
    signupUrl: 'https://github.com/router-for-me/CLIProxyAPI', driver: 'engine:cliproxyapi',
    source: 'notes:upstreams/cliproxyapi.md',
  },
  {
    id: 'magpie', name: 'Magpie', category: 'local-engine', needs: 'engine', protocol: 'anthropic', authStyle: 'both',
    signupUrl: 'https://usemagpie.ai', driver: 'engine:magpie', source: 'notes:upstreams/magpie.md',
  },
  // ---- the user's own Claude login through the local `claude` CLI (drivers/claude-bridge.ts); off until added ----
  {
    id: 'claude-bridge', name: 'Claude subscription (local claude CLI)', category: 'subscription', needs: 'none', protocol: 'anthropic',
    authStyle: 'x-api-key', limits: 'plain chat only, no tool use; one claude CLI run per request (2 at a time); uses your own Claude plan',
    driver: 'claude-bridge', source: 'magpie internal/claudebridge',
  },
  // ---- a grok.com account through its sso cookie (drivers/grok-web.ts) ----
  {
    id: 'grok-web', name: 'Grok (grok.com account)', category: 'subscription', needs: 'key', protocol: 'openai', authStyle: 'bearer',
    free: 'some', signupUrl: 'https://grok.com/', driver: 'grok-web', source: 'CNFlyCat/GrokProxy, justlovemaki/AIClient2API (protocol)',
    keyLabel: 'sso cookie',
    keyHint: 'grok.com → F12 → Application → Cookies → copy the value of sso (or the whole Cookie header; add a line ua=<your browser User-Agent> if Cloudflare blocks it)',
    limits: "the account's own grok.com limits; tool calls emulated in the prompt",
    models: [
      { id: 'grok-4.20', capabilities: { tools: true, reasoning: true } }, { id: 'grok-4.20-fast', capabilities: { tools: true } },
      { id: 'grok-4.20-expert', capabilities: { tools: true, reasoning: true } }, { id: 'grok-4.20-heavy', capabilities: { tools: true, reasoning: true } },
      { id: 'grok-4.1-thinking', capabilities: { tools: true, reasoning: true } }, { id: 'grok-4.1-mini', capabilities: { tools: true } },
    ],
  },
  // ---- logins we already run (upstreams/) ----
  { id: 'claude-account', name: 'Claude', category: 'subscription', needs: 'login', protocol: 'anthropic', driver: 'upstream:claude' },
  { id: 'gemini-web', name: 'Gemini', category: 'subscription', needs: 'login', protocol: 'gemini', driver: 'upstream:gemini' },
  { id: 'workbuddy', name: 'WorkBuddy', category: 'subscription', needs: 'login', protocol: 'openai', driver: 'upstream:workbuddy' },
];

// ---------------------------------------------------------------------------------------------------------------
// Remote catalog: signed data, never code. Off by default (setting `channels.remoteCatalog` = { enabled, url, publicKey });
// no official URL / key ships: it works once the user enters both (settings -> remote model catalog).

export interface RemoteCatalogSetting { enabled?: boolean; url?: string; /** PEM or base64 SPKI DER, Ed25519 */ publicKey?: string }
interface RemoteCatalogFile { version: number; entries: unknown[]; signature: string }

export type { RemoteCatalogState };

const KNOWN_FIELDS = new Set(['id', 'name', 'category', 'needs', 'protocol', 'baseUrl', 'authStyle', 'signupUrl', 'free', 'mayTrain', 'modelFilter', 'models', 'limits', 'notes', 'driver', 'retired', 'keyLabel', 'keyHint']);
const remoteFile = () => path.join(dataDir(), 'channels', 'catalog-remote.json');
const MAX_REMOTE_BYTES = 2 * 1024 * 1024;
/** a verified copy older than this is fetched again in the background when the catalog is first read */
export const REMOTE_STALE_MS = 24 * 3600_000;

const remoteState: { fetchedAt?: number; error?: string; url?: string } = {};

/** Strings, booleans, plain arrays/objects only; unknown fields dropped; an https / loopback URL or nothing. */
function sanitizeEntry(raw: unknown): CatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KNOWN_FIELDS.has(k)) continue;
    if (typeof v === 'function') continue;
    out[k] = JSON.parse(JSON.stringify(v ?? null));
  }
  const e = out as unknown as CatalogEntry;
  if (typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(e.id) || typeof e.name !== 'string') return null;
  if (e.baseUrl !== undefined && e.baseUrl !== '' && !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/i.test(String(e.baseUrl))) return null;
  if (e.modelFilter !== undefined) { try { new RegExp(String(e.modelFilter), 'i'); } catch { return null; } }
  return e;
}

function canonical(entries: unknown[]): string { return JSON.stringify(entries); }

/** Ed25519 over the canonical JSON of `entries`. A missing key or a bad signature is a refusal, not a warning. */
export function verifyRemote(file: RemoteCatalogFile, publicKey: string): boolean {
  try {
    const key = publicKey.includes('BEGIN') ? crypto.createPublicKey(publicKey)
      : crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canonical(file.entries), 'utf8'), key, Buffer.from(file.signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * The setting as the user saves it: an https URL without credentials and an Ed25519 public key (PEM or base64
 * SPKI DER). There is no official URL or key built in: nothing is fetched until the user supplies both.
 */
export function normalizeRemoteSetting(raw: unknown): RemoteCatalogSetting {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(tr('远程模型目录设置不对'));
  const v = raw as Record<string, unknown>;
  const out: RemoteCatalogSetting = {};
  if (v.enabled === true) out.enabled = true;
  const url = typeof v.url === 'string' ? v.url.trim() : '';
  if (url) {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error(tr('远程模型目录只接受 https 地址')); }
    if (u.protocol !== 'https:' || u.username || u.password || url.length > 2000) throw new Error(tr('远程模型目录只接受 https 地址'));
    out.url = u.toString();
  }
  const key = typeof v.publicKey === 'string' ? v.publicKey.trim() : '';
  if (key) {
    if (key.length > 8000 || !isEd25519PublicKey(key)) throw new Error(tr('远程模型目录的公钥不是 Ed25519 公钥'));
    out.publicKey = key;
  }
  return out;
}

export function remoteCatalogState(setting: RemoteCatalogSetting | undefined, entries: number): RemoteCatalogState {
  const s = setting ?? {};
  const hasKey = typeof s.publicKey === 'string' && isEd25519PublicKey(s.publicKey);
  const sameUrl = !!s.url && remoteState.url === s.url;
  return {
    enabled: s.enabled === true,
    ...(s.url ? { url: s.url } : {}),
    hasKey,
    ready: s.enabled === true && !!s.url && /^https:\/\//i.test(s.url) && hasKey,
    ...(sameUrl && remoteState.fetchedAt ? { fetchedAt: remoteState.fetchedAt } : {}),
    entries: s.enabled ? entries : 0,
    ...(sameUrl && remoteState.error ? { error: remoteState.error } : {}),
  };
}

/** The last remote catalog that verified (kept on disk so a failed update falls back to it), for this URL only. */
export async function loadRemote(url?: string): Promise<CatalogEntry[]> {
  try {
    const j = JSON.parse(await fs.readFile(remoteFile(), 'utf8')) as { entries?: unknown[]; at?: number; url?: string };
    // a copy fetched from another address (the user changed it) is not this catalog
    if (url && j.url && j.url !== url) return [];
    if (url) { remoteState.url = url; if (typeof j.at === 'number') remoteState.fetchedAt = j.at; }
    return (j.entries ?? []).map(sanitizeEntry).filter((e): e is CatalogEntry => !!e);
  } catch {
    return [];
  }
}

/** When the copy on disk for this URL was verified (0 = none). */
export function remoteFetchedAt(url?: string): number {
  return url && remoteState.url === url ? remoteState.fetchedAt ?? 0 : 0;
}

/** Fetch (netguard: internet only, every redirect hop checked), verify, keep. Throws (and keeps the last good copy). */
export async function updateRemote(setting: RemoteCatalogSetting | undefined, o: { fetch?: FetchFn; lookup?: LookupAll } = {}): Promise<CatalogEntry[]> {
  if (!setting?.enabled || !setting.url) throw new Error(tr('远程模型目录没有打开'));
  if (!setting.publicKey) throw new Error(tr('远程模型目录没有设置验证公钥'));
  if (!/^https:\/\//i.test(setting.url)) throw new Error(tr('远程模型目录只接受 https 地址'));
  if (remoteState.url !== setting.url) { delete remoteState.fetchedAt; delete remoteState.error; }
  remoteState.url = setting.url;
  try {
    const f = guardedFetch({ policy: 'public', protocols: ['https:'], ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.lookup ? { lookup: o.lookup } : {}) });
    const res = await f(setting.url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(tr('远程模型目录下载失败：HTTP {status}', { status: res.status }));
    const text = await res.text();
    if (text.length > MAX_REMOTE_BYTES) throw new Error(tr('远程模型目录太大'));
    let file: RemoteCatalogFile;
    try { file = JSON.parse(text) as RemoteCatalogFile; } catch { throw new Error(tr('远程模型目录格式不对')); }
    if (!file || !Array.isArray(file.entries) || typeof file.signature !== 'string') throw new Error(tr('远程模型目录格式不对'));
    if (!verifyRemote(file, setting.publicKey)) throw new Error(tr('远程模型目录签名不对，已丢弃'));
    const entries = file.entries.map(sanitizeEntry).filter((e): e is CatalogEntry => !!e);
    const at = Date.now();
    await fs.mkdir(path.dirname(remoteFile()), { recursive: true });
    await fs.writeFile(remoteFile(), JSON.stringify({ version: file.version, at, url: setting.url, entries }, null, 1), { mode: 0o600 });
    remoteState.fetchedAt = at;
    delete remoteState.error;
    return entries;
  } catch (e) {
    remoteState.error = (e as Error).message;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * baseline < remote < user. Remote may add entries, change fields and retire entries; it cannot bring back an entry
 * the user hid or undo a field the user changed. The driver of a built-in entry never changes (a remote entry cannot
 * turn a key preset into an engine that downloads something).
 */
export function mergeCatalog(baseline: CatalogEntry[], remote: CatalogEntry[], user: Record<string, ChannelCatalogOverride> = {}): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  for (const e of baseline) byId.set(e.id, { ...e });
  for (const r of remote) {
    const cur = byId.get(r.id);
    if (cur) byId.set(r.id, { ...cur, ...r, id: cur.id, driver: cur.driver });
    // a new remote entry may only be a provider preset (data); engines and logins are ours
    else if (r.driver === 'provider' && r.protocol && r.category && r.needs && r.needs !== 'engine' && r.needs !== 'login') byId.set(r.id, r);
  }
  const out: CatalogEntry[] = [];
  for (const e of byId.values()) {
    const o = user[e.id];
    if (o?.hidden) continue;
    out.push(o?.patch ? { ...e, ...o.patch, id: e.id, driver: e.driver } : e);
  }
  return out;
}

/** A built-in vendor's name in the interface language (the data holds the English one). */
export function localName(name: string): string {
  switch (name) {
    case 'Zhipu GLM-4.7-Flash': return trAs('智谱 GLM-4.7-Flash', 'Zhipu GLM-4.7-Flash');
    case 'ModelScope (Anthropic)': return trAs('ModelScope 魔搭 (Anthropic)', 'ModelScope (Anthropic)');
    case 'ModelScope': return trAs('ModelScope 魔搭', 'ModelScope');
    case 'SiliconFlow (free models)': return trAs('硅基流动（免费模型）', 'SiliconFlow (free models)');
    case 'Zhipu GLM': return trAs('智谱 GLM', 'Zhipu GLM');
    case 'Alibaba Bailian': return trAs('阿里百炼', 'Alibaba Bailian');
    case 'StepFun': return trAs('阶跃星辰', 'StepFun');
    case 'Meituan LongCat': return trAs('美团 LongCat', 'Meituan LongCat');
    case 'Xiaomi MiMo': return trAs('小米 MiMo', 'Xiaomi MiMo');
    case 'Qiniu': return trAs('七牛云', 'Qiniu');
    case 'SiliconFlow': return trAs('硅基流动', 'SiliconFlow');
    case 'Tencent TokenHub': return trAs('腾讯 TokenHub', 'Tencent TokenHub');
    case 'Claude subscription (local claude CLI)': return trAs('Claude 订阅（本机 claude 命令）', 'Claude subscription (local claude CLI)');
    default: return name;
  }
}

export function summarize(entries: CatalogEntry[], added: Set<string>, user: Record<string, ChannelCatalogOverride> = {}): CatalogSummary[] {
  return entries.map(({ source: _s, ...e }) => ({ ...e, ...(e.plugin ? {} : { name: localName(e.name) }), added: added.has(e.id), ...(user[e.id] ? { overridden: true } : {}) }));
}

/**
 * Sources from enabled plugins as catalog entries (ids `plugin:<plugin>/<source>`, `plugin` set): data only, added
 * through the provider driver like any key preset. They come after every other layer and never replace a built-in id.
 */
export function pluginEntry(pluginId: string, s: DeclarativeSource): CatalogEntry {
  const free = s.models.length && s.models.every((m) => m.free) ? true : s.models.some((m) => m.free) ? 'some' as const : undefined;
  return {
    id: `plugin:${pluginId}/${s.id}`,
    name: s.name,
    category: s.category ?? (free === true ? 'free' : 'api'),
    needs: s.auth === 'none' ? 'none' : 'key',
    protocol: s.protocol === 'openai-responses' ? 'openai' : s.protocol,
    baseUrl: s.endpoint,
    authStyle: s.auth,
    ...(s.docs ? { signupUrl: s.docs } : {}),
    ...(free ? { free } : {}),
    ...(s.models.some((m) => m.mayTrain) ? { mayTrain: true } : {}),
    models: s.models.map((m) => ({ id: m.id, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}), ...(m.free ? { free: true } : {}), ...(m.capabilities ? { capabilities: { tools: m.capabilities.tools, images: m.capabilities.images, reasoning: m.capabilities.reasoning } } : {}) })),
    driver: 'provider',
    plugin: { id: pluginId },
  };
}

/** The merged catalog plus the enabled plugins' sources (a plugin id that collides with an entry is skipped). */
export function withPluginEntries(entries: CatalogEntry[]): CatalogEntry[] {
  const have = new Set(entries.map((e) => e.id));
  const extra = pluginSourceDefs().map(({ pluginId, source }) => pluginEntry(pluginId, source)).filter((e) => !have.has(e.id));
  return extra.length ? [...entries, ...extra] : entries;
}

/** Keep the ids a free-only source's filter accepts (no filter = all). */
export function filterModels(entry: Pick<CatalogEntry, 'modelFilter'> | undefined, models: string[]): string[] {
  if (!entry?.modelFilter) return models;
  let re: RegExp;
  try { re = new RegExp(entry.modelFilter, 'i'); } catch { return models; }
  return models.filter((m) => re.test(m));
}
