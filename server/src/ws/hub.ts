import type { WebSocket, WebSocketServer } from 'ws';
import type { ClientRequest, ServerEvent, WireDown, WireUp } from '../protocol.js';
import { RunnerPool } from '../runtime/pool.js';
import { SessionService } from '../sessions/service.js';
import { ConfigService } from '../config/service.js';
import { UsageService } from '../usage/service.js';
import { FilesService } from '../files/service.js';
import { TerminalService } from '../terminal/service.js';

export interface Services {
  pool: RunnerPool;
  sessions: SessionService;
  config: ConfigService;
  usage: UsageService;
  files: FilesService;
  terminal: TerminalService;
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
    s.terminal.on('data', (termId, data) => this.broadcast({ kind: 'terminal.data', termId, data }));
    s.terminal.on('exit', (termId, code) => this.broadcast({ kind: 'terminal.exit', termId, code }));
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
        this.send(ws, { type: 'reply', reply: { id, ok: false, error: e?.message ?? String(e) } });
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
        const r = s.pool.open(req.params);
        return { sessionId: r.sessionId, info: r.info, history: r.getHistory(), pending: r.getPendingPermissions() };
      }
      case 'session.info': {
        const r = this.runner(req.sessionId);
        return { info: r.info, history: r.getHistory(), pending: r.getPendingPermissions() };
      }
      case 'session.send':
        this.runner(req.params.sessionId).send(req.params.text, req.params.images);
        return null;
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
        return this.runner(req.sessionId).contextUsage();
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
