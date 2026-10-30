import './i18n/init.js'; // first: the interface language is fixed before the modules that read it at load
import './runtime/spawn-guard-install.js'; // first: child_process defaults to windowsHide before anything else loads
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Hub } from './ws/hub.js';
import { withLanguage } from './i18n/boot.js';
import { LANGUAGE_KEY } from './i18n/core.js';
import { RunnerPool } from './runtime/pool.js';
import { SessionService } from './sessions/service.js';
import { appendLastPrompt } from './sessions/unlisted.js';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { ConfigService } from './config/service.js';
import { UsageService } from './usage/service.js';
import { providerTimeline } from './usage/timeline.js';
import { ATTACH_MAX_BYTES, FilesService, attachmentPath, dataDir, workspaceRoots } from './files/service.js';
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
import { CustomCssService } from './appearance/custom-css.js';
import { AgentRegistry } from './agents/types.js';
import { refreshProcessPath } from './agents/locate.js';
import { AgentTranscripts } from './agents/transcript.js';
import { CanonicalLog } from './session/canonical.js';
import { MemoryService } from './memory/service.js';
import { setMemoryMcpEnabled } from './memory/launcher.js';
import { SessionRunner, setNodegraphHint, setPromptSuggestions, setThinkingLanguageSetting } from './runtime/session-runner.js';
import { NODEGRAPH_HINT_KEY } from './runtime/nodegraph-hint.js';
import { THINKING_LANGUAGE_KEY } from './runtime/thinking-language.js';
import { LocalEnvStore } from './runtime/local-env.js';
import { setSessionsDeps, setSessionsMcpEnabled } from './sessions-mcp/tools.js';
import { projectOf } from './meta/project.js';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { ProjectFiles, PROJECT_FILE_MAX } from './cloud/project-files.js';
import { sameOriginRequest } from './cloud/same-origin.js';
import { DispatchService } from './dispatch/service.js';
import type { CloudServices } from './cloud/handlers.js';
import { ClaudeAiSource } from './library/claudeai-source.js';
import { ClaudeAiImport, CLAUDEAI_UPLOAD_MAX } from './import/claude-ai-service.js';
import { PublishService } from './publish/service.js';
import { HandoffService } from './handoff/service.js';
import { renameSession as renameSdkSession } from '@anthropic-ai/claude-agent-sdk';
import { setDesktopSkillsEnabled } from './runtime/desktop-skills.js';
import { findClaudeTranscript } from './runtime/transcript-file.js';
import { PreviewService } from './preview/service.js';
import { setPreviewDeps } from './preview/tools.js';
import { sendWhenIdle } from './sessions-mcp/deliver.js';
import { RemoteService, pairPage } from './remote/service.js';
import { AnywhereService } from './remote/anywhere/service.js';
import { reportKeepAwake } from './remote/keep-awake.js';
import { TunnelManager } from './remote/tunnel.js';
import { ImService } from './im/service.js';
import { VcsService } from './vcs/service.js';
import { WslService, setWslService } from './wsl/service.js';
import { addTranscriptRoot } from './runtime/transcript-file.js';
import { VcsTokenStore } from './vcs/token-store.js';
import { GoalService } from './goals/service.js';
import { AndroidService } from './android/service.js';
import { LibraryService } from './library/service.js';
import { LibraryIndex } from './library/index-db.js';
import { ClaudeSource } from './library/claude-source.js';
import { CodexSource } from './library/codex-source.js';
import { OpenCodeSource } from './library/opencode-source.js';
import { CursorSource } from './library/cursor-source.js';
import { DshSource } from './library/dsh-source.js';
import { AcpListSource } from './library/acp-source.js';
import { PrivacyService } from './privacy/service.js';
import { setPrivacyRoute } from './privacy/route.js';
import { installConsoleMask } from './privacy/output.js';
import { GatewayService } from './gateway/service.js';
import { AuditLog } from './gateway/audit.js';
import type { GatewayAuditLine } from './gateway/types.js';
import { OtlpExporter, setOtlpExporter } from './telemetry/otlp.js';
import { UpstreamService } from './upstreams/service.js';
import { ChannelService } from './channels/service.js';
import { setClaudeBridgeOwnPorts } from './channels/drivers/claude-bridge.js';
import { EngineManager } from './engines/manager.js';
import { MaintenanceScheduler } from './upstreams/tasks.js';
import { setSplitHook } from './gateway/split.js';
import { setIntentMember } from './routing/intent-ask.js';
import { PluginService } from './plugins/service.js';
import { SyncService } from './sync/service.js';
import { RemoteSyncService } from './sync/remote.js';
import { ShareService } from './share/service.js';
import { ImportService } from './import/service.js';
import { AgentConfigService } from './agent-config/service.js';
import { FederationService } from './federation/service.js';
import { swapAgent } from './session/swap.js';
import { createOrchestra } from './orchestra/handlers.js';
import { BackgroundService } from './background/service.js';
import { CharacterService } from './characters/service.js';
import { characterTool } from './characters/tools.js';
import { ThemeService } from './themes/service.js';
import { themeTool } from './themes/tools.js';
import { proxy } from './net/proxy.js';
import { WebService } from './web/service.js';
import { handleWebTool } from './web/http.js';
import { configureWebMcp, setWebAgentBrowser, setWebMcpEnabled } from './web/launcher.js';
import { egoStatus } from './web/ego.js';
import { ComputerAccess } from './computer/access.js';
import { SiteAsk } from './web/site-gate.js';
import { handleComputerAsk } from './computer/http.js';
import { configureComputerMcp } from './computer/launcher.js';
import { noteDutyPid, refreshDutyFiles, restartDutyAfterApp } from './bots/duty.js';
import { acquireServerLock, BUSY_EXIT, lockNonce, processLockEnv, releaseLock, setLockReady, watchLock, watchYield } from './bots/server-lock.js';
import { BotService } from './bots/service.js';
import { CLAUDE_PROVIDER_ID } from './protocol.js';

