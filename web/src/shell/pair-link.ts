// The pairing QR: `<shell>#p=<base64url(JSON {v:1, ps: base64url(P), code, pc})>` (the fragment never reaches a
// server), and the PC's answer to POST api/pair over the pairing link. Pure.
import { unb64u, type MuxResponse } from '@anywhere';

export interface PairLink {
  /** The one-time 16-byte pairing secret: the pairing room is derived from it. */
  ps: Uint8Array;
  /** The 6-digit pairing code the PC checks (its own tries limit applies). */
  code: string;
  /** The PC's name, as the PC wrote it (shown while pairing). */
  pc: string;
}

const PAIR_SECRET_BYTES = 16;
const MAX_LINK_CHARS = 4096;
const MAX_PC_NAME = 256;
const strictDec = new TextDecoder('utf-8', { fatal: true });

/** The pairing link in a URL fragment (`#p=…`, with or without the `#`); null for anything else. */
export function parsePairLink(hash: string): PairLink | null {
  if (typeof hash !== 'string' || hash.length > MAX_LINK_CHARS) return null;
  const p = new URLSearchParams(hash.replace(/^#/, '')).get('p');
  if (!p) return null;
  let o: { v?: unknown; ps?: unknown; code?: unknown; pc?: unknown };
  try {
    o = JSON.parse(strictDec.decode(unb64u(p)));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || o.v !== 1 || typeof o.ps !== 'string' || typeof o.code !== 'string' || !/^\d{6}$/.test(o.code)) return null;
  let ps: Uint8Array;
  try {
    ps = unb64u(o.ps);
  } catch {
    return null;
  }
  if (ps.length !== PAIR_SECRET_BYTES) return null;
  return { ps, code: o.code, pc: typeof o.pc === 'string' ? o.pc.slice(0, MAX_PC_NAME) : '' };
}

/** What POST api/pair answered: the device token and the PC's id for this device, or the PC's own (Chinese) refusal. */
export function readPairAnswer(res: MuxResponse): { token: string; id: string } | { error: string } {
  let j: { token?: unknown; device?: { id?: unknown }; error?: unknown } | null = null;
  try {
    j = JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    // not JSON: said below with the status
  }
  if (j && typeof j.error === 'string' && j.error) return { error: j.error };
  const token = j?.token;
  const id = j?.device?.id;
  if (res.status === 200 && typeof token === 'string' && token && typeof id === 'string' && /^[\w-]{1,64}$/.test(id)) return { token, id };
  return { error: `配对没有成功：电脑的回答读不出来（状态 ${res.status}）` };
}
