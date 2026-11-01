// 预览服务器 (spec 2026-10-16 pages §3): the dev servers a project's `.claude/launch.json` describes, started on
// Claude's request (preview_start), one per project and configuration. Their output is kept (the last 2000 lines) for
// preview_logs; they keep running when the conversation closes and all stop when the app quits.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { resolveSpawn } from '../proc/resolve.js';
import { killTree } from '../proc/kill-tree.js';
import { localEnv } from '../runtime/local-env.js';
import { commandOf, readLaunch, type LaunchConfig } from './launch.js';

const LOG_LINES = 2000;

interface Running { key: string; root: string; name: string; port: number; url: string; child: ChildProcess; log: string[]; exited?: number | null }

function bindable(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createServer();
    // no IPv6 on this machine: that address cannot be taken either
    s.once('error', (e: NodeJS.ErrnoException) => res(e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT'));
    s.listen({ port, host, exclusive: true }, () => s.close(() => res(true)));
  });
}

/** Nothing listens on `port`, on either loopback or the wildcard addresses (Vite on `localhost` is ::1 on Windows). */
export async function portFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1', '0.0.0.0', '::']) if (!(await bindable(port, host))) return false;
  return true;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once('error', rej);
    s.listen({ port: 0, host: '127.0.0.1' }, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
  });
}

async function connects(port: number): Promise<boolean> {
  return (await connectsTo(port, '127.0.0.1')) || connectsTo(port, '::1');
}

function connectsTo(port: number, host: string): Promise<boolean> {
  return new Promise((res) => {
    const c = net.connect({ port, host });
    const done = (ok: boolean) => { c.destroy(); res(ok); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    c.setTimeout(1000, () => done(false));
  });
}

/** One project however its path is spelled (Windows paths are case-insensitive: `c:\x` and `C:\X` are one folder). */
function rootKey(root: string): string {
  const r = path.resolve(root);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export class PreviewService {
  private running = new Map<string, Running>();
  /** a start on its way, per project + configuration: a second preview_start meanwhile waits for the same one */
  private starting = new Map<string, Promise<{ name: string; url: string; port: number; already?: boolean }>>();
  constructor(private o: { waitMs?: number } = {}) {}

  private pick(root: string, name?: string): LaunchConfig {
    const f = readLaunch(root);
    if (!f) throw new Error(`No .claude/launch.json in ${root}. Write one first: { "configurations": [{ "name": "web", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000 }] }`);
    if (!f.configurations.length) throw new Error('.claude/launch.json has no configurations');
    const c = name ? f.configurations.find((x) => x.name === name) : f.configurations[0];
    if (!c) throw new Error(`No configuration "${name}" in .claude/launch.json (there are: ${f.configurations.map((x) => x.name).join(', ')})`);
    return c;
  }

  /** Starts it (or says it already runs) and waits for its port. */
  async start(root: string, name?: string): Promise<{ name: string; url: string; port: number; already?: boolean }> {
    const c = this.pick(root, name);
    const key = `${rootKey(root)}|${c.name}`;
    const was = this.running.get(key);
    if (was && was.exited === undefined) return { name: c.name, url: was.url, port: was.port, already: true };
    const going = this.starting.get(key);
    if (going) return going.then((r) => ({ ...r, already: true }));
    const p = this.launch(root, c, key).finally(() => this.starting.delete(key));
    this.starting.set(key, p);
    return p;
  }

  private async launch(root: string, c: LaunchConfig, key: string): Promise<{ name: string; url: string; port: number }> {
    let port = c.port;
    if (!(await portFree(port))) {
      if (c.autoPort === true) port = await freePort();
      else if (c.autoPort === false) throw new Error(`Port ${port} is taken and "${c.name}" has autoPort: false.`);
      else throw new Error(`Port ${port} is taken. Stop what uses it, or set "autoPort": true in .claude/launch.json for "${c.name}" to use a free port (passed to it as PORT).`);
    }
    const { cmd, args } = commandOf(c);
    const sp = resolveSpawn(cmd, args);
    const cwd = c.cwd ? path.resolve(root, c.cwd) : root;
    const rel = path.relative(path.resolve(root), cwd);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`"${c.name}": cwd must be inside the project (${c.cwd})`);
    const child = spawn(sp.command, sp.args, {
      cwd,
      // an npm-style .cmd runs through cmd.exe with the quoting resolveSpawn made: Node must not escape it again
      // (it would turn the quotes into \" — the command is then not found, and an & in an argument runs)
      windowsVerbatimArguments: sp.via === 'cmd',
      env: { ...process.env, ...localEnv(), ...(c.env ?? {}), ...sp.env, PORT: String(port) },
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const url = c.url && port === c.port ? c.url : `http://localhost:${port}`;
    const r: Running = { key, root, name: c.name, port, url, child, log: [] };
    const push = (b: Buffer) => { for (const line of b.toString('utf8').split(/\r?\n/)) if (line) r.log.push(line); if (r.log.length > LOG_LINES) r.log.splice(0, r.log.length - LOG_LINES); };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('exit', (code) => { r.exited = code; });
    child.on('error', (e) => { r.log.push(`[failed to start] ${e.message}`); r.exited = -1; });
    this.running.set(key, r);
    const until = Date.now() + (this.o.waitMs ?? 60_000);
    while (Date.now() < until) {
      if (r.exited !== undefined) throw new Error(`"${c.name}" exited (code ${r.exited}) before its port opened. Last output:\n${r.log.slice(-30).join('\n')}`);
      if (await connects(port)) return { name: c.name, url, port };
      await new Promise((res) => setTimeout(res, 300));
    }
    await this.stop(root, c.name);
    throw new Error(`"${c.name}" did not open port ${port} within ${Math.round((this.o.waitMs ?? 60_000) / 1000)} s. Last output:\n${r.log.slice(-30).join('\n')}`);
  }

  private find(root: string, name?: string): Running | undefined {
    const base = `${rootKey(root)}|`;
    if (name) return this.running.get(base + name);
    return [...this.running.values()].find((r) => r.key.startsWith(base) && r.exited === undefined);
  }

  async stop(root: string, name?: string): Promise<boolean> {
    const r = this.find(root, name);
    if (!r) return false;
    this.running.delete(r.key);
    if (r.exited === undefined) await killTree(r.child, 2000);
    return true;
  }

  logs(root: string, name?: string, lines = 200): string {
    const r = this.find(root, name) ?? (name ? undefined : [...this.running.values()].find((x) => x.key.startsWith(`${rootKey(root)}|`)));
    if (!r) return 'No preview server of this project is running.';
    const head = `${r.name} — ${r.url}${r.exited !== undefined ? ` (exited, code ${r.exited})` : ''}`;
    return `${head}\n${r.log.slice(-Math.max(1, Math.min(lines, LOG_LINES))).join('\n')}`;
  }

  /**
   * The project's configurations for the browser's empty page (phase 6 §7): name, port, and the address of the ones
   * running. No launch.json → null; one that does not parse → its error, for the page to say.
   */
  list(root: string): { configs: { name: string; port: number; command: string; url?: string }[]; error?: string } | null {
    let f;
    try { f = readLaunch(root); } catch (e) { return { configs: [], error: (e as Error).message }; }
    if (!f) return null;
    return {
      configs: f.configurations.map((c) => {
        const r = this.running.get(`${rootKey(root)}|${c.name}`);
        const { cmd, args } = commandOf(c);
        return { name: c.name, port: c.port, command: [cmd, ...args].join(' '), ...(r && r.exited === undefined ? { url: r.url } : {}) };
      }),
    };
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((r) => this.stop(r.root, r.name)));
  }
}
