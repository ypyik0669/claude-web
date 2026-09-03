import { create } from 'zustand';
import type { AgentInfo, AgentKind, AttachmentRef, EffortLevel, EngineInfo, Limits, MessageFeedback, PermissionMode, Provider, SessionFeatures, PermissionRequestEvent, RunnerState, Schedule, ServerEvent, SessionInfoSnapshot, SessionMeta, SessionSummary, Workspace } from '@shared';
import { decodeAttachments, findChainUuidBefore, type ContextUsage } from '@/model/conversation';
import { activeGroup, chatTile, deriveActive, initialLayout, layoutReducer, migrateLegacy, sanitizeLayout, type LayoutAction, type LayoutState, type Tile } from '@/model/layout';
import { PaneContext, winId } from './paneContext';
import { useContext } from 'react';

export const THEMES = ['dark', 'light', 'dracula', 'nord', 'tokyo-night', 'paper'] as const;
export type Theme = (typeof THEMES)[number];
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { applyMessage, applyTranscript, createConversation, walkTools, type Conversation } from '@/model/conversation';
import { dlg } from '@/ui/dialog';
import { applyUiSettings, resolveTheme } from '@/features/settings/ui-settings';

export type PanelId = import('@/model/layout').PanelId;

export interface QueuedMessage { id: string; text: string; images?: { mediaType: string; data: string }[]; attachments?: AttachmentRef[] }

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
  queue: QueuedMessage[]; // messages typed while running
  draft: string;
  feedback: Record<string, MessageFeedback>; // messageId -> rating (meta.json)
  contextUsage?: ContextUsage;
  lastSent?: QueuedMessage; // for retry / auto-continue
}

const genUuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

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
  settingsOpen: { section?: string; query?: string; reveal?: string } | null;
  metaLoaded: boolean;
  openSettings(o?: { section?: string; query?: string; reveal?: string }): void;
  viewer: { images: string[]; index: number } | null;
  openViewer(images: string[], index?: number): void;
  // workbench layout (groups → panes → tiles); `activeId` and `panels` are projections of it
  layout: LayoutState;
  dispatchLayout(a: LayoutAction): void;
  /** open a session (or a fresh empty tile when null) in the focused pane */
  openInPane(sessionId: string | null, mode?: 'replace' | 'tab', paneId?: string): void;
  openTile(tile: Tile, mode?: 'replace' | 'tab', paneId?: string): void;
  /** close a tile; asks first when it is an editor with unsaved changes */
  closeTile(paneId: string, tileId: string): Promise<void>;
  dirtyDocs: Record<string, boolean>; // doc tile id -> unsaved
  setDocDirty(tileId: string, dirty: boolean): void;
  loadMeta(): Promise<void>;
  addWorkspace(path: string): Promise<void>;
  setSessionMeta(sessionId: string, patch: SessionMeta): Promise<void>;
  // actions
  init(): void;
  refreshSessions(): Promise<void>;
  openSession(p: { sessionId?: string; cwd: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; fork?: boolean; resumeAt?: string; worktree?: string; providerId?: string; features?: SessionFeatures; agent?: AgentKind }, target?: { paneId: string; tileId: string } | 'none'): Promise<string>;
  engine: EngineInfo | null;
  providers: Provider[];
  agents: AgentInfo[];
  loadAgents(refresh?: boolean): Promise<void>;
  settings: Record<string, unknown>;
  loadEngine(): Promise<void>;
  loadProviders(): Promise<void>;
  setSetting(key: string, value: unknown): Promise<void>;
  loadHistory(sessionId: string, opts?: { focus?: boolean; mode?: 'replace' | 'tab' }): Promise<void>;
  send(sessionId: string, text: string, images?: { mediaType: string; data: string }[], steer?: boolean, attachments?: AttachmentRef[]): Promise<void>;
  /** remove a queued message (returns it so the composer can restore the text) */
  recall(sessionId: string, id: string): QueuedMessage | undefined;
  /** interrupt the running turn and send this queued message right away */
  stopAndRun(sessionId: string, id: string): Promise<void>;
  /** fork before this user message and send the edited text into the fork */
  editAndResend(sessionId: string, userItemId: string, text: string): Promise<void>;
  rerun(sessionId: string, userItemId: string): Promise<void>;
  retryLast(sessionId: string): Promise<void>;
  setFeedback(sessionId: string, messageId: string, rating: 'up' | 'down' | null): Promise<void>;
  loadFeedback(sessionId: string): Promise<void>;
  saveDraft(key: string, text: string): void;
  loadDraft(key: string): Promise<string>;
  refreshContextUsage(sessionId: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respondPermission(requestId: string, response: any): Promise<void>;
  loadSubagent(sessionId: string, toolUseId: string): Promise<void>;
  setActive(id: string | null): void;
  togglePanel(p: PanelId): void;
  setTab(t: 'chat' | 'trajectory'): void;
  setDraft(sessionId: string, d: string): void;
  closeSession(sessionId: string): Promise<void>;
  setTheme(t: Theme, fromSettings?: boolean): void;
  forkAt(sessionId: string, messageUuid: string): Promise<void>;
  onTurnEnd(sessionId: string): void;
}

