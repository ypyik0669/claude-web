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
import { FilesService } from './files/service.js';
import { TerminalService } from './terminal/service.js';
import { resolveClaudeExe } from './claude-exe.js';
import { MetaStore } from './meta/store.js';
import { LimitsService } from './usage/limits.js';
import { ScheduleService } from './schedules/service.js';

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

  const pool = new RunnerPool();
  const meta = new MetaStore();
  await meta.load();
  const services = { pool, sessions: new SessionService(), config: new ConfigService(), usage: new UsageService(), files: new FilesService(), terminal: new TerminalService(), meta, limits: new LimitsService(), schedules: new ScheduleService(meta, pool), version };
  new Hub(wss, services);

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(PORT, HOST, () => res());
  });
  const port = (server.address() as { port: number }).port;
  console.log(`claude-web ${version} listening on http://${HOST}:${port}  (claude: ${resolveClaudeExe()})`);

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
