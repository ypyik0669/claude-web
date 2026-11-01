import { create } from 'zustand';
import { readView, VIEW_KEY } from '@/features/sidebar/view';
import type { RoutedInfo, AgentInfo, AgentKind, AttachmentRef, EffortLevel, EngineInfo, Limits, MessageFeedback, PermissionMode, Provider, SessionEnv, SessionFeatures, PermissionRequestEvent, RunnerState, Schedule, ServerEvent, SessionInfoSnapshot, SessionMeta, SessionSummary, SourceStatus, Workspace } from '@shared';
import { withDefaultMode } from './default-mode';
import { decodeAttachments, findChainUuidBefore, isPrompt } from '@/model/conversation';
import { activeGroup, chatTile, deriveActive, hasLegacyLayout, initialLayout, layoutReducer, migrateLegacy, migrateWorkbench, needsSimplifiedNotice, panelToggleEffect, sanitizeLayout, SIMPLIFIED_NOTICE_KEY, type LayoutAction, type LayoutState, type Tile } from '@/model/layout';
import { PaneContext, winId } from './paneContext';
import { useContext } from 'react';
import { isAuthAnswer, type AccountAuth } from './auth';
import { withExplanation } from '@errors';
export type { AccountAuth } from './auth';

export const THEMES = ['dark', 'light', 'dracula', 'nord', 'tokyo-night', 'paper'] as const;
export type Theme = (typeof THEMES)[number];
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { applyMessage, applyTranscript, createConversation, prependTranscript, walkTools, type Conversation } from '@/model/conversation';
import { staleStopResult, stopFoundNothing } from './stop';
import { EXTERNAL_LIVE_MS, externalLive, nextReadAt, readsFromOutside, shownSessions } from './external';
import { isImportedSessionId } from '@/util';
import { forkParams, mergeResume, resumeParams, resumeView, type ResumeChoice } from './reopen';
import { parseLibraryId, parsePeerId } from '@shared';
import { dlg } from '@/ui/dialog';
import { DEFAULT_THEME, applyUiSettings, resolveTheme, setSystemThemeHandler } from '@/features/settings/ui-settings';
import { PERMISSION_MODES, SIMPLIFIED_NOTICE } from '@/ui/terms';
import { MOBILE_QUERY } from '@/ui/viewport';
import type { SheetDetent } from '@/ui/sheet-snap';
import { haptic } from '@/ui/haptics';
import { onTurnEndAutoOpen, paneShowing } from '@/features/browser/auto-open';
import { onTurnEndAutoVerify } from '@/features/browser/auto-verify';
import { pageOf } from '@/features/browser/guest';
import { guestElOf } from '@/features/browser/state';
import type { PendingBundle } from '@/model/attachments';
import { LANGUAGE_KEY, reconcileLanguage, tr } from '@/i18n';

