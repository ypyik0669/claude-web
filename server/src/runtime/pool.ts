import { EventEmitter } from 'node:events';
import { SessionRunner, type AccountPrefs } from './session-runner.js';
import { familyWindows } from '../models/account-window.js';
import type { AgentKind, OpenSessionParams, PermissionMode, Provider, RunnerState } from '../protocol.js';
import type { ProviderService } from '../providers/service.js';
import { proxy } from '../net/proxy.js';
import { withExplanation } from '../errors/explain.js';
import { fullPick, providerKey, subagentModelFor } from '../models/subagent.js';
import { projectFolders } from '../meta/workspace-folders.js';
import { instructionsSection, projectFilesDir, projectOf } from '../meta/project.js';
import { dataDir } from '../files/service.js';
import fs from 'node:fs';

const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
/** A permission mode, or undefined for anything else (a stored setting is not trusted to be one). */
export const asMode = (v: unknown): PermissionMode | undefined => (MODES as readonly unknown[]).includes(v) ? (v as PermissionMode) : undefined;

const IDLE_TTL_MS = 30 * 60 * 1000;

/**
 * How long an idle Claude session keeps its process. Reopening means `--resume`; a turn after the provider's prompt
 * cache has gone cold pays for the whole context again anyway, so the process is kept while the cache would still be
 * warm: anthropic with the 1-hour TTL → just past it (65 min); everything else (5-minute cache, the claude.ai login)
 * → 30 min.
 */
export function idleTtlFor(p: Pick<Provider, 'type' | 'cache1h'> | undefined): number {
  if (p?.type === 'anthropic' && p.cache1h) return 65 * 60_000;
  return IDLE_TTL_MS;
}

/**
 * Longer TTLs mean more idle processes (~150–300 MB each): past this many idle Claude sessions the least
 * recently used one is closed anyway (it resumes on the next message, paying one uncached turn).
 */
export const MAX_IDLE_CLAUDE = 12;

/** meta.json saves this close together pass the account's picks on once (RunnerPool.accountPrefsSaved) */
export const ACCOUNT_PREFS_DEBOUNCE_MS = 400;

/** sessionId -> live runner. Emits everything runners emit, tagged with the session id. */
export class RunnerPool extends EventEmitter {
  private runners = new Map<string, SessionRunner>();
  private ttl = new WeakMap<SessionRunner, number>();

  constructor(private providers: ProviderService) {
    super();
    setInterval(() => this.reap(), 60_000).unref();
    // the own login's 200K / 1M picks and 自动压缩 point (A7) are settings: every save of meta.json says so
    const meta = providers.meta as (ProviderService['meta'] & Partial<Pick<EventEmitter, 'on'>>) | undefined;
    if (meta) this.accountKey = JSON.stringify(this.accountPrefs());
    if (typeof meta?.on === 'function') meta.on('changed', () => this.accountPrefsSaved());
  }

  /**
   * The extra folders of the project whose main folder `cwd` is (stage C2) — looked up here, so a conversation opened by
   * IM, a schedule, a goal or a hand-over gets them too. Read when it opens: a running one keeps what it started with.
   */
  private extraFolders(cwd: string): string[] {
    const meta = this.providers.meta;
    return meta && typeof meta.workspaces === 'function' ? projectFolders(cwd, meta.workspaces()) : [];
  }

  /**
   * 项目页 (stage F2): the project a conversation opens in (meta.workspaceId, else its main folder) — its instructions
   * (appended to the system prompt) and its project files folder (one more additional directory, when it has files).
   */
  private projectExtras(params: OpenSessionParams): { instructions: string; filesDir?: string } {
    const meta = this.providers.meta;
    if (!meta || typeof meta.workspaces !== 'function') return { instructions: '' };
    const sm = params.sessionId ? meta.sessionMeta(params.sessionId) : undefined;
    const w = projectOf({ cwd: params.cwd, workspaceId: sm?.workspaceId, groupCwd: sm?.groupCwd }, meta.workspaces());
    if (!w) return { instructions: '' };
    let filesDir: string | undefined;
    try {
      const d = projectFilesDir(dataDir(), w.id);
      if (fs.existsSync(d) && fs.readdirSync(d).length) filesDir = d;
    } catch { /* no files */ }
    return { instructions: instructionsSection(w), ...(filesDir ? { filesDir } : {}) };
  }

