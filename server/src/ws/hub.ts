import type { WebSocket, WebSocketServer } from 'ws';
import type { ClientRequest, ServerEvent, WireDown, WireUp } from '../protocol.js';
import { RunnerPool } from '../runtime/pool.js';
import { SessionService } from '../sessions/service.js';
import { ConfigService } from '../config/service.js';
import { UsageService } from '../usage/service.js';
import { FilesService } from '../files/service.js';
import { TerminalService } from '../terminal/service.js';
import { MetaStore } from '../meta/store.js';
import { LimitsService } from '../usage/limits.js';
import { ScheduleService } from '../schedules/service.js';
import { execFile } from 'node:child_process';
import { engineInfo, installCcb, runClaudeCli } from '../claude-exe.js';
import type { ProviderService } from '../providers/service.js';
import type { GitService } from '../git/service.js';
import type { SearchService } from '../search/service.js';
import type { SkillsService } from '../skills/service.js';
import type { McpService } from '../mcp/service.js';
import type { DiagService } from '../diag/service.js';
import { detectTools } from '../tools/detect.js';
import type { LedgerService } from '../usage/ledger.js';
import { SCHEDULE_TEMPLATES } from '../schedules/service.js';

export interface Services {
  git: GitService;
  search: SearchService;
  skills: SkillsService;
  mcp: McpService;
  diag: DiagService;
  ledger: LedgerService;
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
}

export class Hub {
  private clients = new Set<WebSocket>();

  constructor(private wss: WebSocketServer, private s: Services) {
    wss.on('connection', (ws) => this.onConnect(ws));
    s.pool.on('message', (sessionId, message) => this.broadcast({ kind: 'session.event', sessionId, message }));
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
  }

  broadcast(event: ServerEvent) {
    const msg = JSON.stringify({ type: 'event', event } satisfies WireDown);
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(msg);
  }

  private send(ws: WebSocket, down: WireDown) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(down));
  }

  private onConnect(ws: WebSocket) {
    this.clients.add(ws);
    this.send(ws, { type: 'event', event: { kind: 'hello', version: this.s.version } });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('message', async (raw) => {
      let up: WireUp;
      try {
        up = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (up.type !== 'request') return;
      const { id, req } = up.request;
      try {
        const data = await this.handle(req, ws);
        this.send(ws, { type: 'reply', reply: { id, ok: true, data } });
      } catch (e: any) {
        // GitCommandError carries a classified kind + hint; encode them so the client can offer a fix
        const error = e?.info?.kind ? `${e.info.message}\n\n[${e.info.kind}] ${e.info.hint}` : e?.message ?? String(e);
        this.send(ws, { type: 'reply', reply: { id, ok: false, error } });
      }
    });
  }

  private runner(sessionId: string) {
    const r = this.s.pool.get(sessionId);
    if (!r) throw new Error(`session ${sessionId} is not open`);
    return r;
  }

  private async handle(req: ClientRequest, ws: WebSocket): Promise<unknown> {
    const s = this.s;
    switch (req.kind) {
      case 'sessions.list': {
        const list = await s.sessions.list(req.limit);
        return list.map((x) => ({ ...x, live: s.pool.stateOf(x.sessionId) }));
      }
      case 'sessions.projects':
        return s.sessions.projects();
      case 'transcript.load':
        return s.sessions.transcript(req.sessionId);
      case 'transcript.subagents':
        return s.sessions.subagents(req.sessionId);
      case 'transcript.subagent':
        return s.sessions.subagent(req.sessionId, req.agentId);

      case 'session.open': {
        let params = req.params;
        // provider: explicit → the one the session was created with → user default (new sessions only)
        if (params.providerId === undefined) {
          const remembered = params.sessionId ? s.meta.sessionMeta(params.sessionId).providerId : undefined;
          const def = params.sessionId ? undefined : (s.meta.settings().defaultProviderId as string | undefined);
          params = { ...params, providerId: remembered ?? def };
        }
        if (!params.features && s.meta.settings().defaultFeatures) params = { ...params, features: s.meta.settings().defaultFeatures as any };
        // forks: copy the transcript first (SDK forkSession) so the new session has a real id before the process starts
        if (params.sessionId && (params.fork || params.resumeAt)) {
          const newId = await s.sessions.fork(params.sessionId, params.resumeAt);
          params = { ...params, sessionId: newId, fork: false, resumeAt: undefined };
        }
        const r = s.pool.open(params);
        if (params.providerId && params.providerId !== 'claude') {
          // remember which provider a session uses so resume / fork keep it (the id is known up front: new sessions get a uuid from us)
          if (s.meta.sessionMeta(r.sessionId).providerId !== params.providerId) void s.meta.setSessionMeta(r.sessionId, { providerId: params.providerId });
        }
        return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), pending: r.getPendingPermissions() };
      }
      case 'session.info': {
        const r = this.runner(req.sessionId);
        return { info: r.info, history: r.getHistory(), pending: r.getPendingPermissions() };
      }
      case 'session.send':
        this.runner(req.params.sessionId).send(req.params.text, req.params.images, req.params.steer, req.params.uuid, req.params.attachments);
        return null;

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
      case 'engine.update':
        return installCcb();
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
        return s.providers.probe(req.id, req.provider);
      case 'settings.get':
        return s.meta.settings();
      case 'settings.set':
        await s.meta.setSetting(req.key, req.value);
        return null;
      case 'sessions.search':
        return s.sessions.search(req.query, req.limit ?? 30);
      case 'shell.open': {
        const app = req.app ?? 'explorer';
        const cmd = app === 'explorer' ? (process.platform === 'win32' ? 'explorer' : 'open') : app;
        execFile(cmd, [req.path], { windowsHide: true }, () => {});
        return null;
      }
      case 'session.interrupt':
        await this.runner(req.sessionId).interrupt();
        return null;
      case 'session.close':
        await s.pool.close(req.sessionId);
        return null;
      case 'session.setPermissionMode':
        await this.runner(req.sessionId).setPermissionMode(req.mode);
        return null;
      case 'session.setModel':
        await this.runner(req.sessionId).setModel(req.model);
        return null;
      case 'session.setEffort':
        await this.runner(req.sessionId).setEffort(req.effort);
        return null;
      case 'session.rename':
        await s.sessions.rename(req.sessionId, req.title);
        return null;
      case 'session.delete':
        await s.pool.close(req.sessionId);
        await s.sessions.delete(req.sessionId);
        return null;
      case 'session.contextUsage':
        return this.runner(req.sessionId).contextUsage(req.detail);
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
        await this.runner(req.sessionId).stopTask(req.taskId);
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
        return s.config.auth();
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
    throw new Error(`unknown request ${(req as any).kind}`);
  }
}