/** the backdrop worker's own CSP: its scripts from here (and the theme's code through new Function), nothing else */
export const BACKDROP_WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval'";

const FILE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
// the desktop shell: Electron utilityProcess talks over process.parentPort (undefined outside Electron)
const parentPort = (process as any).parentPort as { postMessage(m: unknown): void; on(ev: 'message', cb: (e: { data: any }) => void): void } | undefined;

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
  // the user's proxy (a ladder's system proxy, HTTP(S)_PROXY, or 设置 → 供应商 → 网络代理) for this process's own
  // requests and every CLI it starts; requests that go out wait for this first look (net/proxy.ts)
  proxy.configure(() => meta.settings()['network.proxy']);
  void proxy.refresh().catch(() => {});
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
  /** The upload endpoints: like authOk, and with no token to guard them (loopback trusted) same-origin only (cloud/same-origin.ts). */
  const uploadOk = (req: http.IncomingMessage, url: URL): boolean =>
    authOk(req, url) && (!!token || !!(req.socket as any).cwRemote || sameOriginRequest(req));
  // eslint-disable-next-line prefer-const
  let gateway: GatewayService;
  // eslint-disable-next-line prefer-const
  let web: WebService;
  // eslint-disable-next-line prefer-const
  let computer: ComputerAccess;
  // 允许的网站: the browser tools' cards (web/site-gate.ts); knows the pool once it is made
  let knowsSession: (sid: string) => boolean = () => false;
  const siteAsk = new SiteAsk({ knows: (sid) => knowsSession(sid) });
  let modeOf: (sid: string) => import('./protocol.js').PermissionMode | undefined = () => undefined;
  // made after `web`, which only calls into it later (a character tool)
  let characters: CharacterService;
  const themes = new ThemeService();
  /** the main listener's port once it is listening (PORT=0 in the desktop app: a new one every start) */
  let listenPort = 0;
  // 发布 (stage F5): /p/<id>/ snapshots, served before any token check on both listeners (publish/service.ts)
  const publish = new PublishService({
    dir: path.join(dataDir(), 'published'),
    exportsDir: path.join(dataDir(), 'exports'),
    localBase: () => `http://127.0.0.1:${listenPort || PORT}`,
    lanBase: () => { const st = remote?.status(); return st?.running && st.addresses[0] ? `http://${st.addresses[0]}:${st.port}` : null; },
    peers: () => federation?.list() ?? [],
    request: (peerId, req) => federation.request(peerId, req),
  });
  setInterval(() => void publish.sweep().catch(() => {}), 3_600_000).unref();
  // 撤回 a machine missed while it was offline (F6): tried again every few minutes (and whenever the list is read)
  setInterval(() => void publish.retryPendingRevokes().catch(() => {}), 5 * 60_000).unref();
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = requestUrl(req, HOST);
    if (publish.handle(req, res, url)) return;
    // model gateway: its own key auth, loopback only (404 on the LAN listener)
    if (gateway?.handle(req, res, url)) return;
    // 联网: the `web` MCP processes' tool calls — this start's secret, loopback only (404 on the LAN listener)
    if (web && handleWebTool(web, req, res, url)) return;
    // 操控电脑: a `computer` MCP process asking the user for access — the same terms (computer/http.ts)
    if (computer && handleComputerAsk(computer, req, res, url)) return;
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
    // start_url / icons resolve against the manifest's own URL: relative, like everything the page loads
    if (url.pathname === '/manifest.webmanifest') { res.writeHead(200, { 'content-type': 'application/manifest+json' }); res.end(JSON.stringify({ name: 'Claude Web', short_name: 'Claude Web', start_url: './', display: 'standalone', background_color: '#f7f6f2', theme_color: '#f7f6f2', icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }, { src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] })); return; }
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // federation: a hash of the serverId (+ a nonce proof) for anyone; the ids themselves only with a valid token
      // server.lock: ?lock=<nonce> proves this is the server that wrote the lock (bots/server-lock.ts) — a yes / no, the
      // nonce itself is never sent
      const lockQ = url.searchParams.get('lock');
      res.end(JSON.stringify({ ok: true, version, ...(lockQ ? { lock: !!lockNonce() && lockQ === lockNonce() } : {}), ...(fedHealth?.(url.searchParams.get('nonce'), authOk(req, url)) ?? {}) }));
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
      if (!uploadOk(req, url)) { res.writeHead(403).end(); return; }
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
    // 导入 claude.ai 数据 (stage F4): POST /api/import/claude-ai — the export zip, kept under <data>/claude-ai/uploads/
    if (url.pathname === '/api/import/claude-ai' && req.method === 'POST') {
      if (!uploadOk(req, url)) { res.writeHead(403).end(); return; }
      if (Number(req.headers['content-length'] ?? 0) > CLAUDEAI_UPLOAD_MAX) { res.writeHead(413).end('too large'); return; }
      const dir = path.join(dataDir(), 'claude-ai', 'uploads');
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e: any) { res.writeHead(500).end(e.message); return; }
      const dest = path.join(dir, `${randomBytes(12).toString('hex')}.zip`);
      const out = fs.createWriteStream(dest);
      let size = 0;
      req.on('data', (c: Buffer) => { size += c.length; if (size > CLAUDEAI_UPLOAD_MAX) { req.destroy(); out.destroy(); fs.rm(dest, { force: true }, () => {}); } });
      req.pipe(out);
      out.on('finish', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ path: dest, size })); });
      out.on('error', (e) => { if (!res.headersSent) res.writeHead(500).end(e.message); else res.destroy(); });
      return;
    }
    // 项目资料 (stage F2): POST /api/project-files?workspaceId=&name= — token-guarded like /ws, 20 MB
    if (url.pathname === '/api/project-files' && req.method === 'POST') {
      if (!uploadOk(req, url)) { res.writeHead(403).end(); return; }
      const wid = url.searchParams.get('workspaceId') ?? '';
      if (!meta.workspaces().some((w) => w.id === wid)) { res.writeHead(404).end('no such project'); return; }
      if (Number(req.headers['content-length'] ?? 0) > PROJECT_FILE_MAX) { res.writeHead(413).end('too large'); return; }
      projectFiles.write(wid, url.searchParams.get('name') ?? '', req).then(
        (f) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(f)); },
        (e) => { if (!res.headersSent) res.writeHead(400).end(e.message); else res.destroy(); },
      );
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
    // the app is built with base './': it only works when loaded from a directory URL (/, /?token=…), never from a
    // nested path like /a/b, where ./assets/… would resolve to /a/assets/… and come back as this index.html
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h3>web/dist not built. Run <code>npm run build</code> or use <code>npm run dev</code> (Vite on :5173).</h3>');
      return;
    }
    // the page carries the language the user chose (a page without it follows the browser's)
    if (path.basename(file) === 'index.html') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(withLanguage(fs.readFileSync(file, 'utf8'), meta.settings()[LANGUAGE_KEY]));
      return;
    }
    // the character themes' backdrop worker runs code a theme brought (web/src/themes/backdrop-worker.ts): a worker's
    // permissions are its own response's CSP, and this one has no network at all — no fetch, no import() from
    // elsewhere, no fonts (docs/notes/ascii-themes.md 「背景（Worker）」)
    const extra = /^backdrop-worker-[\w-]+\.js$/.test(path.basename(file)) ? { 'Content-Security-Policy': BACKDROP_WORKER_CSP } : {};
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', ...extra });
    pipeFile(file, res);
  };
  const server = http.createServer(handler);

  const wss = new WebSocketServer({ noServer: true });
  const upgrade = (req: http.IncomingMessage, socket: any, head: Buffer) => {
    const origin = req.headers.origin ?? '';
    const url = requestUrl(req, HOST);
    // the model gateway's own socket (Responses over WebSocket): gateway key auth, not the app's
    if (gateway?.handleUpgrade(req, socket, head, url)) return;
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
  // a network path is touched only inside a project folder the user added (files/service.ts uncAllowed)
  // stage E5: WSL distros — their `\\wsl.localhost` / `\\wsl$` roots are readable like workspaces (only listed distros)
  const wsl = new WslService();
  setWslService(wsl);
  const files = new FilesService(() => [...workspaceRoots(meta.workspaces()), ...wsl.roots()]);
  // conversations that ran in a distro: its transcripts folder joins the library (in the background, never blocks start)
  void (async () => {
    const distros = new Set<string>();
    for (const m of Object.values(meta.allSessionMeta())) if (m.env?.kind === 'wsl') distros.add(m.env.distro);
    if (!distros.size) return;
    await wsl.list();
    for (const d of distros) {
      try { await wsl.check(d); const root = wsl.projectsRoot(d); if (root) addTranscriptRoot(root, d); } catch { /* distro gone */ }
    }
  })();
  const agents = new AgentRegistry(meta);
  // agent CLIs installed where a GUI-started app's PATH does not look (npm -g after login, fnm, uv tool…): added before
  // the first probe / session / terminal needs them (agents/locate.ts)
  void refreshProcessPath().catch(() => {});
  const transcripts = new AgentTranscripts();
  const canonical = new CanonicalLog();
  const memory = new MemoryService();
  setMemoryMcpEnabled(meta.settings()['memory.mcp'] !== false);
  setPromptSuggestions(meta.settings()['ui.promptSuggestions'] !== false);
  setNodegraphHint(meta.settings()[NODEGRAPH_HINT_KEY] !== false);
  setThinkingLanguageSetting(meta.settings()[THINKING_LANGUAGE_KEY]);
  setSessionsMcpEnabled(meta.settings()['sessions.mcp'] !== false);
  setDesktopSkillsEnabled(meta.settings()['claude.desktopSkills'] !== false);
  const localEnvStore = new LocalEnvStore(path.join(dataDir(), 'local-env.json'), secrets);
  await localEnvStore.load();
  // stage E: GitHub / GitLab tokens typed in settings — their own encrypted file, never meta.json's settings
  const vcsTokens = new VcsTokenStore(path.join(dataDir(), 'vcs-tokens.json'), secrets);
  // 联网: web search here, the browser tools in whichever desktop window hosts the built-in browser (web/service.ts).
  // Its own fetches wait for the proxy's look like every other request that goes out, and never reach this server.
  web = new WebService({
    settings: () => meta.settings(),
    setSetting: (k, v) => meta.setSetting(k, v),
    secrets,
    goingOut: () => proxy.refresh(),
    // 网吧's character tools ride on the same MCP server; the library is made further down
    characterTool: (tool, args) => characterTool(characters, tool, args) as any,
    themeTool: (tool, args) => themeTool({ svc: themes, getTheme: () => meta.settings()['ui.theme'], setTheme: (v) => meta.setSetting('ui.theme', v) }, tool, args) as any,
    ownPorts: () => [listenPort, remote?.port ?? 0].filter((p) => p > 0),
    gate: { ask: (sid, req, signal) => siteAsk.ask(sid, req, signal), mode: (sid) => modeOf(sid) },
  });
  await web.warm();
  setWebMcpEnabled(meta.settings()['web.mcp'] !== false);
  setWebAgentBrowser(meta.settings()['web.browser.agent']);
  // ego lite: found once at start (launcher.ts reads the verdict when a conversation starts)
  // (after PATH has the registry's entries and ~/.local/bin, where its onboarding puts the command)
  void refreshProcessPath().catch(() => {}).then(() => egoStatus()).then(() => web.settingsChanged()).catch(() => {});
  const pool = new RunnerPool(providers, agents, transcripts);
  knowsSession = (sid) => !!pool.get(sid);
  modeOf = (sid) => pool.get(sid)?.info.permissionMode;
  // 操控电脑: only a conversation that is open here can ask for control of applications; one in 完全放开 is not
  // asked (the same mode lookup as the browser gate's)
  computer = new ComputerAccess({ knows: knowsSession, mode: modeOf });
  const config = new ConfigService();
  pool.accountLoggedOut = () => config.knownLoggedOut();
  const ledger = new LedgerService((id) => meta.provider(id)?.type);
  pool.on('message', (sessionId: string, m: unknown) => ledger.observe(sessionId, m, meta.sessionMeta(sessionId).providerId));
  // 账号池: Claude subscription logins, pools, and the targets a pool resolves to
  const upstreams = new UpstreamService({ meta, secrets });
  // 托管程序: CLIProxyAPI / Magpie on loopback, registered as providers; the ones running last time come back.
  // The desktop installer passes CLAUDE_WEB_ENGINES; a dev / browser start uses vendor/engines when it was fetched.
  const bundledDir = process.env.CLAUDE_WEB_ENGINES ?? path.resolve(__dirname, '../../vendor/engines');
  const engines = new EngineManager({ meta, secrets, providers, ...(fs.existsSync(bundledDir) ? { bundledDir } : {}) });
  void engines.resume();
  // the Claude subscription bridge refuses to run a CLI whose proxy points back at one of these
  setClaudeBridgeOwnPorts(() => [listenPort || PORT, remote?.port ?? 0].filter((p) => p > 0));
  const channels = new ChannelService({ providers, upstreams, engines, meta });
  // 任务中心: our scheduler, so the sidecars' own timers stay off
  const tasks = new MaintenanceScheduler({ meta, upstreams, notify: (line) => console.log(`[tasks] ${line}`) });
  const gatewayAudit = new AuditLog(path.join(dataDir(), 'logs'), () => meta.gatewayAudit());
  // OTLP export (off until set up): the request log's batches as spans / metrics, no prompt or key ever
  const otlp = new OtlpExporter({ meta, secrets, version });
  setOtlpExporter(otlp);
  gatewayAudit.on('lines', (lines: GatewayAuditLine[]) => otlp.record(lines));
  // 隐私保护: redacts what leaves through the gateway / cache shim (privacy/service.ts)
  const privacy = new PrivacyService(meta, { dataDir: dataDir() });
  // what this process prints (server.log) is masked too: secrets always, the user's types with 「日志和导出也遮住」
  installConsoleMask((line) => privacy.maskOutput(line));
  // privacy turned on for the first time: idle Claude conversations restart (resume) so they go through the relay
  // from now on; busy ones / other agents pick it up when reopened (立即生效 covers every later change)
  privacy.onArm(() => {
    for (const r of pool.list()) if (r instanceof SessionRunner && r.state === 'idle' && !r.hasBackgroundWork()) void r.respawn().catch(() => { /* the old process keeps going */ });
  });
  gateway = new GatewayService({
    meta,
    privacy,
    secrets,
    ledger,
    audit: gatewayAudit,
    upstreams,
    member: (id) => providers.member(id),
    // account / pool members go through the upstream service; provider members through the profile
    resolveMember: async (m, model, sessionKey) => {
      const own = await upstreams.resolveMembers(m, model, sessionKey);
      if (own.length || m.accountId || m.upstreamGroupId) return own;
      const p = m.providerId ? providers.member(m.providerId) : null;
      return p ? [p] : [];
    },
  });
  await gateway.init();
  // every group is a provider profile too: the model menu lists a group's models without a manual profile
  await gateway.syncProfiles().catch(() => {});
  upstreams.onGatewayGroups = () => { void gateway.syncProfiles().catch(() => {}); };
  providers.gatewayEndpoint = (groupId) => gateway.endpoint(groupId);
  providers.shimEndpoint = (providerId) => gateway.shimEndpoint(providerId);
  // 隐私保护 on: providers not behind the gateway / shim get the privacy relay as their base URL (privacy/route.ts)
  setPrivacyRoute((target) => gateway.privacyBase(target));
  setSplitHook({ endpoint: (main, sub, model) => gateway.splitEndpoint(main, sub, model), target: (id) => providers.subagentTarget(id) });
  // 智能路由 · 意图判断: the judge model is a provider candidate, asked with its own key (routing/intent-ask.ts)
  setIntentMember((id) => providers.member(id));
  // plugins (declarative sources + isolated executable plugins), sync bundles, 远程共享 keys on the gateway
  const plugins = new PluginService({ meta, secrets, appVersion: version });
  await plugins.init().catch((e) => console.error('[plugins]', e?.message ?? e));
  // request-before / response-after on every gateway attempt, inside 隐私保护's redact → restore (no plugin → no call)
  gateway.plugins = plugins;
  const sync = new SyncService({ meta, secrets });
  const syncRemote = new RemoteSyncService({ meta, secrets, sync });
  const share = new ShareService(gateway);
  remote = new RemoteService(meta, () => { const s = http.createServer(handler); s.on('upgrade', upgrade); return s; });
  // 在外面也能用: bridges phones' links to the remote-access listener above (never to this main one)
  const anywhere = new AnywhereService(meta, remote);
  const tunnels = new TunnelManager();
  const sessionsSvc = new SessionService(path.join(dataDir(), 'session-titles.json'));
  const im = new ImService(meta, secrets, pool, sessionsSvc);
  const gitSvc = new GitService();
  const terminal = new TerminalService();
  // Session library: Claude always; Codex / OpenCode constructed but idle until joined (no process is
  // started before the user joins); other ACP agents get a source built only on join. Launch specs are
  // read through getters so agents.set overrides apply without a restart.
  // claude.ai data export (stage F4): read-only, joined by the import itself
  const claudeAiSource = new ClaudeAiSource(path.join(dataDir(), 'claude-ai'));
  const library = new LibraryService(
    [
      new ClaudeSource(sessionsSvc),
      new CodexSource(() => agents.launch('codex')),
      new OpenCodeSource(() => agents.launch('opencode')),
      new CursorSource(),
      new DshSource(),
      claudeAiSource,
    ],
    new LibraryIndex(),
    transcripts,
    meta,
    {
      agents,
      makeSource: (kind) => (agents.defs().some((d) => d.kind === kind && d.protocol === 'acp') ? new AcpListSource(kind, () => agents.launch(kind)) : null),
      fallbackSearch: (q, limit) => sessionsSvc.search(q, limit),
      isLive: (id) => !!pool.get(id),
    },
  );
  pool.syncMirror = (id) => library.syncMirror(id);
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
  const background = new BackgroundService({ pool, transcriptOf: findClaudeTranscript });
  characters = new CharacterService(path.join(dataDir(), 'characters'), { get: () => meta.settings()['cafe.assign'] as any, set: (a) => meta.setSetting('cafe.assign', a) });
  const customCss = new CustomCssService();
  customCss.watch();
  // 预览服务器 (preview/): dev servers from .claude/launch.json, opened in the app's browser
  const previews = new PreviewService();
  setPreviewDeps({ service: previews, open: async (sid, url) => { await web.openPreview(sid, url); } });
  // 跨对话工具: what a conversation's sessions tools see and do (sessions-mcp/tools.ts)
  setSessionsDeps({
    list: () => library.list(),
    read: async (id) => (await library.read(id)).messages,
    stateOf: (id) => pool.stateOf(id),
    deliver: async (id, text) => {
      const sum = (await library.list()).find((x) => x.sessionId === id);
      // a closed conversation opens again (its provider / mode come back from meta, runtime/pool.ts) and then hears it
      pool.assertWritable(id); // handed to another machine (F4)
      const r = pool.get(id) ?? pool.open({ sessionId: id, cwd: sum?.cwd ?? '', agent: sum?.agent });
      sendWhenIdle(r as any, text, { onGiveUp: (why) => console.warn(`[sessions-mcp] message for ${id} not delivered: ${why}`) });
    },
    rename: async (id, title) => { await library.rename(id, title); sessionsSvc.emit('changed'); },
    archive: async (id) => { await library.archive([id], true); },
    isScheduled: (id) => meta.schedules().some((s) => s.sessionId === id) || meta.scheduleRuns(undefined, 300).some((r) => r.sessionId === id),
    // 项目页 (stage F2): a conversation's project, and whether that project keeps its sessions tools to itself
    projectOf: (id, cwd) => { const m = meta.sessionMeta(id); return projectOf({ cwd, workspaceId: m.workspaceId, groupCwd: m.groupCwd }, meta.workspaces())?.id; },
    cwdOf: (id) => pool.get(id)?.info.cwd || undefined,
    restricted: (id, cwd) => { const m = meta.sessionMeta(id); return projectOf({ cwd, workspaceId: m.workspaceId, groupCwd: m.groupCwd }, meta.workspaces())?.sessionsScope === 'project'; },
  });
  // stage F (cloud/handlers.ts): project files, 派活
  const projectFiles = new ProjectFiles(dataDir());
  const dispatch = new DispatchService({
    meta,
    open: (p) => pool.open(p),
    homeDir: () => os.homedir(),
    forward: (peerId, req) => federation.request(peerId, req),
    peers: () => federation.list(),
  });
  // 交给常开机器继续 (stage F1)
  const handoff = new HandoffService({
    meta,
    request: (peerId, req) => federation.request(peerId, req),
    peers: () => federation.list(),
    summaryOf: async (id) => { const x = (await library.list()).find((y) => y.sessionId === id); return x ? { cwd: x.cwd, title: x.customTitle || x.title } : undefined; },
    readAll: (id) => library.readAll(id),
    stop: (id) => pool.close(id),
    isRunning: (id) => { const st = pool.stateOf(id); return st === 'running' || st === 'waiting'; },
    open: (p) => pool.open(p),
    rename: async (id, title, cwd) => { await renameSdkSession(id, title, { dir: cwd }); sessionsSvc.emit('changed'); },
    dataDir: dataDir(),
    serverName: () => os.hostname(),
  });
  // F4: handed off (or being handed) = read-only here, whoever sends — window, IM, schedule, goal, another conversation
  pool.readOnly = (id) => handoff.readOnlyReason(id);
  // a machine back online hears the 撤回 it missed (F6)
  federation.on('event', (e: { kind: string }) => { if (e.kind === 'peers.changed') void publish.retryPendingRevokes().catch(() => {}); });
  const claudeAi = new ClaudeAiImport({ root: path.join(dataDir(), 'claude-ai'), meta, library: { join: (k, on) => library.join(k, on), invalidate: (k) => library.invalidate(k) }, source: claudeAiSource });
  claudeAi.sweepUploads();
  setInterval(() => claudeAi.sweepUploads(), 3_600_000).unref();
  const cloud: CloudServices = { projectFiles, dispatch, handoff, publish, claudeAi, workspaceExists: (id) => meta.workspaces().some((w) => w.id === id) };
  const importer = new ImportService({
    providers: { hasSame: (t, b, k) => providers.hasSame(t, b, k), upsert: (p) => providers.upsert(p) },
    mcp: {
      names: () => config.mcpUserNames(),
      add: (name, json) => config.mcpAdd(name, json, 'user'),
    },
  });
  themes.watch();
  // 值班 Bot: one service per data dir; runs only while this server holds <dataDir>/bots/scheduler.lock
  const bots = new BotService({
    dataDir: path.join(dataDir(), 'bots'), pool, memory, ledger, meta,
    im: { sendTo: (g, c, t, b) => im.router.sendTo(g, c, t, b), onCallback: (p, h) => im.router.callbackHandlers.set(p, (parts, ctx) => h(parts, ctx)), onStop: (h) => { im.router.onStop = h; } },
    providerKind: (pid) => {
      const id = pid ?? pool.defaultProviderFor('claude');
      if (!id || id === CLAUDE_PROVIDER_ID) return 'claude';
      const p = meta.provider(id);
      if (p?.type === 'gateway' && p.gatewayGroupId && gateway.routingGroup()?.id === p.gatewayGroupId) return 'routing';
      return p?.type === 'anthropic' || p?.type === 'claude-account' ? 'claude' : 'other';
    },
  });
  void bots.start();
  const services = { importer, customCss, orchestra, background, characters, themes, remote, anywhere, tunnels, im, vcs: new VcsService(gitSvc, { gitlabHosts: () => { const v = meta.settings()['vcs.gitlabHosts']; return Array.isArray(v) ? v : []; }, tokens: vcsTokens }), vcsTokens, wsl, goals, android: new AndroidService(), pool, sessions: sessionsSvc, config, usage: new UsageService(async (sid) => providerTimeline(await canonical.providerSwitches(sid), meta.sessionMeta(sid).providerId, (id) => { const p = meta.provider(id); return p ? { type: p.type, name: p.name } : undefined; })), files, terminal, meta, limits: new LimitsService(), schedules: new ScheduleService(meta, pool), providers, git: gitSvc, search: new SearchService(), skills: new SkillsService(), mcp: new McpService(), diag: new DiagService(version), ledger, agents, transcripts, canonical, memory, library, version, federation, agentConfig: new AgentConfigService({ agents, backupDir: path.join(dataDir(), 'config-backups') }), gateway, privacy, upstreams, channels, engines, plugins, sync, syncRemote, share, tasks, web, computer, siteAsk, localEnv: localEnvStore, previews, cloud, bots };
  new Hub(wss, services);
  tasks.start();
  // model lists older than a day (or never pulled) are refreshed in the background — list only, no tokens
  void providers.autoRefreshModels();

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(PORT, HOST, () => res());
  });
  const port = (server.address() as { port: number }).port;
  gateway.port = port;
  listenPort = port;
  // from here on new conversations are told about the `web` MCP server: it calls back to this port
  configureWebMcp({ url: `http://127.0.0.1:${port}`, token: web.token });
  // …and conversations with 操控电脑 on about the `computer` one, which asks here before it grants anything
  configureComputerMcp({ url: `http://127.0.0.1:${port}`, token: computer.token });
  await remote.start();
  if (remote.status().running) console.log(`remote access on http://0.0.0.0:${remote.port}  (${remote.addresses().join(', ')})`);
  // 不让电脑睡眠: the shell holds a powerSaveBlocker while remote access is on — told now and on every change
  // 保持电脑唤醒 (phase 6): also while a conversation set to it (SessionMeta.keepAwake) is busy
  const busy = (st: string | undefined) => st === 'running' || st === 'waiting' || st === 'starting';
  const stopKeepAwake = reportKeepAwake(meta, (on) => parentPort?.postMessage({ type: 'keepAwake', on }), () => pool.list().some((r) => busy(r.state) && !!meta.sessionMeta(r.sessionId).keepAwake));
  pool.on('state', () => stopKeepAwake.recheck());
  // no CLI process writes this conversation's transcript any more (closed, or never reopened since)
  const processGone = (sid: string) => { const st = pool.stateOf(sid); return !st || st === 'closed'; };
  // a name kept for a process that never got to end here (the server stopped while it ran): written now
  for (const [sid, m] of Object.entries(meta.allSessionMeta())) {
    if (m.pendingTitle) void library.rename(sid, m.pendingTitle).catch(() => {}).finally(() => { void meta.setSessionMeta(sid, { pendingTitle: undefined }); });
  }
  // a rename made while the process ran (ws/hub.ts renameKept): the process wrote its old title back on the way out —
  // write the new one again, after it
  pool.on('state', (sid: string, state: string) => {
    if (state !== 'closed' && state !== 'error') return;
    const title = meta.sessionMeta(sid).pendingTitle;
    if (!title) return;
    setTimeout(() => {
      if (!processGone(sid)) return;
      void library.rename(sid, title).catch(() => {}).finally(() => { void meta.setSessionMeta(sid, { pendingTitle: undefined }); sessionsSvc.emit('changed'); });
    }, 500).unref?.();
  });
  // a conversation whose process ended without the title lines a clean CLI exit writes, and whose first prompt is too
  // long for the SDK's head read, is listed by no app that reads Claude Code's history through the SDK (Mirasim…):
  // write the `last-prompt` line the CLI would have (sessions/unlisted.ts)
  pool.on('state', (sid: string, state: string) => {
    if (state !== 'closed' && state !== 'error') return;
    setTimeout(() => {
      void (async () => {
        if (!processGone(sid)) return;
        if (await getSessionInfo(sid).catch(() => undefined)) return;
        const file = findClaudeTranscript(sid);
        if (file && appendLastPrompt(file, sid)) sessionsSvc.emit('changed');
      })().catch(() => {});
    }, 1500).unref?.();
  });
  await anywhere.start();
  await im.startAll();
  const eng = await engineInfo();
  console.log(`claude-web ${version} listening on http://${HOST}:${port}  (runtime: ${eng.runtime} ${eng.version ?? ''} ${eng.path})`);

  return {
    port,
    host: HOST,
    token,
    async close() {
      stopKeepAwake(); // no keepAwake reports while shutting down (the shell releases its blocker on quit)
      configureWebMcp(null); // the MCP secret file goes with this server
      configureComputerMcp(null);
      await im.stopAll();
      await federation.close();
      await tunnels.closeAll();
      await anywhere.stop(); // the phones' links and the broker connections, before the listener they bridge to
      await tasks.stop(); // before the sidecars it drives
      plugins.stop(); // the executable plugins' child processes
      await gateway.stop(); // the LAN listener, the audit buffer and the key counters
      await otlp.stop(); // what the last audit flush handed it
      await upstreams.stop();
      await engines.stopAll(); // CLIProxyAPI / Magpie we started (their trees); they come back at the next start
      await remote.stop();
      // this server's own bot runs end as stopped, before the pool closes their conversations; the lease goes back.
      // Not stopAll: on a server not on duty that would ask the one on duty to stop its runs
      await bots.shutdown().catch(() => {});
      await orchestra.shutdown(); // before the pool: session closes must not fail / advance runs
      await pool.closeAll();
      await library.close(); // library-only Codex app-server / opencode serve / ACP processes
      terminal.closeAll(); // pty children (the embedded `claude` terminals) would outlive us otherwise
      setPreviewDeps(null);
      await previews.stopAll(); // the dev servers preview_start started (preview/service.ts)
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
  // one server per data dir (bots/server-lock.ts): the duty service steps aside for the app, before any port opens
  const lockDir = dataDir();
  const kind = process.env.CLAUDE_WEB_DUTY === '1' ? 'duty' : 'app';
  const got = await acquireServerLock(lockDir, kind, Number(process.env.PORT) || 0, processLockEnv());
  if (!got.ok) {
    console.log(`[duty] another claude-web (pid ${got.holder.pid}, ${got.holder.kind}) serves ${lockDir}; trying again later`);
    process.exit(BUSY_EXIT);
  }
  // the duty server watches for a yield request from the start: an app opened at logon asks while this one starts
  let yieldAsked = false;
  let onYield = () => { yieldAsked = true; };
  const stopYield = kind === 'duty' ? watchYield(lockDir, got.lock.startedAt, process.pid, () => onYield()) : () => {};
  let running: Awaited<ReturnType<typeof startServer>>;
  try {
    running = await startServer();
  } catch (e) {
    stopYield();
    releaseLock(lockDir, process.pid);
    throw e;
  }
  // the duty server: an app took the lock over while this one started (the write may have raced it) → step down below
  if (!setLockReady(lockDir, process.pid, running.port) && kind === 'duty') yieldAsked = true;
  // the app: a duty server that took the dir meanwhile (it judged this one dead through a stall) is asked to step down
  // and the lock taken back — or the lock, gone or dead, just taken (an app that started beside another one)
  const stopWatchLock = kind === 'app' ? watchLock(lockDir, () => ({ ...got.lock, port: running.port, ready: true }), processLockEnv()) : () => {};
  // under the Windows duty task: let "duty off" find and stop us
  noteDutyPid();
  // the duty service's own files, from an older version (a 5 s back-off, the old entry): brought up to date
  if (kind === 'duty') void refreshDutyFiles().then((c) => { if (c.length) console.log(`[duty] updated ${c.join(', ')}`); }).catch(() => {});
  const ready = { type: 'ready', port: running.port, host: running.host };
  // Electron utilityProcess talks over process.parentPort; plain child_process.fork over process.send
  if (parentPort) parentPort.postMessage(ready);
  else if (process.send) process.send(ready);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; // SIGINT twice / signal + parent message: don't close everything twice
    stopping = true;
    stopYield();
    stopWatchLock();
    try {
      await running.close();
    } catch (e) {
      console.error('shutdown:', e);
    }
    releaseLock(lockDir, process.pid);
    // the app / dev server hands the dir back to the duty service, if duty mode is on for it
    if (kind === 'app') await restartDutyAfterApp().catch(() => false);
    process.exit(0);
  };
  // the duty server: an app asked for the dir (server.yield, or it took the lock) → the normal shutdown (its bot runs
  // end as stopped) — at once if that came while it was starting
  onYield = () => { console.log('[duty] the app asked for the data dir; stepping down'); void shutdown(); };
  if (yieldAsked) onYield();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('message', (m: any) => { if (m?.type === 'shutdown') void shutdown(); });
  parentPort?.on('message', (e) => { if (e.data?.type === 'shutdown') void shutdown(); });
}
