import { create } from 'zustand';
import type { AgentInfo, AgentKind, AttachmentRef, EffortLevel, EngineInfo, Limits, MessageFeedback, PermissionMode, Provider, SessionFeatures, PermissionRequestEvent, RunnerState, Schedule, ServerEvent, SessionInfoSnapshot, SessionMeta, SessionSummary, SourceStatus, Workspace } from '@shared';
import { withDefaultMode } from './default-mode';
import { decodeAttachments, findChainUuidBefore, type ContextUsage } from '@/model/conversation';
import { activeGroup, chatTile, deriveActive, hasLegacyLayout, initialLayout, layoutReducer, migrateLegacy, migrateWorkbench, needsSimplifiedNotice, panelToggleEffect, sanitizeLayout, SIMPLIFIED_NOTICE_KEY, type LayoutAction, type LayoutState, type Tile } from '@/model/layout';
import { PaneContext, winId } from './paneContext';
import { useContext } from 'react';
import { isAuthAnswer, type AccountAuth } from './auth';
export type { AccountAuth } from './auth';

export const THEMES = ['dark', 'light', 'dracula', 'nord', 'tokyo-night', 'paper'] as const;
export type Theme = (typeof THEMES)[number];
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { applyMessage, applyTranscript, createConversation, prependTranscript, walkTools, type Conversation } from '@/model/conversation';
import { isImportedSessionId } from '@/util';
import { forkParams, resumeParams, resumeView, type ResumeChoice } from './reopen';
import { parseLibraryId, parsePeerId } from '@shared';
import { dlg } from '@/ui/dialog';
import { DEFAULT_THEME, applyUiSettings, resolveTheme, setSystemThemeHandler } from '@/features/settings/ui-settings';
import { SIMPLIFIED_NOTICE } from '@/ui/terms';
import { MOBILE_QUERY } from '@/ui/viewport';

export type PanelId = import('@/model/layout').PanelId;

export interface QueuedMessage { id: string; text: string; images?: { mediaType: string; data: string }[]; attachments?: AttachmentRef[] }

export interface OpenSession {
  sessionId: string;
  cwd: string;
  /**
   * opened with `openSession({worktree})`: Claude Code works in `<cwd>/.claude/worktrees/<name>` (its own checkout),
   * while `cwd` stays the repository root the runner was started in
   */
  worktree?: string;
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
  /** library sessions: cursor for the next OLDER page (`library.read`); absent = nothing older */
  historyCursor?: string;
  /** the last transcript.load / library.read failed — the chat shows this with a retry button */
  loadError?: string;
  /**
   * not running: what the user picked on its model / permission chips for the next send (final review §9 #1);
   * the send resumes it with `resumeParams()`, and the fresh OpenSession of the resumed one drops it
   */
  resume?: ResumeChoice;
}

export type LibraryOp = 'rename' | 'archive' | 'delete' | 'fork';

const genUuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

