import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';

export interface Workspace { id: string; path: string; name: string; addedAt: number; order: number }
export interface SessionMeta { pinned?: boolean; archived?: boolean; workspaceId?: string; tags?: string[] }
export interface Schedule { id: string; name: string; cwd: string; prompt: string; everyMinutes: number; enabled: boolean; lastRunAt?: number; nextRunAt?: number; sessionId?: string; model?: string; permissionMode?: string }

interface Data { version: 1; workspaces: Workspace[]; sessions: Record<string, SessionMeta>; schedules: Schedule[]; settings: Record<string, unknown> }

const file = path.join(process.env.CLAUDE_WEB_DIR ?? path.join(os.homedir(), '.claude-web'), 'meta.json');

/** Small JSON store for things Claude Code itself does not persist: workspaces, pin/archive flags, schedules, UI settings. */
export class MetaStore extends EventEmitter {
  data: Data = { version: 1, workspaces: [], sessions: {}, schedules: [], settings: {} };
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
    await fs.writeFile(file, JSON.stringify(this.data, null, 2), 'utf8');
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

  settings() {
    return this.data.settings;
  }
  async setSetting(k: string, v: unknown) {
    this.data.settings[k] = v;
    await this.queueSave();
  }
}