  /** What the own claude.ai login runs with (settings claude.contextWindows / claude.compactAt, A7). */
  private accountPrefs(): AccountPrefs {
    const s = this.providers.meta?.settings() ?? {};
    const c = s['claude.compactAt'];
    return { windows: familyWindows(s['claude.contextWindows']), ...(typeof c === 'number' && Number.isFinite(c) ? { compactAt: c } : {}) };
  }
  /**
   * the account prefs last passed on to the running conversations (at start: what meta.json had): a save of anything
   * else passes nothing. Not set by open() — a conversation opened between a save and its 'changed' read the new
   * picks already, the ones running before it have not (final review M1)
   */
  private accountKey?: string;
  private accountTimer: NodeJS.Timeout | null = null;

  /**
   * meta.json was saved. The account dialog saves its two settings one after the other (claude.contextWindows, then
   * claude.compactAt): two 'changed' a few ms apart, and each push may compact or restart a conversation on its own —
   * twice, or two processes (final review I1). Saves that close together go out as one push.
   */
  private accountPrefsSaved() {
    if (this.accountTimer) clearTimeout(this.accountTimer);
    this.accountTimer = setTimeout(() => { this.accountTimer = null; this.accountPrefsChanged(); }, ACCOUNT_PREFS_DEBOUNCE_MS);
    this.accountTimer.unref?.();
  }

  /** Settings were saved: if the account's picks changed, each running own-login Claude conversation gets them. */
  private accountPrefsChanged() {
    const prefs = this.accountPrefs();
    const key = JSON.stringify(prefs);
    if (key === this.accountKey) return;
    this.accountKey = key;
    for (const r of this.runners.values()) {
      if (!r.info.providerId || r.info.providerId === 'claude') void r.setAccountPrefs(prefs).catch(() => { /* the old process keeps going */ });
    }
  }

  get(sessionId: string) {
    return this.runners.get(sessionId);
  }
  list() {
    return [...this.runners.values()];
  }
  stateOf(sessionId: string): RunnerState | undefined {
    return this.runners.get(sessionId)?.state;
  }
  /** A provider was saved in settings: its running Claude conversations start their next process with it. */
  providerSaved(id: string) {
    const runners = [...this.runners.values()].filter((r) => r.info.providerId === id);
    if (!runners.length) return;
    // it may not build any more (no key…): the save went through — the old processes keep going
    let p: ReturnType<ProviderService['forSession']>;
    try { p = this.providers.forSession(id); } catch { return; }
    for (const r of runners) void r.reprovide(p).catch(() => { /* the old process keeps going */ });
  }

  /**
   * 思考用的语言 changed: one conversation's pick (`sessionId`, `own`: '' = the setting), or the setting / the interface
   * language (no id: every running Claude conversation). Each restarts once idle if its instruction changed.
   */
  thinkingLanguageChanged(sessionId?: string, own?: string) {
    const runners = sessionId ? [this.runners.get(sessionId)] : [...this.runners.values()];
    for (const r of runners) if (r) void r.refreshThinkingLanguage(sessionId ? own ?? '' : undefined).catch(() => { /* the old process keeps going */ });
  }

  /**
   * Why a conversation takes no new turns here (null = it does): one handed to another machine, or being handed right
   * now (fix wave F4, set in index.ts from HandoffService.isReadOnly). Every reopen — window, IM, schedule, goal,
   * another conversation's message — comes through open(); senders to a live runner ask `assertWritable`.
   */
  readOnly?: (sessionId: string) => string | null;
  assertWritable(sessionId: string | undefined) {
    const why = sessionId ? this.readOnly?.(sessionId) : null;
    if (why) throw new Error(why);
  }

