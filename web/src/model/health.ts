import { tr } from '@/i18n';
// Pure helpers that turn SDK error / timing signals into UI-facing health state. No DOM, no store.

export type ErrorKind = 'throttled' | 'quota' | 'balance' | 'network' | 'stream' | 'credential' | 'context' | 'output_cap' | 'server' | 'refusal' | 'aborted' | 'history' | 'unknown';

export interface ErrorSignal {
  /** SDKAssistantMessageError / api_retry.error */
  error?: string | null;
  /** HTTP status; null = connection-level failure with no response */
  status?: number | null;
  /** result.terminal_reason */
  terminalReason?: string | null;
  /** free text (result.result, errors[]) */
  text?: string | null;
  /** rate_limit_event status */
  rateLimitStatus?: string | null;
  rateLimitErrorCode?: string | null;
}

/** Map whatever the SDK gave us to one of a few kinds the UI can explain and act on. */
export function classifyError(s: ErrorSignal): ErrorKind {
  const err = (s.error ?? '').toLowerCase();
  const tr = (s.terminalReason ?? '').toLowerCase();
  const text = (s.text ?? '').toLowerCase();
  const st = s.status ?? undefined;
  // the history the engine sent holds a block the API refuses (an empty text from a picture sent alone before
  // 2026-10-17; another vendor's blank or unsigned thinking, the conversation switched to Claude): the server takes it
  // out of the transcript and starts the process over (session-runner dropEmptyBlocks) — a retry goes through
  if (/empty text blocks|text content blocks must be non-empty|thinking block must contain non-whitespace|invalid `signature` in `thinking` block/.test(text)) return 'history';
  if (s.rateLimitStatus === 'rejected' || s.rateLimitErrorCode === 'credits_required') return 'quota';
  // A provider account out of money is not a usage window that resets: say so, and point at topping up.
  if (/insufficient[_ ](?:\w+[_ ])?(?:balance|funds|credit)|credit balance is too low|余额不足|余额已用完/.test(text)) return 'balance';
  if (tr === 'blocking_limit' || err === 'billing_error' || err === 'account_on_hold' || /credit|billing|quota exceeded|insufficient/.test(text)) return 'quota';
  if (err === 'rate_limit' || st === 429 || /rate limit|too many requests|throttl/.test(text)) return 'throttled';
  if (err === 'authentication_failed' || err === 'oauth_org_not_allowed' || st === 401 || st === 403 || /unauthori|invalid api key|authentication|not logged in|expired token/.test(text)) return 'credential';
  if (tr === 'prompt_too_long' || /prompt is too long|context window|too long|input length/.test(text)) return 'context';
  if (err === 'max_output_tokens' || /max_tokens|output token/.test(text)) return 'output_cap';
  if (tr.startsWith('aborted') || /interrupted|aborted|cancel/.test(text)) return 'aborted';
  if (/refus/.test(text) || /refus/.test(tr)) return 'refusal';
  if (err === 'overloaded' || err === 'server_error' || (st !== undefined && st !== null && st >= 500) || /overloaded|internal server error|bad gateway|service unavailable/.test(text)) return 'server';
  // the answer's stream broke off (a relay / proxy cut it, stalled, or sent events out of order): on a provider the CLI
  // no longer re-sends the turn without streaming (session-runner: CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK), so the
  // turn ends here with one of these — 「继续」 picks it up (2026-11-17)
  if (/stream idle timeout|error streaming|response stream was malformed|response stalled|response stopped arriving|part of the response never arrived|connection lost mid-response|stream ended without|content block not found|referenced an? (?:unstarted|already-closed) content block/.test(text)) return 'stream';
  if (s.status === null || /econnreset|econnrefused|etimedout|fetch failed|network|socket hang up|enotfound|dns|connection lost before/.test(text)) return 'network';
  if (tr === 'api_error' || tr === 'model_error') return 'server';
  return 'unknown';
}

export const ERROR_LABEL: Record<ErrorKind, string> = {
  throttled: tr('被限流'),
  quota: tr('额度用尽'),
  balance: tr('余额不足'),
  network: tr('网络错误'),
  stream: tr('回答流断了'),
  credential: tr('凭证失效'),
  context: tr('上下文过长'),
  output_cap: tr('输出超限'),
  server: tr('上游故障'),
  refusal: tr('模型拒答'),
  aborted: tr('已中断'),
  history: tr('对话记录有误'),
  unknown: tr('未知错误'),
};

export const ERROR_HINT: Record<ErrorKind, string> = {
  throttled: tr('等待片刻后重试；订阅额度看顶栏的环。'),
  quota: tr('本窗口额度已用完，等重置或换供应商 / 模型。'),
  balance: tr('供应商账户的余额不够了：去供应商那里充值，或在模型菜单里换一个供应商。'),
  network: tr('检查网络或 Base URL；中转站可能暂时不可达。'),
  stream: tr('网络、代理或中转在回答途中断开了，这一轮停在这里：点重试，或者发「继续」接着做。'),
  credential: tr('供应商的 API Key 不对或过期（设置 → 供应商），或 Claude 账号登录失效（终端里运行 claude auth login）。'),
  context: tr('对话太长了：/compact 压缩，或从某条消息分叉一个新对话。'),
  output_cap: tr('单次输出超过上限，让模型分段继续。'),
  server: tr('上游 5xx / 过载，稍后重试通常就好。'),
  refusal: tr('模型拒绝了这个请求；换个说法或换模型。'),
  aborted: tr('这一轮被中断了，可以直接继续发消息。'),
  history: tr('这个对话的记录里有接口不收的内容（只发一张图片时留下的空文字，或别家模型的思考），已经自动去掉了：点重试或再发一次就行。'),
  unknown: tr('看结果行里的原始错误文本。'),
};

