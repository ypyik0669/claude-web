// Prompt-cache helpers shared by the gateway's translated requests and the per-profile cache shim.
// Caches are keyed on an exact prefix (and, at OpenAI-style providers / new-api relays, on a routing key),
// so everything here is about making the same session send the same bytes with the same key.
import type http from 'node:http';

/** OpenAI caps prompt_cache_key at 64 characters. */
export const CACHE_KEY_MAX = 64;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const header = (h: http.IncomingHttpHeaders, k: string) => str(Array.isArray(h[k]) ? h[k]![0] : h[k]);

/**
 * The client's session identity, in order of how explicitly it names a cache route: the body's
 * `prompt_cache_key` (Codex, OpenAI SDKs) → `session_id` header (Codex, Pi) → `x-claude-code-session-id`
 * (Claude Code) → Anthropic `metadata.user_id`. Not `x-client-request-id`: that names one request.
 */
export function cacheKeyOf(json: any, headers: http.IncomingHttpHeaders): string | undefined {
  return str(json?.prompt_cache_key) ?? header(headers, 'session_id') ?? header(headers, 'x-claude-code-session-id') ?? str(json?.metadata?.user_id);
}

/**
 * Session-affinity headers relays route on (new-api channel affinity, Pi conventions); xAI keeps a
 * conversation on one cache host by `x-grok-conv-id`. Only added when the client did not send them.
 * (No `x-client-request-id`: a request id reused for every call of a session is a lie to the relay's logs.)
 */
export function affinityHeaders(key: string, grok: boolean): Record<string, string> {
  const h: Record<string, string> = { session_id: key, 'x-session-affinity': key };
  if (grok) h['x-grok-conv-id'] = key;
  return h;
}
export function addMissing(headers: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const have = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(extra)) if (!have.has(k)) headers[k] = v;
  return headers;
}

/** An upstream 400 that is about the cache key (so dropping it and retrying is the fix). */
export const mentionsCacheKey = (text: string) => /prompt_cache_key/i.test(text);
/** Status codes where a request we decorated with prompt_cache_key is retried once without it. */
export const isParamRejection = (status: number) => status === 400 || status === 422;

/**
 * Claude Code puts a per-build / per-request billing line first in `system`: useless (and prefix-breaking)
 * for any other vendor. Removes just the lines that start with it; the rest of the text stays.
 */
export const stripBillingHeader = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*x-anthropic-billing-header\s*:/i.test(l)).join('\n');

/**
 * Insert `"key": value` as the FIRST member of a top-level JSON object, leaving every other byte as it was
 * (a relay may hash the body; a cache is keyed on the prefix after all). Null when the text is not an object.
 */
export function insertTopLevelField(json: string, key: string, value: unknown): string | null {
  const i = json.search(/\S/);
  if (i < 0 || json[i] !== '{') return null;
  const rest = json.slice(i + 1);
  const empty = /^\s*\}/.test(rest);
  return `${json.slice(0, i + 1)}${JSON.stringify(key)}:${JSON.stringify(value)}${empty ? '' : ','}${rest}`;
}

/**
 * Some OpenAI-compatible upstreams report the hit only at the top level (`prompt_cache_hit_tokens` —
 * DeepSeek; `cached_tokens` — Kimi). Clients that only read `prompt_tokens_details.cached_tokens` (ccb, the
 * OpenAI SDK's typing) then show 0 %. Adds the details field in place; false when nothing had to change.
 */
/**
 * Line-level SSE pass-through that may rewrite single `data:` lines (a usage chunk) and leaves every other
 * byte — line endings included — as received. A trailing lone `\r` waits for the next chunk (half a CRLF).
 */
const EMPTY_REASONING = /"reasoning_content"\s*:\s*""/;

export class SseLines {
  private buf = '';
  constructor(private rewrite: (data: any) => boolean) {}
  push(s: string): string {
    this.buf += s;
    let out = '';
    let pos = 0;
    for (;;) {
      const i = this.nextBreak(pos);
      if (i < 0) break;
      const len = this.buf[i] === '\r' && this.buf[i + 1] === '\n' ? 2 : 1;
      out += this.line(this.buf.slice(pos, i)) + this.buf.slice(i, i + len);
      pos = i + len;
    }
    this.buf = this.buf.slice(pos);
    return out;
  }
  end(): string {
    const s = this.buf ? this.line(this.buf) : '';
    this.buf = '';
    return s;
  }
  private nextBreak(from: number): number {
    for (let i = from; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c === '\n') return i;
      if (c === '\r') return i + 1 < this.buf.length ? i : -1;
    }
    return -1;
  }
  private line(l: string): string {
    if (!l.startsWith('data:') || !(l.includes('"usage"') || EMPTY_REASONING.test(l))) return l;
    let j: any;
    try { j = JSON.parse(l.slice(5)); } catch { return l; }
    return this.rewrite(j) ? `data: ${JSON.stringify(j)}` : l;
  }
}

export function fixChatUsage(u: any): boolean {
  if (!u || typeof u !== 'object') return false;
  const d = u.prompt_tokens_details;
  if (d && typeof d === 'object' && typeof d.cached_tokens === 'number') return false;
  const hit = typeof u.prompt_cache_hit_tokens === 'number' ? u.prompt_cache_hit_tokens : typeof u.cached_tokens === 'number' ? u.cached_tokens : undefined;
  if (hit === undefined) return false;
  u.prompt_tokens_details = { ...(d && typeof d === 'object' ? d : {}), cached_tokens: hit };
  return true;
}

/**
 * `"reasoning_content": ""` next to a chunk's content (qwen3.8 on aizhongzhuan, 2026-10-02): ccb's OpenAI stream reader
 * takes an empty string for "thinking starts" (it only checks != null), opens a thinking block, and every later text
 * delta lands in it — the answer showed as its first word. An empty field says nothing: drop it (the deltas of a
 * stream, the message of a whole response). False when nothing had to change.
 */
export function dropEmptyReasoning(j: any): boolean {
  let changed = false;
  for (const c of Array.isArray(j?.choices) ? j.choices : []) {
    for (const part of [c?.delta, c?.message]) {
      if (part && typeof part === 'object' && part.reasoning_content === '') { delete part.reasoning_content; changed = true; }
    }
  }
  return changed;
}
