// Claude subscription bridge (after Magpie internal/claudebridge, MIT): a source that serves gateway requests by
// running the user's own `claude` CLI on their own Claude login. It is a small Anthropic-format HTTP endpoint on
// 127.0.0.1 (random key, random port) plus the provider profile pointing at it, so the gateway and routing use it
// like any other Anthropic endpoint. Off until the user adds it from the catalog; plain chat only (no tool use).
//
// Guards: one CLI process per request, at most `maxConcurrent` at a time (429 beyond), a whole-run timeout and an
// idle timeout, the client hanging up kills the run, and nothing in the CLI's env / settings can send it back to
// claude-web (see claude-bridge-core.ts: allow-listed env, user settings not loaded, `loopRisk` checked per run).
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tr } from '../../i18n/index.js';
import type { MetaStore } from '../../meta/store.js';
import { badPort, listenSafe } from '../../net/safe-port.js';
import { accountModels } from '../../providers/service.js';
import { findOnPath, resolveSpawn } from '../../agents/resolve.js';
import type { CatalogEntry, SourceHealth, SourceSummary } from '../types.js';
import { projectProvider } from '../registry.js';
import {
  BRIDGE_CATALOG_ID, BridgeError, CliOutput, LOOP_HEADER, bridgeEnv, classify, cliArgs, defaultWorkRoot, loopRisk,
  makeWorkDir, managedSettingsPaths, sse, synthesizeEvents, toCliTurn,
} from './claude-bridge-core.js';
import type { ProviderDeps } from './provider.js';
import type { AddInput, ChannelDriver, DriverContext } from './types.js';

export { BRIDGE_CATALOG_ID } from './claude-bridge-core.js';

/** claude-web's own listening ports (main server / remote listener) — set once by index.ts. */
let ownPortsFn: () => number[] = () => [Number(process.env.PORT ?? 3090)];
export function setClaudeBridgeOwnPorts(fn: () => number[]): void { ownPortsFn = fn; }

export interface BridgeOptions {
  /** what clients must send as x-api-key / Bearer */
  key: string;
  /** how to start the CLI (tests: node + a fake script); default `claude` on PATH */
  cli?: () => { command: string; args: string[] };
  maxConcurrent?: number;
  /** whole run (default 10 min) */
  timeoutMs?: number;
  /** no output from the CLI for this long (default 2 min) */
  idleMs?: number;
  /** the server's env the CLI's is derived from (default process.env) */
  env?: NodeJS.ProcessEnv;
  ownPorts?: () => number[];
  managedSettings?: string[];
  workRoot?: string;
  models?: () => string[];
}

const MAX_BODY = 32 * 1024 * 1024;

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const errorBody = (type: string, message: string) => ({ type: 'error', error: { type, message } });

