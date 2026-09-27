import type { JsonRpcProcess } from '../agents/jsonrpc.js';

/**
 * A JSON-RPC process that is spawned lazily on first request and killed after `idleMs` of no
 * requests, then respawned transparently on the next one. Used by library sources (Codex app-server,
 * `opencode serve`) that must not share a process with a live chat session and must not sit around
 * forever just to serve the occasional list/read (constraints.md: "库专用后台进程... 闲置 5 分钟退出").
 *
 * `spawn` is called fresh every time a process is needed (so it can read the latest launch config —
 * e.g. after `agents.set` changes the codex command — without a server restart); `init` runs once
 * right after spawn (typically `initialize` + `initialized`) before the first real request goes out.
 */
export class LazyRpc {
  private rpc: JsonRpcProcess | null = null;
  private starting: Promise<JsonRpcProcess> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private gen = 0; // bumped by close(): a start still in flight when it ran must not be adopted

  constructor(
    private readonly spawnFn: () => JsonRpcProcess,
    private readonly initFn: (rpc: JsonRpcProcess) => Promise<void>,
    private readonly idleMs = 300_000,
  ) {}

  private clearIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private armIdle() {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      const rpc = this.rpc;
      this.rpc = null;
      rpc?.kill();
    }, this.idleMs);
  }

  private async ensure(): Promise<JsonRpcProcess> {
    if (this.rpc && !this.rpc.exited) return this.rpc;
    if (this.starting) return this.starting;
    const gen = this.gen;
    const starting = (async () => {
      const rpc = this.spawnFn();
      rpc.on('exit', () => { if (this.rpc === rpc) this.rpc = null; });
      try {
        await this.initFn(rpc);
      } catch (e) {
        rpc.kill();
        throw e;
      }
      if (gen !== this.gen) {
        rpc.kill();
        throw new Error('LazyRpc：启动完成前已被 close()');
      }
      this.rpc = rpc;
      return rpc;
    })();
    this.starting = starting;
    try {
      return await starting;
    } finally {
      // only our own start: after close() a newer one may already be in flight
      if (this.starting === starting) this.starting = null;
    }
  }

  async request<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const rpc = await this.ensure();
    this.armIdle();
    return rpc.request<T>(method, params, timeoutMs);
  }

  async close(): Promise<void> {
    this.gen++;
    this.clearIdle();
    const rpc = this.rpc;
    this.rpc = null;
    this.starting = null;
    rpc?.kill();
  }
}
