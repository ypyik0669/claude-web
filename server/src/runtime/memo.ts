/**
 * Share an expensive async call: callers asking while it runs join it, and its result is reused for `ttlMs`
 * after it settles. A rejection is never kept, and neither is a value `keep` turns down (a CLI that ran but
 * answered with an error) — callers already waiting still get it, the next caller runs the call again.
 * For CLI round trips that several views ask for at once — `claude auth status`, `claude mcp list` — each of
 * which is a whole process start.
 */
export class Memo<T> {
  private entries = new Map<string, { p: Promise<T>; settledAt: number | null }>();
  constructor(private ttlMs: number, private now: () => number = Date.now, private opts: { keep?: (v: T) => boolean } = {}) {}

  /** `force` skips a settled result, but still joins a run that is in flight (it is as fresh as a new one). */
  get(key: string, fn: () => Promise<T>, force = false): Promise<T> {
    const e = this.entries.get(key);
    if (e && (e.settledAt === null || (!force && this.now() - e.settledAt < this.ttlMs))) return e.p;
    const entry: { p: Promise<T>; settledAt: number | null } = { p: undefined as unknown as Promise<T>, settledAt: null };
    const drop = () => { if (this.entries.get(key) === entry) this.entries.delete(key); };
    entry.p = fn().then(
      (v) => { entry.settledAt = this.now(); if (this.opts.keep && !this.opts.keep(v)) drop(); return v; },
      (err) => { drop(); throw err; },
    );
    this.entries.set(key, entry);
    return entry.p;
  }

  clear() { this.entries.clear(); }
}