interface State {
  connected: boolean;
  sessions: SessionSummary[];
  open: Record<string, OpenSession>;
  activeId: string | null;
  tab: 'chat' | 'trajectory';
  panels: PanelId[];
  sidebarOpen: boolean;
  /** Phone-width window (≤ 760px, spec §5.11): no workbench chrome; the right panel is a bottom drawer. Set by App from a media query. */
  mobile: boolean;
  /**
   * Phone: when the right panel's bottom drawer was brought up (0 = it is down). The drawer is the same Dock; this
   * is only whether it is on screen — not persisted, and putting it away never writes the desktop's `dock.open`.
   */
  sheetAt: number;
  inspect: { sessionId: string; toolUseId?: string; file?: { path: string; line?: number } } | null;
  theme: Theme;
  toasts: { id: number; text: string; ok?: boolean }[];
  toast(text: string, ok?: boolean, ms?: number): void;
  workspaces: Workspace[];
  sessionMeta: Record<string, SessionMeta>;
  schedules: Schedule[];
  limits: Limits | null;
  /**
   * Who is signed in (`config.auth` = `claude auth status`), for the sidebar's account row. Asked once per connection
   * (like `limits`), never polled and never on mount: every forced check is an engine start. null = not answered yet.
   * Every check made anywhere (welcome page, onboarding, settings) goes through `checkAuth` and lands here too.
   */
  auth: AccountAuth | null;
  /**
   * `config.auth` for everyone who asks (the welcome page, onboarding, settings, the connection): the reply is
   * returned as is, and written to `auth` when it is an answer about the login (a boolean `loggedIn`). `force` = a
   * fresh `claude auth status` instead of the server's 30 s shared result.
   */
  checkAuth(force?: boolean): Promise<AccountAuth | null>;
  /** 「需要你」 errors the user dismissed (`<sessionId>:<error>`); a changed error shows again. Not persisted. */
  attnDismissed: Record<string, true>;
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
  openSession(p: { sessionId?: string; cwd: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; ultracode?: boolean; fork?: boolean; resumeAt?: string; worktree?: string; providerId?: string; features?: SessionFeatures; agent?: AgentKind }, target?: { paneId: string; tileId: string } | 'none'): Promise<string>;
  engine: EngineInfo | null;
  providers: Provider[];
  agents: AgentInfo[];
  loadAgents(refresh?: boolean): Promise<void>;
  settings: Record<string, unknown>;
  loadEngine(): Promise<void>;
  loadProviders(): Promise<void>;
  setSetting(key: string, value: unknown): Promise<void>;
  /** `cwd`: the conversation's folder when the caller knows it and the list may not have the session yet (a goal's new conversation) */
  loadHistory(sessionId: string, opts?: { focus?: boolean; mode?: 'replace' | 'tab'; cwd?: string }): Promise<void>;
  /** prepend the next older page of an imported session's history; true while there is still more */
  loadOlder(sessionId: string): Promise<boolean>;
  // unified session library
  librarySources: SourceStatus[];
  sourceFilter: AgentKind | 'all';
  setSourceFilter(k: AgentKind | 'all'): void;
  loadLibrarySources(): Promise<void>;
  /** `library.<op>` with `payload` (rename {sessionId,title} / archive {sessionIds,archived} / delete {sessionIds} / fork {sessionId}) */
  libraryOp(op: LibraryOp, payload: Record<string, unknown>): Promise<any>;
  /** sessions deleted while a tile may still show them (the tile shows a banner and locks its composer) */
  deletedSessions: Record<string, true>;
  markDeleted(ids: string[]): void;
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
  /** a conversation that is not running: remember a pick on its chips for the send that resumes it */
  setResume(sessionId: string, patch: ResumeChoice): void;
  closeSession(sessionId: string): Promise<void>;
  setTheme(t: Theme, fromSettings?: boolean): void;
  forkAt(sessionId: string, messageUuid: string): Promise<void>;
  onTurnEnd(sessionId: string): void;
}

const olderInflight = new Map<string, Promise<boolean>>();
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
/** The saved layout (or one rebuilt from the pre-workbench keys); `saved` is false on a first run. */
function loadLayout(): { layout: LayoutState; saved: boolean } {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const s = sanitizeLayout(JSON.parse(raw));
      if (s) return { layout: s, saved: true };
    }
  } catch { /* fall through */ }
  try {
    const saved = hasLegacyLayout(localStorage);
    const s = migrateLegacy(localStorage);
    localStorage.removeItem('cw.panels');
    localStorage.removeItem('cw.rp');
    return { layout: s, saved };
  } catch {
    return { layout: initialLayout(), saved: false };
  }
}
let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;
function persistLayout(s: LayoutState) {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(s)); } catch { /* ignore */ } }, 300);
}
const loadedLayout = loadLayout();
const initialLayoutState = loadedLayout.layout;

/**
 * What a watcher is told besides the action: `since` = the action places the answer to a request sent at that
 * time (a new conversation put in its tile once `session.open` came back) rather than following a click now.
 */
export interface LayoutActionMeta { since?: number }
/**
 * Told about every layout action before it is applied — a no-op too (opening the conversation already in front).
 * A page laid over the main area (the automation page) closes when the main area is sent somewhere; the phone's
 * drawer goes down.
 */
const layoutWatchers = new Set<(a: LayoutAction, meta: LayoutActionMeta) => void>();
export function onLayoutAction(fn: (a: LayoutAction, meta: LayoutActionMeta) => void): () => void {
  layoutWatchers.add(fn);
  return () => { layoutWatchers.delete(fn); };
}
let actionSince: number | undefined;
/** Run `fn`'s layout actions as the answer to a request sent at `since` (see `LayoutActionMeta`). */
export function answering<T>(since: number, fn: () => T): T {
  const prev = actionSince;
  actionSince = since;
  try { return fn(); } finally { actionSince = prev; }
}
/** Phone: put the bottom drawer away (the panels stay mounted; the desktop's open / closed is not touched). */
export const hideSheet = (): void => { if (useStore.getState().sheetAt) useStore.setState({ sheetAt: 0 }); };

