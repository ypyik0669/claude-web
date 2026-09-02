import { utilityProcess, app, type UtilityProcess } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

export interface ServerInfo { port: number; host: string; token: string; url: string }

/**
 * Runs server/dist/index.js in an Electron utility process (Node runtime, same ABI as the
 * shell so node-pty just works). Restarts it if it dies.
 */
export class ServerHost extends EventEmitter {
  private proc: UtilityProcess | null = null;
  private stopping = false;
  info: ServerInfo | null = null;
  // CLAUDE_WEB_TOKEN lets a developer open the embedded server in a normal browser for debugging
  readonly token = process.env.CLAUDE_WEB_TOKEN || randomBytes(24).toString('base64url');
  private log = (s: string) => {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'server.log'), `[${new Date().toISOString()}] ${s}\n`);
    } catch {
      /* ignore */
    }
  };

  /** Resolve server entry + web dist both in dev (repo) and packaged (asar) layouts. */
  private paths() {
    const root = app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : path.resolve(__dirname, '../..');
    return { entry: path.join(root, 'server', 'dist', 'index.js'), dist: path.join(root, 'web', 'dist') };
  }

  async start(): Promise<ServerInfo> {
    const { entry, dist } = this.paths();
    if (!fs.existsSync(entry)) throw new Error(`server build missing: ${entry} (run: npm run build -w server)`);
    return new Promise((resolve, reject) => {
      const proc = utilityProcess.fork(entry, [], {
        serviceName: 'claude-web-server',
        stdio: 'pipe',
        env: { ...process.env, CLAUDE_WEB_STANDALONE: '1', PORT: '0', CLAUDE_WEB_TOKEN: this.token, CLAUDE_WEB_DIST: dist },
      });
      this.proc = proc;
      proc.stdout?.on('data', (d) => this.log(String(d).trimEnd()));
      proc.stderr?.on('data', (d) => this.log('[err] ' + String(d).trimEnd()));
      let ready = false;
      proc.on('message', (m: any) => {
        if (m?.type === 'ready' && !ready) {
          ready = true;
          this.info = { port: m.port, host: m.host, token: this.token, url: `http://${m.host}:${m.port}/?token=${this.token}` };
          this.emit('ready', this.info);
          resolve(this.info);
        }
      });
      proc.on('exit', (code) => {
        this.log(`server exited with ${code}`);
        this.proc = null;
        if (!ready) reject(new Error(`server exited early (code ${code}); see ${path.join(app.getPath('userData'), 'server.log')}`));
        else if (!this.stopping) {
          this.emit('crash', code);
          setTimeout(() => void this.start().catch((e) => this.log(String(e))), 1500);
        }
      });
      setTimeout(() => { if (!ready) reject(new Error('server did not become ready in 30s')); }, 30_000);
    });
  }

  async stop() {
    this.stopping = true;
    const p = this.proc;
    if (!p) return;
    p.postMessage({ type: 'shutdown' });
    await new Promise<void>((r) => {
      const t = setTimeout(() => { p.kill(); r(); }, 4000);
      p.once('exit', () => { clearTimeout(t); r(); });
    });
  }
}
