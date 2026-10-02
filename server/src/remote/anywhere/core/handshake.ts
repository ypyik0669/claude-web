// Internal helpers shared by both ends of the handshake (dial.ts, accept.ts) and by the transports. Not part of the
// public API (index.ts does not export them). Web-standard APIs only.
import { unb64u } from './keys.js';

const NONCE_BYTES = 16;
/** Session ids become part of relay topics (relay-link.ts checks the same shape). */
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Remote candidates held per attempt until the remote description is set; a flood past it is dropped. */
export const MAX_HELD_CANDIDATES = 64;

export function newNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
}

/** The 16 bytes of a b64u nonce from the other side, or null. */
export function readNonce(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || v.length > 32) return null;
  try {
    const b = unb64u(v);
    return b.length === NONCE_BYTES ? b : null;
  } catch {
    return null;
  }
}

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_RE.test(v);
}

/** '' when there is nothing to say (the browser's WebSocket and RTC error events carry no detail at all). */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    // undici's ErrorEvent has message / error, and so does RTCErrorEvent
    const o = e as { message?: unknown; error?: unknown };
    if (typeof o.message === 'string' && o.message) return o.message;
    if (o.error instanceof Error) return o.error.message;
  }
  return '';
}

/**
 * A bug in a callback must not tear a link or a channel down, and must not escape into a socket's, a channel's or
 * the pool's event dispatch: it is logged with the module's tag instead.
 */
export function report(tag: string, what: string, e: unknown): void {
  console.error(`[${tag}] ${what} threw`, e);
}