  /**
   * The permission mode a conversation is resumed in when whoever reopens it names none: what it last ran with, else
   * 新对话默认权限; undefined = the CLI's own default. `open` uses this, and so does the permission chip of a
   * conversation that is not running (session.resumeMode) — the chip shows what the next send will really run in,
   * not the window's own guess (2026-10-26 QA).
   */
  resumeMode(sessionId?: string): PermissionMode | undefined {
    const meta = this.providers.meta;
    if (!meta) return undefined;
    return (sessionId ? meta.sessionMeta(sessionId).permissionMode : undefined) ?? asMode(meta.settings()['ui.defaultMode']);
  }

  /**
   * 发送前核对权限 (compare-and-refuse): the mode a send would really resume `params` in, when it differs from what
   * the chip showed (`expectMode`); null = go ahead. Only a resume that names no mode is checked (a named mode is the
   * user's pick), and not a conversation already running (it keeps its own). Reads only: nothing is recorded.
   */
  modeMismatch(params: OpenSessionParams): PermissionMode | null {
    if (!params.expectMode || !params.sessionId || params.fork || params.resumeAt || params.permissionMode !== undefined) return null;
    const live = this.runners.get(params.sessionId);
    if (live && live.state !== 'closed' && live.state !== 'error') return null;
    const actual = this.resumeMode(params.sessionId) ?? 'default';
    return actual === params.expectMode ? null : actual;
  }

