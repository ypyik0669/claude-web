import type { ClientRequest } from '../protocol.js';

type ClientLog = Extract<ClientRequest, { kind: 'client.log' }>;

// ANSI CSI / OSC sequences; then C0 controls (keeping \n and \t, which the formatting handles), DEL, C1 controls
// (U+0080–U+009F, incl. the 8-bit CSI) and the bidi embedding / override / isolate characters (U+202A–U+202E,
// U+2066–U+2069), which can make a log line display in a different order than it reads
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
const clean = (t: string) => t.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
/** cut first (on what the renderer sent), clean the kept part: an enormous report never reaches the regexes */
const clipped = (s: unknown, n: number): [string, string] => {
  const t = String(s ?? '');
  return t.length > n ? [t.slice(0, n), `… (+${t.length - n})`] : [t, ''];
};
/** one line per field: a renderer can send anything, and a newline must not forge a log line of its own */
const flat = (s: unknown, n: number) => { const [t, more] = clipped(s, n); return `${clean(t).replace(/\n+/g, ' ⏎ ').replace(/\t/g, ' ').replace(/ {2,}/g, ' ').trim()}${more}`; };
const block = (s: unknown, n: number) => { const [t, more] = clipped(s, n); return `${clean(t)}${more}`.split('\n').map((l) => `    | ${l}`).join('\n'); };

/**
 * Renderer error reports (`client.log`, sent by ErrorBoundary) → server log lines. The renderer is not trusted:
 * everything is stripped of ANSI / control characters and size-capped; a connection gets `perConn` reports per
 * window and everyone together `global` (a render loop in several windows must not flood server.log); the same
 * area + message again within the window is only counted, and the next time it is logged it says how often.
 */
export class ClientLogGate<K extends object> {
  private conns = new WeakMap<K, { n: number; t: number }>();
  private all = { n: 0, t: -Infinity };
  private seen = new Map<string, { t: number; dup: number }>();
  private perConn: number;
  private global: number;
  private windowMs: number;
  private now: () => number;

  constructor(o: { perConn?: number; global?: number; windowMs?: number; now?: () => number } = {}) {
    this.perConn = o.perConn ?? 20;
    this.global = o.global ?? 60;
    this.windowMs = o.windowMs ?? 60_000;
    this.now = o.now ?? Date.now;
  }

  private take(bucket: { n: number; t: number }, max: number, now: number): boolean {
    if (now - bucket.t >= this.windowMs) { bucket.t = now; bucket.n = 0; }
    if (bucket.n >= max) return false;
    bucket.n++;
    return true;
  }

  /** The log text for this report, or null when it is a duplicate / over budget. */
  admit(conn: K, req: ClientLog): string | null {
    const now = this.now();
    const area = flat(req.area, 80);
    const message = flat(req.message, 500);
    const key = `${area}\u0000${message}`;
    const prev = this.seen.get(key);
    if (prev && now - prev.t < this.windowMs) { prev.dup++; return null; }
    let conn0 = this.conns.get(conn);
    if (!conn0) this.conns.set(conn, (conn0 = { n: 0, t: -Infinity }));
    // a global refusal must not cost the connection a slot: check both before taking from either
    if (now - conn0.t < this.windowMs && conn0.n >= this.perConn) return null;
    if (now - this.all.t < this.windowMs && this.all.n >= this.global) return null;
    this.take(conn0, this.perConn, now);
    this.take(this.all, this.global, now);
    this.seen.set(key, { t: now, dup: 0 });
    if (this.seen.size > 500) for (const [k, v] of this.seen) { if (now - v.t >= this.windowMs || this.seen.size > 500) this.seen.delete(k); else break; }
    const repeats = prev?.dup ? `（自上次记录以来重复 ${prev.dup} 次）` : '';
    const parts = [`[web ${req.level === 'warn' ? 'warn' : 'error'}] ${area}: ${message}${repeats}${req.url ? `  (${flat(req.url, 200)})` : ''}`];
    if (req.stack) parts.push(block(req.stack, 4000));
    if (req.componentStack) parts.push(`  component stack:\n${block(req.componentStack, 2000)}`);
    return parts.join('\n');
  }
}
