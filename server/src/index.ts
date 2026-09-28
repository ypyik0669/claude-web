import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Hub } from './ws/hub.js';
import { RunnerPool } from './runtime/pool.js';
import { SessionService } from './sessions/service.js';
import { ConfigService } from './config/service.js';
import { UsageService } from './usage/service.js';
import { ATTACH_MAX_BYTES, FilesService, attachmentPath, dataDir } from './files/service.js';
import { TerminalService } from './terminal/service.js';
import { engineInfo } from './claude-exe.js';
import { MetaStore } from './meta/store.js';
import { ProviderService } from './providers/service.js';
import { LimitsService } from './usage/limits.js';
import { ScheduleService } from './schedules/service.js';
import { GitService } from './git/service.js';
import { SearchService } from './search/service.js';
import { SecretService } from './secrets/service.js';
import { SkillsService } from './skills/service.js';
import { McpService } from './mcp/service.js';
import { DiagService } from './diag/service.js';
import { LedgerService } from './usage/ledger.js';
import { AgentRegistry } from './agents/types.js';
import { AgentTranscripts } from './agents/transcript.js';
import { CanonicalLog } from './session/canonical.js';
import { MemoryService } from './memory/service.js';
import { setMemoryMcpEnabled } from './memory/launcher.js';
import { RemoteService, pairPage } from './remote/service.js';
import { TunnelManager } from './remote/tunnel.js';
import { ImService } from './im/service.js';
import { VcsService } from './vcs/service.js';
import { GoalService } from './goals/service.js';
import { AndroidService } from './android/service.js';
import { LibraryService } from './library/service.js';
import { LibraryIndex } from './library/index-db.js';
import { ClaudeSource } from './library/claude-source.js';
import { CodexSource } from './library/codex-source.js';
import { OpenCodeSource } from './library/opencode-source.js';
import { AcpListSource } from './library/acp-source.js';
import { GatewayService } from './gateway/service.js';
import { AgentConfigService } from './agent-config/service.js';
import { FederationService } from './federation/service.js';
import { swapAgent } from './session/swap.js';
import { createOrchestra } from './orchestra/handlers.js';

const FILE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

export interface StartOptions {
  port?: number; // 0 = pick a free port
  host?: string;
  token?: string; // when set, /ws requires ?token=
  distDir?: string; // built web app
  version?: string;
}

export interface RunningServer {
  port: number;
  host: string;
  token?: string;
  close(): Promise<void>;
}

function cookieToken(cookie?: string): string | null {
  const m = /(?:^|;\s*)cw_token=([^;]+)/.exec(cookie ?? '');
  return m ? decodeURIComponent(m[1]) : null;
}

/** `new URL` throws on a malformed Host header — in a request / upgrade listener that is an uncaught crash. */
function requestUrl(req: http.IncomingMessage, fallbackHost: string): URL {
  try {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? fallbackHost}`);
  } catch {
    try {
      return new URL(req.url ?? '/', `http://${fallbackHost}`);
    } catch {
      return new URL('/', `http://${fallbackHost}`);
    }
  }
}

/**
 * Parse a single `Range: bytes=` header against a file size. Returns null for "serve the whole file",
 * 'unsatisfiable' for a range outside the file, else inclusive [start, end].
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m || !size || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    // suffix range: the last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** A read stream error (file vanished / locked between stat and read) must end this response, not the process. */
function pipeFile(file: string, res: http.ServerResponse, opts?: { start: number; end: number }) {
  const rs = fs.createReadStream(file, opts);
  rs.on('error', () => res.destroy());
  rs.pipe(res);
}

function readVersion(): string {
  for (const p of [path.resolve(__dirname, '../../package.json'), path.resolve(__dirname, '../package.json')]) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? '0.0.0';
    } catch {
      /* next */
    }
  }
  return '0.0.0';
}

