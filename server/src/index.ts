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
import { ATTACH_MAX_BYTES, FilesService, attachmentPath } from './files/service.js';
import { TerminalService } from './terminal/service.js';
import { engineInfo } from './claude-exe.js';
import { MetaStore } from './meta/store.js';
import { ProviderService } from './providers/service.js';
import { LimitsService } from './usage/limits.js';
import { ScheduleService } from './schedules/service.js';
import { GitService } from './git/service.js';
import { SearchService } from './search/service.js';

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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version }));
      return;
    }
    // Raw local file for previews (images / pdf / media): GET /api/file?path=<abs>&token= — token-guarded like /ws
    if (url.pathname === '/api/file' && req.method === 'GET') {
      if (token && url.searchParams.get('token') !== token) { res.writeHead(403); res.end('forbidden'); return; }
      const p = url.searchParams.get('path') ?? '';
      if (!path.isAbsolute(p)) { res.writeHead(400); res.end('absolute path required'); return; }
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { res.writeHead(404); res.end('not found'); return; }
      if (!st.isFile()) { res.writeHead(400); res.end('not a file'); return; }
      const type = FILE_MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && st.size) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
        fs.createReadStream(p, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; media-src 'self'" });
      fs.createReadStream(p).pipe(res);
      return;
    }
    // Binary upload for message attachments: POST /api/attachments?sessionId=&rel=path/in/session (token-guarded like /ws)
    if (url.pathname === '/api/attachments' && req.method === 'POST') {
      const tokenOk = !token || url.searchParams.get('token') === token;
      if (!tokenOk) { res.writeHead(403).end(); return; }
      const len = Number(req.headers['content-length'] ?? 0);
      if (len > ATTACH_MAX_BYTES) { res.writeHead(413).end('too large'); return; }
      let dest: string;
      try { dest = attachmentPath(url.searchParams.get('sessionId') ?? '', url.searchParams.get('rel') ?? ''); } catch (e: any) { res.writeHead(400).end(e.message); return; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const out = fs.createWriteStream(dest);
      let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size > ATTACH_MAX_BYTES) { req.destroy(); out.destroy(); fs.rm(dest, { force: true }, () => {}); } });
      req.pipe(out);
      out.on('finish', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: dest, size })); });
      out.on('error', (e) => { res.writeHead(500).end(e.message); });
      return;
    }
    let file = path.join(distDir, decodeURIComponent(url.pathname));
    if (!file.startsWith(distDir)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h3>web/dist not built. Run <code>npm run build</code> or use <code>npm run dev</code> (Vite on :5173).</h3>');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin ?? '';
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const originOk = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
    const tokenOk = !token || url.searchParams.get('token') === token;
    if (!originOk || !tokenOk || url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const meta = new MetaStore();
  await meta.load();
  const providers = new ProviderService(meta);
  const files = new FilesService();
  const pool = new RunnerPool(providers);
  const services = { pool, sessions: new SessionService(), config: new ConfigService(), usage: new UsageService(), files, terminal: new TerminalService(), meta, limits: new LimitsService(), schedules: new ScheduleService(meta, pool), providers, git: new GitService(), search: new SearchService(), version };
  new Hub(wss, services);

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(PORT, HOST, () => res());
  });
  const port = (server.address() as { port: number }).port;
  const eng = engineInfo();
  console.log(`claude-web ${version} listening on http://${HOST}:${port}  (runtime: ${eng.runtime} ${eng.version ?? ''} ${eng.path})`);

  return {
    port,
    host: HOST,
    token,
    async close() {
      await pool.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
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
  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('message', (m: any) => { if (m?.type === 'shutdown') void shutdown(); });
  parentPort?.on('message', (e) => { if (e.data?.type === 'shutdown') void shutdown(); });
}