const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const autoContinueAt = new Map<string, number>(); // sessionId -> epoch ms (for the status strip countdown)

function armAutoContinue(sessionId: string, at: number) {
  disarmAutoContinue(sessionId);
  autoContinueAt.set(sessionId, at);
  const fire = () => {
    autoTimers.delete(sessionId);
    autoContinueAt.delete(sessionId);
    const st = useStore.getState();
    const o = st.open[sessionId];
    if (!o || !o.lastSent || o.state === 'running' || o.state === 'waiting') return;
    st.toast('额度已恢复，自动继续上一条消息', true);
    void st.retryLast(sessionId);
  };
  autoTimers.set(sessionId, setTimeout(fire, Math.max(1000, at - Date.now())));
}
export function disarmAutoContinue(sessionId: string) {
  const t = autoTimers.get(sessionId);
  if (t) clearTimeout(t);
  autoTimers.delete(sessionId);
  autoContinueAt.delete(sessionId);
}
// timers drift while the tab sleeps: re-arm on visibility change
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  for (const [sid, at] of autoContinueAt) armAutoContinue(sid, at);
});

function bump(s: State, id: string, fn: (o: OpenSession) => void): Partial<State> {
  const o = s.open[id];
  if (!o) return {};
  fn(o);
  return { open: { ...s.open, [id]: { ...o, version: o.version + 1 } } };
}

const LAYOUT_KEY = `cw.layout.v2:${winId}`;
function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const s = sanitizeLayout(JSON.parse(raw));
      if (s) return s;
    }
  } catch { /* fall through */ }
  try {
    const s = migrateLegacy(localStorage);
    localStorage.removeItem('cw.panels');
    localStorage.removeItem('cw.rp');
    return s;
  } catch {
    return initialLayout();
  }
}
let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;
function persistLayout(s: LayoutState) {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(s)); } catch { /* ignore */ } }, 300);
}
const initialLayoutState = loadLayout();

