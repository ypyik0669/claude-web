import type { WebSocket, WebSocketServer } from 'ws';
import { CLAUDE_PROVIDER_ID, type ClientRequest, type OpenSessionParams, type RemoteStatus, type ServerEvent, type WireDown, type WireUp } from '../protocol.js';
import { RunnerPool } from '../runtime/pool.js';
import { SessionRunner } from '../runtime/session-runner.js';
import { cacheParentFor } from '../runtime/cache-key.js';
import { SessionService } from '../sessions/service.js';
import { ConfigService } from '../config/service.js';
import { UsageService } from '../usage/service.js';
import { FilesService } from '../files/service.js';
import { TerminalService } from '../terminal/service.js';
import { MetaStore } from '../meta/store.js';
import { LimitsService } from '../usage/limits.js';
import { ScheduleService } from '../schedules/service.js';
import { openPath } from '../runtime/open-path.js';
import { engineInfo, runClaudeCli } from '../claude-exe.js';
import type { ProviderService } from '../providers/service.js';
import type { GitService } from '../git/service.js';
import type { SearchService } from '../search/service.js';
import type { SkillsService } from '../skills/service.js';
import type { McpService } from '../mcp/service.js';
import type { DiagService } from '../diag/service.js';
import { detectTools } from '../tools/detect.js';
import { ClientLogGate } from '../diag/client-log.js';
import type { RemoteService } from '../remote/service.js';
import type { AnywhereService } from '../remote/anywhere/service.js';
import type { TunnelManager } from '../remote/tunnel.js';
import { IM_KINDS, type ImService } from '../im/service.js';
import type { VcsService } from '../vcs/service.js';
import type { GoalService } from '../goals/service.js';
import type { AndroidService } from '../android/service.js';
import type { LedgerService } from '../usage/ledger.js';
import { SCHEDULE_TEMPLATES } from '../schedules/service.js';
import { nextCron } from '../schedules/cron.js';
import type { AgentRegistry } from '../agents/types.js';
import type { AgentTranscripts } from '../agents/transcript.js';
import type { CanonicalLog } from '../session/canonical.js';
import type { MemoryService } from '../memory/service.js';
import { harvest } from '../memory/extract.js';
import { setMemoryMcpEnabled } from '../memory/launcher.js';
import { afterSwitch, normProvider, openOnProvider, swapAgent, swapProvider } from '../session/swap.js';
import { expandSessionRefs } from '../library/briefing.js';
import type { LibraryService } from '../library/service.js';
import type { GatewayService } from '../gateway/service.js';
import { handleGatewayRequest, isGatewayRequest } from '../gateway/handlers.js';

import type { AgentConfigService } from '../agent-config/service.js';
import { handleAgentConfig, isAgentConfigRequest } from '../agent-config/handlers.js';

import type { FederationService } from '../federation/service.js';
import type { IncomingMessage } from 'node:http';
import type { OrchestraService } from '../orchestra/service.js';
import { parseProxySetting, proxy } from '../net/proxy.js';
import { handleOrchestra, isOrchestraRequest } from '../orchestra/handlers.js';
import { isWebKeySetting, maskWebSettings, type WebService } from '../web/service.js';
import { setWebMcpEnabled } from '../web/launcher.js';

export interface Services {
  /** Unified session library: every joined source's sessions (sessions.list / search / library.*). */
  library: LibraryService;
  /** Other agents' config center: MCP / instructions / settings of Codex, Gemini, Qwen, OpenCode (agentConfig.*). */
  agentConfig: AgentConfigService;

  /** Cross-machine sessions: routes peer_… requests / merges lists before handle(); optional (tests). */
  federation?: FederationService;
  /** Multi-agent orchestration (workflows / runs); requests routed by orchestra/handlers.ts */
  orchestra: OrchestraService;
  git: GitService;
  search: SearchService;
  skills: SkillsService;
  mcp: McpService;
  diag: DiagService;
  ledger: LedgerService;
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
  version: string;
  /** Local model gateway (/gateway/<group>/…). */
  gateway: GatewayService;
  /** 联网: web search, and the browser tools carried out by the window hosting the built-in browser (web.* / browser.*). */
  web: WebService;
}

