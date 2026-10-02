// The broker and STUN lists that can take the defaults' place: the PC's settings (remote.anywhere.brokers / .stun) and
// the phone shell's localStorage override (web/src/shell/override.ts) read them with these same rules. The input is
// untrusted: an entry that is not usable is dropped, and a list keeps at most MAX_LIST_ENTRIES usable entries.
// Shared by the Node server and the phone shell, so Web-standard APIs only.
import type { BrokerDef } from './mqtt.js';

/** The most entries a broker or STUN list keeps (its first usable ones). */
export const MAX_LIST_ENTRIES = 16;

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