/** 后台 fills this in (features/background/state.ts — it imports the store, not the other way round): what kept running after the turn's Stop. */
let bgStopNote: (sessionId: string) => string | null = () => null;
export function setBgStopNote(fn: (sessionId: string) => string | null): void { bgStopNote = fn; }

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
  /** how many of those bumps were a frame of streamed deltas only (renderStreamed): `version - streamed` moves only
   *  for whole messages and other changes — what an earlier, finished turn can be affected by */
  streamed?: number;
  state: RunnerState | 'history';
  info?: SessionInfoSnapshot;
  pending: PermissionRequestEvent[];
  error?: string;
  loading: boolean;
  queue: QueuedMessage[]; // messages typed while running
  draft: string;
  feedback: Record<string, MessageFeedback>; // messageId -> rating (meta.json)
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
  /** not running here and its record changed from outside (a CLI in a terminal, Codex): when (store/external.ts) */
  externalAt?: number;
  /** …while it was not on screen: re-read when it is shown */
  staleHistory?: boolean;
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
  /**
   * Phone: how tall that drawer stands — 半 (62% of the room above the keyboard) or 全 (92%); a drag or a tap on its
   * handle changes it (`ui/phone-sheet.ts`). Not persisted; 半 again whenever the drawer is put away.
   */
  sheetDetent: SheetDetent;
  inspect: { sessionId: string; toolUseId?: string; file?: { path: string; line?: number } } | null;
  theme: Theme;
  toasts: { id: number; text: string; ok?: boolean; key?: string }[];
  /** `key`: a toast with the same key that is still up is rewritten in place (and stays its `ms` from now) instead of stacking another */
  toast(text: string, ok?: boolean, ms?: number, key?: string): void;
  workspaces: Workspace[];
  sessionMeta: Record<string, SessionMeta>;
  /**
   * The server's answer to session.resumeMode per conversation: the permission mode a resume that names none runs in
   * (its record, else 新对话默认权限). The chip of a conversation that is not running shows it over this window's copy
   * of the record (2026-10-26 QA). Absent = not asked yet, or an older server.
   */
  resumeModes: Record<string, PermissionMode>;
  /** 智能路由: the model each conversation on a routing group last really got (gateway.routed) — 「自动 → 实际：…」 */
  routed: Record<string, RoutedInfo>;
  loadResumeMode(sessionId: string): Promise<void>;
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
  /** 显示已归档的对话 (the 显示 menu, the palette, the home page): kept in meta.json with the sidebar's view (stage C3) */
  setShowArchived(v: boolean): void;
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
  openTile(tile: Tile, mode?: 'replace' | 'tab' | 'background', paneId?: string): void;
  /** close a tile; asks first when it is an editor with unsaved changes */
  closeTile(paneId: string, tileId: string): Promise<void>;
  dirtyDocs: Record<string, boolean>; // doc tile id -> unsaved
  setDocDirty(tileId: string, dirty: boolean): void;
  loadMeta(): Promise<void>;
  /** ~/.claude-web/custom.css (GitHub issue #2): read on connect and whenever it is saved */
  customCss: { path: string; exists: boolean; css: string; size: number; mtime: number; error?: string } | null;
  loadCustomCss(): Promise<void>;
  addWorkspace(path: string): Promise<void>;
  /** Put the projects in this order (the sidebar's drag, 上移 / 下移): shown at once, saved on the server. */
  reorderWorkspaces(ids: string[]): Promise<void>;
  /** A project's name / extra folders (stage C2); throws the server's refusal (a folder that does not exist) after a toast. */
  updateWorkspace(id: string, patch: { name?: string; folders?: string[]; instructions?: string | null; sessionsScope?: 'project' | null; permissionMode?: PermissionMode | null }): Promise<void>;
  setSessionMeta(sessionId: string, patch: SessionMeta): Promise<void>;
  // actions
  init(): void;
  refreshSessions(): Promise<void>;
  openSession(p: { sessionId?: string; peer?: string; cwd: string; env?: SessionEnv; model?: string; permissionMode?: PermissionMode; expectMode?: PermissionMode; effort?: EffortLevel; ultracode?: boolean; subagentModel?: string; fork?: boolean; resumeAt?: string; worktree?: string; providerId?: string; features?: SessionFeatures; agent?: AgentKind }, target?: { paneId: string; tileId: string } | 'none'): Promise<string>;
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
  /** `transcripts.changed`: open conversations that are not running here re-read what the CLI / Codex wrote */
  externalChanged(sessionIds: string[]): void;
  /** re-read one such conversation now (throttled callers: externalChanged; the chat tile when a stale one is shown) */
  refreshExternal(sessionId: string): Promise<void>;
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
  /**
   * `opts.expectMode`: the permission mode the chip of a conversation that is not running shows (发送前核对权限). When
   * the server would resume it in another one, nothing is sent: the chip is updated and a ModeChangedError is thrown.
   */
  send(sessionId: string, text: string, images?: { mediaType: string; data: string }[], steer?: boolean, attachments?: AttachmentRef[], opts?: { expectMode?: PermissionMode }): Promise<void>;
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
  interrupt(sessionId: string): Promise<void>;
  respondPermission(requestId: string, response: any): Promise<void>;
  loadSubagent(sessionId: string, toolUseId: string): Promise<void>;
  setActive(id: string | null): void;
  togglePanel(p: PanelId): void;
  setTab(t: 'chat' | 'trajectory'): void;
  setDraft(sessionId: string, d: string): void;
  /**
   * Attachments handed to a conversation's composer from elsewhere (the browser's 页面标注), waiting until a composer
   * of that conversation is on screen and takes them (`takeComposerAttachments`). Not persisted.
   */
  composerInbox: Record<string, PendingBundle[]>;
  addComposerAttachment(sessionId: string, b: PendingBundle): void;
  /** what waits for `sessionId`, now taken out of the inbox (the composer keeps it from here on) */
  takeComposerAttachments(sessionId: string): PendingBundle[];
  /** a conversation that is not running: remember a pick on its chips for the send that resumes it */
  setResume(sessionId: string, patch: ResumeChoice): void;
  /** 子代理: the model the conversation's subagents run on ('' = the main model), picked for `providerId` */
  setSubagentModel(sessionId: string, model: string, providerId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  setTheme(t: Theme, fromSettings?: boolean): void;
  forkAt(sessionId: string, messageUuid: string): Promise<void>;
  onTurnEnd(sessionId: string): void;
}

const olderInflight = new Map<string, Promise<boolean>>();
// outside writes (store/external.ts): pending re-read, in flight, asked again while in flight, last read, settle timer
const extTimers = new Map<string, ReturnType<typeof setTimeout>>();
const extInflight = new Set<string>();
const extAgain = new Set<string>();
const extLast = new Map<string, { start: number; ms: number }>();
const extSettle = new Map<string, ReturnType<typeof setTimeout>>();
/**
 * What the last read of a conversation held (message count + newest uuid). A change on disk only counts as a turn
 * written elsewhere when the next read holds more: the CLI's own bookkeeping lines (last-prompt, cost-state, a title)
 * written as a process of ours exits used to light 「正在别处更新」 for nothing (2026-10-14, a user's friend).
 */
const extSeen = new Map<string, string>();
const seenOf = (msgs: any[]) => `${msgs.length}:${msgs[msgs.length - 1]?.uuid ?? ''}`;

