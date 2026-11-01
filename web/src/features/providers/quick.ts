// 接一个模型: the quick connect for people without a Claude subscription (first run, a send with nothing to send
// it with, settings). Pick where the key is from, paste it; the endpoint's own model list decides the default model
// and the family map. Pure — the component (QuickConnect.tsx) only wires requests to these.
import { claudeFamilyMap, pickChatModel } from '@catalog';
import type { ProviderType } from '@shared';
import { tr } from '@/i18n';

export interface QuickPreset {
  id: string;
  name: string;
  /** 'auto' = a relay: its address is asked for */
  type: ProviderType | 'auto';
  /** fixed endpoint (vendors); relays ask for it */
  baseUrl?: string;
  /** where to create a key */
  keyUrl?: string;
  /** one line under the form */
  note?: string;
}

// Anthropic-format endpoints only (Claude Code talks the Messages API): every one serves /v1/models, so the list
// decides the default model and the family map.
export const PRESETS: QuickPreset[] = [
  { id: 'relay', name: tr('中转站'), type: 'auto', note: tr('填中转站给的地址和 Key（Anthropic 兼容接口），读到模型列表后自动选默认模型。') },
  { id: 'anthropic', name: 'Anthropic API', type: 'anthropic', baseUrl: 'https://api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys' },
];

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

export interface QuickPlan { type: ProviderType; baseUrl: string; defaultModel?: string; modelMap?: { haiku?: string; sonnet?: string; opus?: string } }

/**
 * The profile to test and save, from the preset and the endpoint's model list: every family mapped (the CLI calls
 * haiku for background work — a relay without that exact id would fail those), default = its sonnet.
 */
export function quickPlan(p: QuickPreset, base: string, models: string[]): QuickPlan {
  const type = 'anthropic' as const;
  // an Anthropic base never keeps its /v1 (the CLI appends /v1/messages — `…/v1` became /v1/v1/messages)
  if (p.type !== 'auto') return { type, baseUrl: anthropicBase(p.baseUrl ?? base), defaultModel: pickChatModel(models) };
  const fam = claudeFamilyMap(models);
  const def = fam.sonnet ?? pickChatModel(models);
  // a relay answering Claude format with other models (new-api converts): all three families on that model
  const modelMap = Object.keys(fam).length ? fam : def ? { haiku: def, sonnet: def, opus: def } : undefined;
  return { type, baseUrl: anthropicBase(base), defaultModel: def, ...(modelMap ? { modelMap } : {}) };
}

/** The relay's name for the list: its host without `www.` / `api.`. */
export function relayName(base: string): string {
  try { return new URL(cleanBase(base)).hostname.replace(/^(www|api)\./i, '') || tr('中转站'); } catch { return tr('中转站'); }
}

/** `name`, or `name 2`, `name 3`… when taken. */
export function uniqueName(name: string, taken: string[]): string {
  const set = new Set(taken);
  if (!set.has(name)) return name;
  for (let i = 2; ; i++) if (!set.has(`${name} ${i}`)) return `${name} ${i}`;
}

export interface ProbeLike { ok: boolean; status?: number; error?: string; models?: string[]; chat?: { ok: boolean; model: string; error?: string } }

/** A provider refusing this machine's region (user report: 403 "Access from this region requires trusted account access"). */
export const REGION_RE = /\bregion\b|country|territory|location is not supported|unsupported_country|地区|国家/i;
/** Where the proxy is set (catalog: the `proxy` part of the 供应商 page). */
export const PROXY_SETTING_PATH = tr('设置 → 供应商 → 网络代理');
export const REGION_BLOCKED = tr('这个服务不接受你所在地区的直连请求。开着梯子的话，看 {PROXY_SETTING_PATH} 是否显示在用它；没开就先开梯子再试。', { PROXY_SETTING_PATH });

/** A failed check in words a first-time user can act on (the raw error stays in the tooltip). */
export function explainProbe(r: ProbeLike, stage: 'list' | 'chat'): string {
  const raw = `${r.chat && !r.chat.ok ? r.chat.error ?? '' : ''} ${r.error ?? ''}`.trim();
  const st = r.status ?? Number(/HTTP (\d{3})/.exec(raw)?.[1] ?? 0);
  if (REGION_RE.test(raw)) return REGION_BLOCKED;
  if (st === 401 || st === 403 || /unauthori|invalid[_ ]?(api[_ ]?)?key|incorrect api key|无效的令牌|令牌|认证失败|api key/i.test(raw)) return tr('API Key 不对，或者这个 Key 没有权限。检查是否复制完整（前后没有空格）。');
  if (st === 402 || /insufficient|quota|balance|余额|额度|欠费|billing/i.test(raw)) return tr('接通了，但账户余额不足或额度用完了。充值后再试。');
  if (st === 429 || /rate limit|too many/i.test(raw)) return tr('接通了，但被限流了。稍等一会儿再试。');
  if (stage === 'list' && (st === 404 || st === 405)) return tr('地址不对：这个地址下没有模型列表。中转站的地址一般形如 https://example.com 或 https://example.com/v1。');
  if (/超时|timeout|timed out|aborted/i.test(raw)) return tr('连接超时：检查地址；这台电脑访问它要走梯子的话，看 {PROXY_SETTING_PATH}。', { PROXY_SETTING_PATH });
  if (/SSL routines|wrong version number|packet length too long|EPROTO|certificate|self[- ]signed|CERT_/i.test(raw)) return tr('加密连接没建立起来：这个地址可能不是 https（试试把开头改成 http://），或者证书有问题。');
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|getaddrinfo|network|socket/i.test(raw)) return tr('连不上这个地址：检查网址；这台电脑访问它要走梯子的话，看 {PROXY_SETTING_PATH}。', { PROXY_SETTING_PATH });
  if (stage === 'list' && r.ok && !r.models?.length) return tr('接通了，但没有读到任何模型。检查 Key 所属的分组或权限。');
  if (stage === 'chat' && r.chat && !r.chat.ok && /model|模型/i.test(raw)) return tr('接通了，但模型 {model} 用不了：{raw}', { model: r.chat.model, raw: raw.slice(0, 160) });
  return raw ? tr('没接通：{raw}', { raw: raw.slice(0, 200) }) : tr('没接通。');
}
