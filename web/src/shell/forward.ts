// The service worker hands the app frame's requests to the shell window, which makes them over the link (Mux) and
// answers. Pure: the message shapes, and how a PC answer or a failure becomes the reply.
//   SW → window   { cw: 'fetch', v: 1, owner, cache, kind, method, path, headers, body }   on a MessageChannel port
//   window → SW   { skip: true }   not this window's frame (or no app open here)
//                 { status, headers, body: ArrayBuffer | null }   the answer (the body is transferred)
import type { MuxResponse } from '@anywhere';
import { SAY, explainPcError, errText, withRaw } from './explain';

export const MSG_FETCH = 'fetch';
export const MSG_VERSION = 1;

export interface ShellRequest {
  /** The shell window that owns the asking frame; null when the frame has no mark (a worker): any window may answer. */
  owner: string | null;
  /** The app cache the frame reads (an asset fetched for it is kept there). */
  cache: string | null;
  kind: 'asset' | 'api';
  method: string;
  /** Path and query on the PC. */
  path: string;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

export interface ShellReply {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

/** Headers the reply's own Response decides (its body is whole, uncompressed). */
const DROP = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);
const NULL_BODY = new Set([204, 205, 304]);
const TEXT = { 'content-type': 'text/plain; charset=utf-8' };
const enc = new TextEncoder();

/** An ArrayBuffer of exactly these bytes (a Mux body may be a view on a bigger frame buffer). */
function own(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer;
}

function textReply(status: number, text: string): ShellReply {
  return { status, headers: { ...TEXT }, body: own(enc.encode(text)) };
}

/** The PC's answer as it is: status and body unchanged (a 413 over the slow relay is shown where the preview was). */
export function replyFromPc(res: MuxResponse): ShellReply {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) if (!DROP.has(k)) headers[k] = v;
  return { status: res.status, headers, body: own(res.body) };
}

/** The request failed (an ERR from the PC, the link ended): 502 with a Chinese sentence and the original (R8c). */
export function replyFromError(e: unknown): ShellReply {
  return textReply(502, withRaw(explainPcError(errText(e))));
}

export function replyNoWindow(): ShellReply {
  return textReply(503, SAY.noWindow);
}

/** The shell window took longer than the service worker waits (60 s). */
export function replyTimeout(): ShellReply {
  return textReply(504, SAY.timeout);
}

/** An app/api/… address opened as a page of its own: refused, never forwarded (route.ts refusedApi). */
export function replyForbidden(): ShellReply {
  return textReply(403, SAY.forbidden);
}

/** A file the PC does not have: its static server answers with index.html instead (the app's SPA fallback). */
export function spaFallback(path: string, res: MuxResponse): boolean {
  const p = path.split('?')[0];
  if (p === '/' || p.endsWith('/') || p.endsWith('.html')) return false;
  return res.status === 200 && /^text\/html\b/i.test(res.headers['content-type'] ?? '');
}

/** `path` with `token=` set to the device token: only for what goes over the link. */
export function withToken(path: string, token: string): string {
  const at = path.indexOf('?');
  const base = at < 0 ? path : path.slice(0, at);
  const q = new URLSearchParams(at < 0 ? '' : path.slice(at + 1));
  q.set('token', token);
  return `${base}?${q}`;
}

/** What `new Response()` accepts: no body for 204 / 205 / 304, and a status it can have (else 502). */
export function responseParts(r: ShellReply): { body: ArrayBuffer | null; init: ResponseInit } {
  const status = Number.isInteger(r.status) && r.status >= 200 && r.status <= 599 ? r.status : 502;
  return { body: NULL_BODY.has(status) ? null : r.body, init: { status, headers: r.headers } };
}

function strings(o: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
  return out;
}

const orNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A request message from the service worker, or null for anything else. */
export function readShellRequest(d: unknown): ShellRequest | null {
  const m = d as Record<string, unknown> | null;
  if (!m || typeof m !== 'object' || m.cw !== MSG_FETCH || m.v !== MSG_VERSION) return null;
  if (m.kind !== 'asset' && m.kind !== 'api') return null;
  if (typeof m.method !== 'string' || !/^[A-Za-z]{1,16}$/.test(m.method)) return null;
  if (typeof m.path !== 'string' || !m.path.startsWith('/')) return null;
  const body = m.body instanceof ArrayBuffer ? m.body : null;
  return { owner: orNull(m.owner), cache: orNull(m.cache), kind: m.kind, method: m.method, path: m.path, headers: strings(m.headers), body };
}

/** A reply from a shell window: 'skip', the reply, or null for a malformed one. */
export function readShellReply(d: unknown): ShellReply | 'skip' | null {
  const m = d as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') return null;
  if (m.skip === true) return 'skip';
  if (typeof m.status !== 'number') return null;
  return { status: m.status, headers: strings(m.headers), body: m.body instanceof ArrayBuffer ? m.body : null };
}