  open(params: OpenSessionParams): SessionRunner {
    if (params.expectMode !== undefined) { params = { ...params }; delete params.expectMode; }
    if (!params.fork) this.assertWritable(params.sessionId);
    void proxy.refresh(); // IM / schedules / goals come straight here: a stale look is redone for the next start (net/proxy.ts)
    if (params.sessionId && !params.fork && !params.resumeAt) {
      const existing = this.runners.get(params.sessionId);
      if (existing && existing.state !== 'closed' && existing.state !== 'error') return existing;
      if (existing) {
        this.runners.delete(params.sessionId);
        // an errored runner may still hold a child process / input queue; its late 'closed' is filtered below
        void existing.close().catch(() => { /* already dead */ });
      }
    }
    // WSL (spec E5): the conversation's machine is its own — whoever reopens it (a window, IM, a schedule) starts it
    // in the same distro; there it runs the distro's own Claude Code login, never a provider of this machine
    const recordedEnv = params.sessionId ? this.providers.meta?.sessionMeta(params.sessionId).env : undefined;
    const runEnv = params.env ?? recordedEnv;
    if (runEnv?.kind === 'wsl') params = { ...params, env: runEnv, providerId: undefined };
    // the provider, when the caller did not say: IM, scheduled tasks, goals and hand-overs open sessions here
    // without going through the hub, and used to start on the account whatever the user had set up
    const chosen = runEnv?.kind === 'wsl' ? { byPool: false as const } : this.resolveProvider(params);
    if (chosen.byPool) params = { ...params, providerId: chosen.providerId };
    // the permission mode, when the caller did not say (a window that never had it live — after a restart, on the
    // phone — IM, schedules, goals): what this conversation last ran with, else the default for new conversations.
    // It used to fall back to 每步询问 (2026-10-14, a user's friend: 完全放开 came back as 每步询问 after a few turns)
    const saidMode = params.fork || params.resumeAt ? undefined : asMode(params.permissionMode);
    if (params.permissionMode === undefined) {
      const mode = this.resumeMode(params.sessionId && !params.fork ? params.sessionId : undefined);
      if (mode) params = { ...params, permissionMode: mode };
    }
    // 只聊天 is the conversation's, whoever reopens it (a window, another conversation's message, IM, goals, schedules,
    // a provider switch) and its forks: without tools it started, without tools it stays — no caller can drop it
    const chatOnly = !!params.features?.chatOnly || !!(params.sessionId && this.providers.meta?.sessionMeta(params.sessionId).chatOnly);
    if (chatOnly && !params.features?.chatOnly) params = { ...params, features: { ...params.features, chatOnly: true } };
    // the subagents' model: said by the caller (the composer's chip), else this conversation's own pick, else the
    // default for new conversations — IM, schedules, goals and every reopen land here too. Always a whole pick
    // (provider + model): the conversation moving to another provider does not change it
    const m = this.providers.meta;
    const explicit = params.subagentModel === undefined ? undefined : fullPick(params.subagentModel, params.providerId);
    params = { ...params, subagentModel: explicit ?? (m ? subagentModelFor({ recorded: params.sessionId ? m.sessionMeta(params.sessionId).subagent : undefined, settings: m.settings(), providerId: params.providerId }) : undefined) };
    const sp = this.providers.forSession(params.providerId);
    // 思考用的语言 picked for this conversation (a fork thinks in its parent's)
    const thinkingLanguage = params.sessionId ? m?.sessionMeta(params.sessionId).thinkingLanguage : undefined;
    // the own claude.ai login: its 200K / 1M picks and 自动压缩 point (A7); a provider / another account has its own
    let account: AccountPrefs | undefined;
    if (!sp && params.env?.kind !== 'wsl') account = this.accountPrefs();
    // a conversation in a project's main folder works in the project's extra folders too (stage C2)
    const proj = this.projectExtras(params);
    const extra = [...this.extraFolders(params.cwd), ...(proj.filesDir ? [proj.filesDir] : [])];
    // the project's instructions go into NEW conversations (spec F2) and stay theirs (recorded below): a resumed or
    // forked one runs with what it started with — a conversation older than the project never gets them, an edit
    // of the instructions changes no conversation already going
    const projInstr = params.sessionId ? (m?.sessionMeta(params.sessionId).projectInstructions ?? '') : proj.instructions;
    const r = new SessionRunner(params, sp, { thinkingLanguage, ...(account ? { account } : {}), ...(extra.length ? { additionalDirectories: extra } : {}), ...(projInstr ? { projectInstructions: projInstr } : {}) });
    // a pick is the conversation's from then on (a new one: under the id it was given; a fork gets its id at init)
    if (explicit !== undefined && m && !params.fork && !params.resumeAt) {
      void m.setSessionMeta(r.sessionId, { subagent: { providerId: providerKey(params.providerId), model: explicit } }).catch(() => { /* in memory; the next save persists it */ });
    }
    this.ttl.set(r, idleTtlFor(sp));
    // what the pool chose is remembered like a choice made in the window (resume / fork keep it)
    const meta = this.providers.meta;
    if (chosen.byPool && chosen.providerId && meta && meta.sessionMeta(r.sessionId).providerId !== chosen.providerId) {
      void meta.setSessionMeta(r.sessionId, { providerId: chosen.providerId }).catch(() => { /* in memory; the next save persists it */ });
    }
    this.runners.set(r.id, r);
    // a fork runs under a made-up id until the CLI gives it its own at init: nothing is recorded under that one
    const placeholder = params.sessionId && (params.fork || params.resumeAt) ? r.id : undefined;
    const keepChatOnly = (id: string | undefined) => {
      if (chatOnly && meta && id && id !== placeholder && !meta.sessionMeta(id).chatOnly) void meta.setSessionMeta(id, { chatOnly: true }).catch(() => { /* in memory; the next save persists it */ });
    };
    keepChatOnly(r.sessionId);
    const keepEnv = (id: string | undefined) => {
      if (runEnv?.kind === 'wsl' && meta && id && id !== placeholder && !meta.sessionMeta(id).env) void meta.setSessionMeta(id, { env: runEnv }).catch(() => { /* in memory; the next save persists it */ });
    };
    keepEnv(r.sessionId);
    const keepInstr = (id: string | undefined) => {
      if (projInstr && meta && id && id !== placeholder && meta.sessionMeta(id).projectInstructions !== projInstr) void meta.setSessionMeta(id, { projectInstructions: projInstr }).catch(() => { /* in memory; the next save persists it */ });
    };
    keepInstr(r.sessionId);
    // a mode the caller said is the conversation's from the start — not only once the process reports it (below): one
    // whose start failed, or that closed before init, came back without a record, so in 新对话默认权限 — 完全放开 for
    // a conversation opened as 每步询问 (2026-10-26, desktop QA)
    if (saidMode && meta && meta.sessionMeta(r.sessionId).permissionMode !== saidMode) {
      void meta.setSessionMeta(r.sessionId, { permissionMode: saidMode }).catch(() => { /* in memory; the next save persists it */ });
    }
    r.on('message', (m) => this.emit('message', r.sessionId, m));
    // the user message a send accepted, from whichever window, IM, schedule or goal sent it ('sent'). Its own event,
    // not 'message': the canonical mirror records sends itself, the ledger / IM / goals read the stream
    r.on('sent', (m) => this.emit('sent', r.sessionId, m));
    r.on('state', (s, err) => {
      // a replaced runner (reopened after an error) must not report its shutdown as the new one's state
      const holder = this.runners.get(r.sessionId);
      if (holder && holder !== r) return;
      // the failure in the user's words, the original kept under it (the runner explains its own already)
      this.emit('state', r.sessionId, s, s === 'error' && err ? withExplanation(err) : err);
      // after init the map may be keyed by sessionId rather than id; only drop entries that still point at this runner
      if (s === 'closed') for (const k of [r.id, r.sessionId]) if (this.runners.get(k) === r) this.runners.delete(k);
    });
    r.on('info', (i) => {
      // session id can be assigned by init (new session) — keep the map keyed by the real id
      if (i.sessionId !== r.id && this.runners.get(r.id) === r) {
        this.runners.delete(r.id);
        this.runners.set(i.sessionId, r);
      }
      // a fork gets its own id here: it is as tool-less as its parent
      keepChatOnly(i.sessionId);
      keepEnv(i.sessionId);
      keepInstr(i.sessionId);
      // the mode it runs in now (picked in a window, or the CLI's own move out of plan mode) is what it comes back in
      const mode = asMode(i.permissionMode);
      if (mode && meta && i.sessionId && i.sessionId !== placeholder && meta.sessionMeta(i.sessionId).permissionMode !== mode) {
        void meta.setSessionMeta(i.sessionId, { permissionMode: mode }).catch(() => { /* in memory; the next save persists it */ });
      }
      this.emit('info', i);
    });
    r.on('permission', (e) => this.emit('permission', e));
    r.on('permissionResolved', (id) => this.emit('permissionResolved', r.sessionId, id));
    return r;
  }

