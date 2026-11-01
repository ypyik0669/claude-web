import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import type { Goal, ImBinding, ImGatewayConfig, MessageFeedback, PermissionMode, DispatchFrom, HandoffInfo, HandoffFrom, Provider, RemoteHost, Schedule, ScheduleRun, Workflow } from '../protocol.js';
import type { DeviceRecord } from '../remote/service.js';
import type { PeerRecord } from '../federation/types.js';
import type { PrivacySettings } from '../privacy/types.js';
import { randomBytes } from 'node:crypto';
import { normFolders } from './workspace-folders.js';
export type { Schedule } from '../protocol.js';

export interface Workspace { id: string; path: string; name: string; addedAt: number; order: number; /** extra folders (stage C2), never the main path; absent in old files */ folders?: string[]; /** stage F (protocol.ts has the same fields) */ instructions?: string; sessionsScope?: 'project'; permissionMode?: PermissionMode; claudeAiUuid?: string }
export interface SessionMeta { /** replies pinned under them (protocol.ts) */ pinnedMsgs?: { id: string; text: string }[]; /** a rename made while the conversation's process ran: shown over the transcript's title, written into it again when the process ends */ pendingTitle?: string; /** 只聊天: a resume stays without tools (protocol.ts has the same field) */ chatOnly?: boolean; /** 保持电脑唤醒 while this conversation is busy (phase 6) */ keepAwake?: boolean; pinned?: boolean; archived?: boolean; workspaceId?: string; tags?: string[]; providerId?: string; /** sidebar grouping directory when it differs from the cwd (orchestration worktrees) */ groupCwd?: string; /** the model its subagents run on, picked for this provider ('' = the main model) */ subagent?: { providerId: string; model: string }; /** the permission mode it last ran with: a resume without a pick comes back in it (the SDK never says it) */ permissionMode?: PermissionMode; /** 思考用的语言 of this conversation (protocol.ts has the same field) */ thinkingLanguage?: string; /** a `continueInClaude` source's conversation: the Claude conversation it goes on in (protocol.ts) */ continuedAs?: string; /** that Claude conversation: what it goes on from, how many of its messages are in it (protocol.ts) */ continuedFrom?: string; replayed?: number; /** stage E (protocol.ts has the same fields): 自动处理评论, the WSL distro it runs in, the built-in browser's recordings */ prAutoComments?: number; prCommentsDone?: string[]; prCommentsSent?: { ids: string[]; sha: string; at: number; /** local HEAD when the batch went, and the commit made after it (fix E-I2) */ head?: string; commit?: string }; env?: { kind: 'local' } | { kind: 'wsl'; distro: string }; browserRecordings?: { path: string; start: number; end: number }[]; /** stage F (protocol.ts has the same fields) */ origin?: 'dispatch'; dispatchFrom?: DispatchFrom; handedOff?: HandoffInfo; handoffFrom?: HandoffFrom; /** the project instructions it started with (runtime/pool.ts: new conversations only, kept on resume) */ projectInstructions?: string }

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
  privacy?: Partial<PrivacySettings> & { secret?: string };
  /**
   * Provider profiles of the formats this app no longer talks to (OpenAI / Gemini / Grok / the model gateway,
   * removed 2026-11-01): moved out of `providers` when the file is read, kept here as they were — the keys too —
   * so nothing the user set up is lost. Nothing reads them.
   */
  removedProviders?: unknown[];

  peers?: PeerRecord[]; // other machines this one federates with (tokens enc:)
  serverId?: string; // this server's stable id (federation loop guard)
  workflows?: Workflow[]; // orchestration templates (runs live in <dataDir>/orchestra/)
}

const defaultFile = () => path.join(process.env.CLAUDE_WEB_DIR ?? path.join(os.homedir(), '.claude-web'), 'meta.json');

