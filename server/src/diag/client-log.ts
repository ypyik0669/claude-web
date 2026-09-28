import type { ClientRequest } from '../protocol.js';

type ClientLog = Extract<ClientRequest, { kind: 'client.log' }>;

const clip = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}… (+${t.length - n})` : t;
};
/** one line per field: a renderer can send anything, and a newline must not forge a log line of its own */
const flat = (s: unknown, n: number) => clip(String(s ?? '').replace(/[\r\n]+/g, ' ⏎ '), n);
const block = (s: unknown, n: number) => clip(s, n).split(/\r?\n/).map((l) => `    | ${l}`).join('\n');

/**
 * The server-log text for a renderer error an ErrorBoundary reported (`client.log`), or null when the
 * connection is over its budget. Sizes are capped: the renderer is not trusted to keep them small.
 */
export function clientLogLine(req: ClientLog, allowed: boolean): string | null {
  if (!allowed) return null;
  const parts = [`[web ${req.level === 'warn' ? 'warn' : 'error'}] ${flat(req.area, 80)}: ${flat(req.message, 500)}${req.url ? `  (${flat(req.url, 200)})` : ''}`];
  if (req.stack) parts.push(block(req.stack, 4000));
  if (req.componentStack) parts.push(`  component stack:\n${block(req.componentStack, 2000)}`);
  return parts.join('\n');
}

/** Per-connection token bucket: at most `max` reports per minute (a render loop must not flood the log). */
export class LogBudget<K extends object> {
  private seen = new WeakMap<K, { n: number; t: number }>();
  constructor(private max = 20, private windowMs = 60_000) {}
  take(key: K, now = Date.now()): boolean {
    const cur = this.seen.get(key);
    if (!cur || now - cur.t > this.windowMs) { this.seen.set(key, { n: 1, t: now }); return true; }
    cur.n++;
    return cur.n <= this.max;
  }
}