  /**
   * The provider a session runs on when `params.providerId` is not given (an explicit one — `'claude'` = the
   * account — always wins): a resume keeps the one it was recorded with; a new session, or a resume whose recorded
   * provider is gone, gets the default — settings → 供应商 「设为默认」. A resume with nothing recorded stays on the
   * account, as before.
   */
  private resolveProvider(params: OpenSessionParams): { providerId?: string; byPool: boolean } {
    if (params.providerId !== undefined) return { providerId: params.providerId, byPool: false };
    const meta = this.providers.meta;
    if (!meta) return { byPool: false };
    const agent: AgentKind = 'claude';
    if (params.sessionId) {
      const recorded = meta.sessionMeta(params.sessionId).providerId;
      if (this.fits(recorded, agent)) return { providerId: recorded, byPool: true };
      if (recorded) return { providerId: this.defaultProviderFor(agent), byPool: true };
      // nothing recorded (a conversation made in the CLI) = the account — unless the account is known to be logged
      // out: then the default provider, like a new conversation (it failed "Not logged in" with a provider set up)
      return this.accountLoggedOut?.() ? { providerId: this.defaultProviderFor(agent), byPool: true } : { byPool: false };
    }
    return { providerId: this.defaultProviderFor(agent), byPool: true };
  }

