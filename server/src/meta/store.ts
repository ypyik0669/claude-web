import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { GatewayGroup, Goal, ImBinding, ImGatewayConfig, MessageFeedback, Provider, RemoteHost, Schedule, ScheduleRun, Workflow } from '../protocol.js';
import type { DeviceRecord } from '../remote/service.js';
import type { PeerRecord } from '../federation/types.js';
import { randomBytes } from 'node:crypto';
export type { Schedule } from '../protocol.js';

export interface Workspace { id: string; path: string; name: string; addedAt: number; order: number }
export interface SessionMeta { pinned?: boolean; archived?: boolean; workspaceId?: string; tags?: string[]; providerId?: string; /** sidebar grouping directory when it differs from the cwd (orchestration worktrees) */ groupCwd?: string; /** prompt-cache route key when it is not the session's own id (forks keep their root's) */ cacheKey?: string }

interface Data {
  version: 1;
  workspaces: Workspace[];
  sessions: Record<string, SessionMeta>;
  schedules: Schedule[];
  scheduleRuns: ScheduleRun[];
  settings: Record<string, unknown>;
  providers: Provider[];
  feedback: Record<string, Record<string, MessageFeedback>>; // sessionId -> messageId -> feedback
  drafts: Record<string, { text: string; at: number }>; // sessionId | 'welcome' -> draft
  devices: DeviceRecord[]; // paired phones / browsers (token hashes)
  remoteHosts: RemoteHost[];
  imGateways: ImGatewayConfig[];
  imBindings: ImBinding[];
  goals: Goal[];
  gatewayGroups?: GatewayGroup[]; // model gateway failover groups
  gateway?: { enabled?: boolean; key?: string }; // key: enc:… (SecretService)

  peers?: PeerRecord[]; // other machines this one federates with (tokens enc:)
  serverId?: string; // this server's stable id (federation loop guard)
  workflows?: Workflow[]; // orchestration templates (runs live in <dataDir>/orchestra/)
}

const defaultFile = () => path.join(process.env.CLAUDE_WEB_DIR ?? path.join(os.homedir(), '.claude-web'), 'meta.json');

/** Small JSON store for things Claude Code itself does not persist: workspaces, pin/archive flags, schedules, UI settings. */
export class MetaStore extends EventEmitter {
  data: Data = { version: 1, workspaces: [], sessions: {}, schedules: [], scheduleRuns: [], settings: {}, providers: [], feedback: {}, drafts: {}, devices: [], remoteHosts: [], imGateways: [], imBindings: [], goals: [] };
  private saving: Promise<void> | null = null;

  constructor(private file = defaultFile()) {
    super();
  }

