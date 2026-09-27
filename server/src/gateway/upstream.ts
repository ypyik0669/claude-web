// Upstream HTTP for the gateway. Plain node:http/https on purpose: fetch (undici) adds its own headers
// (accept-encoding, sec-fetch-mode, accept-language…) and transparently decompresses, so a "passthrough"
// would no longer be the client's request byte for byte — and relays fingerprint exactly that.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';

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
    const req = mod.request(u, { method: opts.method, headers, agent: u.protocol === 'https:' ? agents.https : agents.http });
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

/** A decompressing view of a response body (for reading / sniffing — passthrough pipes the raw bytes). */
export function decoded(res: http.IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
  const z = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
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
  const out: Record<string, string> = {};
  let usedXApiKey = false;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const lower = name.toLowerCase();
    if (lower === 'x-api-key' && raw[i + 1]) usedXApiKey = true;
    if (HOP.has(lower) || AUTH.has(lower) || lower.startsWith('x-cw-')) continue;
    const prev = Object.keys(out).find((k) => k.toLowerCase() === lower);
    if (prev) out[prev] += `, ${raw[i + 1]}`;
    else out[name] = raw[i + 1];
  }
  if (outbound === 'anthropic') { if (usedXApiKey) out['x-api-key'] = key; else out.authorization = `Bearer ${key}`; }
  else if (outbound === 'gemini') out['x-goog-api-key'] = key;
  else out.authorization = `Bearer ${key}`;
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
