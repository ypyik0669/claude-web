import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { Goal, ImBinding, ImGatewayConfig, MessageFeedback, Provider, RemoteHost, Schedule, ScheduleRun } from '../protocol.js';
import type { DeviceRecord } from '../remote/service.js';
export type { Schedule } from '../protocol.js';

export interface Workspace { id: string; path: string; name: string; addedAt: number; order: number }
export interface SessionMeta { pinned?: boolean; archived?: boolean; workspaceId?: string; tags?: string[]; providerId?: string }

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
}

const file = path.join(process.env.CLAUDE_WEB_DIR ?? path.join(os.homedir(), '.claude-web'), 'meta.json');

/** Small JSON store for things Claude Code itself does not persist: workspaces, pin/archive flags, schedules, UI settings. */
export class MetaStore extends EventEmitter {
  data: Data = { version: 1, workspaces: [], sessions: {}, schedules: [], scheduleRuns: [], settings: {}, providers: [], feedback: {}, drafts: {}, devices: [], remoteHosts: [], imGateways: [], imBindings: [], goals: [] };
  private saving: Promise<void> | null = null;

  async load() {
    try {
      this.data = { ...this.data, ...JSON.parse(await fs.readFile(file, 'utf8')) };
    } catch {
      /* first run */
    }
  }

  private async save(quiet = false) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 }); // holds provider API keys
    if (!quiet) this.emit('changed');
  }
  private queueSave(quiet = false) {
    this.saving = (this.saving ?? Promise.resolve()).then(() => this.save(quiet));
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
  async upsertProvider(p: Partial<Provider> & { id?: string }): Promise<Provider> {
    const list = this.providers();
    let cur = p.id ? list.find((x) => x.id === p.id) : undefined;
    if (!cur) {
      cur = { id: Math.random().toString(36).slice(2, 10), name: p.name ?? 'provider', type: p.type ?? 'anthropic', baseUrl: p.baseUrl ?? '', apiKey: '', createdAt: Date.now() };
      list.push(cur);
    }
    const { apiKey, id: _id, createdAt: _c, ...rest } = p;
    Object.assign(cur, rest);
    for (const k of ['runtime', 'defaultModel', 'modelMap', 'models'] as const) if ((cur as any)[k] == null) delete (cur as any)[k]; // null clears (JSON drops undefined)
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
  imBindings(): ImBinding[] { return this.data.imBindings ??= []; }
  async setImBinding(b: ImBinding) { this.data.imBindings = [...this.imBindings().filter((x) => !(x.gatewayId === b.gatewayId && x.chatId === b.chatId)), b]; await this.queueSave(true); }
  async removeImBinding(gatewayId: string, chatId: string) { this.data.imBindings = this.imBindings().filter((x) => !(x.gatewayId === gatewayId && x.chatId === chatId)); await this.queueSave(true); }
  async setSetting(k: string, v: unknown) {
    this.data.settings[k] = v;
    await this.queueSave();
  }
}
