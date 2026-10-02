// For tests and power users only: a signaling broker list and a STUN list kept in this origin's localStorage replace
// the built-in ones (the shell smoke points the shell at a local test broker this way). Pure: main.ts reads the two
// keys once, at load. Anything that does not read is ignored (the defaults are used). The shipped page's CSP only
// connects to wss: brokers, so a ws:// one only works where the page is served with a CSP that allows it.
import type { BrokerDef } from '@anywhere';

export const BROKERS_KEY = 'cw.shell.brokers';
export const STUN_KEY = 'cw.shell.stun';
const MAX_ENTRIES = 16;

function list(raw: string | null): unknown[] | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.slice(0, MAX_ENTRIES) : null;
  } catch {
    return null;
  }
}

/** The stored broker list's valid entries (a name, a ws: / wss: URL); null when there is none (the defaults then). */
export function brokerOverride(raw: string | null): BrokerDef[] | null {
  const out: BrokerDef[] = [];
  for (const d of list(raw) ?? []) {
    if (!d || typeof d !== 'object') continue;
    const { name, url, username, password, relay } = d as Record<string, unknown>;
    if (typeof name !== 'string' || !name || typeof url !== 'string' || !/^wss?:\/\/\S+$/i.test(url)) continue;
    const def: BrokerDef = { name, url };
    if (typeof username === 'string') def.username = username;
    if (typeof password === 'string') def.password = password;
    if (relay === true) def.relay = true;
    out.push(def);
  }
  // no broker at all is never what was meant: the shell could not find any PC
  return out.length ? out : null;
}

/**
 * The stored STUN list's valid entries (stun: / stuns:, all core's rtcConfig() uses); null when the value is not a
 * list. An empty list is kept: no STUN server, only what the two ends see of each other directly (a LAN, the smoke).
 */
export function stunOverride(raw: string | null): string[] | null {
  const v = list(raw);
  if (!v) return null;
  return v.filter((s): s is string => typeof s === 'string' && /^stuns?:\S+$/i.test(s));
}