function keyOk(req: http.IncomingMessage, key: string): boolean {
  const given = String(req.headers['x-api-key'] ?? '') || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new BridgeError(413, 'request_too_large', 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export class ClaudeBridgeServer {
  private server: http.Server | null = null;
  private running = new Set<ChildProcess>();
  active = 0;

  constructor(private opts: BridgeOptions) {}

  get port(): number { return this.server ? (this.server.address() as AddressInfo).port : 0; }
  get listening(): boolean { return !!this.server?.listening; }

  private max() { return Math.max(1, this.opts.maxConcurrent ?? 2); }
  private ownPorts() { return [...(this.opts.ownPorts ?? ownPortsFn)(), this.port]; }
  private models() { return this.opts.models?.() ?? accountModels().models; }

  async start(port = 0): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 0;
    // the last port (one fetch refuses, kept from before, is dropped: net/safe-port.ts)
    const want = badPort(port) ? 0 : port;
    await listenSafe(server, want, '127.0.0.1').catch(async (e) => {
      if (want === 0) throw e;
      // the last port is taken now: any free one
      await listenSafe(server, 0, '127.0.0.1');
    });
    this.server = server;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const c of this.running) c.kill();
    this.running.clear();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
  }

  /** Can the CLI run here at all (found, no loop)? Returns the reason it cannot, or null. */
  preflight(): string | null {
    if (!this.opts.cli && !findOnPath('claude')) return tr('没找到 claude 命令：先安装 Claude Code 并登录');
    const risk = loopRisk(bridgeEnv(this.opts.env ?? process.env), this.ownPorts(), this.opts.managedSettings ?? managedSettingsPaths());
    return risk ? tr('为避免死循环，已拒绝：{why}', { why: risk }) : null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.headers[LOOP_HEADER]) throw new BridgeError(508, 'api_error', 'loop detected: this request came from a CLI the bridge itself started');
      if (!keyOk(req, this.opts.key)) throw new BridgeError(401, 'authentication_error', 'invalid x-api-key');
      const url = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        const data = this.models().map((id) => ({ type: 'model', id, display_name: id, created_at: '2025-01-01T00:00:00Z' }));
        sendJson(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null });
        return;
      }
      if (req.method === 'POST' && url === '/v1/messages/count_tokens') {
        const raw = await readBody(req);
        sendJson(res, 200, { input_tokens: Math.ceil(raw.length / 4) });
        return;
      }
      if (req.method !== 'POST' || url !== '/v1/messages') throw new BridgeError(404, 'not_found_error', 'not found');
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); } catch (e) { if (e instanceof BridgeError) throw e; throw new BridgeError(400, 'invalid_request_error', 'body is not JSON'); }
      const turn = toCliTurn(body);
      if (this.active >= this.max()) throw new BridgeError(429, 'rate_limit_error', `the Claude subscription bridge is already running ${this.max()} requests`);
      const env = bridgeEnv(this.opts.env ?? process.env);
      const risk = loopRisk(env, this.ownPorts(), this.opts.managedSettings ?? managedSettingsPaths());
      if (risk) throw new BridgeError(508, 'api_error', `refused to avoid a loop: ${risk}`);
      this.active++;
      try { await this.run(turn, env, req, res); } finally { this.active--; }
    } catch (e: any) {
      if (e instanceof BridgeError) sendJson(res, e.status, errorBody(e.type, e.message), e.status === 429 ? { 'retry-after': '5' } : {});
      else sendJson(res, 500, errorBody('api_error', String(e?.message ?? e)));
    }
  }

  private run(turn: ReturnType<typeof toCliTurn>, env: Record<string, string>, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const work = makeWorkDir(this.opts.workRoot ?? defaultWorkRoot(), turn.system);
    const args = cliArgs(turn, work);
    const base = this.opts.cli?.() ?? { command: 'claude', args: [] };
    const sp = this.opts.cli ? { command: base.command, args: [...base.args, ...args], env: {}, via: 'direct' as const } : resolveSpawn(base.command, [...base.args, ...args]);
    const child = spawn(sp.command, sp.args, { cwd: work.dir, env: { ...env, ...sp.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: sp.via === 'cmd' });
    this.running.add(child);

    let streamStarted = false;
    const startStream = () => {
      if (streamStarted) return;
      streamStarted = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    };
    const out = new CliOutput(turn.model, turn.stream ? (ev) => { startStream(); res.write(sse(ev)); } : undefined);
    let stderr = '';
    let killedFor: string | null = null;
    const kill = (why: string) => { if (!killedFor) { killedFor = why; child.kill(); } };

    const whole = setTimeout(() => kill('timeout'), this.opts.timeoutMs ?? 10 * 60_000);
    let idle: NodeJS.Timeout | undefined;
    const poke = () => { clearTimeout(idle); idle = setTimeout(() => kill('idle'), this.opts.idleMs ?? 120_000); };
    poke();
    res.on('close', () => { if (!res.writableFinished) kill('client'); });

    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      poke();
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { out.line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (c: string) => { poke(); stderr = (stderr + c).slice(-4000); });
    child.stdin!.on('error', () => { /* the CLI exited before reading: reported on close */ });
    child.stdin!.end(`${turn.input}\n`);

    return new Promise<void>((resolve) => {
      const finish = (spawnError?: Error) => {
        clearTimeout(whole);
        clearTimeout(idle);
        this.running.delete(child);
        fs.rm(work.dir, { recursive: true, force: true }, () => {});
        if (buf.trim()) { out.line(buf); buf = ''; }
        const msg = out.result();
        const failure = spawnError ? { status: 502, type: 'api_error', message: `could not start claude: ${spawnError.message}` }
          : killedFor === 'timeout' ? { status: 504, type: 'api_error', message: 'the claude CLI took too long' }
            : killedFor === 'idle' ? { status: 504, type: 'api_error', message: 'the claude CLI stopped answering' }
              : out.error ?? (msg ? null : classify(stderr.trim() || 'the claude CLI gave no answer'));
        if (killedFor === 'client') { resolve(); return; }
        if (turn.stream) {
          if (failure) {
            if (streamStarted) res.end(sse({ type: 'error', error: { type: failure.type, message: failure.message } }));
            else sendJson(res, failure.status, errorBody(failure.type, failure.message));
          } else {
            if (!out.streamed && msg) { startStream(); for (const ev of synthesizeEvents(msg)) res.write(sse(ev)); }
            res.end();
          }
        } else if (failure) sendJson(res, failure.status, errorBody(failure.type, failure.message));
        else sendJson(res, 200, msg);
        resolve();
      };
      child.once('error', (e) => finish(e));
      child.once('close', () => finish());
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The source

export const BRIDGE_SOURCE_ID = 'claude-bridge';
const ENGINE_TAG = 'claude-bridge';

export interface ClaudeBridgeDeps {
  providers: ProviderDeps;
  meta?: MetaStore;
  /** tests: a server factory (fake CLI) */
  server?: (key: string) => ClaudeBridgeServer;
}

export class ClaudeBridgeDriver implements ChannelDriver {
  readonly id = 'claude-bridge' as const;
  readonly kind = 'provider' as const;
  readonly needs = 'none' as const;
  private server: ClaudeBridgeServer | null = null;
  private lastError = '';
  private resuming: Promise<void> | null = null;

  constructor(private deps: ClaudeBridgeDeps) {
    // added before: bring the endpoint back up (new key, the old port if it is free) once the server is up
    if (deps.meta && this.providerId()) setImmediate(() => { void this.resume(); });
  }

  owns(sourceId: string) { return sourceId === BRIDGE_SOURCE_ID; }

  private providerId(): string | null {
    const links = this.deps.meta?.channelLinks() ?? {};
    return Object.keys(links).find((id) => links[id]?.engine === ENGINE_TAG) ?? null;
  }

  private make(key: string) { return this.deps.server?.(key) ?? new ClaudeBridgeServer({ key }); }

  list(ctx: DriverContext): SourceSummary[] {
    const id = Object.keys(ctx.links).find((k) => ctx.links[k]?.engine === ENGINE_TAG);
    const p = id ? ctx.providers.find((x) => x.id === id) : undefined;
    if (!p) return [];
    const base = projectProvider(p);
    const health: SourceHealth = this.server?.listening ? (this.lastError ? 'attention' : 'ready') : 'disabled';
    return [{
      ...base,
      id: BRIDGE_SOURCE_ID,
      category: 'subscription',
      health,
      detail: this.lastError || tr('用本机 claude 命令和你自己的 Claude 订阅回答；只支持纯文字对话（不支持工具调用），每次请求启动一次 claude'),
      catalogId: BRIDGE_CATALOG_ID,
      needs: 'none',
      actions: { canAddAccount: false, canEditProvider: false, canManageEngine: false, canRemove: true },
    }];
  }

  private async bringUp(port = 0): Promise<{ key: string; port: number }> {
    const key = `cwb-${crypto.randomBytes(24).toString('base64url')}`;
    const server = this.make(key);
    const why = server.preflight();
    if (why) throw new Error(why);
    const bound = await server.start(port);
    await this.server?.stop();
    this.server = server;
    this.lastError = '';
    return { key, port: bound };
  }

  async add(_entry: CatalogEntry, input: AddInput): Promise<string> {
    if (this.providerId()) { await this.resume(); return BRIDGE_SOURCE_ID; }
    const { key, port } = await this.bringUp();
    try {
      const saved = await this.deps.providers.upsert({
        name: input.name?.trim() || tr('Claude 订阅（本机 claude 命令）'),
        type: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, apiKey: key, authStyle: 'x-api-key',
        ...accountModels(), modelsAt: Date.now(),
      });
      if (this.deps.meta) {
        this.deps.meta.channelLinks()[saved.id] = { catalogId: BRIDGE_CATALOG_ID, engine: ENGINE_TAG };
        await this.deps.meta.saveChannels();
      }
    } catch (e) {
      await this.server?.stop();
      this.server = null;
      throw e;
    }
    return BRIDGE_SOURCE_ID;
  }

  /** Start the endpoint for a source added in an earlier run and point its profile at it. */
  resume(): Promise<void> {
    this.resuming ??= (async () => {
      const id = this.providerId();
      if (!id) return;
      const p = this.deps.providers.list().find((x) => x.id === id);
      if (!p) return;
      const old = Number(/:(\d+)\/?$/.exec(p.baseUrl ?? '')?.[1] ?? 0);
      try {
        const { key, port } = await this.bringUp(this.server?.listening ? 0 : old);
        await this.deps.providers.upsert({ id, baseUrl: `http://127.0.0.1:${port}`, apiKey: key });
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
      }
    })().finally(() => { this.resuming = null; });
    return this.resuming;
  }

  async refresh(): Promise<void> {
    if (!this.server?.listening) await this.resume();
    if (this.lastError) throw new Error(this.lastError);
    const why = this.server?.preflight();
    if (why) { this.lastError = why; throw new Error(why); }
  }

  async remove(): Promise<void> {
    await this.server?.stop();
    this.server = null;
    const id = this.providerId();
    if (!id) return;
    await this.deps.providers.remove(id);
    if (this.deps.meta) {
      delete this.deps.meta.channelLinks()[id];
      await this.deps.meta.saveChannels();
    }
  }

  async stop(): Promise<void> { await this.server?.stop(); this.server = null; }
}