/**
 * Under the first retry that got no response at all (`error_status` null): every connection-level failure (a proxy
 * port nobody listens on, a name that does not resolve, a TLS handshake that fails, a reset) looks the same while
 * the CLI retries — `unknown`, a second or two apart — and its reason is only in the error after the tenth retry,
 * minutes later. 测试连接 runs the same CLI with one retry: the reason in seconds. Which one the conversation talks to
 * matters: a user whose provider tested fine was looking at a conversation on the Claude account, which goes to
 * api.anthropic.com (2026-10-08) — so the hint names it. `provider`: the conversation's provider name; none = the account.
 */
/** Under the first retry of a refused key, worded like `noResponseHint` for what the conversation talks to. */
export function credentialHint(provider?: string): string {
  if (provider) return tr('「{provider}」拒绝了这个 API Key：检查 设置 → 供应商 →「{provider2}」里的 Key（可以点「测试连接」）。', { provider, provider2: provider });
  return tr('这个对话用的是「Claude 账号」，没有经过你添加的供应商（中转）：被拒的是 Claude 账号的登录，或者 ~/.claude/settings.json 里写的 Key。要用供应商：点输入框右下角的模型按钮，在供应商那一节选一个模型。');
}

export function noResponseHint(provider?: string): string {
  const why = tr('具体原因要等十次重试走完才会显示；常见原因：代理（梯子）没开或端口不对，或者域名解析不了。');
  if (provider) return tr('连不上「{provider}」。{why}想马上知道：设置 → 供应商 →「{provider2}」的「测试连接」。', { provider, why, provider2: provider });
  return tr('这个对话用的是「Claude 账号」，没有经过你添加的供应商（中转）。要用供应商：点输入框右下角的模型按钮，在供应商那一节选一个模型。{why}', { why });
}

export interface StallInput {
  state: 'starting' | 'idle' | 'running' | 'waiting' | 'error' | 'closed' | 'history';
  now: number;
  lastEventAt?: number;
  lastModelCallAt?: number;
  /** when this turn started (the user message landed); unset for turns this window did not start */
  turnStartedAt?: number;
  runningTool?: { name: string; since: number; elapsed?: number } | null;
  compacting?: boolean;
}

export type Stall =
  | { kind: 'waiting' }
  | { kind: 'compacting' }
  | { kind: 'tool'; tool: string; seconds: number }
  | { kind: 'quiet'; seconds: number }
  | { kind: 'no_model'; minutes: number; seconds: number }
  /** the turn has not had a single model reply yet (an upstream that never answers) */
  | { kind: 'no_reply'; minutes: number; seconds: number }
  | null;

export const STALL_QUIET_MS = 15_000;
export const STALL_NO_MODEL_MS = 3 * 60_000;

/** What to show in the status strip while a turn is running. Client-side timers over stream events. */
export function deriveStall(i: StallInput): Stall {
  if (i.state === 'waiting') return { kind: 'waiting' };
  if (i.state !== 'running') return null;
  if (i.compacting) return { kind: 'compacting' };
  const now = i.now;
  // a model call from an earlier turn says nothing about this one (lastModelCallAt is conversation-wide)
  const modelAt = i.lastModelCallAt && (!i.turnStartedAt || i.lastModelCallAt >= i.turnStartedAt) ? i.lastModelCallAt : undefined;
  if (!i.runningTool) {
    if (modelAt && now - modelAt >= STALL_NO_MODEL_MS) {
      const since = now - modelAt;
      return { kind: 'no_model', minutes: Math.floor(since / 60_000), seconds: Math.floor(since / 1000) };
    }
    if (!modelAt && i.turnStartedAt && now - i.turnStartedAt >= STALL_NO_MODEL_MS) {
      const since = now - i.turnStartedAt;
      return { kind: 'no_reply', minutes: Math.floor(since / 60_000), seconds: Math.floor(since / 1000) };
    }
  }
  if (i.runningTool) {
    const s = i.runningTool.elapsed ?? Math.floor((now - i.runningTool.since) / 1000);
    return { kind: 'tool', tool: i.runningTool.name, seconds: Math.max(0, Math.floor(s)) };
  }
  const quiet = i.lastEventAt ? now - i.lastEventAt : 0;
  if (i.lastEventAt && quiet >= STALL_QUIET_MS) return { kind: 'quiet', seconds: Math.floor(quiet / 1000) };
  return null;
}

/** "上下文已自动压缩 · 释放 37%" */
export function compactionNotice(meta: { trigger?: string; pre_tokens?: number; post_tokens?: number } | undefined): string {
  const pre = meta?.pre_tokens ?? 0;
  const post = meta?.post_tokens;
  const auto = meta?.trigger === 'auto';
  const head = auto ? tr('上下文已自动压缩') : tr('上下文已压缩');
  if (pre && post !== undefined && post !== null && post <= pre) {
    const pct = Math.round(((pre - post) / pre) * 100);
    return tr('{head} · 释放 {pct}%（{fmtK} → {fmtK2}）', { head, pct, fmtK: fmtK(pre), fmtK2: fmtK(post) });
  }
  return pre ? `${head}（${fmtK(pre)} tok）` : head;
}

function fmtK(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}
