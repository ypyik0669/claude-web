// For tests and power users only: a signaling broker list and a STUN list kept in this origin's localStorage replace
// the built-in ones (the shell smoke points the shell at a local test broker this way). Pure: main.ts reads the two
// keys once, at load, and logs one info line when either is in use. The entries are read by core's rule (lists.ts,
// the same as the PC's settings). Fails closed: only a key that is absent means the defaults; a key that is present
// but does not read (not JSON, not a list, nothing usable in it) is an empty list, so a test that meant to point the
// shell somewhere never reaches the public brokers. The shipped page's CSP only connects to wss: brokers, so a ws://
// one only works where the page is served with a CSP that allows it.
import { brokerEntries, stunEntries, type BrokerDef } from '@anywhere';

export const BROKERS_KEY = 'cw.shell.brokers';
export const STUN_KEY = 'cw.shell.stun';

function parsed(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The stored broker list (`raw`: localStorage's value); null when the key is absent (the defaults then). */
export function brokerOverride(raw: string | null): BrokerDef[] | null {
  if (raw === null) return null;
  return brokerEntries(parsed(raw)) ?? [];
}

/** The stored STUN list; null when the key is absent. An empty list means no STUN server at all. */
export function stunOverride(raw: string | null): string[] | null {
  if (raw === null) return null;
  return stunEntries(parsed(raw)) ?? [];
}

/** The info line for the console when an override is in use (which keys, how many entries each); null when none is. */
export function overrideNote(brokers: BrokerDef[] | null, stun: string[] | null): string | null {
  const used = [brokers && `${BROKERS_KEY}（${brokers.length} 个）`, stun && `${STUN_KEY}（${stun.length} 个）`].filter(Boolean);
  return used.length ? `[shell] 使用 localStorage 里的自定义列表：${used.join('、')}` : null;
}
