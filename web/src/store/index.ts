import { create } from 'zustand';
import type { EffortLevel, EngineInfo, Limits, PermissionMode, Provider, SessionFeatures, PermissionRequestEvent, RunnerState, Schedule, ServerEvent, SessionInfoSnapshot, SessionMeta, SessionSummary, Workspace } from '@shared';

export const THEMES = ['dark', 'light', 'dracula', 'nord', 'tokyo-night', 'paper'] as const;
export type Theme = (typeof THEMES)[number];
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { applyMessage, applyTranscript, createConversation, walkTools, type Conversation } from '@/model/conversation';

export type PanelId = 'tasks' | 'files' | 'usage' | 'config' | 'terminal' | 'inspector';

export interface OpenSession {
  sessionId: string;
  cwd: string;
  conv: Conversation;
  version: number; // bumped on every mutation so React re-renders
  state: RunnerState | 'history';
  info?: SessionInfoSnapshot;
  pending: PermissionRequestEvent[];
  error?: string;
  loading: boolean;
  queue: string[]; // messages typed while running
  draft: string;
}

interface State {
  connected: boolean;
  sessions: SessionSummary[];
  open: Record<string, OpenSession>;
  activeId: string | null;
  tab: 'chat' | 'trajectory';
  panels: PanelId[];
  sidebarOpen: boolean;
  inspect: { sessionId: string; toolUseId?: string; file?: { path: string; line?: number } } | null;
  theme: Theme;
  toasts: { id: number; text: string; ok?: boolean }[];
  toast(text: string, ok?: boolean): void;
  workspaces: Workspace[];
  sessionMeta: Record<string, SessionMeta>;
  schedules: Schedule[];
  limits: Limits | null;
  paletteOpen: boolean;
  showArchived: boolean;
  shortcutsOpen: boolean;
  configTab: string | null; // tab the config panel should open on next mount (one-shot)
  viewer: { images: string[]; index: number } | null;
  openViewer(images: string[], index?: number): void;
  loadMeta(): Promise<void>;
  addWorkspace(path: string): Promise<void>;
  setSessionMeta(sessionId: string, patch: SessionMeta): Promise<void>;
  // actions
  init(): void;
  refreshSessions(): Promise<void>;
  openSession(p: { sessionId?: string; cwd: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; fork?: boolean; resumeAt?: string; worktree?: string; providerId?: string; features?: SessionFeatures }): Promise<string>;
  engine: EngineInfo | null;
  providers: Provider[];
  settings: Record<string, unknown>;
  loadEngine(): Promise<void>;
  loadProviders(): Promise<void>;
  setSetting(key: string, value: unknown): Promise<void>;
  loadHistory(sessionId: string): Promise<void>;
  send(sessionId: string, text: string, images?: { mediaType: string; data: string }[], steer?: boolean): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respondPermission(requestId: string, response: any): Promise<void>;
  loadSubagent(sessionId: string, toolUseId: string): Promise<void>;
  setActive(id: string | null): void;
  togglePanel(p: PanelId): void;
  setTab(t: 'chat' | 'trajectory'): void;
  setDraft(sessionId: string, d: string): void;
  closeSession(sessionId: string): Promise<void>;
  setTheme(t: Theme): void;
  forkAt(sessionId: string, messageUuid: string): Promise<void>;
}

function bump(s: State, id: string, fn: (o: OpenSession) => void): Partial<State> {
  const o = s.open[id];
  if (!o) return {};
  fn(o);
  return { open: { ...s.open, [id]: { ...o, version: o.version + 1 } } };
}

const savedPanels = (() => {
  try {
    return JSON.parse(localStorage.getItem('cw.panels') ?? '["tasks"]');
  } catch {
    return ['tasks'];
  }
})();