export const useStore = create<State>((set, get) => ({
  connected: false,
  sessions: [],
  open: {},
  activeId: deriveActive(initialLayoutState),
  tab: 'chat',
  panels: initialLayoutState.dock.tabs,
  layout: initialLayoutState,
  dispatchLayout(a) {
    const meta: LayoutActionMeta = actionSince === undefined ? {} : { since: actionSince };
    for (const f of layoutWatchers) f(a, meta);
    const prev = get().layout;
    let next = layoutReducer(prev, a);
    if (get().mobile) {
      // the phone's drawer is never minimised (Dock derives it) and does not un-minimise the desktop's panel either
      if (prev.dock.minimized && !next.dock.minimized) next = { ...next, dock: { ...next.dock, minimized: true } };
      // bringing a panel forward brings the drawer up
      const up = a.t === 'dock.show' || (a.t === 'dock.set' && a.patch.open === true) || (a.t === 'dock.toggle' && next.dock.open && next.dock.active === a.panel);
      if (up) set({ sheetAt: Date.now() });
    }
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
    // a second tab is fine without the workbench setting: the tab strip shows up by itself (chromeVisibility)
    get().dispatchLayout({ t: 'tile.open', paneId: paneId ?? g.focusedPaneId, tile, mode });
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
  mobile: typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(MOBILE_QUERY).matches,
  sheetAt: 0,
  inspect: null,
  // cached resolved theme until meta.json arrives; a first run follows the system (spec §6: default = 跟随系统)
  theme: (localStorage.getItem('cw.theme') as Theme) || resolveTheme(DEFAULT_THEME),
  toasts: [],
  workspaces: [],
  sessionMeta: {},
  schedules: [],
  limits: null,
  auth: null,
  async checkAuth(force = false) {
    const a = await ws.request<AccountAuth | null>({ kind: 'config.auth', force });
    if (isAuthAnswer(a)) set({ auth: a });
    return a ?? null;
  },
  attnDismissed: {},
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
    if (key.startsWith('ui.')) { applyUiSettings(get().settings); if (key === 'ui.theme') get().setTheme(resolveTheme((value as any) ?? DEFAULT_THEME), true); }
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
    // one-time: ui.singleWindow → ui.workbench, decided from the layout this window started with
    const saved = loadedLayout.saved ? initialLayoutState : null;
    const wb = migrateWorkbench(settings, saved);
    if (wb !== undefined) {
      // someone who knew the old screen and now lands on the quiet one hears once where the tools went
      const notice = needsSimplifiedNotice(settings, saved, wb);
      settings['ui.workbench'] = wb;
      void ws.request({ kind: 'settings.set', key: 'ui.workbench', value: wb }).catch(() => {});
      if (notice) {
        settings[SIMPLIFIED_NOTICE_KEY] = true;
        void ws.request({ kind: 'settings.set', key: SIMPLIFIED_NOTICE_KEY, value: true }).catch(() => {});
        get().toast(SIMPLIFIED_NOTICE, true, 12_000);
      }
    }
    set({ workspaces, sessionMeta, schedules, settings, metaLoaded: true });
    applyUiSettings(settings);
    get().setTheme(resolveTheme((settings['ui.theme'] as any) ?? DEFAULT_THEME), true);
  },
  async addWorkspace(path) {
    await ws.request({ kind: 'workspaces.add', path });
    await get().loadMeta();
  },
  async setSessionMeta(sessionId, patch) {
    set((s) => ({ sessionMeta: { ...s.sessionMeta, [sessionId]: { ...s.sessionMeta[sessionId], ...patch } } }));
    await ws.request({ kind: 'session.setMeta', sessionId, patch });
  },
  toast(text, ok, ms = 5000) {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts, { id, text, ok }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
  },

  init() {
    // Everything broadcast while the socket was down is gone (state changes, stream events, permission
    // resolutions). Without this a turn that finished during the outage leaves the session "running"
    // forever: queued messages never flush and the composer keeps queueing instead of sending.
    const resyncOpenSessions = async () => {
      await get().refreshSessions().catch(() => {}); // loadHistory reads `live` from the list
      for (const o of Object.values(get().open)) {
        if (o.state === 'history') continue;
        let d: { info: SessionInfoSnapshot; pending: PermissionRequestEvent[] };
        try {
          d = await ws.request({ kind: 'session.info', sessionId: o.sessionId });
        } catch {
          set((s) => bump(s, o.sessionId, (x) => { x.state = 'history'; x.pending = []; }));
          continue;
        }
        set((s) => bump(s, o.sessionId, (x) => { x.info = d.info; x.pending = d.pending ?? []; if (d.info?.state) x.state = d.info.state; }));
        // rebuild the conversation from the transcript (missed events), then flush the queue if the turn ended meanwhile
        await get().loadHistory(o.sessionId, { focus: false }).catch(() => {});
        const cur = get().open[o.sessionId];
        if (cur && cur.state === 'idle' && cur.queue.length) {
          const next = cur.queue[0];
          set((s) => bump(s, o.sessionId, (x) => { x.queue = x.queue.filter((q) => q.id !== next.id); }));
          void get().send(o.sessionId, next.text, next.images, false, next.attachments).catch(() => {});
        }
      }
    };
    ws.onStatus = (c) => {
      set({ connected: c });
      if (c) {
        void get().refreshSessions();
        void get().loadMeta();
        void get().loadEngine().catch(() => {});
        void get().loadProviders().catch(() => {});
        void get().loadAgents().catch(() => {});
        void get().loadLibrarySources().catch(() => {});
        void ws.request<Limits>({ kind: 'limits.get' }).then((limits) => set({ limits })).catch(() => {});
        // a failed check keeps the last answer (a reconnect must not turn a signed-in account into 「未登录」); with
        // none yet the row stops waiting and shows what it can
        void get().checkAuth().catch(() => null).then(() => { if (!get().auth) set({ auth: { loggedIn: false } }); });
        // re-attach open live sessions after reconnect
        void resyncOpenSessions();
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
          if (desktop && e.state === 'idle' && prev === 'running' && !document.hasFocus()) desktop.notify(get().sessions.find((x) => x.sessionId === e.sessionId)?.title ?? '对话', 'Claude 完成了这一轮', e.sessionId);
          set((s) => bump(s, e.sessionId, (o) => { o.state = e.state; if (e.error) o.error = e.error; if (e.state === 'idle' && o.queue.length) { const next = o.queue.shift()!; void get().send(e.sessionId, next.text, next.images, false, next.attachments); } }));
          set((s) => ({ sessions: s.sessions.map((x) => (x.sessionId === e.sessionId ? { ...x, live: e.state === 'closed' ? undefined : e.state } : x)) }));
          break;
        }
        case 'session.info':
          set((s) => bump(s, e.info.sessionId, (o) => { o.info = e.info; if (!o.cwd && e.info.cwd) o.cwd = e.info.cwd; }));
          break;
        case 'permission.request':
          set((s) => bump(s, e.request.sessionId, (o) => { if (!o.pending.some((p) => p.requestId === e.request.requestId)) o.pending.push(e.request); }));
          if (desktop) {
            const title = get().sessions.find((x) => x.sessionId === e.request.sessionId)?.title ?? '对话';
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
        case 'library.changed': {
          // an open session that was listed before and is gone afterwards was deleted (here or elsewhere)
          const before = new Set(get().sessions.map((s) => s.sessionId));
          void Promise.all([get().refreshSessions(), get().loadLibrarySources().catch(() => {})]).then(() => {
            const after = new Set(get().sessions.map((s) => s.sessionId));
            // only trust the absence when the session's source listed cleanly: a source that was just left, or one
            // whose listing failed (the server then serves a stale / partial cache), is not evidence of a deletion
            const listedOk = (id: string) => get().librarySources.some((x) => x.kind === parseLibraryId(id).kind && x.joined && x.enabled && !x.error);
            const gone = Object.keys(get().open).filter((id) => before.has(id) && !after.has(id) && listedOk(id));
            if (gone.length) get().markDeleted(gone);
          }).catch(() => {});
          break;
        }
        case 'library.discovered':
          // the sidebar banner reads detected && !joined && !dismissed from the sources
          void get().loadLibrarySources().catch(() => {});
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
    const sessions = await ws.request<SessionSummary[]>({ kind: 'sessions.list' });
    // a session marked deleted that is listed again (a transient listing gap, a source re-joined) is not deleted
    const back = (sessions ?? []).filter((x) => get().deletedSessions[x.sessionId]).map((x) => x.sessionId);
    if (back.length) {
      const d = { ...get().deletedSessions };
      for (const id of back) delete d[id];
      set({ sessions, deletedSessions: d });
    } else set({ sessions });
    // an open conversation that was opened before the list had it (a goal's new conversation) takes its folder now
    for (const x of sessions ?? []) {
      const o = get().open[x.sessionId];
      if (o && !o.cwd && x.cwd) set((s) => bump(s, x.sessionId, (y) => { if (!y.cwd) y.cwd = x.cwd; }));
    }
  },

  async openSession(p0, target) {
    // a brand-new conversation (sidebar 新建 / worktree, Git view, board…) starts in 「新对话默认权限」 unless the
    // caller chose one — resumes, forks and reopens keep their own (they carry a sessionId)
    const p = withDefaultMode(p0, get().settings);
    const sentAt = Date.now();
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
    const worktree = p.worktree ?? (existing ? existing.worktree : undefined);
    const o: OpenSession = { sessionId: r.sessionId, cwd: p.cwd, ...(worktree ? { worktree } : {}), conv, version: (existing?.version ?? 0) + 1, state: r.info.state, info: r.info, pending: r.pending, loading: false, queue: existing?.queue ?? [], draft: existing?.draft ?? '', feedback: existing?.feedback ?? {}, contextUsage: existing?.contextUsage, lastSent: existing?.lastSent };
    set((s) => {
      const open = { ...s.open };
      if (p.sessionId && p.sessionId !== r.sessionId && !p.fork && !p.resumeAt) delete open[p.sessionId];
      open[r.sessionId] = o;
      return { open };
    });
    // place it in the workbench: a specific tile (welcome composer), the focused pane, or nowhere (background).
    // It is the answer to a request: what the user opened meanwhile (the automation page, the phone's drawer) stays
    answering(sentAt, () => {
      if (target && target !== 'none') get().dispatchLayout({ t: 'session.assign', paneId: target.paneId, tileId: target.tileId, sessionId: r.sessionId });
      else if (target !== 'none') get().openInPane(r.sessionId, p.fork || p.resumeAt ? 'tab' : 'replace');
    });
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
    // interrupt() clears the queue (that is what Stop means); here only the chosen message jumps ahead, the rest stay queued
    const rest = get().open[sessionId]?.queue ?? [];
    await get().interrupt(sessionId);
    // the runner flips to idle after the interrupt lands; queue the message at the front so the idle handler sends it.
    // If the idle already arrived while we awaited, nothing would ever pick it up — send it now instead.
    const o = get().open[sessionId];
    if (o && o.state !== 'running' && o.state !== 'waiting') {
      set((s) => bump(s, sessionId, (x) => { x.queue = [...rest, ...x.queue]; }));
      await get().send(sessionId, q.text, q.images, false, q.attachments);
      return;
    }
    set((s) => bump(s, sessionId, (x) => { x.queue = [q, ...rest, ...x.queue]; }));
  },

  async editAndResend(sessionId, userItemId, text) {
    const o = get().open[sessionId];
    if (!o) return;
    const anchor = findChainUuidBefore(o.conv, userItemId);
    if (anchor === undefined) throw new Error('找不到这条消息');
    const orig = o.conv.items.find((i) => i.id === userItemId);
    const atts = orig?.kind === 'user' ? orig.attachments?.filter((a) => a.path).map((a) => ({ kind: a.kind, name: a.name, path: a.path, size: a.size })) : undefined;
    // the copy starts as the conversation would go on (re-review M-1): its live settings, or its chips' picks
    const meta = get().sessionMeta[sessionId];
    const carry = forkCarry(sessionId);
    if (anchor === null) {
      // first message: brand-new session in the same directory with the same settings (and the provider its chip shows)
      const id = await get().openSession({ cwd: o.cwd, ...carry, providerId: carry.providerId ?? (parsePeerId(sessionId) ? undefined : resumeView(o, meta).providerId) });
      await get().send(id, text, undefined, false, atts as AttachmentRef[] | undefined);
      return;
    }
    const id = await get().openSession({ sessionId, cwd: o.cwd, resumeAt: anchor, ...carry });
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
    // an open conversation never keeps an empty folder once one is known: a resume would start it in the server's
    // own directory (the list, the caller's hint, later `session.info` / the refreshed list fill it)
    const cwdKnown = meta?.cwd || opts?.cwd || '';
    if (!cur) set((s) => ({ open: { ...s.open, [sessionId]: { sessionId, cwd: cwdKnown, conv: createConversation(), version: 0, state: 'history', pending: [], loading: true, queue: [], draft: '', feedback: {} } } }));
    else set((s) => bump(s, sessionId, (o) => { o.loading = true; o.loadError = undefined; if (!o.cwd && cwdKnown) o.cwd = cwdKnown; }));
    if (opts?.focus !== false) get().openInPane(sessionId, opts?.mode ?? 'replace');
    void get().loadFeedback(sessionId);
    if (!cur) void get().loadDraft(sessionId).then((d) => d && set((s) => bump(s, sessionId, (o) => { if (!o.draft) o.draft = d; })));
    try {
      // imported sessions page through library.read (transcript.load would give the newest page but no cursor)
      let msgs: any[];
      let cursor: string | undefined;
      if (isImportedSessionId(sessionId)) {
        const r = await ws.request<{ messages: any[]; next?: string }>({ kind: 'library.read', sessionId });
        msgs = r?.messages ?? [];
        cursor = r?.next || undefined;
      } else msgs = await ws.request<any[]>({ kind: 'transcript.load', sessionId });
      set((s) => bump(s, sessionId, (o) => {
        o.historyCursor = cursor;
        const conv = createConversation();
        applyTranscript(conv, msgs, { live: meta?.live === 'running' || meta?.live === 'waiting' });
        // re-apply live messages that arrived after spawn (they are also in transcript; duplicates are merged by id)
        o.conv = conv;
        o.loading = false;
      }));
      // a runner may already be alive for this session (e.g. page reload): re-attach so controls go live
      if (meta?.live && meta.live !== 'closed' && meta.live !== 'error') await get().openSession({ sessionId, cwd: meta.cwd }, 'none');
    } catch (e: any) {
      set((s) => bump(s, sessionId, (o) => { o.loading = false; o.loadError = e?.message ?? String(e); }));
    }
  },

  async loadOlder(sessionId) {
    const inflight = olderInflight.get(sessionId);
    if (inflight) return inflight;
    const cursor = get().open[sessionId]?.historyCursor;
    if (!cursor) return false;
    const p = (async () => {
      try {
        const r = await ws.request<{ messages: any[]; next?: string }>({ kind: 'library.read', sessionId, cursor });
        const next = r?.next || undefined;
        set((s) => bump(s, sessionId, (o) => {
          if (o.historyCursor !== cursor) return; // history was reloaded meanwhile — this page belongs to the old one
          prependTranscript(o.conv, r?.messages ?? []);
          o.historyCursor = next;
        }));
        return !!get().open[sessionId]?.historyCursor;
      } finally {
        olderInflight.delete(sessionId);
      }
    })();
    olderInflight.set(sessionId, p);
    return p;
  },

  librarySources: [],
  sourceFilter: 'all',
  setSourceFilter(k) {
    set({ sourceFilter: k });
  },
  async loadLibrarySources() {
    const librarySources = await ws.request<SourceStatus[]>({ kind: 'library.sources' });
    set({ librarySources: librarySources ?? [] });
  },
  deletedSessions: {},
  markDeleted(ids) {
    if (!ids.length) return;
    set((s) => ({ deletedSessions: { ...s.deletedSessions, ...Object.fromEntries(ids.map((id) => [id, true as const])) } }));
  },
  async libraryOp(op, payload) {
    // the server broadcasts library.changed afterwards, which refetches the session list
    return ws.request({ ...payload, kind: `library.${op}` } as any);
  },

  async send(sessionId, text, images, steer = false, attachments) {
    const o = get().open[sessionId];
    if (!o) return;
    if (o.state === 'history' || o.state === 'closed' || o.state === 'error') {
      // A reaped / crashed / history session reopens with what its chips show (final review §9 #1): the user's pick
      // there, else what it last had live (model, effort, permission mode, deep orchestration, features — without
      // them the resume silently fell back to the defaults), else its transcript's model and mode.
      await get().openSession({ sessionId, cwd: o.cwd, ...resumeParams(o, get().sessionMeta[sessionId]) }, 'none');
    }
    const cur = get().open[sessionId];
    if ((cur.state === 'running' || cur.state === 'waiting') && !steer) {
      set((s) => bump(s, sessionId, (x) => { x.queue.push({ id: genUuid(), text, images, attachments }); }));
      return;
    }
    // client-minted transcript uuid: the local echo id is the real fork / rewind anchor
    const uuid = genUuid();
    const shown = decodeAttachments(text);
    // uploaded files travel as refs (their markers are added server-side); session references are in the text
    const echoed = [...(attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, path: a.path, size: a.size })), ...(attachments?.length ? shown.attachments.filter((a) => a.kind === 'session') : shown.attachments)];
    const echoAttachments = echoed.length ? echoed : undefined;
    set((s) => bump(s, sessionId, (x) => {
      x.conv.items.push({ kind: 'user', id: uuid, ts: new Date().toISOString(), text: shown.text, images: (images ?? []).map((im) => `data:${im.mediaType};base64,${im.data}`), attachments: echoAttachments, meta: false });
      x.state = 'running';
      x.lastSent = { id: uuid, text, images, attachments };
      x.conv.lastEventAt = Date.now();
      // the SDK never echoes the user message, so applyUser never stamps the turn start for a live send —
      // without this the run card's clock restarts on every event (a steer joins the turn already running)
      if (!steer || !x.conv.turnStartedAt) x.conv.turnStartedAt = Date.now();
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
    try {
      await ws.request({ kind: 'permission.respond', requestId, response });
    } catch (e: any) {
      // answered elsewhere (IM, another window) or the runner is gone, and the resolved event was missed:
      // drop the card instead of leaving buttons that can never succeed
      if (/not found/i.test(e?.message ?? '')) set((s) => { const out = { ...s.open }; for (const [id, o] of Object.entries(out)) if (o.pending.some((p) => p.requestId === requestId)) out[id] = { ...o, pending: o.pending.filter((p) => p.requestId !== requestId), version: o.version + 1 }; return { open: out }; });
      get().toast(e?.message ?? String(e));
    }
  },

  setActive(id) {
    get().openInPane(id, 'replace');
  },
  togglePanel(p) {
    // without the workbench tools the four fixed tabs (审阅 / 文件 / 终端 / 任务) are hidden, never closed
    const workbench = get().settings['ui.workbench'] === true;
    const st = get();
    if (st.mobile) {
      // a phone's right panel is the bottom drawer: a panel is in view only while the drawer is up, and hiding it
      // puts the drawer away (the desktop's dock.open stays as it was)
      const up = st.sheetAt > 0 && st.layout.dock.open;
      const effect = up ? panelToggleEffect({ ...st.layout.dock, minimized: false }, p, workbench) : 'show';
      if (effect === 'show') return get().dispatchLayout({ t: 'dock.show', panel: p });
      if (effect === 'hide') return hideSheet();
    }
    get().dispatchLayout({ t: 'dock.toggle', panel: p, workbench });
  },
  setTab(tab) {
    set({ tab });
  },
  setResume(sessionId, patch) {
    set((s) => bump(s, sessionId, (o) => { o.resume = { ...o.resume, ...patch }; }));
  },

  setDraft(sessionId, draft) {
    // never create a half-formed entry (no conv / state) for a session that is not open
    set((s) => (s.open[sessionId] ? { open: { ...s.open, [sessionId]: { ...s.open[sessionId], draft } } } : {}));
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
    // the desktop caption-button colours follow the theme AND what sits in the top-right corner: App's useTitleBarColors
  },
  async forkAt(sessionId: string, messageUuid: string) {
    const o = get().open[sessionId];
    if (!o) return;
    await get().openSession({ sessionId, cwd: o.cwd, resumeAt: messageUuid, ...forkCarry(sessionId) });
  },
}));

/**
 * What a fork of this conversation starts with, from whichever entry (a message's 分叉, the palette's
 * 「从这里分叉当前对话」, the sidebar's 分叉 — re-review m-4 — and edit-and-resend / rerun): `forkParams` of it as this
 * window has it (its live settings, or its chips' picks); nothing when it is not open here (the server takes the
 * original's record).
 */
export function forkCarry(sessionId: string): ReturnType<typeof forkParams> {
  const st = useStore.getState();
  const o = st.open[sessionId];
  return o ? forkParams(o, st.sessionMeta[sessionId]) : {};
}

// following the system: an OS light / dark switch also updates the cached theme and the desktop title bar colours
setSystemThemeHandler((t) => useStore.getState().setTheme(t, true));

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
