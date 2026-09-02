import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const PORT = Number(process.env.PORT ?? 3090);
const HOST = '127.0.0.1';
const distDir = path.resolve(__dirname, '../../web/dist');
const version = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')).version;

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  // Only serve to same-origin browsers on localhost.
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
  const ok = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (!ok || !(req.url ?? '').startsWith('/ws')) {
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

server.listen(PORT, HOST, () => {
  console.log(`claude-web ${version} listening on http://${HOST}:${PORT}  (claude: ${resolveClaudeExe()})`);
});

const shutdown = async () => {
  await pool.closeAll();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