/**
 * The newest page of a conversation: imported ones page through library.read; ours through transcript.load
 * `page: true` — a long conversation comes in the size the connection can take (a phone on the slow relay waited
 * minutes on 「加载历史…」 for one of several MB), the rest behind 「加载更早的记录」. A server that does not page
 * answers with the whole array.
 */
async function firstPage(sessionId: string): Promise<{ msgs: any[]; cursor?: string }> {
  if (isImportedSessionId(sessionId)) {
    const r = await ws.request<{ messages: any[]; next?: string }>({ kind: 'library.read', sessionId });
    return { msgs: r?.messages ?? [], cursor: r?.next || undefined };
  }
  const r = await ws.request<any[] | { messages: any[]; next?: string }>({ kind: 'transcript.load', sessionId, page: true });
  return Array.isArray(r) ? { msgs: r } : { msgs: r?.messages ?? [], cursor: r?.next ? `${TL_CURSOR}${r.next}` : undefined };
}
/** A cursor of ours (transcript.load), told apart from the library's. */
const TL_CURSOR = 'tl:';
/** This window's own process just stopped: the next read is a starting point, not a turn written elsewhere. */
const extRebase = new Set<string>();
/**
 * Everything on disk is what ran here when our own process stops — read it as the starting point, so neither a
 * conversation started in this window nor the turns that ran here light 「正在别处更新」 once the CLI writes its
 * bookkeeping at exit (the verification of 2026-10-15 caught both). A read that fails leaves the mark: the next read
 * is the starting point then.
 */
