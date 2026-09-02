import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { Provider } from '../protocol.js';

export interface Workspace { id: string; path: string; name: string; addedAt: number; order: number }
export interface SessionMeta { pinned?: boolean; archived?: boolean; workspaceId?: string; tags?: string[]; providerId?: string }
export interface Schedule { id: string; name: string; cwd: string; prompt: string; everyMinutes: number; enabled: boolean; lastRunAt?: number; nextRunAt?: number; sessionId?: string; model?: string; permissionMode?: string }

interface Data { version: 1; workspaces: Workspace[]; sessions: Record<string, SessionMeta>; schedules: Schedule[]; settings: Record<string, unknown>; providers: Provider[] }

const file = path.join(process.env.CLAUDE_WEB_DIR ?? path.join(os.homedir(), '.claude-web'), 'meta.json');

/** Small JSON store for things Claude Code itself does not persist: workspaces, pin/archive flags, schedules, UI settings. */
export class MetaStore extends EventEmitter {
  data: Data = { version: 1, workspaces: [], sessions: {}, schedules: [], settings: {}, providers: [] };
  private saving: Promise<void> | null = null;

  async load() {
    try {
      this.data = { ...this.data, ...JSON.parse(await fs.readFile(file, 'utf8')) };
    } catch {
      /* first run */
    }
  }

  private async save() {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 }); // holds provider API keys
    this.emit('changed');
  }
  private queueSave() {
    this.saving = (this.saving ?? Promise.resolve()).then(() => this.save());
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
    if (cur.enabled && !cur.nextRunAt) cur.nextRunAt = Date.now() + cur.everyMinutes * 60_000;
    await this.queueSave();
    return cur;
  }
  async removeSchedule(id: string) {
    this.data.schedules = this.data.schedules.filter((x) => x.id !== id);
    await this.queueSave();
  }
  async touchSchedule(id: string, patch: Partial<Schedule>) {
    const s = this.data.schedules.find((x) => x.id === id);
    if (s) { Object.assign(s, patch); await this.queueSave(); }
  }

  providers(): Provider[] {
    return this.data.providers ?? (this.data.providers = []);
  }
  provider(id: string) {
    return this.providers().find((p) => p.id === id);
  }
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
    if (apiKey && !/^\S{0,4}…\S{0,4}$/.test(apiKey) && !apiKey.includes('…')) cur.apiKey = apiKey.trim();
    cur.baseUrl = (cur.baseUrl ?? '').trim().replace(/\/+$/, '');
    await this.queueSave();
    return cur;
  }
  async removeProvider(id: string) {
    this.data.providers = this.providers().filter((x) => x.id !== id);
    if (this.data.settings.defaultProviderId === id) delete this.data.settings.defaultProviderId;
    await this.queueSave();
  }

  settings() {
    return this.data.settings;
  }
  async setSetting(k: string, v: unknown) {
    this.data.settings[k] = v;
    await this.queueSave();
  }
}
