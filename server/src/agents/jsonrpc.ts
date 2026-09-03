import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveSpawn } from './resolve.js';

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio (what ACP agents and `codex app-server` speak).
 * Emits: 'notification' (method, params), 'request' handled via `onRequest`, 'exit' (code), 'stderr' (text).
 */
export class JsonRpcProcess extends EventEmitter {
  private child: ChildProcess;
  private seq = 0;
  private pending = new Map<number | string, { resolve: (v: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }>();
  private buf = '';
  private handlers = new Map<string, (params: any, id: number | string) => Promise<any> | any>();
  exited = false;
  stderrTail = '';

  constructor(command: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
    super();
    const r = resolveSpawn(command, args);
    this.child = spawn(r.command, r.args, { cwd: opts.cwd, env: { ...process.env, ...r.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: r.via === 'cmd' });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-4000); this.emit('stderr', d); });
    this.child.on('error', (e) => { this.exited = true; this.failAll(e); this.emit('exit', -1, e.message); });
    this.child.on('exit', (code) => { this.exited = true; this.failAll(new Error(`进程退出 ${code}`)); this.emit('exit', code); });
  }

  get pid() { return this.child.pid; }

  private failAll(e: Error) {
    for (const [, p] of this.pending) { if (p.timer) clearTimeout(p.timer); p.reject(e); }
    this.pending.clear();
  }

  private onLine(line: string) {
    let m: any;
    try { m = JSON.parse(line); } catch { this.emit('garbage', line); return; }
    if (process.env.CW_RPC_DEBUG) console.error('[rpc<]', line.slice(0, 600));
    if (Array.isArray(m)) { for (const x of m) this.dispatch(x); return; }
    this.dispatch(m);
  }

  private dispatch(m: any) {
    if (m.method !== undefined && m.id !== undefined) {
      // server → client request
      const h = this.handlers.get(m.method);
      if (!h) { this.reply(m.id, undefined, { code: -32601, message: `unhandled ${m.method}` }); this.emit('unhandledRequest', m); return; }
      Promise.resolve().then(() => h(m.params, m.id)).then((r) => this.reply(m.id, r ?? null), (e) => this.reply(m.id, undefined, { code: -32000, message: e?.message ?? String(e) }));
    } else if (m.method !== undefined) {
      this.emit('notification', m.method, m.params);
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message ?? 'rpc error'), { code: m.error.code, data: m.error.data }));
      else p.resolve(m.result);
    }
  }

  private write(obj: unknown) {
    if (this.exited || !this.child.stdin?.writable) return;
    if (process.env.CW_RPC_DEBUG) console.error('[rpc>]', JSON.stringify(obj).slice(0, 600));
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  reply(id: number | string, result?: unknown, error?: { code: number; message: string }) {
    this.write(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result });
  }

  notify(method: string, params?: unknown) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const p: any = { resolve, reject };
      if (timeoutMs > 0) p.timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs);
      this.pending.set(id, p);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Register a handler for requests the agent sends to us. */
  onRequest(method: string, h: (params: any, id: number | string) => Promise<any> | any) {
    this.handlers.set(method, h);
  }

  kill() {
    if (this.exited) return;
    try { this.child.stdin?.end(); } catch { /* ignore */ }
    setTimeout(() => {
      if (this.exited) return;
      // Windows: kill the whole tree (a cmd.exe wrapper or node shim would otherwise leave the agent alive)
      if (process.platform === 'win32' && this.child.pid) execFile('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true }, () => {});
      else { try { this.child.kill(); } catch { /* ignore */ } }
    }, 1500);
  }
}