/** Requests after which something connects out: they wait for a fresh look at the proxy. (`web.search` waits inside WebService, like the agents' searches.) */
const GOES_OUT = new Set<string>(['session.open', 'session.send', 'session.setProvider', 'session.switchAgent', 'providers.probe', 'providers.refreshModels', 'terminal.open', 'im.set', 'im.test', 'mcp.registry']);

export class Hub {
  private clients = new Set<WebSocket>();
  /** Connections from another machine's FederationService (`?peer=<serverId>`): never sent what we got from our own peers. */
  private peerConns = new WeakSet<WebSocket>();
  /**
   * Connections that are not a window on this machine: through the remote-access listener (a phone, 在外面也能用) or
   * with a paired device's token. They may use everything else, but not host the built-in browser.
   */
  private remoteConns = new WeakSet<WebSocket>();
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
    s.pool.on('permission', (request) => this.broadcast({ kind: 'permission.request', request }));
    s.pool.on('permissionResolved', (_sid, requestId) => this.broadcast({ kind: 'permission.resolved', requestId }));
    s.sessions.on('changed', () => this.broadcast({ kind: 'sessions.changed' }));
    s.meta.on('changed', () => this.broadcast({ kind: 'meta.changed' }));
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
    s.library.on('transcripts', (ids: string[]) => this.broadcast({ kind: 'transcripts.changed', sessionIds: ids }));
    s.sessions.on('transcripts', (ids: string[]) => {
      for (const id of ids) s.pool.transcriptChanged(id); // a turn from a terminal on a conversation held open here
      this.broadcast({ kind: 'transcripts.changed', sessionIds: ids });
    });
    s.library.on('discovered', (kinds) => this.broadcast({ kind: 'library.discovered', kinds }));
    s.gateway.on('changed', () => this.broadcast({ kind: 'gateway.changed' }));
    s.web.on('changed', () => this.broadcast({ kind: 'web.changed' }));

