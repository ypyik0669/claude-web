// Channel frames: what the direct link, the slow relay and the PC bridge all carry.
// 1 type byte + 4-byte big-endian stream id + payload. Shared by the Node server and the phone shell,
// so Web-standard APIs only (no node:*, no Buffer).

export enum F {
  WS_OPEN = 1,
  WS_MSG = 2,
  WS_CLOSE = 3,
  HTTP_REQ = 0x10,
  BODY = 0x11,
  END = 0x12,
  HTTP_RES = 0x20,
  PING = 0x30,
  PONG = 0x31,
  ERR = 0x40,
}

export const HEADER_BYTES = 5;
export const CHUNK_BYTES = 16_384;

const enc = new TextEncoder();
// ignoreBOM: WS_MSG carries text frames verbatim, so a leading U+FEFF must survive the round trip
const dec = new TextDecoder('utf-8', { ignoreBOM: true });

export interface Frame {
  type: F;
  stream: number;
  payload: Uint8Array;
}

/** Always a fresh buffer: the payload is copied, so the caller may reuse its own bytes afterwards. */
export function encodeFrame(type: F, stream: number, payload?: Uint8Array | string): Uint8Array<ArrayBuffer> {
  // DataView setters wrap silently (-1 → 0xffffffff, 256 → 0), which would route a frame to the wrong stream
  if (!Number.isInteger(type) || type < 0 || type > 0xff) throw new Error(`frame type must be one byte, got ${type}`);
  if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff) {
    throw new Error(`stream id must be an integer in 0..0xffffffff, got ${stream}`);
  }
  const body = typeof payload === 'string' ? enc.encode(payload) : payload ?? new Uint8Array(0);
  const out = new Uint8Array(HEADER_BYTES + body.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, type);
  v.setUint32(1, stream, false);
  out.set(body, HEADER_BYTES);
  return out;
}

/**
 * Unknown types are passed through (the receiver ignores what it does not know, so a newer peer can add types).
 * `payload` is a view on `buf`, not a copy: it changes if `buf` is reused; copy it to keep it past that.
 */
export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length < HEADER_BYTES) throw new Error(`frame too short: ${buf.length} bytes, header is ${HEADER_BYTES}`);
  // byteOffset matters: a frame handed over as a subarray of a larger buffer
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { type: v.getUint8(0) as F, stream: v.getUint32(1, false), payload: buf.subarray(HEADER_BYTES) };
}

/** Views on `data` (no copies), each at most `size` bytes; empty data gives no chunks. */
export function chunks(data: Uint8Array, size = CHUNK_BYTES): Uint8Array[] {
  if (!Number.isInteger(size) || size <= 0) throw new Error(`chunk size must be a positive integer, got ${size}`);
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  return out;
}

export function text(payload: Uint8Array): string {
  return dec.decode(payload);
}

export function json(payload: Uint8Array): any {
  return JSON.parse(text(payload));
}
