// Upstream HTTP for the gateway. Plain node:http/https on purpose: fetch (undici) adds its own headers
// (accept-encoding, sec-fetch-mode, accept-language…) and transparently decompresses, so a "passthrough"
// would no longer be the client's request byte for byte — and relays fingerprint exactly that.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { proxyAgentFor } from '../net/proxy.js';

export interface UpstreamResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

export class UpstreamError extends Error {
  constructor(message: string, readonly timeout = false) { super(message); }
}

const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };

/**
 * Send one request; resolves when response headers arrive. `headerTimeoutMs` bounds the wait for
 * the status line; `signal` aborts (client went away / attempt abandoned).
 */
export function sendUpstream(url: string, opts: { method: string; headers: Record<string, string>; body?: Buffer; signal?: AbortSignal; headerTimeoutMs: number }): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(url); } catch { reject(new UpstreamError(`无效的上游地址：${url}`)); return; }
    const mod = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!mod) { reject(new UpstreamError(`不支持的协议：${u.protocol}`)); return; }
    const headers = { ...opts.headers };
    if (opts.body) headers['content-length'] = String(opts.body.length);
    // through the user's proxy when there is one (net/proxy.ts): a CONNECT tunnel, so the request bytes stay the client's
    const agent = proxyAgentFor(u) ?? (u.protocol === 'https:' ? agents.https : agents.http);
    const req = mod.request(u, { method: opts.method, headers, agent });
    let settled = false;
    const fail = (e: Error) => { if (settled) return; settled = true; clearTimeout(timer); req.destroy(); reject(e); };
    const timer = setTimeout(() => fail(new UpstreamError(`上游 ${Math.round(opts.headerTimeoutMs / 1000)}s 内没有响应`, true)), opts.headerTimeoutMs);
    const onAbort = () => fail(new UpstreamError('请求已取消'));
    if (opts.signal?.aborted) { onAbort(); return; }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('response', (res) => {
      if (settled) { res.destroy(); return; }
      settled = true;
      clearTimeout(timer);
      // abandoning the attempt later (client gone) must also tear down the body
      opts.signal?.addEventListener('abort', () => res.destroy(), { once: true });
      resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res });
    });
    req.on('error', (e: any) => fail(new UpstreamError(e?.code ? `${e.code}: ${e.message}` : e?.message ?? String(e))));
    req.end(opts.body);
  });
}

/** A zlib decompressor for a content-encoding, or null (identity / unknown). */
export function decoder(encoding: string): import('node:stream').Transform | null {
  const enc = encoding.toLowerCase().trim();
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.createGunzip();
  if (enc === 'deflate') return zlib.createInflate();
  if (enc === 'br') return zlib.createBrotliDecompress();
  if (enc === 'zstd' && HAS_ZSTD) return (zlib as any).createZstdDecompress();
  return null;
}

/** A decompressing view of a response body (for reading / sniffing — passthrough pipes the raw bytes). */
export function decoded(res: http.IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
  const z = decoder(enc);
  if (!z) return res;
  z.on('error', () => { /* truncated / bogus encoding: the reader just sees the stream end */ });
  return res.pipe(z);
}

/** Read a whole (decoded) body as text, up to `limit` bytes. */
export async function readText(res: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of decoded(res)) {
    size += (c as Buffer).length;
    if (size > limit) { res.destroy(); throw new UpstreamError('上游响应过大'); }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const HOP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'content-length', 'expect']);
const AUTH = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'cookie']);

/**
 * Client headers for a passthrough request: original order and casing (from rawHeaders), minus
 * hop-by-hop, our own gateway credential and cookies; the member's credential goes in the same
 * style the client used (x-api-key vs Bearer), so the upstream sees what a direct call would send.
 */
