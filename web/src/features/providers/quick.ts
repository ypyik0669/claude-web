// 接一个模型: the quick connect for people without a Claude subscription (first run, a send with nothing to send
// it with, settings). Pick where the key is from, paste it; the endpoint's own model list decides the format and the
// default model. Pure — the component (QuickConnect.tsx) only wires requests to these.
import { claudeFamilyMap, pickChatModel } from '@catalog';
import type { ProviderType } from '@shared';

export interface QuickPreset {
  id: string;
  name: string;
  /** 'auto' = a relay: its model list decides Claude format vs OpenAI format */
  type: ProviderType | 'auto';
  /** fixed endpoint (vendors); relays ask for it */
  baseUrl?: string;
  /** where to create a key */
  keyUrl?: string;
  /** one line under the form */
  note?: string;
}

// Endpoints are the vendors' documented OpenAI-compatible ones: every one serves /models, so the list decides the
// model; ccb talks to them through the cache shim (settings → 供应商 has the details).
export const PRESETS: QuickPreset[] = [
  { id: 'relay', name: '中转站', type: 'auto', note: '填中转站给的地址和 Key。有 Claude 模型的用 Claude 格式（带缓存，更省），其它模型用 OpenAI 格式，读到模型列表后自动选。' },
  { id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi', name: 'Kimi', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'glm', name: '智谱 GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'qwen', name: '通义千问', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'siliconflow', name: '硅基流动', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'gemini', name: 'Gemini', type: 'gemini', keyUrl: 'https://aistudio.google.com/apikey' },
];

export type QuickFormat = 'auto' | 'anthropic' | 'openai';

/**
 * What people paste: a bare host, a host without a scheme, the full `/v1/chat/completions` URL from a relay's docs.
 * → `https://host[/path]` without the endpoint part and without a trailing slash ('' when there is nothing).
 */
export function cleanBase(url: string): string {
  let u = url.trim().replace(/\s+/g, '');
  if (!u) return '';
  // no scheme: https, except on this machine / the local network (a relay run at home is plain http)
  if (!/^https?:\/\//i.test(u)) u = `${/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(u) ? 'http' : 'https'}://${u}`;
  u = u.replace(/\/+$/, '').replace(/\/(chat\/completions|completions|messages|responses|models)$/i, '').replace(/\/+$/, '');
  return u;
}

/** An Anthropic base is the part before `/v1` (the CLI appends `/v1/messages`). */
export const anthropicBase = (url: string) => cleanBase(url).replace(/\/v1$/i, '');

const hasClaude = (models: string[]) => Object.keys(claudeFamilyMap(models)).length > 0;

export interface QuickPlan { type: ProviderType; baseUrl: string; defaultModel?: string; modelMap?: { haiku?: string; sonnet?: string; opus?: string } }

/**
 * The profile to test and save, from the preset, the chosen format and the endpoint's model list. Claude format:
 * every family mapped (the CLI calls haiku for background work — a relay without that exact id would fail those),
 * default = its sonnet. OpenAI format: the best chat model in the list (never an embedding / image model).
 */
export function quickPlan(p: QuickPreset, fmt: QuickFormat, base: string, models: string[]): QuickPlan {
  if (p.type === 'gemini') return { type: 'gemini', baseUrl: '', defaultModel: pickChatModel(models, [/gemini-[\d.]+-pro/i, /gemini-[\d.]+-flash(?!.*lite)/i, /gemini/i]) };
  if (p.type !== 'auto') return { type: p.type, baseUrl: p.baseUrl ?? cleanBase(base), defaultModel: pickChatModel(models) };
  const type: 'anthropic' | 'openai' = fmt === 'auto' ? (hasClaude(models) ? 'anthropic' : 'openai') : fmt;
  if (type === 'openai') return { type, baseUrl: cleanBase(base), defaultModel: pickChatModel(models) };
  const fam = claudeFamilyMap(models);
  const def = fam.sonnet ?? pickChatModel(models);
  // a relay answering Claude format with other models (new-api converts): all three families on that model
  const modelMap = Object.keys(fam).length ? fam : def ? { haiku: def, sonnet: def, opus: def } : undefined;
  return { type, baseUrl: anthropicBase(base), defaultModel: def, ...(modelMap ? { modelMap } : {}) };
}

/** The relay's name for the list: its host without `www.` / `api.`. */
export function relayName(base: string): string {
  try { return new URL(cleanBase(base)).hostname.replace(/^(www|api)\./i, '') || '中转站'; } catch { return '中转站'; }
}

/** `name`, or `name 2`, `name 3`… when taken. */
export function uniqueName(name: string, taken: string[]): string {
  const set = new Set(taken);
  if (!set.has(name)) return name;
  for (let i = 2; ; i++) if (!set.has(`${name} ${i}`)) return `${name} ${i}`;
}

export interface ProbeLike { ok: boolean; status?: number; error?: string; models?: string[]; chat?: { ok: boolean; model: string; error?: string } }

/** A failed check in words a first-time user can act on (the raw error stays in the tooltip). */
export function explainProbe(r: ProbeLike, stage: 'list' | 'chat'): string {
  const raw = `${r.chat && !r.chat.ok ? r.chat.error ?? '' : ''} ${r.error ?? ''}`.trim();
  const st = r.status ?? Number(/HTTP (\d{3})/.exec(raw)?.[1] ?? 0);
  if (st === 401 || st === 403 || /unauthori|invalid[_ ]?(api[_ ]?)?key|incorrect api key|无效的令牌|令牌|认证失败|api key/i.test(raw)) return 'API Key 不对，或者这个 Key 没有权限。检查是否复制完整（前后没有空格）。';
  if (st === 402 || /insufficient|quota|balance|余额|额度|欠费|billing/i.test(raw)) return '接通了，但账户余额不足或额度用完了。充值后再试。';
  if (st === 429 || /rate limit|too many/i.test(raw)) return '接通了，但被限流了。稍等一会儿再试。';
  if (stage === 'list' && (st === 404 || st === 405)) return '地址不对：这个地址下没有模型列表。中转站的地址一般形如 https://example.com 或 https://example.com/v1。';
  if (/超时|timeout|timed out|aborted/i.test(raw)) return '连接超时：检查地址，或者这台电脑访问它是否需要代理。';
  if (/SSL routines|wrong version number|packet length too long|EPROTO|certificate|self[- ]signed|CERT_/i.test(raw)) return '加密连接没建立起来：这个地址可能不是 https（试试把开头改成 http://），或者证书有问题。';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|network|socket/i.test(raw)) return '连不上这个地址：检查网址，或者这台电脑访问它是否需要代理。';
  if (stage === 'list' && r.ok && !r.models?.length) return '接通了，但没有读到任何模型。检查 Key 所属的分组或权限。';
  if (stage === 'chat' && r.chat && !r.chat.ok && /model|模型/i.test(raw)) return `接通了，但模型 ${r.chat.model} 用不了：${raw.slice(0, 160)}`;
  return raw ? `没接通：${raw.slice(0, 200)}` : '没接通。';
}
