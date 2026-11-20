// The pairing QR: `<shell>#p=<base64url(JSON {v:1, ps: base64url(P), code, pc, b?, st?})>` (the fragment never
// reaches a server; core's pairLink() writes it), the PC's answer to POST api/pair over the pairing link, what to do
// with a link on iOS (ruling R12b), and the memory of links already tried. Pure.
import { brokerEntries, stunEntries, unb64u, type BrokerDef, type MuxResponse } from '@anywhere';
import { DEVICE_ID_RE } from './devices';
import { tr } from './i18n';

/** A PC's signaling brokers and STUN servers, when they are not the defaults (from its pairing link). */
export interface PcLists {
  brokers?: BrokerDef[];
  stun?: string[];
}

export interface PairLink extends PcLists {
  /** The one-time 16-byte pairing secret: the pairing room is derived from it. */
  ps: Uint8Array;
  /** The 6-digit pairing code the PC checks (its own tries limit applies). */
  code: string;
  /** The PC's name, as the PC wrote it (shown while pairing). */
  pc: string;
}

/**
 * A link that reads but names a server list with nothing usable in it (`b` or `st` present and broken): refused,
 * never tried with the default lists instead (the PC does not listen on them, and the phone would only say "the PC
 * does not answer").
 */
export const BAD_LISTS = 'bad-lists';

const PAIR_SECRET_BYTES = 16;
const MAX_LINK_CHARS = 4096;
const MAX_PC_NAME = 256;
const strictDec = new TextDecoder('utf-8', { fatal: true });

/**
 * A pairing link: a URL fragment (`#p=…`, with or without the `#`), or a whole pasted address (the part after its
 * `#`); null for anything else, BAD_LISTS for a link whose lists do not read. The lists are read with core's rules
 * (lists.ts, the same as the PC's settings): `b` must give at least one broker; `st` may be empty (no STUN server), but
 * not a list, or entries none of which is usable, refuses the link. Fields this page does not know are ignored.
 */
export function parsePairLink(input: string): PairLink | typeof BAD_LISTS | null {
  if (typeof input !== 'string' || input.length > MAX_LINK_CHARS) return null;
  const s = input.trim();
  const at = s.indexOf('#');
  const p = new URLSearchParams(at >= 0 ? s.slice(at + 1) : s).get('p');
  if (!p) return null;
  let o: { v?: unknown; ps?: unknown; code?: unknown; pc?: unknown; b?: unknown; st?: unknown };
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
  const link: PairLink = { ps, code: o.code, pc: typeof o.pc === 'string' ? o.pc.slice(0, MAX_PC_NAME) : '' };
  if (o.b !== undefined) {
    const b = brokerEntries(o.b);
    if (!b?.length) return BAD_LISTS;
    link.brokers = b;
  }
  if (o.st !== undefined) {
    const st = stunEntries(o.st);
    if (!st || (st.length === 0 && (o.st as unknown[]).length > 0)) return BAD_LISTS;
    link.stun = st;
  }
  return link;
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
  if (res.status === 200 && typeof token === 'string' && token && typeof id === 'string' && DEVICE_ID_RE.test(id)) return { token, id };
  return { error: tr('配对没有成功：电脑的回答读不出来（状态 {status}）', { status: res.status }) };
}

/**
 * Ruling R12b. On iOS a home-screen web app has storage of its own, apart from Safari's: a pairing made in Safari is
 * not there. So iOS Safari asks first (and keeps the link in the address, for the home-screen bookmark); the home
 * screen, and every other browser, pair at once.
 */
export function pairPlan(o: { ios: boolean; standalone: boolean; hasPairLink: boolean }): 'list' | 'ask' | 'pair' {
  if (!o.hasPairLink) return 'list';
  return o.ios && !o.standalone ? 'ask' : 'pair';
}

/**
 * The cookie that carries a pairing link into an iOS home-screen app. Adding a site to the home screen copies the
 * site's cookies into the new app (iOS 17.2 and later, once, at that moment) and nothing else: not localStorage, not
 * IndexedDB — and on a real iPhone (2026-11) not the `#p=` in the address either, so the app opened on an empty list
 * and the link had to be pasted. So while iOS Safari asks (R12b) the link also sits in this cookie for as long as a
 * pairing code lives; the home-screen app reads it on its first start, removes it and pairs.
 *
 * The cookie goes to the shell's host with its requests for those minutes, where the fragment never does. The host
 * serves the shell's own code, so it can read the link anyway; what the fragment keeps the link out of (logs, the
 * Referer) a cookie stays out of too.
 */