    s.federation?.on('event', (e: ServerEvent) => this.broadcast(e, true));
    s.orchestra.on('changed', (run, removed) => this.broadcast({ kind: 'orchestra.changed', run, removed }));
    s.orchestra.on('workflows', () => this.broadcast({ kind: 'orchestra.workflows.changed' }));
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
    const fed = this.s.federation;
    this.send(ws, { type: 'event', event: { kind: 'hello', version: this.s.version, ...(fed ? { serverId: fed.serverId, name: fed.name, bootId: fed.bootId } : {}) } });
    // startup discovery happens before anyone is connected: tell each new client what's waiting to be joined
    void this.s.library.detect().then((kinds) => { if (kinds.length) this.send(ws, { type: 'event', event: { kind: 'library.discovered', kinds } }); }).catch(() => {});
    // a window that hosted the built-in browser is gone with its connection: what it was asked fails now, not in 30 s
    ws.on('close', () => { this.clients.delete(ws); this.s.web.dropConnection(ws); });
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
    if (this.peerConns.has(ws) || this.remoteConns.has(ws)) throw new Error(`只有本机的桌面窗口才能提供${what}`);
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
      return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), pending: r.getPendingPermissions() };
    }
    // provider: explicit → the one the session was created with → user default (new sessions only)
    if (params.providerId === undefined) {
      const remembered = params.sessionId ? s.meta.sessionMeta(params.sessionId).providerId : undefined;
      const def = params.sessionId ? undefined : (s.meta.settings().defaultProviderId as string | undefined);
      params = { ...params, providerId: remembered ?? def };
    }
    if (!params.features && s.meta.settings().defaultFeatures) params = { ...params, features: s.meta.settings().defaultFeatures as any };
    // prompt-cache route key: a fork keeps its parent's (the prefix is the same), decided before the id changes
    const cacheParentId = cacheParentFor(params, (id) => s.meta.sessionMeta(id).cacheKey);
    if (cacheParentId) params = { ...params, cacheParentId };
    // forks: copy the transcript first (SDK forkSession) so the new session has a real id before the process starts
    if (params.sessionId && (params.fork || params.resumeAt)) {
      // right after a turn the CLI is still writing its last answer (~2 s after the result): a copy taken now lost it
      const src = s.pool.get(params.sessionId);
      if (src instanceof SessionRunner) await src.flushed();
      const newId = await s.sessions.fork(params.sessionId, params.resumeAt);
      params = { ...params, sessionId: newId, fork: false, resumeAt: undefined };
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
    return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), pending: r.getPendingPermissions() };
  }

  private async handle(req: ClientRequest, ws: WebSocket): Promise<unknown> {
    const s = this.s;
    // about to go out (a CLI starts, a provider is asked): the system proxy may have changed since the last look —
    // resolves at once when that look is under a minute old (net/proxy.ts)
    if (GOES_OUT.has(req.kind)) await proxy.refresh();
    if (isAgentConfigRequest(req)) return handleAgentConfig(s.agentConfig, req);
    if (isOrchestraRequest(req)) return handleOrchestra(s.orchestra, req);
    switch (req.kind) {
      case 'sessions.list': {
        const all = await s.library.list();
        const list = req.limit ? all.slice(0, req.limit) : all;
        return list.map((x) => ({ ...x, live: s.pool.stateOf(x.sessionId) }));
      }
      case 'sessions.projects':
        return s.sessions.projects();
      case 'transcript.load': {
        // imported sessions (and anything a joined foreign source lists) are read from the agent itself
        const head = await s.transcripts.head(req.sessionId);
        // ours (the mirror) — the library first brings in turns the agent's own CLI added since (Codex)
        if (head && !head.imported) return (await s.library.read(req.sessionId)).messages;
        if (head?.imported || (await s.library.kindOf(req.sessionId)) !== 'claude') return (await s.library.read(req.sessionId)).messages;
        return s.sessions.transcript(req.sessionId);
      }
      case 'transcript.subagents':
        return s.sessions.subagents(req.sessionId);
      case 'transcript.subagent':
        return s.sessions.subagent(req.sessionId, req.agentId);

      case 'session.open': {
        let params = req.params;
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
        // an explicitly chosen profile must fit the agent / engine (welcome page, schedules, IM, orchestration all land here)
        const unfitOpen = s.providers.fitError(req.params.providerId, params.agent ?? 'claude');
        if (unfitOpen) throw new Error(unfitOpen);
        // an existing conversation opened with an explicit provider (a pick on a history conversation's chips, another
        // window, a client whose state is stale — IM, schedules and orchestration open through the pool, not here):
        // not running on the recorded one → open, then the same bookkeeping as session.setProvider (SessionMeta, the
        // account clears it; the canonical switch line); running on another one → session.setProvider's swap. Under
        // the conversation's lock (openOnProvider)
        const nameOf = (id: string) => (normProvider(id) ? s.providers.forSession(id)?.name ?? id : 'Claude 账号');
        return openOnProvider({ pool: s.pool, meta: s.meta, canonical: s.canonical }, params, nameOf, {
          open: (p) => this.openSession(p),
          // running on another provider: the same as session.setProvider (re-review m-3)
          swapped: (r) => ({ ...r, pending: s.pool.get(r.sessionId)?.getPendingPermissions() ?? [] }),
          onRecorded: () => s.sessions.emit('changed'),
        });
      }
      case 'session.info': {
        const r = this.runner(req.sessionId);
        return { info: r.info, history: r.getHistory(), pending: r.getPendingPermissions() };
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
        this.runner(req.params.sessionId).send(outgoing, req.params.images, req.params.steer, req.params.uuid, req.params.attachments);
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
      case 'workspaces.add':
        return s.meta.addWorkspace(req.path);
      case 'workspaces.remove':
        await s.meta.removeWorkspace(req.id);
        return null;
      case 'workspaces.rename':
        await s.meta.renameWorkspace(req.id, req.name);
        return null;
      case 'workspaces.reorder':
        await s.meta.reorderWorkspaces(req.ids);
        return null;
      case 'sessions.meta':
        return s.meta.allSessionMeta();
      case 'session.setMeta':
        await s.meta.setSessionMeta(req.sessionId, req.patch);
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
        await s.schedules.run(sc);
        return null;
      }
      case 'limits.get':
        return s.limits.get(req.force);
      case 'engine.info':
        return engineInfo();
      case 'engine.cli':
        return runClaudeCli(req.args, { cwd: req.cwd, timeoutMs: 120_000 });
      case 'providers.list':
        return s.providers.list();
      case 'providers.upsert':
        return s.providers.upsert(req.provider);
      case 'providers.remove':
        await s.providers.remove(req.id);
        return null;
      case 'providers.probe':
        return s.providers.probe(req.id, req.provider, { listOnly: req.listOnly });
      case 'providers.refreshModels':
        return s.providers.refreshModels(req.ids);
      case 'settings.get':
        // the search engines' keys are stored protected and read as a mask here (web/service.ts)
        return maskWebSettings(s.meta.settings());
      case 'network.proxy':
        return proxy.refresh(!!req.refresh);
      case 'settings.set':
        if (req.key === 'network.proxy') {
          const p = parseProxySetting(req.value); // throws a sentence on SOCKS / junk
          await s.meta.setSetting(req.key, p.mode === 'custom' ? p.url : p.mode === 'off' ? 'off' : undefined);
          s.web.networkChanged(); // a search engine that could not be reached is tried again
          return proxy.refresh(true);
        }
        // a search engine's API key: protected at rest, the mask sent back keeps what is stored, '' removes it
        if (isWebKeySetting(req.key)) { await s.web.setKey(req.key, req.value); return null; }
        await s.meta.setSetting(req.key, req.value);
        // takes effect on the next session start — running children keep the servers they were given
        if (req.key === 'memory.mcp') setMemoryMcpEnabled(req.value !== false);
        if (req.key === 'web.mcp') setWebMcpEnabled(req.value !== false);
        if (req.key.startsWith('web.')) s.web.settingsChanged(); // web.status reads differently now
        // 在外面也能用: brokers / STUN / the shell address / on-off / keep-awake (restarts only when it has to)
        if (req.key === 'remote.anywhere' || req.key.startsWith('remote.anywhere.') || req.key === 'remote.keepAwake') await s.anywhere?.refresh();
        return null;
      case 'sessions.search':
        return s.library.search(req.query, req.limit ?? 30);

      // ---- unified session library ----
      case 'library.sources':
        return s.library.sources();
      case 'library.read':
        return s.library.read(req.sessionId, req.cursor, req.limit);
      case 'library.rename':
        await s.library.rename(req.sessionId, req.title);
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
      case 'session.setPermissionMode':
        await afterSwitch(req.sessionId);
        await this.runner(req.sessionId).setPermissionMode(req.mode);
        return null;
      case 'session.setModel': {
        await afterSwitch(req.sessionId);
        const r = this.runner(req.sessionId);
        // picked for the provider this window saw: another window switched in the meantime → the model may not even
        // exist there (it was applied anyway and every turn failed "issue with the selected model")
        if (req.providerId !== undefined && normProvider(req.providerId) !== normProvider(r.info.providerId)) throw new Error('这个对话刚刚换了供应商，这次选的模型没有用上，请在模型菜单里重新选');
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
      // Swapping the provider or the agent behind a live session. Both are an invisible restart:
      // the CLI's env is fixed at spawn, so "no restart" can only mean the user never sees one.
      case 'session.setProvider': {
        // 'claude' = back to the account, like no provider at all (the window sends either)
        const own = !req.providerId || req.providerId === CLAUDE_PROVIDER_ID;
        const p = own ? undefined : s.providers.forSession(req.providerId);
        if (!own && !p) throw new Error('没有这个供应商');
        // the agent behind the session must be able to use this profile type (Codex cannot talk to an Anthropic relay…)
        const agent = s.pool.get(req.sessionId)?.info.agent ?? (await s.transcripts.head(req.sessionId).catch(() => null))?.agent ?? 'claude';
        const unfit = s.providers.fitError(req.providerId, agent);
        if (unfit) throw new Error(unfit);
        const r = await swapProvider({ pool: s.pool, canonical: s.canonical, transcripts: s.transcripts, meta: s.meta }, req.sessionId, req.providerId, p?.name ?? 'Claude 账号', req.model); // serialised per session inside
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
        return s.memory.search({ q: req.query, scope: req.scope, cwd: req.cwd, sessionId: req.sessionId, kind: req.kind_, limit: req.limit });
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
        if (!cwd) throw new Error('这个对话没有可用的目录');
        return harvest(s.memory, events, { cwd, sessionId: req.sessionId, agent: s.pool.get(req.sessionId)?.info.agent });
      }
      // ---- 联网: search + the built-in browser (every agent reaches them over MCP; see web/mcp.ts) ----
      case 'web.status':
        return s.web.status();
      case 'web.search':
        return s.web.search(req.query, { count: req.count });
      case 'browser.host':
        // the built-in browser is a desktop window's on this machine: a phone or another machine cannot be it
        this.localWindowOnly(ws, '内置浏览器');
        s.web.setHost(ws, !!req.on, (command) => this.send(ws, { type: 'event', event: { kind: 'browser.command', command } }));
        return s.web.status();
      case 'browser.result':
        this.localWindowOnly(ws, '内置浏览器');
        // false: nothing was waiting for it any more (it came after the 30 s, or the command was another window's)
        return { taken: s.web.result(ws, String(req.id), !!req.ok, req.answer, req.error) };

      // legacy shapes, same routing as library.rename / library.delete — so every delete path backs up first
      case 'session.rename':
        await s.library.rename(req.sessionId, req.title);
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
      case 'session.stopTask':
        await this.runner(req.sessionId).stopTask?.(req.taskId);
        return null;
      case 'permission.respond': {
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
        return s.config.mcpAdd(req.name, req.json, req.scope, req.cwd);
      case 'config.mcp.remove':
        return s.config.mcpRemove(req.name, req.scope, req.cwd);
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
      case 'fs.list':
        return s.files.list(req.path);
      case 'fs.read':
        return s.files.read(req.path);
      case 'fs.pickDir':
        return s.terminal.pickDir();
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
      case 'remote.hosts.remove':
        await s.tunnels.close(req.id);
        await s.meta.removeRemoteHost(req.id);
        this.broadcast({ kind: 'tunnel.changed' });
        return null;
      case 'tunnel.open': {
        const host = s.meta.remoteHosts().find((h) => h.id === req.hostId);
        if (!host) throw new Error('主机不存在');
        return s.tunnels.open(host);
      }
      case 'tunnel.close':
        await s.tunnels.close(req.hostId);
        return null;
      case 'tunnel.list':
        return s.tunnels.list();
      case 'tunnel.run': {
        const host = s.meta.remoteHosts().find((h) => h.id === req.hostId);
        if (!host) throw new Error('主机不存在');
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
      case 'vcs.create': return s.vcs.create(req.cwd, { title: req.title, body: req.body, isPr: req.isPr, head: req.head, base: req.base, draft: req.draft, labels: req.labels }, req.repo);
      case 'vcs.checkout': return s.vcs.checkout(req.cwd, req.number, { worktree: req.worktree, repo: req.repo });
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
        return s.terminal.open(req.cwd, req.cols, req.rows);
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
    if (isGatewayRequest(req)) return handleGatewayRequest(s.gateway, req);
    throw new Error(`unknown request ${(req as any).kind}`);
  }
}