export const useStore = create<State>((set, get) => ({
  connected: false,
  sessions: [],
  open: {},
  activeId: deriveActive(initialLayoutState),
  tab: 'chat',
  panels: initialLayoutState.dock.tabs,
  layout: initialLayoutState,
  dispatchLayout(a) {
    const prev = get().layout;
    const next = layoutReducer(prev, a);
    if (next === prev) return;
    const activeId = deriveActive(next);
    const patch: Partial<State> = { layout: next, panels: next.dock.tabs };
    if (activeId !== get().activeId) { patch.activeId = activeId; patch.inspect = null; }
    set(patch);
    persistLayout(next);
  },
  openInPane(sessionId, mode = 'replace', paneId) {
    get().openTile(chatTile(sessionId), mode, paneId);
  },
  openTile(tile, mode = 'replace', paneId) {
    const g = activeGroup(get().layout);
    const single = !!get().settings['ui.singleWindow'];
    get().dispatchLayout({ t: 'tile.open', paneId: paneId ?? g.focusedPaneId, tile, mode: single ? 'replace' : mode });
  },
  async closeTile(paneId, tileId) {
    if (get().dirtyDocs[tileId] && !(await dlg.confirm('这个文件有未保存的改动，确定关闭？', { okLabel: '关闭', danger: true }))) return;
    get().dispatchLayout({ t: 'tile.close', paneId, tileId });
  },
  dirtyDocs: {},
  setDocDirty(tileId, dirty) {
    set((s) => {
      if (!!s.dirtyDocs[tileId] === dirty) return {};
      const d = { ...s.dirtyDocs };
      if (dirty) d[tileId] = true; else delete d[tileId];
      return { dirtyDocs: d };
    });
  },
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
  agents: [],
  async loadAgents(refresh = false) {
    const agents = await ws.request<AgentInfo[]>({ kind: 'agents.list', refresh });
    set({ agents });
  },
  settingsOpen: null,
  metaLoaded: false,
  openSettings(o = {}) { set({ settingsOpen: o }); },
  async setSetting(key, value) {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    if (key.startsWith('ui.')) { applyUiSettings(get().settings); if (key === 'ui.theme') get().setTheme(resolveTheme(value as any), true); }
    if (key === 'ui.softwareRender' && desktop?.setFlags) { void desktop.setFlags({ softwareRender: !!value }); get().toast('重启应用后生效', true); }
    await ws.request({ kind: 'settings.set', key, value });
  },
  async loadMeta() {
    const [workspaces, sessionMeta, schedules, settings] = await Promise.all([
      ws.request<Workspace[]>({ kind: 'workspaces.list' }),
      ws.request<Record<string, SessionMeta>>({ kind: 'sessions.meta' }),
      ws.request<Schedule[]>({ kind: 'schedules.list' }),
      ws.request<Record<string, unknown>>({ kind: 'settings.get' }),
    ]);
    set({ workspaces, sessionMeta, schedules, settings, metaLoaded: true });
    applyUiSettings(settings);
    if (settings['ui.theme']) get().setTheme(resolveTheme(settings['ui.theme'] as any), true);
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
        void get().loadAgents().catch(() => {});
        void ws.request<Limits>({ kind: 'limits.get' }).then((limits) => set({ limits })).catch(() => {});
        // re-attach open live sessions after reconnect
        for (const o of Object.values(get().open)) if (o.state !== 'history') void ws.request({ kind: 'session.info', sessionId: o.sessionId }).then((d: any) => set((s) => bump(s, o.sessionId, (x) => { x.info = d.info; x.pending = d.pending; }))).catch(() => set((s) => bump(s, o.sessionId, (x) => { x.state = 'history'; })));
      }
    };
    ws.on((e: ServerEvent) => {
      switch (e.kind) {
        case 'session.event':
          set((s) => bump(s, e.sessionId, (o) => applyMessage(o.conv, e.message)));
          if ((e.message as any)?.type === 'result') get().onTurnEnd(e.sessionId);
          break;
        case 'session.state': {
          const prev = get().open[e.sessionId]?.state;
          if (desktop && e.state === 'idle' && prev === 'running' && !document.hasFocus()) desktop.notify(get().sessions.find((x) => x.sessionId === e.sessionId)?.title ?? '会话', 'Claude 完成了这一轮', e.sessionId);
          set((s) => bump(s, e.sessionId, (o) => { o.state = e.state; if (e.error) o.error = e.error; if (e.state === 'idle' && o.queue.length) { const next = o.queue.shift()!; void get().send(e.sessionId, next.text, next.images, false, next.attachments); } }));
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

  async openSession(p, target) {
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
    const o: OpenSession = { sessionId: r.sessionId, cwd: p.cwd, conv, version: (existing?.version ?? 0) + 1, state: r.info.state, info: r.info, pending: r.pending, loading: false, queue: existing?.queue ?? [], draft: existing?.draft ?? '', feedback: existing?.feedback ?? {}, contextUsage: existing?.contextUsage, lastSent: existing?.lastSent };
    set((s) => {
      const open = { ...s.open };
      if (p.sessionId && p.sessionId !== r.sessionId && !p.fork && !p.resumeAt) delete open[p.sessionId];
      open[r.sessionId] = o;
      return { open };
    });
    // place it in the workbench: a specific tile (welcome composer), the focused pane, or nowhere (background)
    if (target && target !== 'none') get().dispatchLayout({ t: 'session.assign', paneId: target.paneId, tileId: target.tileId, sessionId: r.sessionId });
    else if (target !== 'none') get().openInPane(r.sessionId, p.fork || p.resumeAt ? 'tab' : 'replace');
    if (!p.sessionId) void get().refreshSessions();
    // load transcript in the background for resumed / forked sessions with empty conv
    if (p.sessionId && !existing) void get().loadHistory(r.sessionId);
    if (p.fork || p.resumeAt) void get().refreshSessions();
    void get().loadFeedback(r.sessionId);
    return r.sessionId;
  },

  onTurnEnd(sessionId: string) {
    const o = get().open[sessionId];
    if (!o) return;
    void get().refreshContextUsage(sessionId);
    const res = o.conv.lastResult;
    // auto-continue when a quota / throttle error ends the turn and the user opted in
    if (res?.isError && (res.errorKind === 'quota' || res.errorKind === 'throttled') && get().settings.autoContinueOnReset && o.lastSent) {
      const resetsAt = o.conv.rateLimit?.resetsAt;
      const at = resetsAt ? resetsAt * (resetsAt < 1e12 ? 1000 : 1) + 5000 : Date.now() + (res.errorKind === 'throttled' ? 60_000 : 30 * 60_000);
      armAutoContinue(sessionId, at);
    }
  },

  async refreshContextUsage(sessionId) {
    const o = get().open[sessionId];
    if (!o || o.state === 'history' || o.state === 'closed' || o.state === 'error') return;
    try {
      const u: any = await ws.request({ kind: 'session.contextUsage', sessionId, detail: 'summary' });
      if (!u) return;
      const cu: ContextUsage = { percentage: u.percentage ?? Math.round(((u.total_tokens ?? 0) / Math.max(1, u.raw_max_tokens ?? 1)) * 100), totalTokens: u.total_tokens ?? 0, maxTokens: u.raw_max_tokens ?? 0, model: u.model, overLimit: u.over_limit ? { tokensOver: u.over_limit.tokens_over, kind: u.over_limit.kind } : undefined };
      set((s) => bump(s, sessionId, (x) => { x.contextUsage = cu; x.conv.contextUsage = cu; }));
    } catch {
      /* runtime without the control request */
    }
  },

  recall(sessionId, id) {
    const o = get().open[sessionId];
    const q = o?.queue.find((m) => m.id === id);
    if (!o || !q) return undefined;
    set((s) => bump(s, sessionId, (x) => { x.queue = x.queue.filter((m) => m.id !== id); }));
    return q;
  },

  async stopAndRun(sessionId, id) {
    const q = get().recall(sessionId, id);
    if (!q) return;
    await get().interrupt(sessionId);
    // the runner flips to idle after the interrupt lands; queue the message at the front so the idle handler sends it
    set((s) => bump(s, sessionId, (x) => { x.queue.unshift(q); }));
  },

  async editAndResend(sessionId, userItemId, text) {
    const o = get().open[sessionId];
    if (!o) return;
    const anchor = findChainUuidBefore(o.conv, userItemId);
    if (anchor === undefined) throw new Error('找不到这条消息');
    const orig = o.conv.items.find((i) => i.id === userItemId);
    const atts = orig?.kind === 'user' ? orig.attachments?.filter((a) => a.path).map((a) => ({ kind: a.kind, name: a.name, path: a.path, size: a.size })) : undefined;
    if (anchor === null) {
      // first message: brand-new session in the same directory with the same settings
      const id = await get().openSession({ cwd: o.cwd, model: o.info?.model, permissionMode: o.info?.permissionMode, providerId: o.info?.providerId, features: o.info?.features });
      await get().send(id, text, undefined, false, atts as AttachmentRef[] | undefined);
      return;
    }
    const id = await get().openSession({ sessionId, cwd: o.cwd, resumeAt: anchor });
    await get().send(id, text, undefined, false, atts as AttachmentRef[] | undefined);
  },

  async rerun(sessionId, userItemId) {
    const o = get().open[sessionId];
    const it = o?.conv.items.find((i) => i.id === userItemId);
    if (!o || it?.kind !== 'user') return;
    await get().editAndResend(sessionId, userItemId, it.text);
  },

  async retryLast(sessionId) {
    const o = get().open[sessionId];
    const last = o?.lastSent;
    if (!o || !last) return;
    await get().send(sessionId, last.text, last.images, false, last.attachments);
  },

  async setFeedback(sessionId, messageId, rating) {
    set((s) => bump(s, sessionId, (x) => { if (rating) x.feedback[messageId] = { rating, at: Date.now() }; else delete x.feedback[messageId]; }));
    await ws.request({ kind: 'feedback.set', sessionId, messageId, rating }).catch((e) => get().toast(e.message));
  },
  async loadFeedback(sessionId) {
    try {
      const fb = await ws.request<Record<string, MessageFeedback>>({ kind: 'feedback.list', sessionId });
      set((s) => bump(s, sessionId, (x) => { x.feedback = fb ?? {}; }));
    } catch {
      /* ignore */
    }
  },

  saveDraft(key, text) {
    const t = draftTimers.get(key);
    if (t) clearTimeout(t);
    draftTimers.set(key, setTimeout(() => { draftTimers.delete(key); void ws.request({ kind: 'drafts.set', key, text }).catch(() => {}); }, 500));
  },
  async loadDraft(key) {
    try {
      return (await ws.request<string>({ kind: 'drafts.get', key })) ?? '';
    } catch {
      return '';
    }
  },

  async loadHistory(sessionId, opts) {
    const cur = get().open[sessionId];
    // tiles restored from a persisted layout can ask before the session list arrived → fetch it first (cwd comes from it)
    if (!get().sessions.some((s) => s.sessionId === sessionId)) await get().refreshSessions().catch(() => {});
    const meta = get().sessions.find((s) => s.sessionId === sessionId);
    if (!cur) set((s) => ({ open: { ...s.open, [sessionId]: { sessionId, cwd: meta?.cwd ?? '', conv: createConversation(), version: 0, state: 'history', pending: [], loading: true, queue: [], draft: '', feedback: {} } } }));
    else set((s) => bump(s, sessionId, (o) => { o.loading = true; }));
    if (opts?.focus !== false) get().openInPane(sessionId, opts?.mode ?? 'replace');
    void get().loadFeedback(sessionId);
    if (!cur) void get().loadDraft(sessionId).then((d) => d && set((s) => bump(s, sessionId, (o) => { if (!o.draft) o.draft = d; })));
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
      if (meta?.live && meta.live !== 'closed' && meta.live !== 'error') await get().openSession({ sessionId, cwd: meta.cwd }, 'none');
    } catch (e: any) {
      set((s) => bump(s, sessionId, (o) => { o.loading = false; o.error = e.message; }));
    }
  },

  async send(sessionId, text, images, steer = false, attachments) {
    const o = get().open[sessionId];
    if (!o) return;
    if (o.state === 'history' || o.state === 'closed' || o.state === 'error') {
      await get().openSession({ sessionId, cwd: o.cwd }, 'none');
    }
    const cur = get().open[sessionId];
    if ((cur.state === 'running' || cur.state === 'waiting') && !steer) {
      set((s) => bump(s, sessionId, (x) => { x.queue.push({ id: genUuid(), text, images, attachments }); }));
      return;
    }
    // client-minted transcript uuid: the local echo id is the real fork / rewind anchor
    const uuid = genUuid();
    const shown = decodeAttachments(text);
    set((s) => bump(s, sessionId, (x) => {
      x.conv.items.push({ kind: 'user', id: uuid, ts: new Date().toISOString(), text: shown.text, images: (images ?? []).map((im) => `data:${im.mediaType};base64,${im.data}`), attachments: attachments?.length ? attachments.map((a) => ({ kind: a.kind, name: a.name, path: a.path, size: a.size })) : shown.attachments.length ? shown.attachments : undefined, meta: false });
      x.state = 'running';
      x.lastSent = { id: uuid, text, images, attachments };
      x.conv.lastEventAt = Date.now();
    }));
    disarmAutoContinue(sessionId);
    get().saveDraft(sessionId, '');
    await ws.request({ kind: 'session.send', params: { sessionId, text, images, steer, uuid, attachments } });
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
    get().openInPane(id, 'replace');
  },
  togglePanel(p) {
    get().dispatchLayout({ t: 'dock.toggle', panel: p });
  },
  setTab(tab) {
    set({ tab });
  },
  setDraft(sessionId, draft) {
    set((s) => ({ open: { ...s.open, [sessionId]: { ...s.open[sessionId], draft } } }));
  },
  async closeSession(sessionId) {
    await ws.request({ kind: 'session.close', sessionId }).catch(() => {});
    // keep the tile: it re-loads the transcript as history
    set((s) => bump(s, sessionId, (o) => { o.state = 'history'; o.pending = []; o.queue = []; }));
  },
  setTheme(theme, fromSettings = false) {
    localStorage.setItem('cw.theme', theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
    if (!fromSettings && get().settings['ui.theme'] !== theme) { set((s) => ({ settings: { ...s.settings, 'ui.theme': theme } })); void ws.request({ kind: 'settings.set', key: 'ui.theme', value: theme }).catch(() => {}); }
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
/** Session of the enclosing workbench pane (falls back to the focused pane's session outside a pane). */
export const useScopedSession = () => {
  const ctx = useContext(PaneContext);
  return useStore((s) => {
    const id = ctx ? ctx.sessionId : s.activeId;
    return id ? s.open[id] : undefined;
  });
};
export const useScopedSessionId = () => {
  const ctx = useContext(PaneContext);
  const activeId = useStore((s) => s.activeId);
  return ctx ? ctx.sessionId : activeId;
};