function rebaseExt(sessionId: string) {
  extRebase.add(sessionId);
  void firstPage(sessionId).then(({ msgs }) => { if (extRebase.delete(sessionId)) extSeen.set(sessionId, seenOf(msgs)); }, () => {});
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
    st.toast(tr('额度已恢复，自动继续上一条消息'), true);
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

/** a fresh conversation; a 值班 Bot's own one (SessionMeta.botRole, the bots page marks it as it opens) hides the server's blocks */
export function botConv(s: Pick<State, 'sessionMeta'>, sessionId: string): Conversation {
  return createConversation({ botThread: s.sessionMeta?.[sessionId]?.botRole === 'thread' });
}

function bump(s: State, id: string, fn: (o: OpenSession) => void): Partial<State> {
  const o = s.open[id];
  if (!o) return {};
  fn(o);
  unrendered.delete(id); // a render takes the deltas applied so far along
  return { open: { ...s.open, [id]: { ...o, version: o.version + 1 } } };
}

/** Conversations with streamed deltas applied to `conv` (in place) but not rendered yet: the next frame renders them. */
const unrendered = new Set<string>();
let frameAsked = false;
function askFrame() {
  if (frameAsked) return;
  frameAsked = true;
  // a hidden window gets no frames: its deltas wait in `conv` and show with the next frame or the next whole message
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(renderStreamed);
  else setTimeout(renderStreamed, 16);
}
function renderStreamed() {
  frameAsked = false;
  if (!unrendered.size) return;
  const ids = [...unrendered];
  unrendered.clear();
  useStore.setState((s) => {
    const open = { ...s.open };
    for (const id of ids) if (open[id]) open[id] = { ...open[id], version: open[id].version + 1, streamed: (open[id].streamed ?? 0) + 1 };
    return { open };
  });
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
export const hideSheet = (): void => { if (useStore.getState().sheetAt) useStore.setState({ sheetAt: 0, sheetDetent: 'half' }); };

/** When each toast goes: a keyed one that is rewritten starts its time again. */
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
/**
 * 发送前核对权限: the send was refused because the conversation would resume in `mode`, not the one its chip showed.
 * The chip has been updated (resumeModes); the composer keeps the draft and says so.
 */
export class ModeChangedError extends Error {
  constructor(readonly mode: PermissionMode) {
    super(tr('这个对话的权限是「{label}」，已更新显示，请再发一次', { label: (PERMISSION_MODES[mode] ?? PERMISSION_MODES.default).label }));
    this.name = 'ModeChangedError';
  }
}

/** The latest session.resumeMode ask per conversation: an older reply that comes back later is dropped. */
const resumeModeSeq = new Map<string, number>();

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
    if (get().dirtyDocs[tileId] && !(await dlg.confirm(tr('这个文件有未保存的改动，确定关闭？'), { okLabel: tr('关闭'), danger: true }))) return;
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
  sheetDetent: 'half',
  inspect: null,
  // cached resolved theme until meta.json arrives; a first run follows the system (spec §6: default = 跟随系统)
  theme: (localStorage.getItem('cw.theme') as Theme) || resolveTheme(DEFAULT_THEME),
  toasts: [],
  workspaces: [],
  sessionMeta: {},
  resumeModes: {},
  routed: {},
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
  customCss: null,
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
    if (key === 'ui.softwareRender' && desktop?.setFlags) { void desktop.setFlags({ softwareRender: !!value }); get().toast(tr('重启应用后生效'), true); }
    await ws.request({ kind: 'settings.set', key, value });
    // the language is read when the page loads: the page loads again in the new one
    if (key === LANGUAGE_KEY) reconcileLanguage(value);
  },
  async loadCustomCss() {
    try {
      set({ customCss: await ws.request({ kind: 'ui.customCss' }) });
    } catch { /* an older server: no custom.css */ }
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
    set({ workspaces, sessionMeta, schedules, settings, metaLoaded: true, showArchived: readView(settings[VIEW_KEY]).show.archived });
    reconcileLanguage(settings[LANGUAGE_KEY]);
    applyUiSettings(settings);
    get().setTheme(resolveTheme((settings['ui.theme'] as any) ?? DEFAULT_THEME), true);
  },
  async reorderWorkspaces(ids) {
    const by = new Map(get().workspaces.map((w) => [w.id, w]));
    const next = ids.map((id, i) => by.get(id) && { ...by.get(id)!, order: i }).filter((w): w is Workspace => !!w);
    if (next.length === by.size) set({ workspaces: next });
    await ws.request({ kind: 'workspaces.reorder', ids }).catch((e) => { get().toast(e.message); void get().loadMeta(); });
  },
  setShowArchived(v) {
    set({ showArchived: v });
    const cur = readView(get().settings[VIEW_KEY]);
    void get().setSetting(VIEW_KEY, { ...cur, show: { ...cur.show, archived: v } });
  },
  async updateWorkspace(id, patch) {
    try {
      const w = await ws.request<Workspace>({ kind: 'workspaces.update', id, ...patch });
      set({ workspaces: get().workspaces.map((x) => (x.id === id ? w : x)) });
    } catch (e: any) {
      get().toast(e.message);
      void get().loadMeta();
      throw e;
    }
  },
  async addWorkspace(path) {
    await ws.request({ kind: 'workspaces.add', path });
    await get().loadMeta();
  },
  async loadResumeMode(sessionId) {
    // replies can come back out of order (a refetch right after the first ask): only the latest ask's answer counts
    const seq = (resumeModeSeq.get(sessionId) ?? 0) + 1;
    resumeModeSeq.set(sessionId, seq);
    const r = await ws.request<{ permissionMode?: PermissionMode } | null>({ kind: 'session.resumeMode', sessionId }).catch(() => null);
    if (resumeModeSeq.get(sessionId) !== seq) return;
    const mode = r?.permissionMode;
    if (get().resumeModes[sessionId] === mode) return;
    set((s) => {
      const next = { ...s.resumeModes };
      if (mode) next[sessionId] = mode; else delete next[sessionId];
      return { resumeModes: next };
    });
  },
  async setSessionMeta(sessionId, patch) {
    set((s) => ({ sessionMeta: { ...s.sessionMeta, [sessionId]: { ...s.sessionMeta[sessionId], ...patch } } }));
    await ws.request({ kind: 'session.setMeta', sessionId, patch });
  },
  toast(text, ok, ms = 5000, key) {
    const up = key ? get().toasts.find((t) => t.key === key) : undefined;
    const id = up?.id ?? Date.now() + Math.random();
    // a failure we recognise gets its Chinese explanation on top, the original underneath (@errors) — and time to read it
    if (!ok) {
      const told = withExplanation(text);
      if (told !== text) { text = told; ms = Math.max(ms, 10_000); }
    }
    set((s) => ({ toasts: up ? s.toasts.map((t) => (t.id === id ? { ...t, text, ok } : t)) : [...s.toasts, { id, text, ok, key }] }));
    clearTimeout(toastTimers.get(id));
    toastTimers.set(id, setTimeout(() => { toastTimers.delete(id); set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })); }, ms));
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
        void get().loadCustomCss();
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
        case 'session.event': {
          // a delta goes into the conversation now and is rendered with the next frame: one render per delta was
          // 10–33 ms, and a model streaming a token per delta (DeepSeek) left the window minutes behind the relay
          if ((e.message as any)?.type === 'stream_event') {
            const o = get().open[e.sessionId];
            if (!o) break;
            applyMessage(o.conv, e.message);
            unrendered.add(e.sessionId);
            askFrame();
            break;
          }
          set((s) => bump(s, e.sessionId, (o) => applyMessage(o.conv, e.message)));
          if ((e.message as any)?.type === 'result') get().onTurnEnd(e.sessionId);
          break;
        }
        case 'session.state': {
          const prev = get().open[e.sessionId]?.state;
          if (desktop && e.state === 'idle' && prev === 'running' && !document.hasFocus()) desktop.notify(get().sessions.find((x) => x.sessionId === e.sessionId)?.title ?? tr('对话'), tr('Claude 完成了这一轮'), e.sessionId);
          set((s) => bump(s, e.sessionId, (o) => { o.state = e.state; if (e.error) o.error = e.error; if (e.state === 'idle' && o.queue.length) { const next = o.queue.shift()!; void get().send(e.sessionId, next.text, next.images, false, next.attachments); } }));
          set((s) => ({ sessions: s.sessions.map((x) => (x.sessionId === e.sessionId ? { ...x, live: e.state === 'closed' ? undefined : e.state } : x)) }));
          break;
        }
        case 'session.info':
          set((s) => bump(s, e.info.sessionId, (o) => { o.info = e.info; if (!o.cwd && e.info.cwd) o.cwd = e.info.cwd; }));
          break;
        case 'permission.request':
          set((s) => bump(s, e.request.sessionId, (o) => { if (!o.pending.some((p) => p.requestId === e.request.requestId)) o.pending = [...o.pending, e.request]; }));
          if (desktop) {
            const title = get().sessions.find((x) => x.sessionId === e.request.sessionId)?.title ?? tr('对话');
            const body = e.request.toolName === 'AskUserQuestion' ? tr('Claude 有问题要问你') : e.request.toolName === 'ExitPlanMode' ? tr('Claude 请求批准计划') : tr('需要权限：{toolName}', { toolName: e.request.toolName });
            desktop.notify(title, body, e.request.sessionId);
          }
          break;
        case 'permission.resolved':
          set((s) => { const out = { ...s.open }; for (const [id, o] of Object.entries(out)) if (o.pending.some((p) => p.requestId === e.requestId)) out[id] = { ...o, pending: o.pending.filter((p) => p.requestId !== e.requestId), version: o.version + 1 }; return { open: out }; });
          break;
        case 'gateway.routed': {
          const { kind: _k, ...info } = e;
          const prev = get().routed[e.sessionId];
          // only a change re-renders (every request of a turn reports)
          if (!prev || prev.model !== info.model || prev.label !== info.label || prev.switched !== info.switched || prev.policy !== info.policy) set((s) => ({ routed: { ...s.routed, [e.sessionId]: info } }));
          break;
        }
        case 'gateway.promptHeavy':
          // Gemini web / WorkBuddy re-send the whole prompt every turn and have a byte ceiling: past it the model
          // gets an attachment (slow) and eventually a truncated tail. Said once per conversation, server-side.
          get().toast(tr('「{title}」已经超过 {kb} KB。{via} 每轮都要重发整段对话，太长会先上传附件再回答，再长还会被截断。建议输入 /compact 或开一个新对话。', {
            title: get().sessions.find((x) => x.sessionId === e.sessionId)?.title ?? tr('这条对话'),
            kb: Math.round(e.bytes / 1024),
            via: e.via === 'workbuddy' ? 'WorkBuddy' : tr('Gemini 网页'),
          }));
          break;
        case 'sessions.changed':
          void get().refreshSessions();
          // another machine's meta.changed never reaches this window, its sessions.changed does: a chip that already
          // asked what a conversation will resume in asks again (a mode recorded over there shows here)
          for (const id of Object.keys(get().resumeModes)) void get().loadResumeMode(id);
          break;
        case 'transcripts.changed':
          get().externalChanged(e.sessionIds);
          break;
        case 'session.caughtUp': {
          // said in DeepSeek Harness since, now in this conversation: a view of it re-reads (not mid-turn: its events own it)
          const o = get().open[e.sessionId];
          if (o && !o.loading && o.state !== 'running' && o.state !== 'waiting') void get().loadHistory(e.sessionId, { focus: false }).catch(() => {});
          break;
        }
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
        case 'notice':
          // the server did something on its own (a scheduled catch-up run): say so, and to the OS when not looking
          get().toast(e.text, true, 6000);
          if (e.notify && desktop && !document.hasFocus()) desktop.notify('Claude Web', e.text, e.sessionId);
          break;
        case 'meta.changed':
          void get().loadMeta();
          void get().loadProviders().catch(() => {});
          break;
        case 'customCss.changed':
          void get().loadCustomCss();
          break;
        case 'agents.changed':
          void get().loadAgents().catch(() => {});
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
    const r = await ws.request<{ sessionId: string; info: SessionInfoSnapshot; history: any[]; pending: PermissionRequestEvent[]; caughtUp?: number; modeChanged?: PermissionMode }>({ kind: 'session.open', params: p });
    // 发送前核对权限: the server would resume it in another mode than the chip showed — nothing started
    if (r.modeChanged) {
      const sid = p.sessionId!;
      resumeModeSeq.set(sid, (resumeModeSeq.get(sid) ?? 0) + 1); // an older resumeMode reply must not put the old one back
      set((s) => ({ resumeModes: { ...s.resumeModes, [sid]: r.modeChanged! } }));
      throw new ModeChangedError(r.modeChanged);
    }
    const existing = p.sessionId && !p.fork && !p.resumeAt ? get().open[p.sessionId] : undefined;
    // it goes on under another id (a DeepSeek Harness conversation → the Claude conversation that replays it): its
    // tabs follow, and it shows that conversation's own transcript — its ids are the rewind / fork anchors now.
    // `caughtUp`: what was said in the harness since was added to its transcript — the history shown is old
    const moved = !!existing && r.sessionId !== p.sessionId;
    const reload = moved || (!!existing && !!r.caughtUp);
    const conv = existing && !reload ? existing.conv : botConv(get(), r.sessionId);
    if (existing && !reload) {
      // history already loaded from transcript; only apply live messages we have not seen
      // (runner history is replayed from spawn — transcript already contains them, so skip when history was loaded)
      if (!existing.conv.items.length) for (const m of r.history) applyMessage(conv, m);
    } else {
      for (const m of r.history) applyMessage(conv, m);
    }
    const worktree = p.worktree ?? (existing ? existing.worktree : undefined);
    const o: OpenSession = { sessionId: r.sessionId, cwd: p.cwd, ...(worktree ? { worktree } : {}), conv, version: (existing?.version ?? 0) + 1, state: r.info.state, info: r.info, pending: r.pending, loading: false, queue: existing?.queue ?? [], draft: existing?.draft ?? '', feedback: existing?.feedback ?? {}, lastSent: existing?.lastSent };
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
    if (reload) {
      if (moved) {
        get().dispatchLayout({ t: 'session.rekey', from: p.sessionId!, to: r.sessionId });
        // what the server recorded (sessionMeta is read once at start): send() catches the new one up from here on
        set((s) => ({ sessionMeta: { ...s.sessionMeta, [p.sessionId!]: { ...s.sessionMeta[p.sessionId!], continuedAs: r.sessionId }, [r.sessionId]: { ...s.sessionMeta[r.sessionId], continuedFrom: p.sessionId! } } }));
      }
      // awaited: a send right after this must land after the history, not under it
      await get().refreshSessions().catch(() => {});
      await get().loadHistory(r.sessionId, { focus: false });
    }
    // load transcript in the background for resumed / forked sessions with empty conv — placed where the open placed it:
    // 'none' stays out of the workbench (a bot's conversation lives in the Bot page; placing it here switched the
    // window to the chat section and hid the Bot page, 2026-11-01)
    if (p.sessionId && !existing) void get().loadHistory(r.sessionId, target === 'none' ? { focus: false } : undefined);
    if (p.fork || p.resumeAt) void get().refreshSessions();
    void get().loadFeedback(r.sessionId);
    return r.sessionId;
  },

  onTurnEnd(sessionId: string) {
    const o = get().open[sessionId];
    if (!o) return;
    const res = o.conv.lastResult;
    // auto-continue when a quota / throttle error ends the turn and the user opted in
    if (res?.isError && (res.errorKind === 'quota' || res.errorKind === 'throttled') && get().settings.autoContinueOnReset && o.lastSent) {
      const resetsAt = o.conv.rateLimit?.resetsAt;
      const at = resetsAt ? resetsAt * (resetsAt < 1e12 ? 1000 : 1) + 5000 : Date.now() + (res.errorKind === 'throttled' ? 60_000 : 30 * 60_000);
      armAutoContinue(sessionId, at);
    }
    // the last page / document / picture this turn wrote opens, when the conversation is on screen here
    try { onTurnEndAutoOpen(sessionId, get(), desktop); } catch { /* opening a preview never breaks the turn's end */ }
    // a turn that changed front-end files: the open preview reloads and its errors show under the turn (never sent)
    try {
      void onTurnEndAutoVerify(sessionId, { ...get(), shown: !!paneShowing(get().layout, sessionId) }, {
        canDebug: !!desktop?.guestDebug,
        pageOf,
        hasFocus: (tabId) => { const el = guestElOf(tabId); return !!el && document.activeElement === (el as unknown as Element) && document.hasFocus(); },
        launchUrls: async (cwd) => {
          const r = await ws.request<{ configs: { url?: string }[] } | null>({ kind: 'preview.list', cwd });
          return (r?.configs ?? []).map((c) => c.url ?? '').filter(Boolean);
        },
      }).catch(() => {});
    } catch { /* checking a preview never breaks the turn's end */ }
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
    // a bot's hidden kickoff / 「已批准」 is the server's, not something to edit
    if (o.conv.items.some((i) => i.id === userItemId && i.kind === 'user' && i.hidden)) return;
    const anchor = findChainUuidBefore(o.conv, userItemId);
    if (anchor === undefined) throw new Error(tr('找不到这条消息'));
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
    if (!o || it?.kind !== 'user' || it.hidden) return;
    // the last thing asked (a turn that failed, an answer to try again — user report: 重跑 opened a new conversation):
    // asked again right here. An earlier one would leave the turns after it behind, so that one still forks.
    if (isLastPrompt(o.conv.items, userItemId)) {
      const images = it.images.map(dataUrlImage).filter((x): x is { mediaType: string; data: string } => !!x);
      const atts = it.attachments?.filter((a) => a.path).map((a) => ({ kind: a.kind, name: a.name, path: a.path, size: a.size })) as AttachmentRef[] | undefined;
      await get().send(sessionId, it.text, images.length ? images : undefined, false, atts?.length ? atts : undefined);
      return;
    }
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
    if (!cur) set((s) => ({ open: { ...s.open, [sessionId]: { sessionId, cwd: cwdKnown, conv: botConv(get(), sessionId), version: 0, state: 'history', pending: [], loading: true, queue: [], draft: '', feedback: {} } } }));
    else set((s) => bump(s, sessionId, (o) => { o.loading = true; o.loadError = undefined; if (!o.cwd && cwdKnown) o.cwd = cwdKnown; }));
    if (opts?.focus !== false) get().openInPane(sessionId, opts?.mode ?? 'replace');
    void get().loadFeedback(sessionId);
    if (!cur) void get().loadDraft(sessionId).then((d) => d && set((s) => bump(s, sessionId, (o) => { if (!o.draft) o.draft = d; })));
    try {
      const { msgs, cursor } = await firstPage(sessionId);
      extSeen.set(sessionId, seenOf(msgs));
      set((s) => bump(s, sessionId, (o) => {
        o.historyCursor = cursor;
        const conv = botConv(get(), sessionId);
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

  externalChanged(sessionIds) {
    const shown = shownSessions(get().layout);
    const schedule = (id: string) => {
      if (extTimers.has(id)) return;
      const last = extLast.get(id);
      const wait = last ? Math.max(0, nextReadAt(last.start, last.ms) - Date.now()) : 0;
      extTimers.set(id, setTimeout(() => { extTimers.delete(id); void get().refreshExternal(id); }, wait));
    };
    for (const id of sessionIds) {
      const o = get().open[id];
      if (!o || !readsFromOutside(o)) continue;
      const on = shown.has(id);
      // live (externalAt) only once a read shows it holds more (refreshExternal)
      if (!on) set((s) => bump(s, id, (x) => { x.staleHistory = true; }));
      if (on) schedule(id);
      // once it has been quiet for the live window: one more read, so a finished turn stops looking like it runs
      const t = extSettle.get(id);
      if (t) clearTimeout(t);
      extSettle.set(id, setTimeout(() => {
        extSettle.delete(id);
        const cur = get().open[id];
        if (!cur || !readsFromOutside(cur)) return;
        if (shownSessions(get().layout).has(id)) schedule(id);
        else set((s) => bump(s, id, (x) => { x.staleHistory = true; }));
      }, EXTERNAL_LIVE_MS + 500));
    }
  },

  async refreshExternal(sessionId) {
    const o = get().open[sessionId];
    if (!o || !readsFromOutside(o) || o.loading) return;
    if (extInflight.has(sessionId)) { extAgain.add(sessionId); return; }
    extInflight.add(sessionId);
    const start = Date.now();
    try {
      const { msgs, cursor } = await firstPage(sessionId);
      // started here meanwhile: its own events own the view now
      const cur = get().open[sessionId];
      if (!cur || !readsFromOutside(cur) || cur.loading) return;
      const seen = seenOf(msgs);
      // no starting point yet, or our own process just stopped: this read is the starting point
      const base = extRebase.delete(sessionId) ? undefined : extSeen.get(sessionId);
      const grew = base !== undefined && base !== seen;
      extSeen.set(sessionId, seen);
      set((s) => bump(s, sessionId, (x) => {
        if (grew) x.externalAt = Date.now();
        const conv = botConv(get(), sessionId);
        applyTranscript(conv, msgs, { live: externalLive(x) });
        x.conv = conv;
        x.historyCursor = cursor;
        x.staleHistory = false;
        x.loadError = undefined;
      }));
    } catch {
      /* keep what is shown: the next write tries again (a thread that is gone leaves the list on its own) */
    } finally {
      extInflight.delete(sessionId);
      extLast.set(sessionId, { start, ms: Date.now() - start });
      if (extAgain.delete(sessionId)) get().externalChanged([sessionId]);
    }
  },

  async loadOlder(sessionId) {
    const inflight = olderInflight.get(sessionId);
    if (inflight) return inflight;
    const cursor = get().open[sessionId]?.historyCursor;
    if (!cursor) return false;
    const p = (async () => {
      try {
        const ours = cursor.startsWith(TL_CURSOR);
        const r = ours
          ? await ws.request<{ messages: any[]; next?: string }>({ kind: 'transcript.load', sessionId, page: true, cursor: cursor.slice(TL_CURSOR.length) })
          : await ws.request<{ messages: any[]; next?: string }>({ kind: 'library.read', sessionId, cursor });
        const next = r?.next ? (ours ? `${TL_CURSOR}${r.next}` : r.next) : undefined;
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

  async send(sessionId0, text, images, steer = false, attachments, opts) {
    let sessionId = sessionId0;
    const o = get().open[sessionId];
    if (!o) return;
    if (o.state === 'history' || o.state === 'closed' || o.state === 'error') {
      // A reaped / crashed / history session reopens with what its chips show (final review §9 #1): the user's pick
      // there, else what it last had live (model, effort, permission mode, deep orchestration, features — without
      // them the resume silently fell back to the defaults), else its transcript's model and mode.
      // A DeepSeek Harness conversation answers with the Claude conversation it goes on in: the send goes there.
      const rp = resumeParams(o, get().sessionMeta[sessionId]);
      // the chip's mode goes along only when the resume names none (a named one is what the chip shows anyway)
      sessionId = await get().openSession({ sessionId, cwd: o.cwd, ...rp, ...(opts?.expectMode && rp.permissionMode === undefined ? { expectMode: opts.expectMode } : {}) }, 'none');
      if (sessionId !== sessionId0) get().saveDraft(sessionId0, '');
    } else if ((o.state === 'idle' || o.state === 'starting') && get().sessionMeta?.[sessionId]?.continuedFrom) {
      // it went on from DeepSeek Harness, whose process is up (or coming up): what was said there since goes in first
      // (the process restarts with it), and shows above this message
      const n = await ws.request<number>({ kind: 'library.catchUp', sessionId }).catch(() => 0);
      if (n) await get().loadHistory(sessionId, { focus: false });
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
      x.conv.suggestion = undefined; // the SDK never echoes the user message: the guess at it is spent here
      x.error = undefined; // an earlier failure's reason, from before this send reopened the conversation
      x.lastSent = { id: uuid, text, images, attachments };
      x.conv.lastEventAt = Date.now();
      // the SDK never echoes the user message, so applyUser never stamps the turn start for a live send —
      // without this the run card's clock restarts on every event (a steer joins the turn already running)
      if (!steer || !x.conv.turnStartedAt) x.conv.turnStartedAt = Date.now();
    }));
    disarmAutoContinue(sessionId);
    get().saveDraft(sessionId, '');
    try {
      await ws.request({ kind: 'session.send', params: { sessionId, text, images, steer, uuid, attachments } });
    } catch (e: any) {
      // not taken (its process died before this window heard about it): end the turn shown as running and say why;
      // the 'error' state makes the next send reopen the conversation (above)
      const why = withExplanation(String(e?.message ?? e));
      set((s) => bump(s, sessionId, (x) => { x.state = 'error'; x.error = why; x.conv.turnStartedAt = undefined; }));
      throw e;
    }
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
    if (!agentId) throw new Error(tr('找不到子代理 id'));
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
    let reply: unknown;
    try {
      reply = await ws.request({ kind: 'session.interrupt', sessionId });
    } catch (e: any) {
      get().toast(tr('停止失败：{message}', { message: e?.message ?? e }));
      return;
    }
    // nothing runs on the server for it any more: end the turn this window still shows (store/stop.ts)
    if (stopFoundNothing(reply)) set((s) => bump(s, sessionId, (x) => { applyMessage(x.conv, staleStopResult(sessionId)); x.state = 'idle'; }));
    // 后台: the turn's Stop spares the background work (perTaskStopAffordance) — say where it is stopped
    const note = bgStopNote(sessionId);
    if (note) get().toast(note, true);
  },

  async respondPermission(requestId, response) {
    // a phone: approving gives a tick under the finger (UI refresh §8 触感) — every caller is a tap or a key press here
    if (get().mobile && response?.behavior === 'allow') haptic('confirm');
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
    set((s) => bump(s, sessionId, (o) => { o.resume = mergeResume(o.resume, patch); }));
  },
  async setSubagentModel(sessionId, model, providerId) {
    const prev = get().sessionMeta[sessionId];
    set((s) => ({ sessionMeta: { ...s.sessionMeta, [sessionId]: { ...s.sessionMeta[sessionId], subagent: { providerId, model } } } }));
    try {
      await ws.request({ kind: 'session.setSubagentModel', sessionId, model, providerId });
    } catch (e) {
      set((s) => ({ sessionMeta: { ...s.sessionMeta, [sessionId]: { ...prev } } }));
      throw e;
    }
  },

  setDraft(sessionId, draft) {
    // never create a half-formed entry (no conv / state) for a session that is not open
    set((s) => (s.open[sessionId] ? { open: { ...s.open, [sessionId]: { ...s.open[sessionId], draft } } } : {}));
  },
  composerInbox: {},
  addComposerAttachment(sessionId, b) {
    set((s) => ({ composerInbox: { ...s.composerInbox, [sessionId]: [...(s.composerInbox[sessionId] ?? []), b] } }));
  },
  takeComposerAttachments(sessionId) {
    const got = get().composerInbox[sessionId];
    if (!got?.length) return [];
    set((s) => {
      const { [sessionId]: _taken, ...rest } = s.composerInbox;
      return { composerInbox: rest };
    });
    return got;
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

// whichever way our own process ends — its event, a resync after a reconnect, a send that wasn't taken — from then on
// the disk is read for outside writes, starting from what ran here. The states seen last are kept here: bump() changes
// the entry in place, so the previous snapshot already holds the new state.
const lastState = new Map<string, string>();
useStore.subscribe((s, prev) => {
  if (s.open === prev.open) return;
  for (const id in s.open) {
    const now = s.open[id].state, was = lastState.get(id);
    if (was === now) continue;
    lastState.set(id, now);
    if (was && !readsFromOutside({ state: was }) && readsFromOutside({ state: now })) rebaseExt(id);
  }
  for (const id of lastState.keys()) if (!s.open[id]) lastState.delete(id);
});

/** Whether `userItemId` is the conversation's last prompt (no message typed after it). */
export function isLastPrompt(items: readonly { kind: string; id: string; meta?: boolean; hidden?: boolean }[], userItemId: string): boolean {
  const at = items.findIndex((i) => i.id === userItemId);
  return at >= 0 && isPrompt(items[at]) && !items.slice(at + 1).some(isPrompt);
}

const dataUrlImage = (u: string): { mediaType: string; data: string } | null => {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(u);
  return m ? { mediaType: m[1], data: m[2] } : null;
};

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