/** Start the claude-web server. Used by `npm start` (browser mode) and by the desktop shell. */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const HOST = opts.host ?? '127.0.0.1';
  const PORT = opts.port ?? Number(process.env.PORT ?? 3090);
  const token = opts.token ?? process.env.CLAUDE_WEB_TOKEN ?? undefined;
  const distDir = opts.distDir ?? process.env.CLAUDE_WEB_DIST ?? path.resolve(__dirname, '../../web/dist');
  const version = opts.version ?? readVersion();

  const meta = new MetaStore();
  await meta.load();
  // eslint-disable-next-line prefer-const
  let remote: RemoteService;
  let fedHealth: ((nonce: string | null, authed: boolean) => object) | null = null;
  /** Main token (desktop / CLI) or a paired device token (query ?token= or cookie cw_token). */
  const authOk = (req: http.IncomingMessage, url: URL): boolean => {
    const presented = url.searchParams.get('token') ?? cookieToken(req.headers.cookie);
    const viaRemote = !!(req.socket as any).cwRemote;
    if (!token && !viaRemote) return true; // local browser mode without a token: trust loopback
    if (token && presented === token) return true;
    return !!presented && !!remote?.authenticate(presented, req);
  };
  // eslint-disable-next-line prefer-const
  let gateway: GatewayService;
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = requestUrl(req, HOST);
    // model gateway: its own key auth, loopback only (404 on the LAN listener)
    if (gateway?.handle(req, res, url)) return;
    if (url.pathname === '/pair' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pairPage()); return; }
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let j: any = {};
        try { j = JSON.parse(body || '{}'); } catch { /* ignore */ }
        remote.redeem(String(j.code ?? ''), String(j.name ?? ''), req).then((r) => {
          const ok = !('error' in r);
          res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json', ...(ok ? { 'set-cookie': `cw_token=${(r as any).token}; Path=/; Max-Age=31536000; SameSite=Lax` } : {}) });
          res.end(JSON.stringify(r));
        }).catch((e) => { res.writeHead(500).end(e.message); });
      });
      return;
    }
    if (url.pathname === '/manifest.webmanifest') { res.writeHead(200, { 'content-type': 'application/manifest+json' }); res.end(JSON.stringify({ name: 'Claude Web', short_name: 'Claude Web', start_url: '/', display: 'standalone', background_color: '#1f1e1a', theme_color: '#1f1e1a', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] })); return; }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // federation: a hash of the serverId (+ a nonce proof) for anyone; the ids themselves only with a valid token
      res.end(JSON.stringify({ ok: true, version, ...(fedHealth?.(url.searchParams.get('nonce'), authOk(req, url)) ?? {}) }));
      return;
    }
    // Raw local file for previews (images / pdf / media): GET /api/file?path=<abs>&token= — token-guarded like /ws
    if (url.pathname === '/api/file' && req.method === 'GET') {
      if (!authOk(req, url)) { res.writeHead(403); res.end('forbidden'); return; }
      const p = url.searchParams.get('path') ?? '';
      if (!path.isAbsolute(p)) { res.writeHead(400); res.end('absolute path required'); return; }
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { res.writeHead(404); res.end('not found'); return; }
      if (!st.isFile()) { res.writeHead(400); res.end('not a file'); return; }
      const type = FILE_MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
      const range = parseRange(req.headers.range, st.size);
      if (range === 'unsatisfiable') { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
      if (range) {
        const { start, end } = range;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
        pipeFile(p, res, { start, end });
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; media-src 'self'" });
      pipeFile(p, res);
      return;
    }
    // Binary upload for message attachments: POST /api/attachments?sessionId=&rel=path/in/session (token-guarded like /ws)
    if (url.pathname === '/api/attachments' && req.method === 'POST') {
      if (!authOk(req, url)) { res.writeHead(403).end(); return; }
      const len = Number(req.headers['content-length'] ?? 0);
      if (len > ATTACH_MAX_BYTES) { res.writeHead(413).end('too large'); return; }
      let dest: string;
      try { dest = attachmentPath(url.searchParams.get('sessionId') ?? '', url.searchParams.get('rel') ?? ''); } catch (e: any) { res.writeHead(400).end(e.message); return; }
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e: any) { res.writeHead(500).end(e.message); return; }
      const out = fs.createWriteStream(dest);
      let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size > ATTACH_MAX_BYTES) { req.destroy(); out.destroy(); fs.rm(dest, { force: true }, () => {}); } });
      req.pipe(out);
      out.on('finish', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: dest, size })); });
      out.on('error', (e) => { if (!res.headersSent) res.writeHead(500).end(e.message); else res.destroy(); });
      return;
    }
    let pathname: string;
    // a stray `%` (e.g. GET /%E0) makes decodeURIComponent throw — uncaught, that takes the server down
    try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end(); return; }
    const root = path.resolve(distDir);
    let file = path.join(root, pathname);
    // `root + sep`, not `root`: `/../dist-old/x` resolves to a sibling that merely shares the prefix
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h3>web/dist not built. Run <code>npm run build</code> or use <code>npm run dev</code> (Vite on :5173).</h3>');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    pipeFile(file, res);
  };
  const server = http.createServer(handler);

  const wss = new WebSocketServer({ noServer: true });
  const upgrade = (req: http.IncomingMessage, socket: any, head: Buffer) => {
    const origin = req.headers.origin ?? '';
    const url = requestUrl(req, HOST);
    // same-origin only: localhost, or (remote listener) whatever host the page was served from
    const originHost = origin ? (() => { try { return new URL(origin).host; } catch { return ''; } })() : '';
    const originOk = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin) || (!!req.headers.host && originHost === req.headers.host);
    if (!originOk || !authOk(req, url) || url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const presented = url.searchParams.get('token') ?? cookieToken(req.headers.cookie);
    (req as any).cwDevice = presented && presented !== token ? remote.authenticate(presented, req) : null;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  server.on('upgrade', upgrade);
  const secrets = new SecretService();
  const providers = new ProviderService(meta, secrets);
  await providers.warm();
  const files = new FilesService();
  const agents = new AgentRegistry(meta);
  const transcripts = new AgentTranscripts();
  const canonical = new CanonicalLog();
  const memory = new MemoryService();
  setMemoryMcpEnabled(meta.settings()['memory.mcp'] !== false);
  const pool = new RunnerPool(providers, agents, transcripts);
  const ledger = new LedgerService();
  pool.on('message', (sessionId: string, m: unknown) => ledger.observe(sessionId, m, meta.sessionMeta(sessionId).providerId));
  gateway = new GatewayService({ meta, secrets, member: (id) => providers.member(id), ledger });
  await gateway.init();
  providers.gatewayEndpoint = (groupId) => gateway.endpoint(groupId);
  remote = new RemoteService(meta, () => { const s = http.createServer(handler); s.on('upgrade', upgrade); return s; });
  const tunnels = new TunnelManager();
  const sessionsSvc = new SessionService();
  const im = new ImService(meta, secrets, pool, sessionsSvc);
  const gitSvc = new GitService();
  const terminal = new TerminalService();
  // Session library: Claude always; Codex / OpenCode constructed but idle until joined (no process is
  // started before the user joins); other ACP agents get a source built only on join. Launch specs are
  // read through getters so agents.set overrides apply without a restart.
  const library = new LibraryService(
    [
      new ClaudeSource(sessionsSvc),
      new CodexSource(() => agents.launch('codex')),
      new OpenCodeSource(() => agents.launch('opencode')),
    ],
    new LibraryIndex(),
    transcripts,
    meta,
    {
      agents,
      makeSource: (kind) => (agents.defs().some((d) => d.kind === kind && d.protocol === 'acp') ? new AcpListSource(kind, () => agents.launch(kind)) : null),
      fallbackSearch: (q, limit) => sessionsSvc.search(q, limit),
    },
  );
  sessionsSvc.on('changed', () => library.invalidate('claude'));
  library.start();
  // cross-machine sessions: outbound connections to other claude-web servers (meta.peers)
  const federation = new FederationService({
    store: meta,
    secrets,
    tunnels,
    version,
    revokeDevice: (id) => remote.revoke(id),
    // same path as handing over an imported library session: a NEW local session seeded with a briefing
    handover: (a) => swapAgent({ pool, canonical, transcripts, meta, readAll: a.readAll, imported: a.imported }, a.sessionId, a.agent, a.model),
  });
  await federation.start();
  fedHealth = (nonce, authed) => federation.healthInfo(nonce, authed);
  const goals = new GoalService(meta, pool);
  const orchestra = await createOrchestra({ pool, meta, canonical, transcripts, agents, git: gitSvc, goals, library, im });
  const services = { orchestra, remote, tunnels, im, vcs: new VcsService(gitSvc), goals, android: new AndroidService(), pool, sessions: sessionsSvc, config: new ConfigService(), usage: new UsageService(), files, terminal, meta, limits: new LimitsService(), schedules: new ScheduleService(meta, pool), providers, git: gitSvc, search: new SearchService(), skills: new SkillsService(), mcp: new McpService(), diag: new DiagService(version), ledger, agents, transcripts, canonical, memory, library, version, federation, agentConfig: new AgentConfigService({ agents, backupDir: path.join(dataDir(), 'config-backups') }), gateway };
  new Hub(wss, services);

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(PORT, HOST, () => res());
  });
  const port = (server.address() as { port: number }).port;
  gateway.port = port;
  await remote.start();
  if (remote.status().running) console.log(`remote access on http://0.0.0.0:${remote.port}  (${remote.addresses().join(', ')})`);
  await im.startAll();
  const eng = engineInfo();
  console.log(`claude-web ${version} listening on http://${HOST}:${port}  (runtime: ${eng.runtime} ${eng.version ?? ''} ${eng.path})`);

  return {
    port,
    host: HOST,
    token,
    async close() {
      await im.stopAll();
      await federation.close();
      await tunnels.closeAll();
      await remote.stop();
      await orchestra.shutdown(); // before the pool: session closes must not fail / advance runs
      await pool.closeAll();
      await library.close(); // library-only Codex app-server / opencode serve / ACP processes
      terminal.closeAll(); // pty children (the embedded `claude` terminals) would outlive us otherwise
      // server.close() waits for every open connection; a connected browser's ws / keep-alive would hang shutdown forever
      for (const c of wss.clients) c.terminate();
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
    },
  };
}

// `npm start` / `tsx src/index.ts`: run directly
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain || process.env.CLAUDE_WEB_STANDALONE === '1') {
  const running = await startServer();
  const ready = { type: 'ready', port: running.port, host: running.host };
  // Electron utilityProcess talks over process.parentPort; plain child_process.fork over process.send
  const parentPort = (process as any).parentPort as { postMessage(m: unknown): void; on(ev: 'message', cb: (e: { data: any }) => void): void } | undefined;
  if (parentPort) parentPort.postMessage(ready);
  else if (process.send) process.send(ready);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; // SIGINT twice / signal + parent message: don't close everything twice
    stopping = true;
    try {
      await running.close();
    } catch (e) {
      console.error('shutdown:', e);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('message', (m: any) => { if (m?.type === 'shutdown') void shutdown(); });
  parentPort?.on('message', (e) => { if (e.data?.type === 'shutdown') void shutdown(); });
}
