// The broker and STUN lists: the defaults, and the lists that can take their place — the PC's settings
// (remote.anywhere.brokers / .stun), the pairing link (a PC whose lists differ from the defaults names them in it, so
// the phone dials what the PC listens on) and the phone shell's localStorage override (web/src/shell/override.ts) are
// all read with these same rules. The input is untrusted: an entry that is not usable is dropped, and a list keeps at
// most MAX_LIST_ENTRIES usable entries. Shared by the Node server and the phone shell, so Web-standard APIs only.
import { b64u } from './keys.js';
import type { BrokerDef } from './mqtt.js';

/** The most entries a broker or STUN list keeps (its first usable ones). */
export const MAX_LIST_ENTRIES = 16;

/**
 * Signaling brokers, in order of preference (the settings' "more options" can replace the list). Only the ones marked
 * `relay` carry the slow relay: the emqx pair rate-limits bursts (in the field test about half of a 30-message burst
 * came back), which signaling survives and the relay would not.
 */
export const DEFAULT_BROKERS: BrokerDef[] = [
  { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
  { name: 'emqx-cn', url: 'wss://broker-cn.emqx.io:8084/mqtt' },
  { name: 'mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt', relay: true },
  { name: 'shiftr', url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public', relay: true },
  { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt', relay: true },
];

/** STUN servers for ICE; the first four answer from mainland China, Google's does not. */
export const DEFAULT_STUN: string[] = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.hitv.com:3478',
  'stun:stun.miwifi.com:3478',
  'stun:stun.chat.bilibili.com:3478',
  'stun:stun.l.google.com:19302',
];

const BROKER_URL_RE = /^wss?:\/\/\S+$/i;
const STUN_URL_RE = /^stuns?:\S+$/i;

/** A signaling broker's address: ws:// or wss://, then something, no spaces. */
export function isBrokerUrl(s: unknown): s is string {
  return typeof s === 'string' && BROKER_URL_RE.test(s);
}

/** A STUN server's address: stun: or stuns: (the ICE config uses nothing else; there is no TURN sign-in to give). */
export function isStunUrl(s: unknown): s is string {
  return typeof s === 'string' && STUN_URL_RE.test(s);
}

/**
 * The usable entries of a broker list: a non-empty name and a broker address; username and password when they are
 * strings, relay only when it is true. Null when `v` is not a list at all.
 */
export function brokerEntries(v: unknown): BrokerDef[] | null {
  if (!Array.isArray(v)) return null;
  const out: BrokerDef[] = [];
  for (const d of v) {
    if (out.length >= MAX_LIST_ENTRIES) break;
    if (!d || typeof d !== 'object') continue;
    const { name, url, username, password, relay } = d as Record<string, unknown>;
    if (typeof name !== 'string' || !name || !isBrokerUrl(url)) continue;
    const def: BrokerDef = { name, url };
    if (typeof username === 'string') def.username = username;
    if (typeof password === 'string') def.password = password;
    if (relay === true) def.relay = true;
    out.push(def);
  }
  return out;
}

/** The usable entries of a STUN list (stun: / stuns: addresses). Null when `v` is not a list at all. */
export function stunEntries(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const s of v) {
    if (out.length >= MAX_LIST_ENTRIES) break;
    if (isStunUrl(s)) out.push(s);
  }
  return out;
}

function sameBroker(a: BrokerDef, b: BrokerDef): boolean {
  return a.name === b.name && a.url === b.url && a.username === b.username && a.password === b.password && !!a.relay === !!b.relay;
}

export function sameBrokers(a: readonly BrokerDef[], b: readonly BrokerDef[]): boolean {
  return a.length === b.length && a.every((d, i) => sameBroker(d, b[i]));
}

export function sameStun(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/**
 * What the pairing link says about the PC's lists: `b` (its brokers) and `st` (its STUN servers), each only when it
 * differs from the default, so that links of a PC on the defaults stay as short as before (and an old shell, which
 * ignores fields it does not know, is no worse off). An empty broker list is left out: there is nothing to dial then.
 */
export function pairLists(brokers: readonly BrokerDef[], stun: readonly string[]): { b?: BrokerDef[]; st?: string[] } {
  const out: { b?: BrokerDef[]; st?: string[] } = {};
  if (brokers.length && !sameBrokers(brokers, DEFAULT_BROKERS)) out.b = brokers.map((d) => ({ ...d }));
  if (!sameStun(stun, DEFAULT_STUN)) out.st = [...stun];
  return out;
}

/**
 * The longest pairing link the settings let a PC's lists make. One QR code holds 2 953 bytes at its lowest error
 * correction (version 40-L); a little under it, so the settings page can always draw the code. The phone shell's paste
 * field takes up to 4 096 characters.
 */
export const MAX_PAIR_LINK_BYTES = 2_900;
/** The PC's name goes into the pairing link cut to this many characters. */
export const MAX_PAIR_PC_NAME = 64;

const enc = new TextEncoder();

/** The pairing QR's address: `<shell>#p=<base64url(JSON {v: 1, ps, code, pc, b?, st?})>`; the fragment never reaches a server. */
export function pairLink(shellUrl: string, o: { ps: string; code: string; pc: string; brokers: readonly BrokerDef[]; stun: readonly string[] }): string {
  const qr = { v: 1, ps: o.ps, code: o.code, pc: o.pc.slice(0, MAX_PAIR_PC_NAME), ...pairLists(o.brokers, o.stun) };
  return `${shellUrl}#p=${b64u(enc.encode(JSON.stringify(qr)))}`;
}

/**
 * How many bytes the longest pairing link of these lists takes, whatever its secret, code and PC name (the name at
 * its cap, in three-byte characters): what the settings check against MAX_PAIR_LINK_BYTES before saving a list.
 */
export function pairLinkBytes(shellUrl: string, brokers: readonly BrokerDef[], stun: readonly string[]): number {
  const worst = pairLink(shellUrl, { ps: 'A'.repeat(22), code: '000000', pc: '中'.repeat(MAX_PAIR_PC_NAME), brokers, stun });
  return enc.encode(worst).length;
}
