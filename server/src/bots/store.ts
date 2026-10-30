import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AuditRow, Bot, BotRun, InboxItem } from '../protocol.js';
import { atomicWrite } from '../agent-config/backup.js';
import type { PendingResume, RoutineState, TrustMap } from './types.js';

/** Bot and run ids arrive from WebSocket requests and become path segments: plain names only. */
const SAFE_ID = /^[\w-]+$/;
function checkId(id: string, what: string): string {
  if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new Error(`invalid ${what}: ${JSON.stringify(id)}`);
  return id;
}

/** A missing file is the normal "nothing yet"; anything else (bad JSON, a read error) is worth a warning. */
function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e: any) {
    if (e?.code !== 'ENOENT') console.warn(`[bots] cannot read ${file}: ${e?.message ?? e}`);
    return fallback;
  }
  try { return JSON.parse(text) as T; } catch (e: any) {
    console.warn(`[bots] bad JSON in ${file}: ${e?.message ?? e}`);
    return fallback;
  }
}
/** Line by line: one torn or corrupt line (a crash mid-append) costs that line, not the file. */
function readJsonl<T>(file: string): T[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e: any) {
    if (e?.code !== 'ENOENT') console.warn(`[bots] cannot read ${file}: ${e?.message ?? e}`);
    return [];
  }
  const out: T[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { bad++; }
  }
  if (bad) console.warn(`[bots] skipped ${bad} bad line(s) in ${file}`);
  return out;
}
const writeJson = (file: string, v: unknown) => atomicWrite(file, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });

/** One directory per bot under <dataDir>/bots; bot.json is the profile, everything else is what it accumulates. */
export class BotStore {
  private bots = new Map<string, Bot>();
  /** per-file promise chains: two runs finishing together must not interleave read-modify-writes */
  private locks = new Map<string, Promise<unknown>>();
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
    this.bots = this.readAll();
  }
  private readAll(): Map<string, Bot> {
    const out = new Map<string, Bot>();
    for (const d of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!d.isDirectory() || !SAFE_ID.test(d.name)) continue;
      const b = readJson<Bot | null>(path.join(this.root, d.name, 'bot.json'), null);
      if (b?.id === d.name) out.set(b.id, b);
    }
    return out;
  }
  /**
   * Re-reads every bot.json (another server on this dir may have changed them — the scheduler calls this when it takes
   * the lease over). Waits for this store's own writes in flight first, so it never reads back half of them.
   */
  async reload(): Promise<void> {
    for (let pending = [...this.locks.values()]; pending.length; pending = [...this.locks.values()]) await Promise.all(pending);
    this.bots = this.readAll();
  }

  private async locked<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    try { return await run; } finally { if (this.locks.get(key) === tail) this.locks.delete(key); }
  }

  newId() { return `b_${randomBytes(4).toString('hex')}`; }
  /** throws for anything but a plain name, so `..` or `a/b` can never reach the file system */
  dir(id: string) { return path.join(this.root, checkId(id, 'bot id')); }
  list(): Bot[] { return [...this.bots.values()].sort((a, b) => a.createdAt - b.createdAt); }
  get(id: string) { return this.bots.get(id); }
  async save(bot: Bot): Promise<Bot> {
    const file = path.join(this.dir(bot.id), 'bot.json');
    const b = { ...bot, updatedAt: Date.now() };
    this.bots.set(b.id, b);
    await this.locked(file, () => writeJson(file, b));
    return b;
  }
  /**
   * Read-modify-write inside the bot.json lock: `fn` sees the bot as it is after every earlier save / update, so two
   * runs (or a run and a user edit) changing different routines both land. `fn` → undefined = no change; unknown id → undefined.
   */
  async update(id: string, fn: (bot: Bot) => Bot | undefined): Promise<Bot | undefined> {
    const file = path.join(this.dir(id), 'bot.json');
    return this.locked(file, async () => {
      const cur = this.bots.get(id);
      if (!cur) return undefined;
      const next = fn(cur);
      if (!next) return cur;
      const b = { ...next, id, updatedAt: Date.now() };
      this.bots.set(id, b);
      await writeJson(file, b);
      return b;
    });
  }
  /** only a bot this store knows: an unknown id touches nothing on disk */
  async remove(id: string) {
    const dir = this.dir(id);
    if (!this.bots.delete(id)) return;
    await fsp.rm(dir, { recursive: true, force: true });
  }

  private stateFile(id: string, routineId: string) { return path.join(this.dir(id), 'state', `${routineId.replace(/[^\w-]/g, '_')}.json`); }
  stateOf(id: string, routineId: string): RoutineState { return readJson<RoutineState>(this.stateFile(id, routineId), { updatedAt: 0 }); }
  async setState(id: string, routineId: string, patch: Partial<RoutineState>) {
    const file = this.stateFile(id, routineId);
    await this.locked(file, () => writeJson(file, { ...this.stateOf(id, routineId), ...patch, updatedAt: Date.now() }));
  }

  private trustFile(id: string) { return path.join(this.dir(id), 'trust.json'); }
  trust(id: string): TrustMap { return readJson<TrustMap>(this.trustFile(id), {}); }
  async setTrust(id: string, t: TrustMap) { const file = this.trustFile(id); await this.locked(file, () => writeJson(file, t)); }

  private resumesFile(id: string) { return path.join(this.dir(id), 'resumes.json'); }
  pendingResumes(id: string): PendingResume[] { const v = readJson<PendingResume[]>(this.resumesFile(id), []); return Array.isArray(v) ? v : []; }
  /** read-modify-write in the file's lock; `fn` returns the new list and what to hand back */
  async updateResumes<T>(id: string, fn: (cur: PendingResume[]) => { next: PendingResume[]; out: T }): Promise<T> {
    const file = this.resumesFile(id);
    return this.locked(file, async () => {
      const { next, out } = fn(this.pendingResumes(id));
      if (next.length) await writeJson(file, next);
      else await fsp.rm(file, { force: true });
      return out;
    });
  }

  private runsFile(id: string) { return path.join(this.dir(id), 'runs', 'index.jsonl'); }
  /** newest first; when an id has several lines (its start, then its end) the last line wins */
  runs(id: string, limit = 200): BotRun[] {
    const byId = new Map<string, BotRun>();
    for (const r of readJsonl<BotRun>(this.runsFile(id))) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  }
  /** appends a line to runs/index.jsonl; re-adding an id appends again and runs() keeps the last line per id */
  async addRun(run: BotRun) {
    const f = this.runsFile(run.botId);
    await this.locked(f, async () => {
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.appendFile(f, JSON.stringify(run) + '\n', 'utf8');
    });
  }
  private auditFile(id: string, runId: string) { return path.join(this.dir(id), 'runs', `${checkId(runId, 'run id')}.audit.jsonl`); }
  async appendAudit(id: string, runId: string, row: AuditRow) {
    const f = this.auditFile(id, runId);
    await this.locked(f, async () => {
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.appendFile(f, JSON.stringify(row) + '\n', 'utf8');
    });
  }
  audit(id: string, runId: string): AuditRow[] { return readJsonl<AuditRow>(this.auditFile(id, runId)); }

  private inboxFile() { return path.join(this.root, 'inbox.json'); }
  inbox(id?: string): InboxItem[] { const all = readJson<InboxItem[]>(this.inboxFile(), []); return id ? all.filter((i) => i.botId === id) : all; }
  async setInbox(items: InboxItem[]) { const file = this.inboxFile(); await this.locked(file, () => writeJson(file, items)); }
}