  /** Set by the server: the last `claude auth status` said logged out (unknown = false). */
  accountLoggedOut?: () => boolean;

  /** The provider a new session gets (undefined = the account). */
  defaultProviderFor(agent: AgentKind = 'claude'): string | undefined {
    const meta = this.providers.meta;
    if (!meta) return undefined;
    const def = meta.settings().defaultProviderId;
    return this.fits(def, agent) ? def : undefined;
  }

  private fits(id: unknown, agent: AgentKind): id is string {
    return typeof id === 'string' && !!id && id !== 'claude' && !!this.providers.meta?.provider(id) && !this.providers.fitError(id, agent);
  }

  /** Why `providerId` cannot drive `agent` (null = it can) — IM checks its configured provider with this. */
  providerFitError(providerId: string | undefined, agent: string | undefined): string | null {
    return this.providers.fitError(providerId, (agent || 'claude') as AgentKind);
  }

  async close(sessionId: string) {
    const r = this.runners.get(sessionId);
    if (!r) return;
    this.runners.delete(sessionId);
    await r.close();
  }

  /**
   * The transcript of a conversation changed. An idle Claude process whose conversation got a turn from somewhere else
   * (the CLI in a terminal) has a stale context: its next turn answered without that turn and branched it off for good.
   * Close it; the window re-reads the transcript and the next message resumes from disk.
   */
  transcriptChanged(sessionId: string) {
    const r = this.runners.get(sessionId);
    if (!r || !r.wroteElsewhere()) return;
    this.runners.delete(sessionId);
    void r.yieldToOutside().catch(() => { /* already gone */ });
  }

  /** Nothing of ours has the conversation's transcript open, or its Claude process is idle and quiet (`quiet()`). */
  quiet(sessionId: string): boolean {
    const r = this.runners.get(sessionId);
    return !r || r.quiet();
  }

  /** Its Claude process is not quiet yet but will be soon on its own (`SessionRunner.settling`). */
  settling(sessionId: string): boolean {
    const r = this.runners.get(sessionId);
    return !!r && r.settling();
  }

  /** Restart a quiet Claude process after something was appended to its transcript, so its context has it. */
  async reloadTranscript(sessionId: string): Promise<boolean> {
    const r = this.runners.get(sessionId);
    if (!r || !r.quiet()) return false;
    await r.reloadTranscript();
    return true;
  }

  findPermission(requestId: string) {
    for (const r of this.runners.values()) if (r.getPendingPermissions().some((p) => p.requestId === requestId)) return r;
    return undefined;
  }

  private reap() {
    const now = Date.now();
    const idleClaude: [string, SessionRunner][] = [];
    for (const [id, r] of this.runners) {
      if (r.state !== 'idle') continue;
      // 后台: a workflow / background agent / command still going in it — reaping would kill it, and its result
      // (a task notification that starts a turn of its own) would never come
      if (r.hasBackgroundWork()) continue;
      if (now - r.lastActivity > (this.ttl.get(r) ?? IDLE_TTL_MS)) void this.close(id).catch(() => { /* already gone */ });
      else idleClaude.push([id, r]);
    }
    // cap on idle Claude processes: the least recently used beyond MAX_IDLE_CLAUDE go
    idleClaude.sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    for (const [id] of idleClaude.slice(0, Math.max(0, idleClaude.length - MAX_IDLE_CLAUDE))) void this.close(id).catch(() => { /* already gone */ });
  }

  async closeAll() {
    // one runner failing to close must not stop the rest (or the server shutdown) from proceeding
    await Promise.allSettled([...this.runners.keys()].map((id) => this.close(id)));
  }
}
