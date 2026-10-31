import path from 'node:path';
import type { ImportService } from '../import/service.js';
import fs from 'node:fs';
import type { WebSocket, WebSocketServer } from 'ws';
import { CLAUDE_PROVIDER_ID, type ClientRequest, type OpenSessionParams, type RemoteStatus, type ServerEvent, type WireDown, type WireUp } from '../protocol.js';
import { RunnerPool, asMode } from '../runtime/pool.js';
import { SessionRunner, setNodegraphHint, setPromptSuggestions, setThinkingLanguageSetting } from '../runtime/session-runner.js';
import { NODEGRAPH_HINT_KEY } from '../runtime/nodegraph-hint.js';
import { THINKING_LANGUAGE_KEY } from '../runtime/thinking-language.js';
import { setSessionsMcpEnabled } from '../sessions-mcp/tools.js';
import { setDesktopSkillsEnabled } from '../runtime/desktop-skills.js';
import { listProjectFiles, rankFiles } from '../files/find.js';
import { copyWorktreeIncludes, resolveWorktreeDir } from '../git/worktree-include.js';
import { readChangelog } from '../app/changelog.js';
import { recentArtifacts } from '../library/artifacts.js';
import type { LocalEnvStore } from '../runtime/local-env.js';
import type { VcsTokenStore } from '../vcs/token-store.js';
import { autoLeases } from '../vcs/auto-lease.js';
import type { WslService } from '../wsl/service.js';
import { INSTALL_CMD } from '../wsl/distros.js';
import type { PreviewService } from '../preview/service.js';
import { cacheParentFor } from '../runtime/cache-key.js';
import { userCompactSource } from '../runtime/user-env.js';
import { SessionService, claudeDir } from '../sessions/service.js';
import { ConfigService } from '../config/service.js';
import { UsageService } from '../usage/service.js';
import { FilesService } from '../files/service.js';
import { TerminalService } from '../terminal/service.js';
import { MetaStore } from '../meta/store.js';
import { checkExtraFolders, refusePeerUnc } from '../meta/folder-check.js';
import { LimitsService } from '../usage/limits.js';
import { ScheduleService } from '../schedules/service.js';
import { installedEditors, openPath } from '../runtime/open-path.js';
import { engineInfo, runClaudeCli } from '../claude-exe.js';
import type { ProviderService } from '../providers/service.js';
import type { GitService } from '../git/service.js';
import type { SearchService } from '../search/service.js';
import type { SkillsService } from '../skills/service.js';
import type { McpService } from '../mcp/service.js';
import type { DiagService } from '../diag/service.js';
import { detectTools } from '../tools/detect.js';
import { runCode } from '../tools/run-code.js';
import { ClientLogGate } from '../diag/client-log.js';
import type { RemoteService } from '../remote/service.js';
import type { AnywhereService } from '../remote/anywhere/service.js';
import type { TunnelManager } from '../remote/tunnel.js';
import { IM_KINDS, type ImService } from '../im/service.js';
import type { VcsService } from '../vcs/service.js';
import type { GoalService } from '../goals/service.js';
import type { AndroidService } from '../android/service.js';
import type { LedgerService } from '../usage/ledger.js';
import type { CustomCssService } from '../appearance/custom-css.js';
import { LOCAL_PAGE_BYTES, REMOTE_PAGE_BYTES, pageOf, withTurnStats } from '../sessions/history.js';
import { SCHEDULE_TEMPLATES } from '../schedules/service.js';
import { nextCron } from '../schedules/cron.js';
import type { AgentRegistry } from '../agents/types.js';
import type { AgentTranscripts } from '../agents/transcript.js';
import type { CanonicalLog } from '../session/canonical.js';
import type { MemoryService } from '../memory/service.js';
import { harvest } from '../memory/extract.js';
import { setMemoryMcpEnabled } from '../memory/launcher.js';
import { afterSwitch, normProvider, openOnProvider, swapAgent, swapProvider } from '../session/swap.js';
import { fullPick, providerKey } from '../models/subagent.js';
import { applyLanguage } from '../i18n/boot.js';
import { LANGUAGE_KEY } from '../i18n/core.js';
import { expandSessionRefs } from '../library/briefing.js';
import type { LibraryService } from '../library/service.js';
import { scanLocalHistory } from '../library/local-scan.js';
import type { GatewayService } from '../gateway/service.js';
import { handleGatewayRequest, isGatewayRequest } from '../gateway/handlers.js';
import { handlePrivacyRequest, isPrivacyRequest, type PrivacyService } from '../privacy/service.js';
import type { UpstreamService } from '../upstreams/service.js';
import type { MaintenanceScheduler } from '../upstreams/tasks.js';
import { handleUpstreamRequest, isUpstreamRequest } from '../upstreams/handlers.js';
import type { ChannelService } from '../channels/service.js';
import { handleChannelRequest, isChannelRequest } from '../channels/handlers.js';
import { handleSourceHealthRequest, isSourceHealthRequest, sourceHealth } from '../channels/health.js';
import type { PluginService } from '../plugins/service.js';
import { handlePluginRequest, isPluginRequest } from '../plugins/handlers.js';
import { handleSyncRequest, isSyncRequest, type SyncService } from '../sync/service.js';
import { handleRemoteSyncRequest, isRemoteSyncRequest, maskSyncRemoteSettings, type RemoteSyncService } from '../sync/remote.js';
import { handleShareRequest, isShareRequest, type ShareService } from '../share/service.js';
import { handleTelemetryRequest, isTelemetryRequest, maskOtlpSettings, otlpExporter } from '../telemetry/otlp.js';
import type { EngineManager } from '../engines/manager.js';
import { handleEngineRequest, isEngineRequest } from '../engines/handlers.js';

import type { AgentConfigService } from '../agent-config/service.js';
import { handleAgentConfig, isAgentConfigRequest } from '../agent-config/handlers.js';

import type { FederationService } from '../federation/service.js';
import type { IncomingMessage } from 'node:http';
import type { OrchestraService } from '../orchestra/service.js';
import { parseProxySetting, proxy } from '../net/proxy.js';
import { CharacterService, handleCharacters, isCharactersRequest } from '../characters/service.js';
import { handleCloud, isCloudRequest, type CloudServices } from '../cloud/handlers.js';
import type { ThemeService } from '../themes/service.js';
import { usable } from '../themes/tools.js';
import { handleOrchestra, isOrchestraRequest } from '../orchestra/handlers.js';
import { handleBackground, isBackgroundRequest, type BackgroundService } from '../background/service.js';
import { isWebKeySetting, maskWebSettings, type WebService } from '../web/service.js';
import { setWebAgentBrowser, setWebMcpEnabled } from '../web/launcher.js';
import { egoStatus } from '../web/ego.js';
import type { ComputerAccess } from '../computer/access.js';
import type { SiteAsk } from '../web/site-gate.js';
import { computerSupported, defaultFeaturesOf } from '../computer/launcher.js';
import { tr } from '../i18n/index.js';
import { clientSessionParams, refusePeerUncBot, type BotService } from '../bots/service.js';
import { dutyInstalled, installDuty } from '../bots/duty.js';
import { isBotSession, refuseOnThread } from '../bots/hidden.js';
import { serverSend, stripBotTags } from '../bots/tags.js';

export interface Services {
  /** Unified session library: every joined source's sessions (sessions.list / search / library.*). */
  library: LibraryService;
  /** Other agents' config center: MCP / instructions / settings of Codex, Gemini, Qwen, OpenCode (agentConfig.*). */
  agentConfig: AgentConfigService;
  /** 本机环境变量 (runtime/local-env.ts); optional (tests) */
  localEnv?: LocalEnvStore;
  /** 预览服务器 (preview/service.ts): the browser's empty page lists and starts them; optional (tests) */
  previews?: PreviewService;
  /** stage E: GitHub / GitLab tokens typed in settings (vcs/token-store.ts); optional (tests) */
  vcsTokens?: VcsTokenStore;
  /** stage E5: WSL distros; optional (tests) */
  wsl?: WslService;

  /** Cross-machine sessions: routes peer_… requests / merges lists before handle(); optional (tests). */
  federation?: FederationService;
  /** Multi-agent orchestration (workflows / runs); requests routed by orchestra/handlers.ts */
  orchestra: OrchestraService;
  /** 后台: every conversation's running sub-agents / workflows / commands (background/service.ts). */
  background: BackgroundService;
  characters: CharacterService;
  /** stage F: project files, 派活, 交接, 发布, 导入 claude.ai (cloud/handlers.ts) */
  cloud?: CloudServices;
  themes: ThemeService;
  git: GitService;
  search: SearchService;
  skills: SkillsService;
  mcp: McpService;
  diag: DiagService;
  ledger: LedgerService;
  customCss: CustomCssService;
  agents: AgentRegistry;
  transcripts: AgentTranscripts;
  canonical: CanonicalLog;
  memory: MemoryService;
  remote: RemoteService;
  /** 在外面也能用: phones reaching the remote-access listener through the signaling brokers; optional (tests). */
  anywhere?: AnywhereService;
  tunnels: TunnelManager;
  im: ImService;
  vcs: VcsService;
  goals: GoalService;
  android: AndroidService;
  pool: RunnerPool;
  sessions: SessionService;
  config: ConfigService;
  usage: UsageService;
  files: FilesService;
  terminal: TerminalService;
  meta: MetaStore;
  limits: LimitsService;
  schedules: ScheduleService;
  providers: ProviderService;
  /** 从其它工具导入 (import/) */
  importer: ImportService;
  version: string;
  /** Local model gateway (/gateway/<group>/…, /<group>/v1/… and the /v1 root). */
  gateway: GatewayService;
  /** 隐私保护: settings, preview and hit counts (privacy.*) */
  privacy: PrivacyService;
  /** 账号池: Claude subscription accounts and the pools they are grouped into (upstreams.*). */
  upstreams: UpstreamService;
  channels: ChannelService;
  /** plugins / sync / 远程共享 (spec 2026-10-26 §4.3, §8); optional so test hubs need not build them */
  plugins?: PluginService;
  sync?: SyncService;
  /** 备份与同步 → 远程同步: WebDAV / S3 / GitHub (sync/remote.ts); optional so test hubs need not build it */
  syncRemote?: RemoteSyncService;
  share?: ShareService;
  /** 托管程序: CLIProxyAPI / Magpie (engines.*) */
  engines: EngineManager;
  /** 任务中心: the scheduler behind tasks.* (check-in, keepalive, growth, …). */
  tasks: MaintenanceScheduler;
  /** 联网: web search, and the browser tools carried out by the window hosting the built-in browser (web.* / browser.*). */
  web: WebService;
  /** 操控电脑: the user's answer to an agent asking for control of applications (computer/access.ts). */
  computer: ComputerAccess;
  /** 允许的网站: the user's answer before an agent changes a page of a new site in the built-in browser (web/site-gate.ts). */
  siteAsk?: SiteAsk;
  /** 值班 Bot */
  bots: BotService;
}

