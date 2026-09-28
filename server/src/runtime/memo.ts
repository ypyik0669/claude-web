/**
 * Share an expensive async call: callers asking while it runs join it, and its result is reused for `ttlMs`
 * after it settles. A rejection is not kept (the next caller tries again). For CLI round trips that several
 * views ask for at once — `claude auth status`, `claude mcp list` — each of which is a whole process start.
 */
export class Memo<T> {
  private entries = new Map<string, { p: Promise<T>; settledAt: number | null }>();
  constructor(private ttlMs: number, private now: () => number = Date.now) {}

  get(key: string, fn: () => Promise<T>, force = false): Promise<T> {
    const e = this.entries.get(key);
    if (!force && e && (e.settledAt === null || this.now() - e.settledAt < this.ttlMs)) return e.p;
    const entry: { p: Promise<T>; settledAt: number | null } = { p: undefined as unknown as Promise<T>, settledAt: null };
    entry.p = fn().then(
      (v) => { entry.settledAt = this.now(); return v; },
      (err) => { if (this.entries.get(key) === entry) this.entries.delete(key); throw err; },
    );
    this.entries.set(key, entry);
    return entry.p;
  }

  clear() { this.entries.clear(); }
}
