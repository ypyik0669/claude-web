// The privacy relay (`/gateway/~v/<sig>/<target>/…`): while 隐私保护 is on, conversations, agents and connection tests
// whose provider is not already behind the gateway / cache shim get this as their base URL (privacy/route.ts). The real
// upstream base rides in the path (base64url, signed with a per-process HMAC so the route is not an open proxy), the
// client's own credential and headers go on as they came (order and casing kept, hop-by-hop dropped).
//
// Byte fidelity: a body with nothing to replace goes out as the very bytes the client sent and the answer comes back
// as the upstream's bytes (compressed or not). Only a request that got a placeholder is re-serialised; its answer is
// asked for uncompressed and restored on the way back (JSON and SSE). Pipeline on and failing → refused, never raw.
import crypto from 'node:crypto';
import type http from 'node:http';
import zlib from 'node:zlib';
import { UpstreamError, forwardHeaders, readText, sendUpstream } from './upstream.js';
import { tr } from '../i18n/index.js';
import { PrivacyBlocked, PrivacyFailed, privacyErrorStatus, type PrivacyService } from './service.js';

export const RELAY_PREFIX = '/gateway/~v/';
const BODY_LIMIT = 64 * 1024 * 1024;
/** a non-streamed answer only sends its headers when it is done: as long as a long turn may take */
const HEADER_MS = 15 * 60_000;
const HOP = /^(connection|keep-alive|transfer-encoding|content-length|proxy-connection|upgrade|trailer|te)$/i;

const b64 = (s: string) => Buffer.from(s).toString('base64url');

export class PrivacyRelay {
  private secret = crypto.randomBytes(32);
  constructor(private privacy: PrivacyService, private baseUrl: () => string | null) {}

  private sig(target: string) { return crypto.createHmac('sha256', this.secret).update(target).digest('hex').slice(0, 32); }

  /** The base a client should use for `target` (null: the server is not listening yet). */
  base(target: string): string | null {
    const root = this.baseUrl();
    if (!root) return null;
    const t = target.trim().replace(/\/+$/, '');
    return `${root}/~v/${this.sig(t)}/${b64(t)}`;
  }

  private fail(res: http.ServerResponse, status: number, message: string) {
    if (res.headersSent) { res.destroy(); return; }
    // one shape every SDK reads a message from (Anthropic `error.message`, OpenAI `error.message`, Gemini `error.message`)
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'privacy_error', code: status, message } }));
  }

  async serve(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const m = /^\/gateway\/~v\/([a-f0-9]{32})\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return this.fail(res, 404, tr('隐私中转地址不对'));
    let target = '';
    try { target = Buffer.from(m[2], 'base64url').toString('utf8'); } catch { /* bad */ }
    const want = Buffer.from(this.sig(target));
    const got = Buffer.from(m[1]);
    if (!target || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return this.fail(res, 403, tr('隐私中转地址无效（只接受本进程发出的地址）'));
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > BODY_LIMIT) return this.fail(res, 413, tr('请求体过大'));
      chunks.push(c as Buffer);
    }
    let body: Buffer = Buffer.concat(chunks);
    const headers = forwardHeaders(req.rawHeaders);
    const rest = m[3] ?? '';
    let stream = /stream/i.test(rest) || /alt=sse/.test(url.search);
    let redacted = false;
    let guard: ReturnType<PrivacyService['forRequest']> = null;
    if (body.length) {
      try {
        guard = this.privacy.forRequest({ url: target, source: hostOf(target) });
        if (guard) {
          // a compressed request body (Codex on a ChatGPT login may zstd its requests) is read plain, and goes on plain
          const encKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-encoding');
          if (encKey) {
            const plain = decodeBody(body, headers[encKey]);
            if (!plain) throw new PrivacyFailed(tr('请求体的压缩格式（{enc}）读不了', { enc: headers[encKey] }));
            body = plain;
            delete headers[encKey];
          }
          await guard.prepare(body);
          body = guard.body(body);
          redacted = guard.redacted;
          guard.done();
        }
      } catch (e: any) {
        if (e instanceof PrivacyBlocked) guard?.done(true);
        // fail closed: a privacy pipeline that cannot run means the request is not sent at all — 503, never plaintext
        return this.fail(res, privacyErrorStatus(e), this.privacy.scrub(e?.message ?? String(e)));
      }
    }
    if (redacted) {
      try { stream ||= !!JSON.parse(body.toString('utf8'))?.stream; } catch { /* not JSON */ }
      // the answer has to be readable to put the values back
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'accept-encoding') delete headers[k];
      headers['accept-encoding'] = 'identity';
    }
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    let up;
    try {
      up = await sendUpstream(`${target}${rest}${url.search}`, { method: req.method ?? 'GET', headers, body: body.length ? body : undefined, signal: ac.signal, headerTimeoutMs: HEADER_MS });
    } catch (e: any) {
      if (ac.signal.aborted) return;
      return this.fail(res, e instanceof UpstreamError && e.timeout ? 504 : 502, this.privacy.scrub(e?.message ?? String(e)));
    }
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP.test(k)) out[k] = v;
    // an error may quote the request: masked before the client (and whatever it logs) sees it
    if (up.status >= 400) {
      let text = '';
      try { text = await readText(up.body, 4 * 1024 * 1024); } catch { /* keep empty */ }
      delete out['content-encoding'];
      res.writeHead(up.status, out).end(this.privacy.scrub(text));
      return;
    }
    if (redacted) guard!.restore(res, stream);
    res.writeHead(up.status, out);
    up.body.pipe(res);
  }
}

function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}

/** A request body in plain bytes (null: an encoding this Node cannot read). */
export function decodeBody(b: Buffer, encoding: string): Buffer | null {
  const encs = encoding.toLowerCase().split(',').map((x) => x.trim()).filter((x) => x && x !== 'identity').reverse();
  try {
    for (const e of encs) {
      if (e === 'gzip' || e === 'x-gzip') b = zlib.gunzipSync(b);
      else if (e === 'deflate') b = zlib.inflateSync(b);
      else if (e === 'br') b = zlib.brotliDecompressSync(b);
      else if (e === 'zstd' && typeof (zlib as any).zstdDecompressSync === 'function') b = (zlib as any).zstdDecompressSync(b);
      else return null;
    }
    return b;
  } catch { return null; }
}
