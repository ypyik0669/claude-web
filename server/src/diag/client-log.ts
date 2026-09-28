import type { ClientRequest } from '../protocol.js';

type ClientLog = Extract<ClientRequest, { kind: 'client.log' }>;

// ANSI CSI / OSC sequences, then any other C0 control (keeps \n and \t, which the formatting handles) and DEL
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const clean = (s: unknown) => String(s ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}… (+${t.length - n})` : t);
/** one line per field: a renderer can send anything, and a newline must not forge a log line of its own */
const flat = (s: unknown, n: number) => clip(clean(s).replace(/\n+/g, ' ⏎ ').replace(/\t/g, ' ').replace(/ {2,}/g, ' ').trim(), n);
const block = (s: unknown, n: number) => clip(clean(s), n).split('\n').map((l) => `    | ${l}`).join('\n');

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
    const repeats = prev?.dup ? `（前一分钟内另有 ${prev.dup} 次相同报告）` : '';
    const parts = [`[web ${req.level === 'warn' ? 'warn' : 'error'}] ${area}: ${message}${repeats}${req.url ? `  (${flat(req.url, 200)})` : ''}`];
    if (req.stack) parts.push(block(req.stack, 4000));
    if (req.componentStack) parts.push(`  component stack:\n${block(req.componentStack, 2000)}`);
    return parts.join('\n');
  }
}