  async load() {
    const file = this.file;
    let txt: string;
    try {
      txt = await fs.readFile(file, 'utf8');
    } catch {
      return; // first run
    }
    try {
      this.data = { ...this.data, ...JSON.parse(txt) };
    } catch {
      // A torn / hand-broken file would otherwise be silently replaced by defaults on the next save,
      // taking workspaces, providers and keys with it. Keep a copy the user can recover from.
      await fs.copyFile(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    }
  }

  private async save(quiet = false) {
    const file = this.file;
    await fs.mkdir(path.dirname(file), { recursive: true });
    // write-then-rename: a crash mid-write must not leave a truncated meta.json (it holds provider API keys)
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.rename(tmp, file);
    } catch {
      // Windows: rename over a file another process holds open fails — fall back to an in-place write
      await fs.rm(tmp, { force: true }).catch(() => {});
      await fs.writeFile(file, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
    if (!quiet) this.emit('changed');
  }
  private queueSave(quiet = false) {
    // chain on the previous save's settlement, not its success: one failed write (EBUSY, disk full)
    // must not make every later save reject without even trying
    const prev = this.saving ?? Promise.resolve();
    this.saving = prev.catch(() => {}).then(() => this.save(quiet));
    return this.saving;
  }

  workspaces() {
    return [...this.data.workspaces].sort((a, b) => a.order - b.order);
  }
  async addWorkspace(p: string) {
    const norm = path.resolve(p);
    const existing = this.data.workspaces.find((w) => w.path.toLowerCase() === norm.toLowerCase());
    if (existing) return existing;
    const w: Workspace = { id: Math.random().toString(36).slice(2, 10), path: norm, name: path.basename(norm) || norm, addedAt: Date.now(), order: this.data.workspaces.length };
    this.data.workspaces.push(w);
    await this.queueSave();
    return w;
  }
  async removeWorkspace(id: string) {
    this.data.workspaces = this.data.workspaces.filter((w) => w.id !== id);
    await this.queueSave();
  }
  async renameWorkspace(id: string, name: string) {
    const w = this.data.workspaces.find((x) => x.id === id);
    if (w) { w.name = name; await this.queueSave(); }
  }
  async reorderWorkspaces(ids: string[]) {
    ids.forEach((id, i) => { const w = this.data.workspaces.find((x) => x.id === id); if (w) w.order = i; });
    await this.queueSave();
  }

  sessionMeta(id: string): SessionMeta {
    return this.data.sessions[id] ?? {};
  }
  allSessionMeta() {
    return this.data.sessions;
  }
  async setSessionMeta(id: string, patch: SessionMeta) {
    this.data.sessions[id] = { ...this.data.sessions[id], ...patch };
    await this.queueSave();
  }

  schedules() {
    return this.data.schedules;
  }
  async upsertSchedule(s: Partial<Schedule> & { id?: string }) {
    let cur = s.id ? this.data.schedules.find((x) => x.id === s.id) : undefined;
    if (!cur) {
      cur = { id: Math.random().toString(36).slice(2, 10), name: s.name ?? 'schedule', cwd: s.cwd ?? '', prompt: s.prompt ?? '', everyMinutes: s.everyMinutes ?? 60, enabled: s.enabled ?? true };
      this.data.schedules.push(cur);
    }
    Object.assign(cur, s, { id: cur.id });
    if (cur.enabled && !cur.nextRunAt && !cur.cron) cur.nextRunAt = Date.now() + cur.everyMinutes * 60_000;
    await this.queueSave();
    return cur;
  }
  async removeSchedule(id: string) {
    this.data.schedules = this.data.schedules.filter((x) => x.id !== id);
    await this.queueSave();
  }
  async touchSchedule(id: string, patch: Partial<Schedule>) {
    const s = this.data.schedules.find((x) => x.id === id);
    if (s) { Object.assign(s, patch); for (const k of Object.keys(patch) as (keyof Schedule)[]) if (patch[k] === undefined) delete (s as any)[k]; await this.queueSave(); }
  }
  scheduleRuns(scheduleId?: string, limit = 50): ScheduleRun[] {
    const all = this.data.scheduleRuns ?? (this.data.scheduleRuns = []);
    return (scheduleId ? all.filter((r) => r.scheduleId === scheduleId) : all).slice(-limit).reverse();
  }
  async addScheduleRun(r: ScheduleRun) {
    const all = this.data.scheduleRuns ?? (this.data.scheduleRuns = []);
    all.push(r);
    if (all.length > 300) all.splice(0, all.length - 300);
    await this.queueSave(true);
  }

  providers(): Provider[] {
    return this.data.providers ?? (this.data.providers = []);
  }
  provider(id: string) {
    return this.providers().find((p) => p.id === id);
  }
  /** Installed by the SecretService so keys are protected before they hit disk. */
  secretCodec: { protect(plain: string, id: string): Promise<string> } | null = null;
  /** Insert or update. An empty / masked apiKey keeps the stored one. */
  /** `mustExist`: a background write-back (model refresh / probe) for a profile deleted meanwhile is dropped, not a re-create. */
  async upsertProvider(p: Partial<Provider> & { id?: string }, opts: { mustExist: true }): Promise<Provider | null>;
  async upsertProvider(p: Partial<Provider> & { id?: string }, opts?: { mustExist?: false }): Promise<Provider>;
  async upsertProvider(p: Partial<Provider> & { id?: string }, opts: { mustExist?: boolean } = {}): Promise<Provider | null> {
    const list = this.providers();
    let cur = p.id ? list.find((x) => x.id === p.id) : undefined;
    if (!cur && opts.mustExist) return null;
    if (!cur) {
      cur = { id: Math.random().toString(36).slice(2, 10), name: p.name ?? 'provider', type: p.type ?? 'anthropic', baseUrl: p.baseUrl ?? '', apiKey: '', createdAt: Date.now() };
      list.push(cur);
    }
    const { apiKey, id: _id, createdAt: _c, ...rest } = p;
    Object.assign(cur, rest);
    for (const k of ['runtime', 'defaultModel', 'modelMap', 'models', 'modelNames', 'modelEfforts', 'promptEffortModels', 'modelsAt', 'modelsError', 'cacheShim', 'responsesApi', 'cache1h', 'cacheControlFormat', 'noPromptCacheKey', 'noResponsesApi', 'noCacheRetention'] as const) if ((cur as any)[k] == null) delete (cur as any)[k]; // null clears (JSON drops undefined)
    if (apiKey && !/^\S{0,4}…\S{0,4}$/.test(apiKey) && !apiKey.includes('…')) cur.apiKey = this.secretCodec ? await this.secretCodec.protect(apiKey.trim(), cur.id) : apiKey.trim();
    cur.baseUrl = (cur.baseUrl ?? '').trim().replace(/\/+$/, '');
    await this.queueSave();
    return cur;
  }
  async removeProvider(id: string) {
    this.data.providers = this.providers().filter((x) => x.id !== id);
    if (this.data.settings.defaultProviderId === id) delete this.data.settings.defaultProviderId;
    await this.queueSave();
  }

  feedback(sessionId: string): Record<string, MessageFeedback> {
    return (this.data.feedback ??= {})[sessionId] ?? {};
  }
  async setFeedback(sessionId: string, messageId: string, f: MessageFeedback | null) {
    const fb = (this.data.feedback ??= {});
    const s = (fb[sessionId] ??= {});
    if (f && f.rating) s[messageId] = f;
    else delete s[messageId];
    if (!Object.keys(s).length) delete fb[sessionId];
    await this.queueSave();
  }

  draft(key: string) {
    return (this.data.drafts ??= {})[key]?.text ?? '';
  }
  async setDraft(key: string, text: string) {
    const d = (this.data.drafts ??= {});
    if (text) d[key] = { text, at: Date.now() };
    else delete d[key];
    // drafts change often: save without broadcasting a meta.changed storm
    await this.queueSave(true);
  }

  settings() {
    return this.data.settings;
  }

  // ---- remote devices ----
  devices(): DeviceRecord[] { return this.data.devices ??= []; }
  async addDevice(d: DeviceRecord) { this.devices().push(d); await this.queueSave(); }
  async removeDevice(id: string) { this.data.devices = this.devices().filter((d) => d.id !== id); await this.queueSave(); }
  async renameDevice(id: string, name: string) { const d = this.devices().find((x) => x.id === id); if (d) { d.name = name; await this.queueSave(); } }
  async touchDevice(id: string, ip?: string) { const d = this.devices().find((x) => x.id === id); if (d) { d.lastSeenAt = Date.now(); if (ip) d.ip = ip; await this.queueSave(true); } }

  // ---- remote hosts (ssh tunnels) ----
  remoteHosts(): RemoteHost[] { return this.data.remoteHosts ??= []; }
  async setRemoteHost(h: RemoteHost) { const list = this.remoteHosts(); const i = list.findIndex((x) => x.id === h.id); if (i >= 0) list[i] = h; else list.push(h); await this.queueSave(); }
  async removeRemoteHost(id: string) { this.data.remoteHosts = this.remoteHosts().filter((h) => h.id !== id); await this.queueSave(); }

  // ---- IM gateways ----
  imGateways(): ImGatewayConfig[] { return this.data.imGateways ??= []; }
  async setImGateway(g: ImGatewayConfig) { const list = this.imGateways(); const i = list.findIndex((x) => x.id === g.id); if (i >= 0) list[i] = g; else list.push(g); await this.queueSave(true); }
  async removeImGateway(id: string) { this.data.imGateways = this.imGateways().filter((g) => g.id !== id); this.data.imBindings = this.imBindings().filter((b) => b.gatewayId !== id); await this.queueSave(); }
  goals(): Goal[] { return this.data.goals ??= []; }
  async setGoal(g: Goal) { const list = this.goals(); const i = list.findIndex((x) => x.id === g.id); if (i >= 0) list[i] = g; else list.push(g); await this.queueSave(true); }
  async removeGoal(id: string) { this.data.goals = this.goals().filter((g) => g.id !== id); await this.queueSave(true); }
  workflows(): Workflow[] { return this.data.workflows ??= []; }
  async setWorkflow(w: Workflow) { const list = this.workflows(); const i = list.findIndex((x) => x.id === w.id); if (i >= 0) list[i] = w; else list.push(w); await this.queueSave(true); }
  async removeWorkflow(id: string) { this.data.workflows = this.workflows().filter((w) => w.id !== id); await this.queueSave(true); }
  imBindings(): ImBinding[] { return this.data.imBindings ??= []; }
  async setImBinding(b: ImBinding) { this.data.imBindings = [...this.imBindings().filter((x) => !(x.gatewayId === b.gatewayId && x.chatId === b.chatId)), b]; await this.queueSave(true); }
  async removeImBinding(gatewayId: string, chatId: string) { this.data.imBindings = this.imBindings().filter((x) => !(x.gatewayId === gatewayId && x.chatId === chatId)); await this.queueSave(true); }
  // ---- federation (other machines) ----
  peers(): PeerRecord[] { return this.data.peers ??= []; }
  async setPeer(p: PeerRecord) { const list = this.peers(); const i = list.findIndex((x) => x.id === p.id); if (i >= 0) list[i] = p; else list.push(p); await this.queueSave(true); }
  async removePeer(id: string) { this.data.peers = this.peers().filter((p) => p.id !== id); await this.queueSave(true); }
  /** Generated once and persisted: identifies this server in forwarded requests' `via` chain. */
  async serverId(): Promise<string> {
    if (!this.data.serverId) { this.data.serverId = randomBytes(8).toString('hex'); await this.queueSave(true); }
    return this.data.serverId;
  }
  async setSetting(k: string, v: unknown) {
    this.data.settings[k] = v;
    await this.queueSave();
  }
  // ---- model gateway ----
  gatewayGroups(): GatewayGroup[] { return this.data.gatewayGroups ??= []; }
  gatewayConfig(): { enabled?: boolean; key?: string } { return this.data.gateway ??= {}; }
  async saveGateway() { await this.queueSave(true); }
}