export const HANDOFF_COOKIE = 'cw_pair';
export const HANDOFF_MAX_AGE_S = 600;
/** Under a browser's 4 KB a cookie, with its name and attributes. */
const HANDOFF_MAX_CHARS = 3800;

/** The `document.cookie` assignment that keeps `link`'s `p=` (base64url: cookie-safe as it is) for the home screen; null for one that cannot go. */
export function handoffCookie(link: string, path: string): string | null {
  const at = link.indexOf('#');
  const p = new URLSearchParams(at >= 0 ? link.slice(at + 1) : link).get('p');
  if (!p || p.length > HANDOFF_MAX_CHARS || !/^[\w-]+$/.test(p)) return null;
  return `${HANDOFF_COOKIE}=${p}; Max-Age=${HANDOFF_MAX_AGE_S}; Path=${path}; Secure; SameSite=Strict`;
}

/** The assignment that removes it. */
export function handoffClear(path: string): string {
  return `${HANDOFF_COOKIE}=; Max-Age=0; Path=${path}; Secure; SameSite=Strict`;
}

/** The link the cookies (`document.cookie`) hand over, as the `#p=` fragment the QR gave; null when there is none. */
export function handoffLink(cookies: string): string | null {
  const m = new RegExp(`(?:^|;\\s*)${HANDOFF_COOKIE}=([\\w-]+)`).exec(cookies ?? '');
  return m ? `#p=${m[1]}` : null;
}

/**
 * The pairing link a page starts with: the address's `#p=`, else — in a home-screen app — the one the handoff cookie
 * brought. Safari only writes that cookie, it never takes a link from it: there the link is still in the address.
 */
export function startLink(o: { hash: string; cookies: string; standalone: boolean }): { link: string; from: 'address' | 'cookie' } | null {
  if (/^#p=/.test(o.hash)) return { link: o.hash, from: 'address' };
  const c = o.standalone ? handoffLink(o.cookies) : null;
  return c ? { link: c, from: 'cookie' } : null;
}

/** A pairing code lives 10 minutes on the PC. */
export const LINK_FRESH_MS = 10 * 60_000;
const LINK_MEMORY = 20;

/** Links seen, by a hash of their pairing secret: when first, and whether the PC gave a final answer (paired or refused). */
export type LinkMemory = Record<string, { first: number; used?: true }>;

/**
 * A home-screen app opens its saved address every time, `#p=` and all: a link already used (or refused) is not tried
 * again, nor one first seen more than 10 minutes ago.
 */
export function linkState(m: LinkMemory | null | undefined, key: string, now: number): 'fresh' | 'used' | 'expired' {
  const e = m && typeof m === 'object' ? m[key] : undefined;
  if (!e || typeof e.first !== 'number') return 'fresh';
  if (e.used) return 'used';
  return now - e.first > LINK_FRESH_MS ? 'expired' : 'fresh';
}

/** `m` with `key` seen (first time kept) and, when `used`, marked so; only the newest LINK_MEMORY entries stay. */
export function rememberLink(m: LinkMemory | null | undefined, key: string, now: number, used: boolean): LinkMemory {
  const all: LinkMemory = { ...(m && typeof m === 'object' ? m : {}) };
  const prev = all[key];
  all[key] = { first: typeof prev?.first === 'number' ? prev.first : now, ...(used || prev?.used ? { used: true as const } : {}) };
  const keep = Object.entries(all)
    .sort((a, b) => b[1].first - a[1].first)
    .slice(0, LINK_MEMORY);
  return Object.fromEntries(keep);
}

/** The memory's key for a link: a hash of its pairing secret (the secret itself is not kept). */
export async function linkKey(l: PairLink): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(l.ps)));
  return Array.from(d.subarray(0, 12), (x) => x.toString(16).padStart(2, '0')).join('');
}