export const useStore = create<State>((set, get) => ({
  connected: false,
  sessions: [],
  open: {},
  activeId: null,
  tab: 'chat',
  panels: savedPanels,
  sidebarOpen: true,
  inspect: null,
  theme: (localStorage.getItem('cw.theme') as Theme) || 'dark',
  toasts: [],
  workspaces: [],
  sessionMeta: {},
  schedules: [],
  limits: null,
  paletteOpen: false,
  showArchived: false,
  shortcutsOpen: false,
  configTab: null,
  viewer: null,
  openViewer(images, index = 0) {
    if (images.length) set({ viewer: { images, index } });
  },
  engine: null,
  providers: [],
  settings: {},
  async loadEngine() {
    const engine = await ws.request<EngineInfo>({ kind: 'engine.info' });
    set({ engine });
  },
  async loadProviders() {
    const providers = await ws.request<Provider[]>({ kind: 'providers.list' });
    set({ providers });
  },
  async setSetting(key, value) {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    await ws.request({ kind: 'settings.set', key, value });
  },
  async loadMeta() {
    const [workspaces, sessionMeta, schedules, settings] = await Promise.all([
      ws.request<Workspace[]>({ kind: 'workspaces.list' }),
      ws.request<Record<string, SessionMeta>>({ kind: 'sessions.meta' }),
      ws.request<Schedule[]>({ kind: 'schedules.list' }),
      ws.request<Record<string, unknown>>({ kind: 'settings.get' }),
    ]);
    set({ workspaces, sessionMeta, schedules, settings });
  },
  async addWorkspace(path) {
    await ws.request({ kind: 'workspaces.add', path });
    await get().loadMeta();
  },
  async setSessionMeta(sessionId, patch) {
    set((s) => ({ sessionMeta: { ...s.sessionMeta, [sessionId]: { ...s.sessionMeta[sessionId], ...patch } } }));
    await ws.request({ kind: 'session.setMeta', sessionId, patch });
  },
  toast(text, ok) {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, text, ok }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000);
  },

  init() {
    ws.onStatus = (c) => {
      set({ connected: c });
      if (c) {
        void get().refreshSessions();
        void get().loadMeta();
        void get().loadEngine().catch(() => {});
        void get().loadProviders().catch(() => {});
        void ws.request<Limits>({ kind: 'limits.get' }).then((limits) => set({ limits })).catch(() => {});
        // re-attach open live sessions after reconnect
        for (const o of Object.values(get().open)) if (o.state !== 'history') void ws.request({ kind: 'session.info', sessionId: o.sessionId }).then((d: any) => set((s) => bump(s, o.sessionId, (x) => { x.info = d.info; x.pending = d.pending; }))).catch(() => set((s) => bump(s, o.sessionId, (x) => { x.state = 'history'; })));
      }
    };
    ws.on((e: ServerEvent) => {
      switch (e.kind) {
        case 'session.event':
          set((s) => bump(s, e.sessionId, (o) => applyMessage(o.conv, e.message)));
          break;
        case 'session.state': {
          const prev = get().open[e.sessionId]?.state;
          if (desktop && e.state === 'idle' && prev === 'running' && !document.hasFocus()) desktop.notify(get().sessions.find((x) => x.sessionId === e.sessionId)?.title ?? '会话', 'Claude 完成了这一轮', e.sessionId);
          set((s) => bump(s, e.sessionId, (o) => { o.state = e.state; if (e.error) o.error = e.error; if (e.state === 'idle' && o.queue.length) { const next = o.queue.shift()!; void get().send(e.sessionId, next); } }));
          set((s) => ({ sessions: s.sessions.map((x) => (x.sessionId === e.sessionId ? { ...x, live: e.state === 'closed' ? undefined : e.state } : x)) }));
          break;
        }
        case 'session.info':
          set((s) => bump(s, e.info.sessionId, (o) => { o.info = e.info; }));
          break;
        case 'permission.request':
          set((s) => bump(s, e.request.sessionId, (o) => { if (!o.pending.some((p) => p.requestId === e.request.requestId)) o.pending.push(e.request); }));
          if (desktop) {
            const title = get().sessions.find((x) => x.sessionId === e.request.sessionId)?.title ?? '会话';
            const body = e.request.toolName === 'AskUserQuestion' ? 'Claude 有问题要问你' : e.request.toolName === 'ExitPlanMode' ? 'Claude 请求批准计划' : `需要权限：${e.request.toolName}`;
            desktop.notify(title, body, e.request.sessionId);
          }
          break;
        case 'permission.resolved':
          set((s) => { const out = { ...s.open }; for (const [id, o] of Object.entries(out)) if (o.pending.some((p) => p.requestId === e.requestId)) out[id] = { ...o, pending: o.pending.filter((p) => p.requestId !== e.requestId), version: o.version + 1 }; return { open: out }; });
          break;
        case 'sessions.changed':
          void get().refreshSessions();
          break;
        case 'meta.changed':
          void get().loadMeta();
          void get().loadProviders().catch(() => {});
          break;
        case 'limits':
          set({ limits: e.limits });
          break;
      }
    });
    ws.connect();
  },

  async refreshSessions() {
    const sessions = await ws.request<SessionSummary[]>({ kind: 'sessions.list', limit: 500 });
    set({ sessions });
  },

  async openSession(p) {
    const r = await ws.request<{ sessionId: string; info: SessionInfoSnapshot; history: any[]; pending: PermissionRequestEvent[] }>({ kind: 'session.open', params: p });
    const existing = p.sessionId && !p.fork && !p.resumeAt ? get().open[p.sessionId] : undefined;
    const conv = existing?.conv ?? createConversation();
    if (existing) {
      // history already loaded from transcript; only apply live messages we have not seen
      // (runner history is replayed from spawn — transcript already contains them, so skip when history was loaded)
      if (!existing.conv.items.length) for (const m of r.history) applyMessage(conv, m);
    } else {
      for (const m of r.history) applyMessage(conv, m);
    }
    const o: OpenSession = { sessionId: r.sessionId, cwd: p.cwd, conv, version: (existing?.version ?? 0) + 1, state: r.info.state, info: r.info, pending: r.pending, loading: false, queue: existing?.queue ?? [], draft: existing?.draft ?? '' };
    set((s) => {
      const open = { ...s.open };
      if (p.sessionId && p.sessionId !== r.sessionId && !p.fork && !p.resumeAt) delete open[p.sessionId];
      open[r.sessionId] = o;
      return { open, activeId: r.sessionId };
    });
    if (!p.sessionId) void get().refreshSessions();
    // load transcript in the background for resumed / forked sessions with empty conv
    if (p.sessionId && !existing) void get().loadHistory(r.sessionId);
    if (p.fork || p.resumeAt) void get().refreshSessions();
    return r.sessionId;
  },

  async loadHistory(sessionId) {
    const cur = get().open[sessionId];
    const meta = get().sessions.find((s) => s.sessionId === sessionId);
    if (!cur) set((s) => ({ open: { ...s.open, [sessionId]: { sessionId, cwd: meta?.cwd ?? '', conv: createConversation(), version: 0, state: 'history', pending: [], loading: true, queue: [], draft: '' } }, activeId: sessionId }));
    else set((s) => bump(s, sessionId, (o) => { o.loading = true; }));
    try {
      const msgs = await ws.request<any[]>({ kind: 'transcript.load', sessionId });
      set((s) => bump(s, sessionId, (o) => {
        const conv = createConversation();
        applyTranscript(conv, msgs);
        // re-apply live messages that arrived after spawn (they are also in transcript; duplicates are merged by id)
        o.conv = conv;
        o.loading = false;
      }));
      // a runner may already be alive for this session (e.g. page reload): re-attach so controls go live
      if (meta?.live && meta.live !== 'closed' && meta.live !== 'error') await get().openSession({ sessionId, cwd: meta.cwd });
    } catch (e: any) {
      set((s) => bump(s, sessionId, (o) => { o.loading = false; o.error = e.message; }));
    }
  },

  async send(sessionId, text, images, steer = false) {
    const o = get().open[sessionId];
    if (!o) return;
    if (o.state === 'history' || o.state === 'closed' || o.state === 'error') {
      await get().openSession({ sessionId, cwd: o.cwd });
    }
    const cur = get().open[sessionId];
    if ((cur.state === 'running' || cur.state === 'waiting') && !steer) {
      set((s) => bump(s, sessionId, (x) => { x.queue.push(text); }));
      return;
    }
    // echo locally — the SDK does not replay user messages
    set((s) => bump(s, sessionId, (x) => { x.conv.items.push({ kind: 'user', id: `local-${Date.now()}`, ts: new Date().toISOString(), text, images: (images ?? []).map((im) => `data:${im.mediaType};base64,${im.data}`), meta: false }); x.state = 'running'; }));
    await ws.request({ kind: 'session.send', params: { sessionId, text, images, steer } });
  },

  async loadSubagent(sessionId, toolUseId) {
    const o = get().open[sessionId];
    const t = o?.conv.toolIndex.get(toolUseId);
    if (!t) return;
    const text = `${t.result?.content ?? ''} ${JSON.stringify(t.result?.structured ?? '')}`;
    let agentId = /agentId[":\s]+([a-f0-9]{8,})/i.exec(text)?.[1];
    if (!agentId) {
      // fall back: match by order among the session's subagents
      const ids = await ws.request<string[]>({ kind: 'transcript.subagents', sessionId });
      const agentsInOrder = [...walkTools(o.conv.items)].filter((x) => x.tool.name === 'Agent' || x.tool.name === 'Task').map((x) => x.tool.id);
      agentId = ids[agentsInOrder.indexOf(toolUseId)];
    }
    if (!agentId) throw new Error('找不到子代理 id');
    const msgs = await ws.request<any[]>({ kind: 'transcript.subagent', sessionId, agentId });
    set((s) => bump(s, sessionId, (x) => {
      const sub = createConversation();
      applyTranscript(sub, msgs);
      t.children = sub.items;
      for (const [k, v] of sub.toolIndex) x.conv.toolIndex.set(k, v);
    }));
  },

  async interrupt(sessionId) {
    set((s) => bump(s, sessionId, (x) => { x.queue = []; }));
    await ws.request({ kind: 'session.interrupt', sessionId });
  },

  async respondPermission(requestId, response) {
    await ws.request({ kind: 'permission.respond', requestId, response });
  },

  setActive(id) {
    set({ activeId: id, inspect: null });
  },
  togglePanel(p) {
    set((s) => {
      const panels = s.panels.includes(p) ? s.panels.filter((x) => x !== p) : [...s.panels, p];
      localStorage.setItem('cw.panels', JSON.stringify(panels));
      return { panels };
    });
  },
  setTab(tab) {
    set({ tab });
  },
  setDraft(sessionId, draft) {
    set((s) => ({ open: { ...s.open, [sessionId]: { ...s.open[sessionId], draft } } }));
  },
  async closeSession(sessionId) {
    await ws.request({ kind: 'session.close', sessionId }).catch(() => {});
    set((s) => { const open = { ...s.open }; delete open[sessionId]; return { open, activeId: s.activeId === sessionId ? null : s.activeId }; });
  },
  setTheme(theme) {
    localStorage.setItem('cw.theme', theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
    const d = desktop;
    if (d) {
      const cs = getComputedStyle(document.documentElement);
      setTimeout(() => d.setTitleBarColors(cs.getPropertyValue('--bg').trim(), cs.getPropertyValue('--fg-1').trim()), 0);
    }
  },
  async forkAt(sessionId: string, messageUuid: string) {
    const o = get().open[sessionId];
    if (!o) return;
    await get().openSession({ sessionId, cwd: o.cwd, resumeAt: messageUuid });
  },
}));

export const useActive = () => useStore((s) => (s.activeId ? s.open[s.activeId] : undefined));