/** Small JSON store for things Claude Code itself does not persist: workspaces, pin/archive flags, schedules, UI settings. */
export class MetaStore extends EventEmitter {
  data: Data = { version: 1, workspaces: [], sessions: {}, schedules: [], scheduleRuns: [], settings: {}, providers: [], feedback: {}, drafts: {}, devices: [], remoteHosts: [], imGateways: [], imBindings: [], goals: [] };
  private saving: Promise<void> | null = null;
  /** meta.json on disk is known good, so it may become meta.json.bak */
  private diskValid = false;

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
      this.diskValid = true;
      this.setAsideRemoved();
    } catch {
      // A torn / hand-broken file would otherwise be silently replaced by defaults on the next save,
      // taking workspaces, providers and keys with it. Keep a copy the user can recover from.
      await fs.copyFile(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      // a power cut can leave the file full of NUL bytes (data never flushed): fall back to the last good copy
      try {
        this.data = { ...this.data, ...JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')) };
        this.setAsideRemoved();
      } catch { /* no usable backup */ }
    }
  }

  /** Profiles of a removed format (see `removedProviders`) out of the list; a default that was one of them goes. */
  private setAsideRemoved() {
    const all = Array.isArray(this.data.providers) ? this.data.providers : [];
    const gone = all.filter((p) => p.type !== 'anthropic' && p.type !== 'claude-account');
    if (!gone.length) return;
    this.data.providers = all.filter((p) => !gone.includes(p));
    this.data.removedProviders = [...(this.data.removedProviders ?? []), ...gone];
    if (gone.some((p) => p.id === this.data.settings.defaultProviderId)) delete this.data.settings.defaultProviderId;
  }

  private async writeDurable(target: string, text: string) {
    const h = await fs.open(target, 'w', 0o600);
    try {
      await h.writeFile(text, 'utf8');
      await h.sync();
    } finally {
      await h.close();
    }
  }

  private async save(quiet = false) {
    const file = this.file;
    await fs.mkdir(path.dirname(file), { recursive: true });
    // write-then-rename: a crash mid-write must not leave a truncated meta.json (it holds provider API keys)
    // and fsync before the rename: without it a sudden reboot keeps the rename but not the data (a NUL-filled file)
    const text = JSON.stringify(this.data, null, 2);
    const tmp = `${file}.${process.pid}.tmp`;
    await this.writeDurable(tmp, text);
    // the file being replaced was itself durable and valid: keep it as the fallback load() uses
    if (this.diskValid) await fs.readFile(file, 'utf8').then((old) => this.writeDurable(`${file}.bak`, old)).catch(() => {});
    try {
      await fs.rename(tmp, file);
    } catch {
      // Windows: rename over a file another process holds open fails — fall back to an in-place write
      await fs.rm(tmp, { force: true }).catch(() => {});
      await this.writeDurable(file, text);
    }
    this.diskValid = true;
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
    return [...this.data.workspaces].sort((a, b) => a.order - b.order).map((w) => ({ ...w, folders: normFolders(w.path, w.folders, { resolve: (p) => p }) }));
  }
  async addWorkspace(p: string) {
    const norm = path.resolve(p);
    const existing = this.data.workspaces.find((w) => w.path.toLowerCase() === norm.toLowerCase());
    if (existing) return existing;
    // a new project goes on top (user report 2026-10-14: it landed at the bottom, under everything older)
    for (const x of this.data.workspaces) x.order += 1;
    const w: Workspace = { id: Math.random().toString(36).slice(2, 10), path: norm, name: path.basename(norm) || norm, addedAt: Date.now(), order: 0 };
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
  /** 编辑项目 (stage C2): the name and the extra folders (normalised: never the main folder, no duplicates) */
  async updateWorkspace(id: string, patch: { name?: string; folders?: string[]; instructions?: string | null; sessionsScope?: 'project' | null; permissionMode?: PermissionMode | null; claudeAiUuid?: string }) {
    const w = this.data.workspaces.find((x) => x.id === id);
    if (!w) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) w.name = patch.name.trim();
    // only a list replaces them: anything else (a string from a confused client) leaves them as they are (C-S2)
    if (Array.isArray(patch.folders)) w.folders = normFolders(w.path, patch.folders);
    // 项目页 (stage F2): null / '' clears
    if (patch.instructions !== undefined) { const t = (patch.instructions ?? '').slice(0, 20_000); if (t.trim()) w.instructions = t; else delete w.instructions; }
    if (patch.sessionsScope !== undefined) { if (patch.sessionsScope === 'project') w.sessionsScope = 'project'; else delete w.sessionsScope; }
    if (patch.permissionMode !== undefined) { if (patch.permissionMode) w.permissionMode = patch.permissionMode; else delete w.permissionMode; }
    if (typeof patch.claudeAiUuid === 'string' && patch.claudeAiUuid) w.claudeAiUuid = patch.claudeAiUuid;
    await this.queueSave();
    return { ...w, folders: w.folders ?? [] };
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
    for (const k of ['defaultModel', 'modelMap', 'models', 'modelNames', 'modelEfforts', 'modelContext', 'contextWindows', 'compactAt', 'modelsAt', 'modelsError', 'cache1h', 'authStyle'] as const) if ((cur as any)[k] == null) delete (cur as any)[k]; // null clears (JSON drops undefined)
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
  async markDevicePeer(id: string) { const d = this.devices().find((x) => x.id === id); if (d) { d.kind = 'peer'; await this.queueSave(); } }
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
  // ---- privacy pipeline (privacy/service.ts): settings + the per-install placeholder secret (never on the wire) ----
  privacyConfig(): Partial<PrivacySettings> & { secret?: string } { return this.data.privacy ??= {}; }
  async savePrivacy() { await this.queueSave(true); }
}
