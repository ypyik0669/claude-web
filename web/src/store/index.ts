import { create } from 'zustand';
import type { EffortLevel, PermissionMode, PermissionRequestEvent, RunnerState, ServerEvent, SessionInfoSnapshot, SessionSummary } from '@shared';
import { ws } from '@/ws/client';
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
  inspect: { sessionId: string; toolUseId: string } | null;
  theme: 'dark' | 'light';
  // actions
  init(): void;
  refreshSessions(): Promise<void>;
  openSession(p: { sessionId?: string; cwd: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; fork?: boolean }): Promise<string>;
  loadHistory(sessionId: string): Promise<void>;
  send(sessionId: string, text: string, images?: { mediaType: string; data: string }[]): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respondPermission(requestId: string, response: any): Promise<void>;
  loadSubagent(sessionId: string, toolUseId: string): Promise<void>;
  setActive(id: string | null): void;
  togglePanel(p: PanelId): void;
  setTab(t: 'chat' | 'trajectory'): void;
  setDraft(sessionId: string, d: string): void;
  closeSession(sessionId: string): Promise<void>;
  setTheme(t: 'dark' | 'light'): void;
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
  theme: (localStorage.getItem('cw.theme') as 'dark' | 'light') || 'dark',

  init() {
    ws.onStatus = (c) => {
      set({ connected: c });
      if (c) {
        void get().refreshSessions();
        // re-attach open live sessions after reconnect
        for (const o of Object.values(get().open)) if (o.state !== 'history') void ws.request({ kind: 'session.info', sessionId: o.sessionId }).then((d: any) => set((s) => bump(s, o.sessionId, (x) => { x.info = d.info; x.pending = d.pending; }))).catch(() => set((s) => bump(s, o.sessionId, (x) => { x.state = 'history'; })));
      }
    };
    ws.on((e: ServerEvent) => {
      switch (e.kind) {
        case 'session.event':
          set((s) => bump(s, e.sessionId, (o) => applyMessage(o.conv, e.message)));
          break;
        case 'session.state':
          set((s) => bump(s, e.sessionId, (o) => { o.state = e.state; if (e.error) o.error = e.error; if (e.state === 'idle' && o.queue.length) { const next = o.queue.shift()!; void get().send(e.sessionId, next); } }));
          set((s) => ({ sessions: s.sessions.map((x) => (x.sessionId === e.sessionId ? { ...x, live: e.state === 'closed' ? undefined : e.state } : x)) }));
          break;
        case 'session.info':
          set((s) => bump(s, e.info.sessionId, (o) => { o.info = e.info; }));
          break;
        case 'permission.request':
          set((s) => bump(s, e.request.sessionId, (o) => { if (!o.pending.some((p) => p.requestId === e.request.requestId)) o.pending.push(e.request); }));
          break;
        case 'permission.resolved':
          set((s) => { const out = { ...s.open }; for (const [id, o] of Object.entries(out)) if (o.pending.some((p) => p.requestId === e.requestId)) out[id] = { ...o, pending: o.pending.filter((p) => p.requestId !== e.requestId), version: o.version + 1 }; return { open: out }; });
          break;
        case 'sessions.changed':
          void get().refreshSessions();
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
    const existing = p.sessionId && !p.fork ? get().open[p.sessionId] : undefined;
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
      if (p.sessionId && p.sessionId !== r.sessionId) delete open[p.sessionId];
      open[r.sessionId] = o;
      return { open, activeId: r.sessionId };
    });
    if (!p.sessionId) void get().refreshSessions();
    // load transcript in the background for resumed sessions with empty conv
    if (p.sessionId && !existing) void get().loadHistory(r.sessionId);
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
    } catch (e: any) {
      set((s) => bump(s, sessionId, (o) => { o.loading = false; o.error = e.message; }));
    }
  },

  async send(sessionId, text, images) {
    const o = get().open[sessionId];
    if (!o) return;
    if (o.state === 'history' || o.state === 'closed' || o.state === 'error') {
      await get().openSession({ sessionId, cwd: o.cwd });
    }
    const cur = get().open[sessionId];
    if (cur.state === 'running' || cur.state === 'waiting') {
      set((s) => bump(s, sessionId, (x) => { x.queue.push(text); }));
      return;
    }
    // echo locally — the SDK does not replay user messages
    set((s) => bump(s, sessionId, (x) => { x.conv.items.push({ kind: 'user', id: `local-${Date.now()}`, ts: new Date().toISOString(), text, images: (images ?? []).map((im) => `data:${im.mediaType};base64,${im.data}`) }); x.state = 'running'; }));
    await ws.request({ kind: 'session.send', params: { sessionId, text, images } });
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
  },
}));

export const useActive = () => useStore((s) => (s.activeId ? s.open[s.activeId] : undefined));