/** Requests after which something connects out: they wait for a fresh look at the proxy. (`web.search` waits inside WebService, like the agents' searches.) */
const GOES_OUT = new Set<string>(['session.open', 'session.send', 'session.setProvider', 'session.switchAgent', 'providers.probe', 'providers.refreshModels', 'import.run', 'terminal.open', 'im.set', 'im.test', 'mcp.registry', 'sync.remote.test', 'sync.remote.push', 'sync.remote.pull']);

const isLoopback = (a: string | undefined) => !!a && (a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.'));

export class Hub {
  private clients = new Set<WebSocket>();
  /** Connections from another machine's FederationService (`?peer=<serverId>`): never sent what we got from our own peers. */
  private peerConns = new WeakSet<WebSocket>();
  /**
   * Connections that are not a window on this machine: through the remote-access listener (a phone, 在外面也能用) or
   * with a paired device's token. They may use everything else, but not host the built-in browser.
   */
  private remoteConns = new WeakSet<WebSocket>();
  /** Connections whose screen is not this machine's: a native dialog (`fs.pickDir`) would open where nobody sees it. */
  private otherScreen = new WeakSet<WebSocket>();
  /** renderer error reports (`client.log`): 20 per connection, 60 in all per minute, duplicates counted */
  private clientLogs = new ClientLogGate<WebSocket>();

  constructor(private wss: WebSocketServer, private s: Services) {
    wss.on('connection', (ws, req: IncomingMessage) => this.onConnect(ws, req));
    // every session is mirrored into the provider-neutral timeline, whichever agent is behind it
    s.pool.on('message', (sessionId, message) => s.canonical.observe(sessionId, message));
    s.pool.on('message', (sessionId, message) => this.broadcast({ kind: 'session.event', sessionId, message }));
    // what was asked, from wherever (a phone, another window, IM, a schedule, a goal's 继续): no agent echoes it, and the
    // other windows showed only the answer (2026-10-08, a user's phone). `cw_echo`: the sender's window already has it
    // under the same uuid and skips it
    s.pool.on('sent', (sessionId, message) => this.broadcast({ kind: 'session.event', sessionId, message: { ...message, cw_echo: true } }));
    s.pool.on('state', (sessionId, state, error) => this.broadcast({ kind: 'session.state', sessionId, state, error }));
    s.pool.on('info', (info) => this.broadcast({ kind: 'session.info', info }));
    // 隐私保护: settings / hit counters pushed to the privacy center, at most once a second (counters move per request)
    if (s.privacy) {
      let timer: NodeJS.Timeout | null = null;
      s.privacy.listen(() => {
        if (timer) return;
        timer = setTimeout(() => { timer = null; this.broadcast({ kind: 'privacy.changed', status: s.privacy!.status() }); }, 1000);
        timer.unref?.();
      });
    }
    s.pool.on('permission', (request) => this.broadcast({ kind: 'permission.request', request }));
    // 派活 (stage F3): a dispatched conversation says when it is done or needs an answer — a notice every window and the
    // phone get (notify: a system notification when the window is not in front); IM chats are told by the IM router
    s.pool.on('message', (sessionId, message: any) => {
      if (message?.type !== 'result' || s.meta.sessionMeta(sessionId).origin !== 'dispatch') return;
      this.broadcast({ kind: 'notice', text: message.is_error ? tr('派来的活出错了') : tr('派来的活做完了'), notify: true, sessionId });
    });
    s.pool.on('permission', (request: any) => {
      if (!request?.sessionId || s.meta.sessionMeta(request.sessionId).origin !== 'dispatch') return;
      this.broadcast({ kind: 'notice', text: tr('派来的活需要你回答'), notify: true, sessionId: request.sessionId });
    });
    s.pool.on('permissionResolved', (_sid, requestId) => this.broadcast({ kind: 'permission.resolved', requestId }));
    // 操控电脑: which applications an agent may control is asked here, as a permission card of its conversation —
    // by this server, whatever the conversation's own permission mode lets through, except 完全放开 which is not asked
    // (computer/access.ts)
    s.computer.on('permission', (request) => this.broadcast({ kind: 'permission.request', request }));
    s.computer.on('permissionResolved', (requestId) => this.broadcast({ kind: 'permission.resolved', requestId }));
    s.pool.on('state', (sessionId, state) => { if (state === 'closed' || state === 'error') s.computer.drop(sessionId); });
    // …and the built-in browser's 允许的网站 cards, the same way
    if (s.siteAsk) {
      const site = s.siteAsk;
      site.on('permission', (request) => this.broadcast({ kind: 'permission.request', request }));
      site.on('permissionResolved', (requestId) => this.broadcast({ kind: 'permission.resolved', requestId }));
      s.pool.on('state', (sessionId, state) => { if (state === 'closed' || state === 'error') site.drop(sessionId); });
    }
    s.sessions.on('changed', () => this.broadcast({ kind: 'sessions.changed' }));
    s.meta.on('changed', () => this.broadcast({ kind: 'meta.changed' }));
    s.schedules.on?.('notice', (n: { text: string; notify?: boolean; sessionId?: string }) => this.broadcast({ kind: 'notice', ...n }));
    const pushLimits = () => s.limits.get().then((limits) => this.broadcast({ kind: 'limits', limits })).catch(() => {});
    setInterval(pushLimits, 5 * 60_000).unref();
    let lastIdlePush = 0;
    s.pool.on('state', (_sid, state) => {
      if (state === 'idle' && Date.now() - lastIdlePush > 4 * 60_000) { lastIdlePush = Date.now(); setTimeout(pushLimits, 5000); }
    });
    s.terminal.on('data', (termId, data) => this.broadcast({ kind: 'terminal.data', termId, data }));
    s.terminal.on('exit', (termId, code) => this.broadcast({ kind: 'terminal.exit', termId, code }));
    s.files.on('changed', (e: { path: string; type: any }) => this.broadcast({ kind: 'fs.changed', path: e.path, type: e.type }));
    s.git.on('changed', (cwd: string) => this.broadcast({ kind: 'git.changed', cwd }));
    s.remote.on('changed', () => this.broadcast({ kind: 'remote.changed' }));
    s.anywhere?.on('changed', () => this.broadcast({ kind: 'remote.changed' }));
    s.im.on('changed', () => this.broadcast({ kind: 'im.changed' }));
    s.tunnels.on('changed', () => this.broadcast({ kind: 'tunnel.changed' }));
    s.goals.on('changed', () => this.broadcast({ kind: 'goals.changed' }));
    s.memory.on('changed', () => this.broadcast({ kind: 'memory.changed' }));
    s.library.on('changed', () => this.broadcast({ kind: 'library.changed' }));
    s.library.on('continuationBehind', (id: string) => void this.catchUpFromSource(id, { announce: true }));
    s.pool.on('state', (sessionId: string, state: string) => { if (state === 'idle' && this.behindPending.has(sessionId)) this.behindRetry(sessionId); });
    s.library.on('transcripts', (ids: string[]) => this.broadcast({ kind: 'transcripts.changed', sessionIds: ids }));
    s.sessions.on('transcripts', (ids: string[]) => {
      for (const id of ids) s.pool.transcriptChanged(id); // a turn from a terminal on a conversation held open here
      this.broadcast({ kind: 'transcripts.changed', sessionIds: ids });
    });
    s.library.on('discovered', (kinds) => this.broadcast({ kind: 'library.discovered', kinds }));
    s.gateway.on('changed', () => this.broadcast({ kind: 'gateway.changed' }));
    s.gateway.on('audit', (lines) => this.broadcast({ kind: 'gateway.log', lines }));
    s.gateway.on('promptHeavy', (e: { sessionId: string; bytes: number; via: string }) => this.broadcast({ kind: 'gateway.promptHeavy', ...e }));
    // 智能路由: which model a conversation on a routing group really got (the composer's 「自动 → 实际：…」)
    s.gateway.on('routed', (e: import('../routing/types.js').RoutedInfo) => this.broadcast({ kind: 'gateway.routed', ...e }));
    s.upstreams.on('changed', () => this.broadcast({ kind: 'upstreams.changed' }));
    // 托管程序: each step of a long install / start, every state change, and a stop nobody asked for
    s.engines.on('progress', (id: import('../engines/types.js').EngineId, step: import('../engines/types.js').EngineStep) => this.broadcast({ kind: 'engines.changed', id, step }));
    s.engines.on('changed', (id: import('../engines/types.js').EngineId) => this.broadcast({ kind: 'engines.changed', id }));
    s.engines.on('crash', (id: import('../engines/types.js').EngineId, why: string) => this.broadcast({ kind: 'engines.changed', id, crash: why }));
    s.tasks.on('changed', () => this.broadcast({ kind: 'upstreams.changed' }));
    s.tasks.on('notice', (text: string, notify?: boolean) => this.broadcast({ kind: 'notice', text, notify: !!notify }));
    s.web.on('changed', () => this.broadcast({ kind: 'web.changed' }));

    s.federation?.on('event', (e: ServerEvent) => this.broadcast(e, true));
    s.orchestra.on('changed', (run, removed) => this.broadcast({ kind: 'orchestra.changed', run, removed }));
    s.orchestra.on('workflows', () => this.broadcast({ kind: 'orchestra.workflows.changed' }));
    s.background.on('changed', (session) => this.broadcast({ kind: 'background.changed', session }));
    s.characters.on('changed', () => this.broadcast({ kind: 'characters.changed' }));
    s.customCss.on('changed', () => this.broadcast({ kind: 'customCss.changed' }));
    s.themes.on('changed', () => this.broadcast({ kind: 'themes.changed' }));
    s.agents.events.on('reported', () => this.broadcast({ kind: 'agents.changed' }));
    s.bots.on('changed', (bots) => this.broadcast({ kind: 'bots.changed', bots }));
    s.bots.on('run', (run) => this.broadcast({ kind: 'bots.run', run }));
    s.bots.on('inbox', (item) => this.broadcast({ kind: 'bots.inbox', item }));
    s.bots.on('load', (load) => this.broadcast({ kind: 'bots.load', load }));
    s.bots.on('timeline', (entry) => this.broadcast({ kind: 'bots.timeline', entry }));
  }

  /** `fromPeer`: re-broadcast of another machine's event — local clients only (two machines peering each other would echo forever). */
  broadcast(event: ServerEvent, fromPeer = false) {
    const msg = JSON.stringify({ type: 'event', event } satisfies WireDown);
    for (const c of this.clients) if (c.readyState === c.OPEN && !(fromPeer && this.peerConns.has(c))) c.send(msg);
  }

  private send(ws: WebSocket, down: WireDown) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(down));
  }

  private onConnect(ws: WebSocket, req?: IncomingMessage) {
    this.clients.add(ws);
    try { if (req && new URL(req.url ?? '/', 'http://x').searchParams.get('peer')) this.peerConns.add(ws); } catch { /* not a peer */ }
    if (req && ((req.socket as any)?.cwRemote || (req as any).cwDevice)) this.remoteConns.add(ws);
    if (this.peerConns.has(ws) || this.remoteConns.has(ws) || !isLoopback(req?.socket?.remoteAddress)) this.otherScreen.add(ws);
    const fed = this.s.federation;
    this.send(ws, { type: 'event', event: { kind: 'hello', version: this.s.version, ...(fed ? { serverId: fed.serverId, name: fed.name, bootId: fed.bootId } : {}) } });
    // startup discovery happens before anyone is connected: tell each new client what's waiting to be joined
    void this.s.library.detect().then((kinds) => { if (kinds.length) this.send(ws, { type: 'event', event: { kind: 'library.discovered', kinds } }); }).catch(() => {});
    // a window that hosted the built-in browser is gone with its connection: what it was asked fails now, not in 30 s
    ws.on('close', () => { this.clients.delete(ws); this.s.web.dropConnection(ws); this.s.themes.dropConnection(ws); });
    // without a listener, a malformed frame / oversized payload makes ws emit an 'error' that crashes the server
    ws.on('error', () => this.clients.delete(ws));
    ws.on('message', async (raw) => {
      let up: WireUp;
      try {
        up = JSON.parse(String(raw));
      } catch {
        return;
      }
      // this listener is async: a throw here (`null`, missing `request`) would be an unhandled rejection
      if (!up || typeof up !== 'object' || up.type !== 'request' || !up.request || typeof up.request !== 'object' || !up.request.req) return;
      const { id, req } = up.request;
      try {
        const routed = this.s.federation?.route(req, { via: up.request.via, peerConn: this.peerConns.has(ws), local: (r = req) => this.handle(r, ws) });
        const data = await (routed ?? this.handle(req, ws));
        this.send(ws, { type: 'reply', reply: { id, ok: true, data } });
      } catch (e: any) {
        // GitCommandError carries a classified kind + hint; encode them so the client can offer a fix
        const error = e?.info?.kind ? `${e.info.message}\n\n[${e.info.kind}] ${e.info.hint}` : e?.message ?? String(e);
        this.send(ws, { type: 'reply', reply: { id, ok: false, error } });
      }
    });
  }

  /** Remote access, with 在外面也能用 in it when that service exists. */
  private remoteStatus(): RemoteStatus {
    const st = this.s.remote.status();
    return this.s.anywhere ? { ...st, anywhere: this.s.anywhere.status() } : st;
  }

  /** For what only a window on this machine may do: refuses another machine's connection and a remote-access / paired-device one. */
  private localWindowOnly(ws: WebSocket, what: string) {
    if (this.peerConns.has(ws) || this.remoteConns.has(ws)) throw new Error(tr('只有本机的桌面窗口才能提供{what}', { what }));
  }

  /** What a conversation is waiting on the user for: its tools' requests, and what 操控电脑 asked. */
  private pendingOf(sessionId: string) {
    return [...(this.s.pool.get(sessionId)?.getPendingPermissions() ?? []), ...this.s.computer.pendingFor(sessionId), ...(this.s.siteAsk?.pendingFor(sessionId) ?? [])];
  }

  /**
   * A conversation that went on from DeepSeek Harness: what was said there since goes into its transcript
   * (LibraryService.catchUp) — only while nothing of ours is mid-turn in it. A process of it then restarts so its
   * context has those turns. Mid-turn, it is noted and tried again once that process is idle and quiet (a write
   * skipped then was never caught up while the process lived: verifier, 2026-10-22).
   * `wait`: a send is coming — an idle process that is not quiet yet gets a few seconds. `announce`: nobody asked
   * (watcher, retry) — open views re-read (`session.caughtUp`).
   */
  private behindPending = new Set<string>();
  private catchingUp = new Map<string, Promise<number>>();
  private catchUpFromSource(sessionId: string, o: { wait?: boolean; announce?: boolean } = {}): Promise<number> {
    if (!this.s.meta.sessionMeta(sessionId).continuedFrom) return Promise.resolve(0);
    // one at a time per conversation, each after the one before: two at once each restarted the process — two engines
    // on one conversation (verifier, 2026-10-22). A send waiting behind one that wrote still reloads its view.
    const prev = this.catchingUp.get(sessionId);
    const p = (prev ?? Promise.resolve(0)).catch(() => 0).then(async (before) => {
      const n = await this.catchUpOnce(sessionId, o);
      return o.wait ? n + before : n;
    });
    this.catchingUp.set(sessionId, p);
    void p.finally(() => { if (this.catchingUp.get(sessionId) === p) this.catchingUp.delete(sessionId); }).catch(() => {});
    return p;
  }
  private async catchUpOnce(sessionId: string, o: { wait?: boolean; announce?: boolean }): Promise<number> {
    const s = this.s;
    // a send waits only when there is something to bring, and only for what ends soon on its own: a process starting
    // (~5 s after a restart or an open), restarting, or inside its 3 s after a turn — up to 10 s. Background work (a
    // dev server) kept every send waiting 11 s for nothing (verifier, 2026-10-22): that one is caught up after.
    if (o.wait && s.pool.settling(sessionId) && (await s.library.newSince(sessionId)) > 0) {
      for (let i = 0; i < 40 && !s.pool.quiet(sessionId) && s.pool.settling(sessionId); i++) await new Promise((r) => setTimeout(r, 250));
    }
    if (!s.pool.quiet(sessionId)) { this.behindLater(sessionId); return 0; }
    this.behindPending.delete(sessionId);
    const n = await s.library.catchUp(sessionId, () => s.pool.quiet(sessionId)).catch(() => 0);
    // a turn started while the harness was read: next time
    if (!n && !s.pool.quiet(sessionId)) this.behindLater(sessionId);
    if (n && s.pool.get(sessionId)) await s.pool.reloadTranscript(sessionId);
    if (n && o.announce) this.broadcast({ kind: 'session.caughtUp', sessionId });
    return n;
  }

  /** Try again once the process is idle and quiet: now if it already is idle (no state change will come), else on its next `idle`. */
  private behindLater(sessionId: string) {
    this.behindPending.add(sessionId);
    if (this.s.pool.stateOf(sessionId) === 'idle') this.behindRetry(sessionId);
  }
  /** one timer per conversation: every skipped trigger used to start its own chain */
  private behindTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private behindRetry(sessionId: string) {
    if (this.behindTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      this.behindTimers.delete(sessionId);
      if (this.behindPending.has(sessionId)) void this.catchUpFromSource(sessionId, { announce: true });
    }, 3300);
    t.unref?.();
    this.behindTimers.set(sessionId, t);
  }

  private runner(sessionId: string) {
    const r = this.s.pool.get(sessionId);
    if (!r) throw new Error(`session ${sessionId} is not open`);
    return r;
  }

  /** `session.open` after the agent is known and the profile checked: foreign agents resume from their transcript, Claude forks / resumes / starts. */
  private async openSession(params: OpenSessionParams) {
    const s = this.s;
    if (params.agent && params.agent !== 'claude') {
      // the profile a foreign-agent session was started / switched with survives a resume, like Claude's
      if (params.providerId === undefined && params.sessionId) params = { ...params, providerId: s.meta.sessionMeta(params.sessionId).providerId };
      const head = params.sessionId ? await s.transcripts.head(params.sessionId) : null;
      const hist = !params.sessionId ? [] : head?.imported
        ? await s.library.read(params.sessionId).then((r) => r.messages).catch(() => [])
        : await s.transcripts.load(params.sessionId).catch(() => []);
      const before = params.sessionId ? s.pool.get(params.sessionId) : undefined;
      const r = s.pool.open(params, hist);
      await s.canonical.ensure(r.sessionId, params.cwd);
      // recorded only when this open started the process (re-review m-3): a runner handed back as it was runs on its
      // own provider, whatever this request asked for (openOnProvider swaps those)
      if (r !== before && params.providerId && params.providerId !== 'claude' && s.meta.sessionMeta(r.sessionId).providerId !== params.providerId) void s.meta.setSessionMeta(r.sessionId, { providerId: params.providerId }).catch(() => { /* in memory; the next save persists it */ });
      return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), pending: this.pendingOf(r.sessionId) };
    }
    // provider: explicit → the one the session was created with → user default (new sessions only)
    if (params.providerId === undefined) {
      const remembered = params.sessionId ? s.meta.sessionMeta(params.sessionId).providerId : undefined;
      const def = params.sessionId ? undefined : (s.meta.settings().defaultProviderId as string | undefined);
      params = { ...params, providerId: remembered ?? def };
    }
    if (!params.features && s.meta.settings().defaultFeatures) params = { ...params, features: defaultFeaturesOf(s.meta.settings().defaultFeatures) };
    // prompt-cache route key: a fork keeps its parent's (the prefix is the same), decided before the id changes
    const cacheParentId = cacheParentFor(params, (id) => s.meta.sessionMeta(id).cacheKey);
    if (cacheParentId) params = { ...params, cacheParentId };
    // forks: copy the transcript first (SDK forkSession) so the new session has a real id before the process starts
    if (params.sessionId && (params.fork || params.resumeAt)) {
      // right after a turn the CLI is still writing its last answer (~2 s after the result): a copy taken now lost it
      const src = s.pool.get(params.sessionId);
      if (src instanceof SessionRunner) await src.flushed();
      // 只聊天 carries over: the copy gets a new id the pool has no record for (it records it once opened)
      const chatOnly = !!s.meta.sessionMeta(params.sessionId).chatOnly;
      const thinkingLanguage = s.meta.sessionMeta(params.sessionId).thinkingLanguage;
      const newId = await s.sessions.fork(params.sessionId, params.resumeAt);
      // …and so does its 思考语言, before the pool reads it for the new id
      if (thinkingLanguage) await s.meta.setSessionMeta(newId, { thinkingLanguage });
      params = { ...params, sessionId: newId, fork: false, resumeAt: undefined, ...(chatOnly ? { features: { ...params.features, chatOnly: true } } : {}) };
    }
    const before = params.sessionId ? s.pool.get(params.sessionId) : undefined;
    const r = s.pool.open(params);
    if (cacheParentId && cacheParentId !== r.sessionId && s.meta.sessionMeta(r.sessionId).cacheKey !== cacheParentId) void s.meta.setSessionMeta(r.sessionId, { cacheKey: cacheParentId }).catch(() => { /* in memory; the next save persists it */ });
    await s.canonical.ensure(r.sessionId, params.cwd);
    if (r !== before && params.providerId && params.providerId !== 'claude') {
      // remember which provider a session uses so resume / fork keep it (the id is known up front: new sessions get a
      // uuid from us) — only when this open started the process (re-review m-3: a live runner keeps its own provider)
      if (s.meta.sessionMeta(r.sessionId).providerId !== params.providerId) void s.meta.setSessionMeta(r.sessionId, { providerId: params.providerId }).catch(() => { /* in memory; the next save persists it */ });
    }
    return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), pending: this.pendingOf(r.sessionId) };
  }

  private async handle(req: ClientRequest, ws: WebSocket): Promise<unknown> {
    const s = this.s;
    // about to go out (a CLI starts, a provider is asked): the system proxy may have changed since the last look —
    // resolves at once when that look is under a minute old (net/proxy.ts)
    if (GOES_OUT.has(req.kind)) await proxy.refresh();
    // a bot's own conversation stays the gated Claude conversation the bot page set up: no provider / agent swap (the
    // pool would refuse the ungated reopen and the thread would die), no handoff (it would turn read-only)
    refuseOnThread(req, (id) => !!s.bots.threads.isThread(id));
    if (isAgentConfigRequest(req)) return handleAgentConfig(s.agentConfig, req);
    if (isOrchestraRequest(req)) return handleOrchestra(s.orchestra, req);
    if (isBackgroundRequest(req)) return handleBackground(s.background, req);
    if (isCharactersRequest(req)) return handleCharacters(s.characters, req, this.peerConns.has(ws) || this.remoteConns.has(ws));
    if (isCloudRequest(req)) return handleCloud(s.cloud, req, { peer: this.peerConns.has(ws), remote: this.remoteConns.has(ws) });
    switch (req.kind) {
      case 'sessions.list': {
        // a bot's thread, its runs and internal work are reached from the Bot page, never the list (bots/hidden.ts)
        const all = (await s.library.list()).filter((x) => !isBotSession(s.meta.sessionMeta(x.sessionId), x));
        const list = req.limit ? all.slice(0, req.limit) : all;
        // a folder the list could not read (issue #9) is known to the conversation's own process while it runs
        return list.map((x) => {
          const pending = s.meta.sessionMeta(x.sessionId).pendingTitle;
          return { ...x, ...(pending ? { title: pending } : {}), cwd: x.cwd || s.pool.get(x.sessionId)?.cwd || '', live: s.pool.stateOf(x.sessionId) };
        });
      }
      case 'sessions.projects':
        return s.sessions.projects();
      case 'transcript.load': {
        // imported sessions (and anything a joined foreign source lists) are read from the agent itself
        const head = await s.transcripts.head(req.sessionId);
        // ours (the mirror) — the library first brings in turns the agent's own CLI added since (Codex)
        if (head && !head.imported) return (await s.library.read(req.sessionId)).messages;
        if (head?.imported || (await s.library.kindOf(req.sessionId)) !== 'claude') return (await s.library.read(req.sessionId)).messages;
        // a Claude conversation that went on from DeepSeek Harness: what was said there since, first
        if (!req.cursor) await this.catchUpFromSource(req.sessionId);
        const state = s.pool.stateOf(req.sessionId);
        const msgs = withTurnStats(await s.sessions.transcript(req.sessionId), await s.ledger.rowsFor(req.sessionId), { live: state === 'running' || state === 'waiting' || state === 'starting' });
        if (!req.page) return msgs;
        return pageOf(msgs, req.cursor, this.remoteConns.has(ws) || this.peerConns.has(ws) ? REMOTE_PAGE_BYTES : LOCAL_PAGE_BYTES);
      }
      case 'transcript.subagents':
        return s.sessions.subagents(req.sessionId);
      case 'transcript.subagent':
        return s.sessions.subagent(req.sessionId, req.agentId);

      case 'session.open': {
        // `gated` is set by the server for a bot's run only, never by a window
        let params = clientSessionParams(req.params);
        // a bot's own conversation opens only gated, as the bot set it up: the window's model / mode / provider are not
        // its to pick (a fork or a rewind of it goes on as below: a copy, not the bot's)
        const threadOf = params.sessionId && !params.fork && !params.resumeAt ? s.bots.threads.isThread(params.sessionId) : undefined;
        if (threadOf) {
          const r = await s.bots.openThread(threadOf);
          await s.canonical.ensure(r.sessionId, r.cwd);
          return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), pending: this.pendingOf(r.sessionId) };
        }
        // 发送前核对权限: the chip showed another mode than the resume would run in — do not start, say which it is
        {
          const changed = s.pool.modeMismatch(params);
          if (changed) return { modeChanged: changed };
          if (params.expectMode !== undefined) { params = { ...params }; delete params.expectMode; }
        }
        // stage E5: a WSL conversation needs Claude Code in that distro (interop off still opens: the runner drops the MCP)
        if (params.env?.kind === 'wsl') {
          if (!s.wsl) throw new Error('no WSL');
          const d = await s.wsl.check(params.env.distro);
          if (d.claude === false) throw new Error(tr('{d} 里没有 Claude Code，先在「选机器」里安装', { d: d.name }));
        }
        // DeepSeek Harness (SourceCaps.continueInClaude): a send goes on in the Claude conversation that replays it, on
        // any provider — never in the harness (its own DeepSeek key). Before the head check: an earlier version left an
        // imported `dsh` head that would start the harness again. The reply's other sessionId re-keys the client.
        if (params.sessionId && !params.agent && s.library.continuesInClaude(params.sessionId)) {
          const c = await s.library.continuation(params.sessionId);
          // a new one runs where a new conversation would (what its chips showed), unless one was picked; a subagent
          // model picked on its chips was recorded under the harness id
          if (c.created) {
            const sub = s.meta.sessionMeta(params.sessionId).subagent;
            await s.meta.setSessionMeta(c.sessionId, { providerId: normProvider(params.providerId ?? s.pool.defaultProviderFor('claude')), ...(sub ? { subagent: sub } : {}) });
          }
          params = { ...params, sessionId: c.sessionId, cwd: c.cwd, agent: 'claude', fork: false, resumeAt: undefined };
        }
        // …and what was said in the harness since, before the engine reads the transcript (never while it has it); a
        // client showing the old history reloads it (`caughtUp`)
        const caughtUp = params.sessionId && !params.fork ? await this.catchUpFromSource(params.sessionId) : 0;
        // resuming a foreign-agent session: the transcript head knows which agent it belongs to
        if (params.sessionId && !params.agent) {
          const head = await s.transcripts.head(params.sessionId);
          if (head) params = { ...params, agent: head.agent, fork: false, resumeAt: undefined };
          else if ((await s.library.kindOf(params.sessionId)) !== 'claude') {
            // a library session from another agent's own store: give it a resume head first, so the
            // Codex / ACP driver continues the native thread and new turns land in the agent's record
            const r = await s.library.prepareResume(params.sessionId);
            params = { ...params, agent: r.agent, cwd: params.cwd || r.cwd, fork: false, resumeAt: undefined };
          }
        }
        // worktree 位置 / 分支前缀 (spec 2026-10-16 sessions-env §4): Claude Code's --worktree always makes
        // <repo>/.claude/worktrees/<name> on worktree-<name>. With either setting the worktree is made here instead (and
        // .worktreeinclude copied, which the CLI does for its own), then the conversation starts in it, listed under the repo
        let worktreeRoot: string | undefined;
        if (params.worktree && !params.sessionId && (params.agent ?? 'claude') === 'claude') {
          const set = s.meta.settings();
          const where = typeof set['worktree.dir'] === 'string' ? set['worktree.dir'].trim() : '';
          const prefix = typeof set['worktree.prefix'] === 'string' ? set['worktree.prefix'].trim() : '';
          const root = where || prefix ? await s.git.root(params.cwd) : null;
          if (root) {
            const name = params.worktree;
            const wt = await s.git.worktreeAdd(root, name, { branch: `${prefix || 'worktree-'}${name}`, dir: where ? path.join(resolveWorktreeDir(where), `${path.basename(root)}-${name}`) : undefined });
            await copyWorktreeIncludes(root, wt.path);
            params = { ...params, cwd: wt.path, worktree: undefined };
            worktreeRoot = root;
          }
        }
        // an explicitly chosen profile must fit the agent / engine (welcome page, schedules, IM, orchestration all land here)
        const unfitOpen = s.providers.fitError(req.params.providerId, params.agent ?? 'claude');
        if (unfitOpen) throw new Error(unfitOpen);
        // an existing conversation opened with an explicit provider (a pick on a history conversation's chips, another
        // window, a client whose state is stale — IM, schedules and orchestration open through the pool, not here):
        // not running on the recorded one → open, then the same bookkeeping as session.setProvider (SessionMeta, the
        // account clears it; the canonical switch line); running on another one → session.setProvider's swap. Under
        // the conversation's lock (openOnProvider)
        const nameOf = (id: string) => (normProvider(id) ? s.providers.forSession(id)?.name ?? id : tr('Claude 账号'));
        const opened = await openOnProvider({ pool: s.pool, meta: s.meta, canonical: s.canonical }, params, nameOf, {
          open: async (p) => {
            const r = await this.openSession(p);
            if (worktreeRoot) { await s.meta.setSessionMeta(r.sessionId, { groupCwd: worktreeRoot }); s.sessions.emit('changed'); }
            return r;
          },
          // running on another provider: the same as session.setProvider (re-review m-3)
          swapped: (r) => ({ ...r, pending: this.pendingOf(r.sessionId) }),
          onRecorded: () => s.sessions.emit('changed'),
        });
        return caughtUp ? { ...opened, caughtUp } : opened;
      }
      case 'session.info': {
        const r = this.runner(req.sessionId);
        return { info: r.info, history: r.getHistory(), pending: this.pendingOf(r.sessionId) };
      }
      case 'session.send': {
        // `<session-ref>` markers (inserted by the composer when the user references another
        // library session) get expanded into a briefing only for the agent — the local echo and
        // the canonical mirror below keep the original, unexpanded text the user actually typed.
        let outgoing = req.params.text;
        if (outgoing.includes('<session-ref ')) {
          outgoing = await expandSessionRefs(outgoing, (id) => s.library.readAll(id));
        }
        await afterSwitch(req.params.sessionId); // a switch in progress: the new process takes it
        this.s.pool.assertWritable(req.params.sessionId); // handed to another machine (F4): read-only here
        const runner = this.runner(req.params.sessionId);
        // a bot's own conversation: what happened since the user last wrote goes in front, for the model only — the
        // user's text loses any such block of its own first, and only the server's goes through (serverSend)
        outgoing = s.bots.threads.withEvents(req.params.sessionId, stripBotTags(outgoing));
        serverSend(runner, outgoing, req.params.images, req.params.steer, req.params.uuid, req.params.attachments);
        // Neither path echoes the user's own message back through the pool (the SDK doesn't, and the
        // foreign drivers `record()` it without emitting), so the canonical mirror has to be told here
        // — otherwise a handover briefing would have no idea what was actually asked for.
        s.canonical.observe(req.params.sessionId, { type: 'user', uuid: req.params.uuid, message: { role: 'user', content: [{ type: 'text', text: req.params.text }] } });
        // foreign agents: first prompt becomes the title (Claude's transcripts derive it themselves)
        const head = await s.transcripts.head(req.params.sessionId);
        if (head && !head.title) { await s.transcripts.patchHead(req.params.sessionId, { title: req.params.text.replace(/<attached[^>]*\/>/g, '').trim().slice(0, 80) }); s.sessions.emit('changed'); }
        return null;
      }

      case 'workspaces.list':
        return s.meta.workspaces();
      case 'workspaces.add': {
        // a project folder is a trust root (network paths inside it are let through): never a share another machine names
        refusePeerUnc(req.path, this.peerConns.has(ws));
        const w = await s.meta.addWorkspace(req.path);
        return s.meta.workspaces().find((x) => x.id === w.id) ?? w;
      }
      case 'workspaces.remove':
        await s.meta.removeWorkspace(req.id);
        return null;
      case 'workspaces.rename':
        await s.meta.renameWorkspace(req.id, req.name);
        return null;
      case 'workspaces.reorder':
        await s.meta.reorderWorkspaces(req.ids);
        return null;
      case 'workspaces.update': {
        // the folders must be a list of existing folders: checked here (the page cannot), one sentence naming the first
        // that is not; a network folder only from this user's own windows, and its stat bounded (folder-check.ts)
        await checkExtraFolders(req.folders, { fromPeer: this.peerConns.has(ws) });
        // what goes into every new conversation's system prompt / permission mode: only a string of bounded length, only a real mode
        if (req.instructions != null && (typeof req.instructions !== 'string' || req.instructions.length > 20_000)) throw new Error(tr('项目说明不能超过 20000 个字'));
        if (req.permissionMode != null && !asMode(req.permissionMode)) throw new Error(tr('没有这个权限模式'));
        if (req.sessionsScope != null && req.sessionsScope !== 'project') throw new Error(tr('不认识这个范围'));
        const w = await s.meta.updateWorkspace(req.id, { name: req.name, folders: req.folders, instructions: req.instructions, sessionsScope: req.sessionsScope, permissionMode: req.permissionMode });
        if (!w) throw new Error(tr('这个项目已经不在了'));
        return w;
      }
      case 'sessions.meta':
        return s.meta.allSessionMeta();
      case 'session.setMeta':
        await s.meta.setSessionMeta(req.sessionId, req.patch);
        // 思考用的语言 of this conversation: its running process restarts with it once idle
        if ('thinkingLanguage' in req.patch) s.pool.thinkingLanguageChanged(req.sessionId, req.patch.thinkingLanguage ?? '');
        return null;
      case 'schedules.list':
        return s.meta.schedules();
      case 'schedules.upsert': {
        // validate before persisting: a bad cron saved first would sit in meta.json and fail every tick
        // (nextCron parses and also rejects expressions that never fire, e.g. "0 0 30 2 *")
        if (typeof req.schedule.cron === 'string' && req.schedule.cron.trim()) nextCron(req.schedule.cron);
        const cur = await s.meta.upsertSchedule(req.schedule);
        // timing changed (or first enable) → recompute the next run from the new cron / interval
        if (cur.enabled && (req.schedule.cron !== undefined || req.schedule.everyMinutes !== undefined || req.schedule.enabled !== undefined || !cur.nextRunAt)) await s.meta.touchSchedule(cur.id, { nextRunAt: s.schedules.nextRun(cur) });
        return s.meta.schedules().find((x) => x.id === cur.id);
      }
      case 'schedules.remove':
        await s.meta.removeSchedule(req.id);
        return null;
      case 'schedules.runNow': {
        const sc = s.meta.schedules().find((x) => x.id === req.id);
        if (!sc) throw new Error('schedule not found');
        // manual: the next scheduled time stays as it was (it used to move to "now + one period" on every click)
        await s.schedules.run(sc, true);
        return null;
      }
      case 'limits.get':
        return s.limits.get(req.force);
      case 'engine.info':
        return { ...(await engineInfo()), computerUse: computerSupported() };
      case 'engine.cli':
        return runClaudeCli(req.args, { cwd: req.cwd, timeoutMs: 120_000 });
      case 'providers.list':
        return s.providers.list();
      case 'providers.upsert': {
        const saved = await s.providers.upsert(req.provider);
        s.pool.providerSaved(saved.id);
        return saved;
      }
      case 'providers.remove':
        await s.providers.remove(req.id);
        return null;
      case 'providers.probe':
        return s.providers.probe(req.id, req.provider, { listOnly: req.listOnly });
      case 'providers.refreshModels':
        return s.providers.refreshModels(req.ids);
      case 'import.scan':
        return s.importer.scan();
      case 'import.run': {
        const r = await s.importer.run(req.keys);
        // the new providers' model lists, pulled before answering (the window lists them right after)
        if (r.providers.length) await s.providers.refreshModels(r.providers).catch(() => {});
        return r;
      }
      case 'settings.get':
        // the search engines' keys and the remote sync credentials are stored protected and read as masks here
        return maskOtlpSettings(maskSyncRemoteSettings(maskWebSettings(s.meta.settings())));
      case 'network.proxy':
        return proxy.refresh(!!req.refresh);
      case 'settings.set':
        // remote sync credentials are only written through sync.remote.set (encrypted by SecretService)
        if (req.key === 'sync.remote') throw new Error(tr('远程同步设置请在「备份与同步」里保存'));
        // the OTLP collector's headers are only written through telemetry.otlp.set (encrypted by SecretService)
        if (req.key === 'telemetry.otlp') throw new Error(tr('OTLP 导出请在模型中心的设置里修改'));
        if (req.key === 'network.proxy') {
          const p = parseProxySetting(req.value); // throws a sentence on SOCKS / junk
          await s.meta.setSetting(req.key, p.mode === 'custom' ? p.url : p.mode === 'off' ? 'off' : undefined);
          s.web.networkChanged(); // a search engine that could not be reached is tried again
          return proxy.refresh(true);
        }
        // a search engine's API key: protected at rest, the mask sent back keeps what is stored, '' removes it
        if (isWebKeySetting(req.key)) { await s.web.setKey(req.key, req.value); return null; }
        await s.meta.setSetting(req.key, req.value);
        // the language of what the server words from now on (the page reloads itself)
        if (req.key === LANGUAGE_KEY) applyLanguage(req.value);
        // 思考用的语言 (跟随界面语言 follows the language above): running conversations restart with it once idle
        if (req.key === THINKING_LANGUAGE_KEY) setThinkingLanguageSetting(req.value);
        if (req.key === THINKING_LANGUAGE_KEY || req.key === LANGUAGE_KEY) s.pool.thinkingLanguageChanged();
        // takes effect on the next session start — running children keep the servers they were given
        if (req.key === 'memory.mcp') setMemoryMcpEnabled(req.value !== false);
        if (req.key === 'ui.promptSuggestions') setPromptSuggestions(req.value !== false);
        if (req.key === NODEGRAPH_HINT_KEY) setNodegraphHint(req.value !== false);
        if (req.key === 'sessions.mcp') setSessionsMcpEnabled(req.value !== false);
        if (req.key === 'claude.desktopSkills') setDesktopSkillsEnabled(req.value !== false);
        if (req.key === 'web.mcp') setWebMcpEnabled(req.value !== false);
        if (req.key === 'web.browser.agent') setWebAgentBrowser(req.value);
        if (req.key.startsWith('web.')) s.web.settingsChanged(); // web.status reads differently now
        // 在外面也能用: brokers / STUN / the shell address / on-off / keep-awake (restarts only when it has to)
        if (req.key === 'remote.anywhere' || req.key.startsWith('remote.anywhere.') || req.key === 'remote.keepAwake') await s.anywhere?.refresh();
        return null;
      case 'sessions.search':
        return (await s.library.search(req.query, req.limit ?? 30)).filter((h) => !isBotSession(s.meta.sessionMeta(h.session.sessionId), h.session));

      // ---- unified session library ----
      case 'library.sources':
        return s.library.sources();
      case 'library.localScan':
        return scanLocalHistory();
      case 'library.catchUp':
        return this.catchUpFromSource(req.sessionId, { wait: true });
      case 'library.read':
        // a conversation that went on from DeepSeek Harness: what was said there since comes over first (catchUp)
        if (!req.cursor) await this.catchUpFromSource(req.sessionId);
        return s.library.read(req.sessionId, req.cursor, req.limit);
      case 'library.rename':
        await renameKept(s, req.sessionId, req.title);
        return null;
      case 'library.archive':
        return s.library.archive(req.sessionIds, req.archived);
      case 'library.delete':
        for (const id of req.sessionIds) await s.pool.close(id);
        return s.library.remove(req.sessionIds);
      case 'library.fork':
        return s.library.fork(req.sessionId);
      case 'library.reindex':
        await s.library.refreshIndex();
        return null;
      case 'library.join':
        await s.library.join(req.kind_, req.joined);
        return s.library.sources();
      case 'library.dismiss':
        await s.library.dismiss(req.kind_);
        return s.library.sources();
      case 'shell.open':
        openPath(req.path, req.app);
        return null;
      case 'env.list': return { names: s.localEnv?.names() ?? [] };
      case 'env.reveal': return { value: (await s.localEnv?.reveal(req.name)) ?? '' };
      case 'env.set': {
        if (!s.localEnv) throw new Error('local env unavailable');
        try { await s.localEnv.set(req.name, req.value); } catch (e: any) {
          throw new Error(e?.message === 'reserved' ? tr('{name} 由供应商设置决定，不能在这里改', { name: req.name }) : e?.message === 'exists' ? tr('已经有一个只是大小写不同的 {name}：Windows 上它们是同一个变量', { name: req.name }) : e?.message === 'invalid' ? tr('变量名只能用字母、数字和下划线，且不以数字开头') : String(e?.message ?? e));
        }
        return { names: s.localEnv.names() };
      }
      case 'artifacts.list':
        return { items: await recentArtifacts(s.library) };
      case 'app.changelog':
        return { markdown: readChangelog(String(req.lang ?? 'en')), version: s.version };
      case 'shell.editors':
        return { editors: await installedEditors() };
      case 'themes.list':
        return s.themes.list().filter(usable);
      case 'themes.delete':
        this.localWindowOnly(ws, tr('字符画主题'));
        return { deleted: s.themes.remove(String(req.id)) };
      case 'themes.trialHost':
        // a draft runs in a window on this machine (a phone or a peer is not handed someone's code)
        this.localWindowOnly(ws, tr('字符画主题'));
        s.themes.setHost(ws, !!req.on, (r) => this.send(ws, { type: 'event', event: { kind: 'themes.trial', id: r.id, source: { id: r.source.id, json: r.source.json, backdrop: r.source.backdrop, css: r.source.css } } }));
        return null;
      case 'themes.trialResult':
        this.localWindowOnly(ws, tr('字符画主题'));
        return { taken: s.themes.trialResult(ws, String(req.id), { png: req.png, errors: req.errors, avgMs: req.avgMs, maxMs: req.maxMs, note: req.note }) };
      case 'ui.customCss':
        return s.customCss.read();
      case 'ui.customCss.create':
        return { path: s.customCss.create() };
      case 'session.side': {
        // a conversation not running here (closed, idle-reclaimed, history): the client opens it and asks again
        const r = s.pool.get(req.sessionId);
        if (!r) return { error: 'not-open' };
        if (!(r instanceof SessionRunner)) return { error: 'unsupported' };
        return r.askSide(req.question, req.history ?? []);
      }
      case 'session.interrupt': {
        // no process (closed, crashed, the server restarted): nothing is running here — the client says so and ends
        // the turn it still shows, instead of a Stop button that errors in silence
        const r = s.pool.get(req.sessionId);
        if (!r) return { running: false };
        await r.interrupt();
        return { running: true };
      }
      case 'session.close':
        await s.pool.close(req.sessionId);
        return null;
      case 'session.resumeMode':
        // the chip of a conversation that is not running shows what the next send really runs in (pool.open uses the same)
        return { permissionMode: s.pool.resumeMode(req.sessionId) };
      case 'session.setPermissionMode':
        await afterSwitch(req.sessionId);
        await this.runner(req.sessionId).setPermissionMode(req.mode);
        return null;
      case 'session.setModel': {
        await afterSwitch(req.sessionId);
        const r = this.runner(req.sessionId);
        // picked for the provider this window saw: another window switched in the meantime → the model may not even
        // exist there (it was applied anyway and every turn failed "issue with the selected model")
        if (req.providerId !== undefined && normProvider(req.providerId) !== normProvider(r.info.providerId)) throw new Error(tr('这个对话刚刚换了供应商，这次选的模型没有用上，请在模型菜单里重新选'));
        await r.setModel(req.model);
        return null;
      }
      case 'session.setEffort':
        await afterSwitch(req.sessionId);
        await this.runner(req.sessionId).setEffort?.(req.effort);
        return null;
      case 'session.setUltracode':
        await afterSwitch(req.sessionId);
        await this.runner(req.sessionId).setUltracode?.(req.on);
        return null;
      // the subagents' model: the conversation's own from now on (also one that is not running: its next start takes it)
      case 'session.setSubagentModel': {
        await afterSwitch(req.sessionId);
        const live = s.pool.get(req.sessionId);
        const on = live && live.state !== 'closed' && live.state !== 'error' ? live : undefined;
        // a whole pick (provider + model): a plain id is a model of the provider the window picked it on
        const providerId = req.providerId ?? (on ? on.info.providerId : s.meta.sessionMeta(req.sessionId).providerId);
        const model = fullPick(req.model, providerId);
        await s.meta.setSessionMeta(req.sessionId, { subagent: { providerId: providerKey(providerId), model } });
        await on?.setSubagentModel?.(model);
        return null;
      }
      // Swapping the provider or the agent behind a live session. Both are an invisible restart:
      // the CLI's env is fixed at spawn, so "no restart" can only mean the user never sees one.
      case 'session.setProvider': {
        // 'claude' = back to the account, like no provider at all (the window sends either)
        const own = !req.providerId || req.providerId === CLAUDE_PROVIDER_ID;
        const p = own ? undefined : s.providers.forSession(req.providerId);
        if (!own && !p) throw new Error(tr('没有这个供应商'));
        // the agent behind the session must be able to use this profile type (Codex cannot talk to an Anthropic relay…)
        const agent = s.pool.get(req.sessionId)?.info.agent ?? (await s.transcripts.head(req.sessionId).catch(() => null))?.agent ?? 'claude';
        const unfit = s.providers.fitError(req.providerId, agent);
        if (unfit) throw new Error(unfit);
        const r = await swapProvider({ pool: s.pool, canonical: s.canonical, transcripts: s.transcripts, meta: s.meta }, req.sessionId, req.providerId, p?.name ?? tr('Claude 账号'), req.model); // serialised per session inside
        s.sessions.emit('changed');
        return r;
      }
      case 'session.switchAgent': {
        const readAll = (id: string) => s.library.readAll(id);
        // imported library sessions hand over into a NEW session (returned sessionId differs); the rest swap in place
        const imported = (id: string) => s.library.importedInfo(id);
        const r = await swapAgent({ pool: s.pool, canonical: s.canonical, transcripts: s.transcripts, meta: s.meta, readAll, imported }, req.sessionId, req.agent, req.model);
        s.sessions.emit('changed');
        return r;
      }
      case 'session.canonical':
        return s.canonical.load(req.sessionId);

      // ---- shared memory (also reachable by every agent over MCP; see memory/mcp.ts) ----
      case 'memory.search':
        return s.memory.search({ q: req.query, scope: req.scope, cwd: req.cwd, sessionId: req.sessionId, botId: req.botId, kind: req.kind_, limit: req.limit });
      case 'memory.write':
        return s.memory.write({ text: req.text, scope: req.scope, key: (req.scope ?? 'project') === 'session' ? req.sessionId ?? '' : req.cwd ?? '', kind: req.kind_, tags: req.tags, pinned: req.pinned, sourceSession: req.sessionId });
      case 'memory.update':
        return s.memory.update(req.id, req.patch) ?? null;
      case 'memory.remove':
        return s.memory.remove(req.id);
      case 'memory.stats':
        return s.memory.stats();
      case 'memory.harvest': {
        // pull the durable facts out of a finished session: dead ends, decisions, constraints
        const events = await s.canonical.load(req.sessionId);
        const cwd = s.pool.get(req.sessionId)?.cwd ?? (await s.canonical.head(req.sessionId))?.cwd ?? '';
        if (!cwd) throw new Error(tr('这个对话没有可用的目录'));
        return harvest(s.memory, events, { cwd, sessionId: req.sessionId, agent: s.pool.get(req.sessionId)?.info.agent });
      }
      // ---- 联网: search + the built-in browser (every agent reaches them over MCP; see web/mcp.ts) ----
      case 'web.status':
        return s.web.status();
      case 'web.egoDetect':
        await egoStatus(true);
        return s.web.status();
      case 'web.allowedSites.remove': {
        const r = await s.web.removeSite(String(req.host ?? ''));
        s.web.settingsChanged();
        return r;
      }
      case 'web.search':
        return s.web.search(req.query, { count: req.count });
      case 'browser.host':
        // the built-in browser is a desktop window's on this machine: a phone or another machine cannot be it
        this.localWindowOnly(ws, tr('内置浏览器'));
        s.web.setHost(ws, !!req.on, (command) => this.send(ws, { type: 'event', event: { kind: 'browser.command', command } }));
        return s.web.status();
      case 'browser.result':
        this.localWindowOnly(ws, tr('内置浏览器'));
        // false: nothing was waiting for it any more (it came after the 30 s, or the command was another window's)
        return { taken: s.web.result(ws, String(req.id), !!req.ok, req.answer, req.error) };

      // legacy shapes, same routing as library.rename / library.delete — so every delete path backs up first
      case 'session.rename':
        await renameKept(s, req.sessionId, req.title);
        s.sessions.emit('changed');
        return null;
      case 'session.delete': {
        await s.pool.close(req.sessionId);
        const r = await s.library.remove([req.sessionId]);
        if (r.failed.length) throw new Error(r.failed[0].error);
        s.sessions.emit('changed');
        return null;
      }
      case 'session.contextUsage':
        return this.runner(req.sessionId).contextUsage?.(req.detail ?? 'summary') ?? null;
      case 'feedback.set':
        await s.meta.setFeedback(req.sessionId, req.messageId, req.rating ? { rating: req.rating, note: req.note, at: Date.now() } : null);
        return null;
      case 'feedback.list':
        return s.meta.feedback(req.sessionId);
      case 'drafts.set':
        await s.meta.setDraft(req.key, req.text);
        return null;
      case 'drafts.get':
        return s.meta.draft(req.key);
      case 'export.save':
        return s.files.saveExport(req.name, req.html);
      case 'session.fastMode': {
        const r = this.runner(req.sessionId);
        if (!r.setFastMode) throw new Error(tr('这个对话的 Agent 没有快速模式'));
        await r.setFastMode(req.on);
        return null;
      }
      case 'session.toggleMcp': {
        const r = this.runner(req.sessionId);
        if (!r.toggleMcp) throw new Error(tr('这个对话的 Agent 不能在对话里开关连接器'));
        await r.toggleMcp(req.name, req.enabled);
        return null;
      }
      case 'preview.list':
        return s.previews?.list(req.cwd) ?? null;
      case 'preview.start': {
        if (!s.previews) throw new Error(tr('这里没有预览服务器'));
        return s.previews.start(req.cwd, req.name);
      }
      case 'session.stopTask':
        await this.runner(req.sessionId).stopTask?.(req.taskId);
        return null;
      case 'permission.respond': {
        if (s.computer.respond(req.requestId, req.response)) return null;
        if (s.siteAsk?.respond(req.requestId, req.response)) return null;
        const r = s.pool.findPermission(req.requestId);
        if (!r) throw new Error('permission request not found (already answered?)');
        r.respondPermission(req.requestId, req.response);
        return null;
      }

      case 'config.overview':
        return s.config.overview();
      case 'config.plugins':
        return s.config.plugins();
      case 'config.plugin.toggle':
        return s.config.pluginToggle(req.name, req.enable);
      case 'config.plugin.install':
        return s.config.pluginInstall(req.spec);
      case 'config.plugin.uninstall':
        return s.config.pluginUninstall(req.name);
      case 'config.marketplaces':
        return s.config.marketplaces();
      case 'config.marketplace.add':
        return s.config.marketplaceAdd(req.source);
      case 'config.mcp':
        return s.config.mcp();
      case 'config.mcp.add':
        return s.config.mcpAddWarm(req.name, req.json, req.scope, req.cwd);
      case 'config.mcp.remove':
        return s.config.mcpRemove(req.name, req.scope, req.cwd);
      case 'config.mcp.get':
        return s.config.mcpGet(req.name, req.cwd);
      case 'config.mcp.update':
        return s.config.mcpUpdate(req.name, req.json, req.cwd, req.from);
      case 'config.auth':
        return s.config.auth(req.force);
      case 'config.settings.read':
        return s.config.settingsRead(req.scope, req.cwd);
      case 'config.settings.write':
        return s.config.settingsWrite(req.scope, req.json, req.cwd);
      case 'config.skills':
        return s.config.skills();
      case 'config.agents':
        return s.config.agents();
      case 'config.hooks':
        return s.config.hooks();
      case 'config.doctor':
        return s.config.doctor();
      case 'config.compactSource':
        return userCompactSource();

      case 'usage.session': {
        const file = await s.sessions.locate(req.sessionId);
        if (!file) throw new Error('transcript not found');
        return s.usage.session(file);
      }
      case 'usage.global':
        return s.usage.global(req.days);

      case 'files.changed': {
        const file = await s.sessions.locate(req.sessionId);
        if (!file) return [];
        return s.files.changed(file);
      }
      case 'files.diff':
        return s.files.diff(req.path);
      case 'fs.findFiles': {
        // a project folder: absolute and a directory (an empty root would list the server's own folder); a network
        // path only inside a project folder the user added (files/service.ts pathAllowed — the same check)
        if (!req.root || !path.isAbsolute(req.root) || !s.files.pathAllowed(req.root) || !(await fs.promises.stat(req.root).then((st) => st.isDirectory(), () => false))) return { files: [] };
        const limit = Math.max(1, Math.min(Math.floor(Number(req.limit) || 30), 100));
        return { files: rankFiles(await listProjectFiles(req.root), String(req.query ?? ''), limit) };
      }
      case 'fs.list':
        return s.files.list(req.path);
      case 'fs.read':
        return s.files.read(req.path);
      case 'fs.pickDir': {
        if (this.otherScreen.has(ws)) return req.fallback ? { unavailable: 'remote' } : null;
        const r = await s.terminal.pickDir();
        return typeof r === 'object' && r && !req.fallback ? null : r;
      }
      case 'fs.dirs':
        return s.files.dirs(req.path);
      case 'fs.stat':
        return s.files.stat(req.path);
      case 'fs.open':
        return s.files.open(req.path);
      case 'fs.write':
        return s.files.write(req.path, req.text, req.expectMtime);
      case 'fs.mkdir':
        await s.files.mkdir(req.path);
        return null;
      case 'fs.create':
        await s.files.create(req.path, req.text);
        return null;
      case 'fs.rename':
        await s.files.rename(req.from, req.to);
        return null;
      case 'fs.copy':
        await s.files.copy(req.from, req.to);
        return null;
      case 'fs.trash':
        await s.files.trash(req.paths);
        return null;
      case 'fs.watch':
        await s.files.watch(req.path);
        return null;
      case 'fs.unwatch':
        await s.files.unwatch(req.path);
        return null;
      case 'search.run':
        return s.search.search(req.root, req.query, req.options);
      case 'search.replace':
        return s.search.replace(req.root, req.query, req.replacement, { ...req.options, targets: req.targets });
      case 'git.status':
        return s.git.status(req.cwd);
      case 'git.diff':
        return s.git.diff(req.cwd, req.path, !!req.staged);
      case 'git.stage':
        await s.git.stage(req.cwd, req.files);
        return null;
      case 'git.unstage':
        await s.git.unstage(req.cwd, req.files);
        return null;
      case 'git.discard':
        await s.git.discard(req.cwd, req.files);
        return null;
      case 'git.commit':
        return s.git.commit(req.cwd, req.message, { amend: req.amend, all: req.all });
      case 'git.log':
        return s.git.log(req.cwd, req.n, req.rev);
      case 'git.show':
        return s.git.show(req.cwd, req.rev);
      case 'git.branches':
        return s.git.listBranches(req.cwd);
      case 'git.checkout':
        await s.git.checkout(req.cwd, req.name, { create: req.create, from: req.from });
        return null;
      case 'git.deleteBranch':
        await s.git.deleteBranch(req.cwd, req.name, req.force);
        return null;
      case 'git.fetch':
        await s.git.fetch(req.cwd);
        return null;
      case 'git.pull':
        return s.git.pull(req.cwd, req.rebase ?? true);
      case 'git.push':
        return s.git.push(req.cwd, { setUpstream: req.setUpstream, force: req.force });
      case 'git.stash':
        return s.git.stash(req.cwd, req.op, req.message);
      case 'git.worktrees':
        return s.git.worktrees(req.cwd);
      case 'git.worktreeAdd':
        return s.git.worktreeAdd(req.cwd, req.name, { branch: req.branch, from: req.from, dir: req.dir });
      case 'git.worktreeRemove':
        await s.git.worktreeRemove(req.cwd, req.dir, req.force);
        return null;
      case 'git.remotes':
        return s.git.remotes(req.cwd);
      case 'git.watch':
        return s.git.watch(req.cwd);
      case 'skills.list':
        return s.skills.list(req.cwd);
      case 'skills.install':
        return s.skills.install({ source: req.source, scope: req.scope, cwd: req.cwd, name: req.name });
      case 'skills.create':
        return s.skills.create({ name: req.name, scope: req.scope, cwd: req.cwd, description: req.description });
      case 'skills.remove':
        await s.skills.remove(req.path);
        return null;
      case 'skills.backup':
        return s.skills.backup();
      case 'skills.restore':
        await s.skills.restore(req.file);
        return null;
      case 'tools.detect':
        return detectTools();
      case 'diag.bundle':
        return s.diag.bundle({ settings: s.meta.settings(), providers: s.providers.list(), sessionsCount: (await s.sessions.list()).length });
      case 'client.log': {
        const line = this.clientLogs.admit(ws, req);
        if (line) (req.level === 'warn' ? console.warn : console.error)(line);
        return null;
      }
      case 'code.run': {
        // executes arbitrary code as the user: a window on this machine only, never a phone or a peer
        this.localWindowOnly(ws, tr('运行代码'));
        const live = req.sessionId ? s.pool.get(req.sessionId) : undefined;
        return runCode(req.lang, req.code, { cwd: live?.info.cwd ?? req.cwd });
      }
      case 'mcp.registry':
        return s.mcp.registry(req.query, req.limit);
      case 'mcp.health':
        return s.mcp.health(req.cwd);
      case 'secrets.status':
        return s.providers.secretsStatus();
      case 'secrets.migrate':
        await s.providers.migrateSecrets();
        return null;
      case 'ledger.list':
        return s.ledger.list(req.days, req.sessionId);
      case 'ledger.export':
        return s.ledger.exportCsv(req.days);
      case 'schedules.history':
        return s.meta.scheduleRuns(req.id, req.limit);
      case 'schedules.templates':
        return SCHEDULE_TEMPLATES;
      case 'agents.list': {
        const list = await s.agents.list(!!req.refresh);
        // a refresh re-probes what's installed: newly detected agents are offered to the library
        if (req.refresh) void s.library.announce().catch(() => {});
        return list;
      }
      case 'remote.status':
        return this.remoteStatus();
      case 'remote.set': {
        if (req.anywhere !== undefined) await s.meta.setSetting('remote.anywhere', !!req.anywhere);
        if (req.keepAwake !== undefined) await s.meta.setSetting('remote.keepAwake', !!req.keepAwake);
        // the listener restarts for enabled / port (or a bare remote.set, as before); not for the two settings alone
        if (req.enabled !== undefined || req.port !== undefined || (req.anywhere === undefined && req.keepAwake === undefined)) {
          await s.remote.set({ enabled: req.enabled, port: req.port });
        }
        await s.anywhere?.refresh();
        return this.remoteStatus();
      }
      case 'remote.pairCode':
        return s.remote.newPairCode();
      case 'remote.devices.revoke':
        await s.remote.revoke(req.id);
        return null;
      case 'remote.devices.rename':
        await s.remote.rename(req.id, req.name);
        return null;
      case 'remote.hosts.list':
        return s.meta.remoteHosts();
      case 'remote.hosts.set': {
        const prev = s.meta.remoteHosts().find((h) => h.id === req.host.id);
        const before = prev ? { ...prev } : undefined; // setRemoteHost replaces the entry; keep the old values
        await s.meta.setRemoteHost(req.host);
        this.broadcast({ kind: 'tunnel.changed' });
        await s.federation?.hostChanged(req.host.id, before); // peers riding this host reconnect when its connection settings moved
        return null;
      }
      case 'remote.hosts.test':
        return s.tunnels.probe(req);
      // stage E5: WSL
      case 'wsl.list':
        if (!s.wsl) return { available: false, distros: [] };
        return { available: s.wsl.available(), distros: await s.wsl.list() };
      case 'wsl.check':
        if (!s.wsl) throw new Error('no WSL');
        return s.wsl.check(req.distro);
      case 'wsl.installCommand':
        return { command: INSTALL_CMD };
      case 'wsl.install':
        // only after the user saw the command and said yes (the dialog sends confirmed: true)
        if (req.confirmed !== true) throw new Error(tr('安装要先确认'));
        if (!s.wsl) throw new Error('no WSL');
        return s.wsl.install(req.distro);
      case 'remote.hosts.remove':
        await s.tunnels.close(req.id);
        await s.meta.removeRemoteHost(req.id);
        this.broadcast({ kind: 'tunnel.changed' });
        return null;
      case 'tunnel.open': {
        const host = s.meta.remoteHosts().find((h) => h.id === req.hostId);
        if (!host) throw new Error(tr('主机不存在'));
        return s.tunnels.open(host);
      }
      case 'tunnel.close':
        await s.tunnels.close(req.hostId);
        return null;
      case 'tunnel.list':
        return s.tunnels.list();
      case 'tunnel.run': {
        const host = s.meta.remoteHosts().find((h) => h.id === req.hostId);
        if (!host) throw new Error(tr('主机不存在'));
        return s.tunnels.runRemote(host, req.command);
      }
      case 'im.kinds':
        return IM_KINDS;
      case 'im.list':
        return s.im.list();
      case 'im.set':
        await s.im.set(req.id, req.patch);
        return s.im.list();
      case 'im.test':
        return s.im.test(req.id);
      case 'im.pairCode':
        return s.im.router.newPairCode(req.id);
      case 'im.unbind':
        await s.meta.removeImBinding(req.gatewayId, req.chatId);
        this.broadcast({ kind: 'im.changed' });
        return null;
      case 'vcs.repo': return s.vcs.repo(req.cwd, req.repo);
      case 'vcs.issues': return s.vcs.issues(req.cwd, { state: req.state, q: req.q, page: req.page, repo: req.repo, mine: req.mine });
      case 'vcs.pulls': return s.vcs.pulls(req.cwd, { state: req.state, page: req.page, repo: req.repo });
      case 'vcs.item': return s.vcs.item(req.cwd, req.number, req.isPr, req.repo);
      case 'vcs.comment': await s.vcs.comment(req.cwd, req.number, req.body, req.isPr, req.repo); return null;
      case 'vcs.setState': await s.vcs.setState(req.cwd, req.number, req.state, req.isPr, req.repo); return null;
      case 'vcs.assign': await s.vcs.assign(req.cwd, req.number, req.assignees, req.isPr, req.repo); return null;
      case 'vcs.labels': await s.vcs.labels(req.cwd, req.number, req.labels, req.isPr, req.repo); return null;
      case 'vcs.merge': await s.vcs.merge(req.cwd, req.number, req.method, req.repo); return null;
      case 'vcs.prForBranch': return s.vcs.prForBranch(req.cwd);
      case 'vcs.autoMerge': await s.vcs.autoMerge(req.cwd, req.prId, req.on); return null;
      // stage E
      case 'vcs.prComments': return s.vcs.prComments(req.cwd, req.number, req.base);
      case 'vcs.replyComment': await s.vcs.replyComment(req.cwd, req.number, req.comment, req.body); return null;
      case 'vcs.resolveComment': await s.vcs.resolveComment(req.cwd, req.number, req.comment); return null;
      case 'vcs.failureLog': return s.vcs.failureLog(req.cwd, req.jobId);
      case 'vcs.autoLease':
        if (req.release) { autoLeases.release(req.sessionId, req.holder); return { ok: false }; }
        return { ok: autoLeases.claim(req.sessionId, req.holder) };
      case 'vcs.tokens.list': return s.vcs.tokenHosts();
      case 'vcs.tokens.set':
        if (!s.vcsTokens) throw new Error('no token store');
        await s.vcsTokens.set(req.host, req.token); s.vcs.forgetToken(req.host); return null;
      case 'vcs.create': return s.vcs.create(req.cwd, { title: req.title, body: req.body, isPr: req.isPr, head: req.head, base: req.base, draft: req.draft, labels: req.labels }, req.repo);
      case 'vcs.checkout': return s.vcs.checkout(req.cwd, req.number, { worktree: req.worktree, repo: req.repo });
      case 'bots.list': return s.bots.list();
      case 'bots.get': return s.bots.get(req.id);
      // a peer's network path never becomes a bot's folder or output file
      case 'bots.create': refusePeerUncBot(req.bot, this.peerConns.has(ws)); return s.bots.create(req.bot);
      case 'bots.update': refusePeerUncBot(req.patch, this.peerConns.has(ws)); return s.bots.update(req.id, req.patch);
      case 'bots.delete': await s.bots.remove(req.id); return null;
      case 'bots.pause': return s.bots.pause(req.id, req.paused);
      case 'bots.unleash': return s.bots.unleash(req.id, req.on);
      case 'bots.runNow': await s.bots.runNow(req.id, req.routineId); return null;
      // { requested, note } when another claude-web is on duty: the stop was handed to it
      case 'bots.stop': return s.bots.stopBot(req.id);
      case 'bots.stopAll': return s.bots.stopAll();
      case 'bots.inbox.list': return s.bots.inboxList(req.botId, req.includeDone);
      case 'bots.inbox.answer': return s.bots.inboxAnswer(req.answer);
      case 'bots.runs.list': return s.bots.runs(req.botId, req.routineId, req.limit);
      case 'bots.runs.audit': return s.bots.audit(req.botId, req.runId);
      // the one-sentence generator is gone (it left its conversations in the list): a bot starts as a conversation now
      case 'bots.generate': throw new Error(tr('一句话生成 Bot 已停用：新建 Bot 后在它的对话里说你要什么'));
      // chat-first bots: a bot is a conversation (its thread), with its timeline beside it
      case 'bots.start': refusePeerUnc(req.cwd, this.peerConns.has(ws)); return s.bots.startBot({ name: req.name, avatar: req.avatar, templateId: req.templateId, cwd: req.cwd });
      case 'bots.thread.open': return s.bots.threadOpen(req.id);
      case 'bots.thread.seen': await s.bots.seen(req.id); return null;
      case 'bots.timeline.list': return s.bots.timeline(req.id, req.before, req.limit);
      case 'bots.templates': return s.bots.templates();
      case 'bots.load': return s.bots.load();
      case 'bots.duty.install': this.localWindowOnly(ws, tr('值班服务')); return installDuty(req.on);
      case 'bots.duty.status': this.localWindowOnly(ws, tr('值班服务')); return { installed: await dutyInstalled() };
      case 'goals.list': return s.goals.list();
      case 'goals.create': return s.goals.create({ objective: req.objective, spec: req.spec, cwd: req.cwd, maxTurns: req.maxTurns, tokenBudget: req.tokenBudget, agent: req.agent, permissionMode: req.permissionMode, model: req.model });
      case 'goals.update': return s.goals.update(req.id, req.patch);
      case 'goals.start': return s.goals.start(req.id);
      case 'goals.pause': return s.goals.pause(req.id);
      case 'goals.resume': return s.goals.resume(req.id);
      case 'goals.complete': return s.goals.complete(req.id);
      case 'goals.remove': await s.goals.remove(req.id); return null;
      case 'goals.note': await s.goals.note(req.id, req.text); return null;
      case 'android.status': return s.android.status();
      case 'android.screenshot': return s.android.screenshot(req.serial);
      case 'android.input': await s.android.input(req.serial, req.input); return null;
      case 'android.install': return s.android.install(req.serial, req.apk);
      case 'android.logcat': if (req.clear) { await s.android.clearLogcat(req.serial); return ''; } return s.android.logcat(req.serial, req.lines, req.filter);
      case 'android.packages': return s.android.packages(req.serial);
      case 'android.launchApp': return s.android.launchApp(req.serial, req.pkg);
      case 'android.startEmulator': return s.android.startEmulator(req.avd);
      case 'agents.set':
        await s.agents.setConfig(req.agent, req.patch);
        s.agents.invalidate();
        return s.agents.list();

      case 'terminal.open':
        // a WSL terminal only in a distro this computer lists (its name goes to wsl.exe -d)
        if (req.wsl) { if (!s.wsl) throw new Error('no WSL'); await s.wsl.ensureKnown(String(req.wsl.distro)); }
        return s.terminal.open(req.cwd, req.cols, req.rows, req.wsl ? { wsl: { distro: String(req.wsl.distro) } } : {});
      case 'terminal.input':
        s.terminal.input(req.termId, req.data);
        return null;
      case 'terminal.resize':
        s.terminal.resize(req.termId, req.cols, req.rows);
        return null;
      case 'terminal.close':
        s.terminal.close(req.termId);
        return null;
    }
    if (isChannelRequest(req)) return handleChannelRequest(s.channels, req);
    if (isSourceHealthRequest(req)) return handleSourceHealthRequest(sourceHealth({ providers: s.providers }), req);
    if (isPluginRequest(req) && s.plugins) return handlePluginRequest(s.plugins, req);
    // remote kinds also start with `sync.`, so they must be matched before the file export / import handler
    if (isRemoteSyncRequest(req) && s.syncRemote) return handleRemoteSyncRequest(s.syncRemote, req);
    if (isSyncRequest(req) && s.sync) return handleSyncRequest(s.sync, req);
    if (isShareRequest(req) && s.share) return handleShareRequest(s.share, req);
    if (isTelemetryRequest(req) && otlpExporter()) return handleTelemetryRequest(otlpExporter()!, req, this.peerConns.has(ws) || this.remoteConns.has(ws));
    if (isEngineRequest(req)) return handleEngineRequest(s.engines, req, this.peerConns.has(ws) || this.remoteConns.has(ws));
    if (isUpstreamRequest(req)) return handleUpstreamRequest(s.upstreams, s.tasks, req);
    if (isGatewayRequest(req)) return handleGatewayRequest(s.gateway, req);
    if (isPrivacyRequest(req)) return handlePrivacyRequest(s.privacy, req);
    throw new Error(`unknown request ${(req as any).kind}`);
  }
}

/**
 * Rename, and keep the name while the conversation's process runs: the process holds the old title in memory and
 * writes it back later (2026-10-17 user report: 「改了名字，一会它自己会改回去」). The official binary is told; for our
 * engine the name waits in SessionMeta.pendingTitle — the list shows it, and it is written again when the process ends.
 */
async function renameKept(s: { library: { rename(id: string, title: string): Promise<void> }; pool: { get(id: string): { renameLive?(t: string): Promise<boolean> } | undefined }; meta: { setSessionMeta(id: string, patch: Record<string, unknown>): unknown } }, sessionId: string, title: string): Promise<void> {
  await s.library.rename(sessionId, title);
  const r = s.pool.get(sessionId);
  const told = r?.renameLive ? await r.renameLive(title) : false;
  await s.meta.setSessionMeta(sessionId, { pendingTitle: r && !told ? title : undefined });
}
