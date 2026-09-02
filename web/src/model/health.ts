// Pure helpers that turn SDK error / timing signals into UI-facing health state. No DOM, no store.

export type ErrorKind = 'throttled' | 'quota' | 'network' | 'credential' | 'context' | 'output_cap' | 'server' | 'refusal' | 'aborted' | 'unknown';

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
  if (s.rateLimitStatus === 'rejected' || s.rateLimitErrorCode === 'credits_required') return 'quota';
  if (tr === 'blocking_limit' || err === 'billing_error' || err === 'account_on_hold' || /credit|billing|quota exceeded|insufficient/.test(text)) return 'quota';
  if (err === 'rate_limit' || st === 429 || /rate limit|too many requests|throttl/.test(text)) return 'throttled';
  if (err === 'authentication_failed' || err === 'oauth_org_not_allowed' || st === 401 || st === 403 || /unauthori|invalid api key|authentication|not logged in|expired token/.test(text)) return 'credential';
  if (tr === 'prompt_too_long' || /prompt is too long|context window|too long|input length/.test(text)) return 'context';
  if (err === 'max_output_tokens' || /max_tokens|output token/.test(text)) return 'output_cap';
  if (tr.startsWith('aborted') || /interrupted|aborted|cancel/.test(text)) return 'aborted';
  if (/refus/.test(text) || /refus/.test(tr)) return 'refusal';
  if (err === 'overloaded' || err === 'server_error' || (st !== undefined && st !== null && st >= 500) || /overloaded|internal server error|bad gateway|service unavailable/.test(text)) return 'server';
  if (s.status === null || /econnreset|econnrefused|etimedout|fetch failed|network|socket hang up|enotfound|dns/.test(text)) return 'network';
  if (tr === 'api_error' || tr === 'model_error') return 'server';
  return 'unknown';
}

export const ERROR_LABEL: Record<ErrorKind, string> = {
  throttled: '被限流',
  quota: '额度用尽',
  network: '网络错误',
  credential: '凭证失效',
  context: '上下文过长',
  output_cap: '输出超限',
  server: '上游故障',
  refusal: '模型拒答',
  aborted: '已中断',
  unknown: '未知错误',
};

export const ERROR_HINT: Record<ErrorKind, string> = {
  throttled: '等待片刻后重试；订阅额度看顶栏的环。',
  quota: '本窗口额度已用完，等重置或换供应商 / 模型。',
  network: '检查网络或 Base URL；中转站可能暂时不可达。',
  credential: '在终端面板 /login 重新登录，或检查供应商的 API Key。',
  context: '对话太长了：/compact 压缩，或从某条消息分叉一个新会话。',
  output_cap: '单次输出超过上限，让模型分段继续。',
  server: '上游 5xx / 过载，稍后重试通常就好。',
  refusal: '模型拒绝了这个请求；换个说法或换模型。',
  aborted: '这一轮被中断了，可以直接继续发消息。',
  unknown: '看结果行里的原始错误文本。',
};

export interface StallInput {
  state: 'starting' | 'idle' | 'running' | 'waiting' | 'error' | 'closed' | 'history';
  now: number;
  lastEventAt?: number;
  lastModelCallAt?: number;
  runningTool?: { name: string; since: number; elapsed?: number } | null;
  compacting?: boolean;
}

export type Stall =
  | { kind: 'waiting' }
  | { kind: 'compacting' }
  | { kind: 'tool'; tool: string; seconds: number }
  | { kind: 'quiet'; seconds: number }
  | { kind: 'no_model'; minutes: number; seconds: number }
  | null;

export const STALL_QUIET_MS = 15_000;
export const STALL_NO_MODEL_MS = 3 * 60_000;

/** What to show in the status strip while a turn is running. Client-side timers over stream events. */
export function deriveStall(i: StallInput): Stall {
  if (i.state === 'waiting') return { kind: 'waiting' };
  if (i.state !== 'running') return null;
  if (i.compacting) return { kind: 'compacting' };
  const now = i.now;
  const sinceModel = i.lastModelCallAt ? now - i.lastModelCallAt : 0;
  if (i.lastModelCallAt && sinceModel >= STALL_NO_MODEL_MS && !i.runningTool) {
    return { kind: 'no_model', minutes: Math.floor(sinceModel / 60_000), seconds: Math.floor(sinceModel / 1000) };
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
  const head = auto ? '上下文已自动压缩' : '上下文已压缩';
  if (pre && post !== undefined && post !== null && post <= pre) {
    const pct = Math.round(((pre - post) / pre) * 100);
    return `${head} · 释放 ${pct}%（${fmtK(pre)} → ${fmtK(post)}）`;
  }
  return pre ? `${head}（${fmtK(pre)} tok）` : head;
}

function fmtK(n: number) {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}