export function passthroughHeaders(raw: string[], outbound: 'anthropic' | 'openai' | 'gemini', key: string): Record<string, string> {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
  // RFC 9110 §7.6.1: fields named in Connection are hop-by-hop too
  const hop = new Set(HOP);
  for (const [n, v] of pairs) if (n.toLowerCase() === 'connection') for (const t of v.split(',')) if (t.trim()) hop.add(t.trim().toLowerCase());
  const has = (h: string) => pairs.some(([n, v]) => n.toLowerCase() === h && v.trim());
  // the credential the member gets, named the way the client named its own
  const cred: [string, string] = outbound === 'gemini' ? ['x-goog-api-key', key]
    : outbound === 'anthropic' && has('x-api-key') ? ['x-api-key', key]
    : ['authorization', `Bearer ${key}`];
  const out: Record<string, string> = {};
  let placed = false;
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (AUTH.has(lower) && lower !== 'cookie' && !placed && (value.trim() || lower === cred[0])) {
      // swap the value in place: header order is part of what a fingerprinting relay sees
      out[lower === cred[0] ? name : cred[0]] = cred[1];
      placed = true;
      continue;
    }
    if (hop.has(lower) || AUTH.has(lower) || lower.startsWith('x-cw-')) continue;
    const v = lower === 'accept-encoding' ? acceptEncoding(value) : value;
    const prev = Object.keys(out).find((k) => k.toLowerCase() === lower);
    if (prev) out[prev] += `, ${v}`;
    else out[name] = v;
  }
  if (!placed) out[cred[0]] = cred[1];
  return out;
}

/** Codings we can decode for usage sniffing; zstd only where this Node / Electron has it. */
const HAS_ZSTD = typeof (zlib as any).createZstdDecompress === 'function';
export function acceptEncoding(v: string): string {
  if (HAS_ZSTD) return v;
  const kept = v.split(',').map((s) => s.trim()).filter((s) => s && !/^zstd\b/i.test(s));
  return kept.length ? kept.join(', ') : 'gzip, deflate, br';
}

/** Rate-limit / request-id headers worth handing back with an upstream error. */
export function errorHeaders(h: http.IncomingHttpHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    if (v === undefined) continue;
    if (k === 'retry-after' || k === 'request-id' || k === 'x-request-id' || k.startsWith('anthropic-ratelimit-') || k.startsWith('x-ratelimit-')) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** Headers for a translated request (a different vendor than the client spoke to: nothing to preserve). */
export function translatedHeaders(outbound: 'anthropic' | 'openai' | 'gemini', key: string, stream: boolean, userAgent?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', 'accept-encoding': 'identity', 'user-agent': userAgent || 'claude-web-gateway/1' };
  if (outbound === 'anthropic') { h['x-api-key'] = key; h.authorization = `Bearer ${key}`; h['anthropic-version'] = '2023-06-01'; }
  else if (outbound === 'gemini') h['x-goog-api-key'] = key;
  else h.authorization = `Bearer ${key}`;
  return h;
}

/** Response headers we copy back to the client on passthrough. */
export function responseHeaders(h: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k) && k !== 'set-cookie') out[k] = v;
  return out;
}

/**
 * Replace the value of a top-level string field in a JSON object text without touching any other byte
 * (a relay may compare the body against what the official client sends). Returns null when the key is
 * absent at depth 1 or not a string.
 */
export function replaceTopLevelString(json: string, key: string, value: string): string | null {
  let depth = 0;
  let i = 0;
  const n = json.length;
  const readString = (start: number): number => { // returns index after closing quote
    let j = start + 1;
    while (j < n) { const c = json[j]; if (c === '\\') j += 2; else if (c === '"') return j + 1; else j++; }
    return -1;
  };
  while (i < n) {
    const c = json[i];
    if (c === '"') {
      const end = readString(i);
      if (end < 0) return null;
      if (depth === 1) {
        let k = end;
        while (k < n && /\s/.test(json[k])) k++;
        if (json[k] === ':' && JSON.parse(json.slice(i, end)) === key) {
          k++;
          while (k < n && /\s/.test(json[k])) k++;
          if (json[k] !== '"') return null;
          const vEnd = readString(k);
          if (vEnd < 0) return null;
          return json.slice(0, k) + JSON.stringify(value) + json.slice(vEnd);
        }
        // a value string at depth 1 (after ':') is skipped by the same path: it's never followed by ':'
      }
      i = end;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    i++;
  }
  return null;
}

/** A promise that rejects with Error('timeout') after ms (the late settlement of the original is swallowed). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => { /* a late rejection after the timeout must not go unhandled */ });
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), Math.max(0, ms));
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Resolves once the response can take more data, or at once when nobody is listening any more. */
export function waitDrain(res: http.ServerResponse, signal: AbortSignal): Promise<void> {
  // an abort that already happened will never fire its listener again, and a dead socket never drains
  if (signal.aborted || res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise((r) => {
    const done = () => { res.off('drain', done); res.off('close', done); signal.removeEventListener('abort', done); r(); };
    res.once('drain', done);
    res.once('close', done);
    signal.addEventListener('abort', done, { once: true });
  });
}
