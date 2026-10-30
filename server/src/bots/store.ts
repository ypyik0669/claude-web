import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AuditRow, Bot, BotRun, InboxItem } from '../protocol.js';
import type { RoutineState, TrustMap } from './types.js';

const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; } };
const readJsonl = <T>(file: string): T[] => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T); } catch { return []; } };
async function writeJson(file: string, v: unknown) { await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, JSON.stringify(v, null, 2) + '\n', 'utf8'); }

/** One directory per bot under <dataDir>/bots; bot.json is the profile, everything else is what it accumulates. */
export class BotStore {
  private bots = new Map<string, Bot>();
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const b = readJson<Bot | null>(path.join(root, d.name, 'bot.json'), null);
      if (b?.id) this.bots.set(b.id, b);
    }
  }
  newId() { return `b_${randomBytes(4).toString('hex')}`; }
  dir(id: string) { return path.join(this.root, id); }
  list(): Bot[] { return [...this.bots.values()].sort((a, b) => a.createdAt - b.createdAt); }
  get(id: string) { return this.bots.get(id); }
  async save(bot: Bot): Promise<Bot> {
    const b = { ...bot, updatedAt: Date.now() };
    this.bots.set(b.id, b);
    await writeJson(path.join(this.dir(b.id), 'bot.json'), b);
    return b;
  }
  async remove(id: string) { this.bots.delete(id); await fsp.rm(this.dir(id), { recursive: true, force: true }); }

  private stateFile(id: string, routineId: string) { return path.join(this.dir(id), 'state', `${routineId.replace(/[^\w-]/g, '_')}.json`); }
  stateOf(id: string, routineId: string): RoutineState { return readJson<RoutineState>(this.stateFile(id, routineId), { updatedAt: 0 }); }
  async setState(id: string, routineId: string, patch: Partial<RoutineState>) { await writeJson(this.stateFile(id, routineId), { ...this.stateOf(id, routineId), ...patch, updatedAt: Date.now() }); }

  trust(id: string): TrustMap { return readJson<TrustMap>(path.join(this.dir(id), 'trust.json'), {}); }
  async setTrust(id: string, t: TrustMap) { await writeJson(path.join(this.dir(id), 'trust.json'), t); }

  private runsFile(id: string) { return path.join(this.dir(id), 'runs', 'index.jsonl'); }
  /** newest first; a run appended again under the same id (its end after its start) replaces the earlier line */
  runs(id: string, limit = 200): BotRun[] {
    const byId = new Map<string, BotRun>();
    for (const r of readJsonl<BotRun>(this.runsFile(id))) byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, limit);
  }
  async addRun(run: BotRun) {
    const f = this.runsFile(run.botId);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.appendFile(f, JSON.stringify(run) + '\n', 'utf8');
  }
  private auditFile(id: string, runId: string) { return path.join(this.dir(id), 'runs', `${runId}.audit.jsonl`); }
  async appendAudit(id: string, runId: string, row: AuditRow) { const f = this.auditFile(id, runId); await fsp.mkdir(path.dirname(f), { recursive: true }); await fsp.appendFile(f, JSON.stringify(row) + '\n', 'utf8'); }
  audit(id: string, runId: string): AuditRow[] { return readJsonl<AuditRow>(this.auditFile(id, runId)); }

  private inboxFile() { return path.join(this.root, 'inbox.json'); }
  inbox(id?: string): InboxItem[] { const all = readJson<InboxItem[]>(this.inboxFile(), []); return id ? all.filter((i) => i.botId === id) : all; }
  async setInbox(items: InboxItem[]) { await writeJson(this.inboxFile(), items); }
}
