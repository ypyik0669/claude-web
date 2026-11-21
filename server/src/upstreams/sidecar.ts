// Sidecar processes (phase B/C): install the pinned binary, run it on loopback with a random admin token,
// supervise it, and keep its log. The adapters own the flags and the health check; this owns the lifecycle.
import fs from 'node:fs/promises';
import { appendFile, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { dataDir } from '../files/service.js';
import { freePort } from '../net/safe-port.js';
import type { SidecarId, SidecarStatus } from './types.js';
import { tr } from '../i18n/index.js';
import manifest from './sidecars.json' with { type: 'json' };

const execFileAsync = promisify(execFile);
const LOG_MAX = 5 * 1024 * 1024;
const READY_MS = 30_000;

// Windows: `tar` on PATH may be Git's GNU tar (a `C:\…` path reads as a remote host, and it has no zip); System32's
// tar.exe is bsdtar, which reads zip as well
const SYS_TAR = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/**
 * Unpack a release asset. On Windows zip goes through PowerShell's Expand-Archive (bsdtar when that fails) and tar.gz
 * through the bsdtar Windows ships.
 */
export async function unpack(archive: 'zip' | 'tar.gz', file: string, dest: string): Promise<void> {
  const opts = { windowsHide: true, timeout: 120_000 };
  if (archive === 'zip') {
    if (process.platform === 'win32') await unpackZipWindows(file, dest);
    else await execFileAsync('unzip', ['-o', file, '-d', dest], opts);
    return;
  }
  await execFileAsync(process.platform === 'win32' ? SYS_TAR : 'tar', ['-xzf', file, '-C', dest], opts);
}

export type RunFile = (cmd: string, args: string[], opts: { windowsHide: boolean; timeout: number }) => Promise<unknown>;

/**
 * A zip on Windows: Expand-Archive, told to stop on errors, and System32's tar.exe when it fails. A newer Archive module
 * (from the PowerShell Gallery) under Windows PowerShell 5.1 writes "Cannot find an overload for ExtractToDirectory",
 * unpacks nothing and still exits 0 — GitHub's windows-2025 image of 2026-11-16 has one: the 0.5.15 build lost the
 * workbuddy and CLIProxyAPI executables that way, and a download here would have said the package had no executable.
 */
export async function unpackZipWindows(file: string, dest: string, run: RunFile = execFileAsync): Promise<void> {
  const opts = { windowsHide: true, timeout: 120_000 };
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath ${q(file)} -DestinationPath ${q(dest)} -Force`], opts);
  } catch (e) {
    try { await run(SYS_TAR, ['-xf', file, '-C', dest], opts); } catch { throw e; }
  }
}

export interface PlatformAsset { url: string; sha256: string; size: number; entry: string; archive?: 'zip' | 'tar.gz' }
export interface ManifestEntry { version: string; healthPath: string; archive?: 'none'; platforms: Record<string, PlatformAsset> }
type Manifest = Record<SidecarId, ManifestEntry>;

export interface SpawnSpec {
  /** the flags; `dir` is this sidecar's data directory */
  args(ctx: { port: number; dir: string }): string[] | Promise<string[]>;
  /** secrets go here, never into argv */
  env?(ctx: { port: number; dir: string }): Record<string, string> | Promise<Record<string, string>>;
  /** config files, directories, … (mode 0600 for anything with a secret) */
  prepare?(ctx: { port: number; dir: string }): Promise<void>;
  /** is it answering yet? polled every 500 ms until READY_MS */
  health(port: number): Promise<boolean>;
}

interface Runtime {
  child: import('node:child_process').ChildProcess;
  port: number;
  stopping: boolean;
  restarts: number;
  health: SidecarStatus['health'];
  detail?: string;
  healthFails: number;
  checking: boolean;
  monitor?: NodeJS.Timeout;
}

/** `win32-x64` / `darwin-arm64` / `linux-x64` … */
export const platformKey = (): string => `${process.platform}-${process.arch}`;

export function assetFor(id: SidecarId, platform = platformKey()): PlatformAsset | null {
  return (manifest as Manifest)[id]?.platforms[platform] ?? null;
}

/** A port nobody holds right now (the sidecar binds it a moment later), never one fetch refuses (net/safe-port.ts). */
export { freePort };

const envBin = (id: SidecarId) => process.env[`CW_SIDECAR_${id.toUpperCase()}_BIN`];

/**
 * A development binary wins over the pinned download. `_BIN` is the executable alone (the spec supplies the
 * script argument); `_CMD` is a JSON array for a launcher plus its argument, e.g. ["C:\\node.exe","fake.mjs"].
 */
const devCommand = (id: SidecarId): string[] | null => {
  const raw = process.env[`CW_SIDECAR_${id.toUpperCase()}_CMD`];
  if (raw) {
    try {
      const cmd = JSON.parse(raw);
      if (Array.isArray(cmd) && cmd.length && cmd.every((x) => typeof x === 'string')) return cmd;
    } catch { /* a broken override falls back to _BIN / the pinned build */ }
  }
  const bin = envBin(id);
  return bin ? [bin] : null;
};

export class SidecarManager extends EventEmitter {
  private readonly root: string;
  private readonly bundled: string;
  private readonly healthMs: number;
  /** this manager's view of the pinned manifest (tests replace entries; the module's copy stays as shipped) */
  private readonly manifest: Manifest;
  private runs = new Map<SidecarId, Runtime>();
  /** a start in flight: concurrent callers share it instead of spawning a second process */
  private starting = new Map<SidecarId, Promise<void>>();
  /** asked to stop; a start still between its awaits sees this and kills what it spawned */
  private stopping = new Set<SidecarId>();
  /** bumped by stop: a crash-restart timer from before it must not spawn anything */
  private epoch = new Map<SidecarId, number>();
  private specs = new Map<SidecarId, SpawnSpec>();
  private timers = new Map<SidecarId, NodeJS.Timeout>();

  constructor(opts: { dir?: string; manifest?: Manifest; healthMs?: number; bundledDir?: string } = {}) {
    super();
    this.root = opts.dir ?? path.join(dataDir(), 'sidecars');
    // the installer's extraResources copy (see electron-builder.yml / scripts/sidecars/fetch.mjs)
    this.bundled = opts.bundledDir ?? process.env.CLAUDE_WEB_SIDECARS ?? '';
    this.healthMs = opts.healthMs ?? 30_000;
    this.manifest = structuredClone(manifest) as Manifest;
    if (opts.manifest) for (const id of Object.keys(opts.manifest) as SidecarId[]) this.manifest[id] = opts.manifest[id];
  }

  private asset(id: SidecarId): PlatformAsset | null {
    return this.manifest[id]?.platforms[platformKey()] ?? null;
  }

  version(id: SidecarId): string {
    return this.installedVersion(id) ?? this.manifest[id]?.version ?? '';
  }

  dir(id: SidecarId): string { return path.join(this.root, id); }

  /** A dev binary wins; then the installer's copy; then the pinned version downloaded into the data directory. */
  binary(id: SidecarId): string | null {
    const dev = devCommand(id);
    if (dev && existsSync(dev[0])) return dev[0];
    const asset = this.asset(id);
    const version = this.manifest[id]?.version;
    if (!asset || !version) return null;
    const shipped = path.join(this.bundled, platformKey(), id, asset.entry);
    if (this.bundled && existsSync(shipped)) return shipped;
    const bin = path.join(this.dir(id), version, asset.entry);
    return existsSync(bin) ? bin : null;
  }

  private installedVersion(id: SidecarId): string | undefined {
    const dev = devCommand(id);
    if (dev && existsSync(dev[0])) return 'dev';
    const asset = this.asset(id);
    const version = this.manifest[id]?.version;
    if (!asset || !version) return undefined;
    if (this.bundled && existsSync(path.join(this.bundled, platformKey(), id, asset.entry))) return version;
    return existsSync(path.join(this.dir(id), version, asset.entry)) ? version : undefined;
  }

  status(id: SidecarId): SidecarStatus {
    const run = this.runs.get(id);
    const installed = !!this.binary(id);
    return {
      id,
      installed,
      running: !!run && run.health !== 'stopped',
      version: this.installedVersion(id),
      ...(run ? { port: run.port, health: run.health, detail: run.detail } : { health: 'stopped' as const }),
    };
  }

  statuses(): SidecarStatus[] { return (Object.keys(this.manifest) as SidecarId[]).map((id) => this.status(id)); }

  /** Download + verify + unpack the pinned build; returns the binary path. */
  async install(id: SidecarId): Promise<string> {
    const entry = this.manifest[id];
    const asset = this.asset(id);
    if (!entry || !asset) throw new Error(tr('没有 {id} 在这个平台上的组件版本（{platform}）', { id, platform: platformKey() }));
    const destDir = path.join(this.dir(id), entry.version);
    const destBin = path.join(destDir, asset.entry);
    if (existsSync(destBin)) return destBin;

    const tmp = path.join(this.dir(id), `.tmp-${crypto.randomBytes(4).toString('hex')}`);
    await fs.mkdir(tmp, { recursive: true });
    const dl = path.join(tmp, 'download');
    try {
      let res: Response;
      try {
        res = await fetch(asset.url, { signal: AbortSignal.timeout(10 * 60_000) });
      } catch (e: any) {
        throw new Error(tr('下载组件失败：{message}（也可以手动放到 {path}）', { message: e?.message ?? String(e), path: destBin }));
      }
      if (!res.ok) throw new Error(tr('下载组件失败：HTTP {status}（{url}）', { status: res.status, url: asset.url }));
      const buf = Buffer.from(await res.arrayBuffer());
      if (asset.size && buf.length !== asset.size) throw new Error(tr('组件下载大小不对（{got} / {want}）', { got: buf.length, want: asset.size }));
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (hash !== asset.sha256) throw new Error(tr('组件校验失败（SHA256 不一致），已丢弃'));
      await fs.writeFile(dl, buf);
      if (asset.archive === 'zip' || asset.archive === 'tar.gz') {
        // PowerShell's Expand-Archive insists on a .zip name
        const packed = asset.archive === 'zip' ? `${dl}.zip` : dl;
        if (packed !== dl) await fs.rename(dl, packed);
        await unpack(asset.archive, packed, tmp);
      } else await fs.rename(dl, path.join(tmp, asset.entry));
      // the archive may put the binary in a sub-directory: look one level down
      let found = path.join(tmp, asset.entry);
      if (!existsSync(found)) {
        const entries = await fs.readdir(tmp, { withFileTypes: true });
        for (const d of entries) if (d.isDirectory() && existsSync(path.join(tmp, d.name, asset.entry))) { found = path.join(tmp, d.name, asset.entry); break; }
      }
      if (!existsSync(found)) throw new Error(tr('组件包里没有 {entry}', { entry: asset.entry }));
      // normalise: the entry sits at the archive root, whatever folder it was packed in
      const rootEntry = path.join(tmp, asset.entry);
      if (found !== rootEntry) await fs.rename(found, rootEntry);
      found = rootEntry;
      await fs.chmod(found, 0o755);
      await fs.mkdir(path.dirname(destDir), { recursive: true });
      await fs.rm(destDir, { recursive: true, force: true });
      await fs.rename(tmp, destDir);
      return destBin;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  async ensure(id: SidecarId): Promise<string> {
    return this.binary(id) ?? this.install(id);
  }

  /**
   * Start it (idempotent). Resolves once its health check answers; a crash afterwards is restarted with
   * 1s / 2s / 4s … 60s backoff (a process that lived a minute resets the count).
   */
  async start(id: SidecarId, spec: SpawnSpec): Promise<void> {
    this.specs.set(id, spec);
    // a fresh start supersedes a crash restart that is waiting to fire, or the two would both spawn
    const restart = this.timers.get(id);
    if (restart) { clearTimeout(restart); this.timers.delete(id); }
    if (this.runs.get(id)) return;
    const pending = this.starting.get(id);
    if (pending) return pending;
    const p = this.spawnOnce(id, spec, 0).finally(() => {
      if (this.starting.get(id) === p) this.starting.delete(id);
    });
    this.starting.set(id, p);
    return p;
  }

  private async spawnOnce(id: SidecarId, spec: SpawnSpec, restarts: number): Promise<void> {
    await this.ensure(id);
    const dir = this.dir(id);
    await fs.mkdir(dir, { recursive: true });
    const port = await freePort();
    if (spec.prepare) await spec.prepare({ port, dir });
    const args = await spec.args({ port, dir });
    const extraEnv = spec.env ? await spec.env({ port, dir }) : {};
    const dev = devCommand(id);
    const [bin, ...prefix] = dev && existsSync(dev[0]) ? dev : [this.binary(id)!];
    const child = spawn(bin, [...prefix, ...args], {
      cwd: dir,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const run: Runtime = { child, port, stopping: false, restarts, health: 'starting', healthFails: 0, checking: false };
    this.runs.set(id, run);
    const append = (chunk: Buffer) => this.appendLog(id, chunk);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const startedAt = Date.now();
    child.once('exit', (code, signal) => {
      if (this.runs.get(id) !== run) return;
      this.clearMonitor(run);
      this.runs.delete(id);
      run.health = 'stopped';
      this.emit('changed');
      if (run.stopping) return;
      const lived = Date.now() - startedAt;
      const next = lived > 60_000 ? 0 : restarts + 1;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(6, Math.max(0, next - 1)));
      run.detail = tr('组件退出（{code}），{sec}s 后重启', { code: code ?? signal ?? '?', sec: Math.round(delay / 1000) });
      this.emit('crash', id, run.detail);
      const gen = this.epoch.get(id) ?? 0;
      const t = setTimeout(() => {
        this.timers.delete(id);
        if ((this.epoch.get(id) ?? 0) !== gen) return;
        // a start (manual or another health-driven one) may already be bringing it back
        if (this.runs.get(id) || this.starting.has(id)) return;
        const p = this.spawnOnce(id, this.specs.get(id) ?? spec, next)
          .catch((e) => {
            run.health = 'error';
            run.detail = String(e?.message ?? e);
            this.emit('error', id, e);
          })
          .finally(() => { if (this.starting.get(id) === p) this.starting.delete(id); });
        this.starting.set(id, p);
      }, delay);
      t.unref?.();
      this.timers.set(id, t);
    });
    // health: slow sidecars (a cold DB, a first-run tokenizer) need a moment
    const deadline = Date.now() + READY_MS;
    let lastError = '';
    while (Date.now() < deadline) {
      if (this.stopping.has(id)) {
        run.stopping = true;
        await this.kill(run);
        if (this.runs.get(id) === run) this.runs.delete(id);
        throw new Error(tr('启动已取消'));
      }
      if (this.runs.get(id) !== run) throw new Error(lastError || tr('组件启动失败'));
      try {
        if (await spec.health(port)) {
          run.health = 'ok';
          run.detail = undefined;
          this.emit('changed');
          this.monitor(id, run, spec);
          return;
        }
      } catch (e: any) {
        lastError = String(e?.message ?? e);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    run.stopping = true;
    await this.kill(run);
    this.runs.delete(id);
    throw new Error(tr('组件 30 秒内没有就绪：{message}', { message: lastError || tr('没有响应') }));
  }

  /** A sidecar that is up but no longer answering: three failed checks in a row kills it into the restart path. */
  private monitor(id: SidecarId, run: Runtime, spec: SpawnSpec): void {
    this.clearMonitor(run);
    run.monitor = setInterval(() => {
      if (this.runs.get(id) !== run || run.health !== 'ok' || run.checking) return;
      run.checking = true;
      const miss = () => {
        if (this.runs.get(id) !== run) return;
        run.healthFails += 1;
        if (run.healthFails < 3) return;
        run.detail = tr('组件连续 3 次健康检查失败，重启');
        this.emit('crash', id, run.detail);
        try { run.child.kill(); } catch { /* already gone */ }
      };
      void spec.health(run.port)
        .then((ok) => { if (ok) run.healthFails = 0; else miss(); })
        .catch(miss)
        .finally(() => { run.checking = false; });
    }, this.healthMs);
    run.monitor.unref?.();
  }

  private clearMonitor(run: Runtime): void {
    if (run.monitor) { clearInterval(run.monitor); run.monitor = undefined; }
  }

  async stop(id: SidecarId): Promise<void> {
    const t = this.timers.get(id);
    if (t) { clearTimeout(t); this.timers.delete(id); }
    this.epoch.set(id, (this.epoch.get(id) ?? 0) + 1);
    this.stopping.add(id);
    const run = this.runs.get(id);
    if (run) {
      run.stopping = true;
      this.clearMonitor(run);
      await this.kill(run);
      if (this.runs.get(id) === run) this.runs.delete(id);
      this.emit('changed');
    }
    const pending = this.starting.get(id);
    if (pending) {
      await pending.catch(() => {});
      // a start that committed its run just before noticing the stop
      const late = this.runs.get(id);
      if (late) {
        late.stopping = true;
        this.clearMonitor(late);
        await this.kill(late);
        if (this.runs.get(id) === late) this.runs.delete(id);
        this.emit('changed');
      }
    }
    this.stopping.delete(id);
  }

  async stopAll(): Promise<void> {
    for (const id of new Set([...this.runs.keys(), ...this.starting.keys()])) await this.stop(id);
  }

  private async kill(run: Runtime): Promise<void> {
    try { run.child.kill(); } catch { /* already gone */ }
    const exited = new Promise<void>((r) => {
      if (run.child.exitCode !== null) return r();
      run.child.once('exit', () => r());
      setTimeout(r, 5_000).unref?.();
    });
    await exited;
    if (run.child.exitCode === null) {
      try { run.child.kill('SIGKILL'); } catch { /* windows: nothing more to do */ }
    }
  }

  /** The last `lines` lines of the sidecar's log (tail, not the whole file). */
  async logs(id: SidecarId, lines = 200): Promise<string> {
    const file = path.join(this.root, '..', 'logs', `${id}.log`);
    try {
      const text = await fs.readFile(file, 'utf8');
      return text.split('\n').slice(-lines).join('\n');
    } catch {
      return '';
    }
  }

  private appendLog(id: SidecarId, chunk: Buffer): void {
    try {
      const dir = path.join(this.root, '..', 'logs');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.log`);
      appendFile(file, chunk, () => {});
      // rotate by size, keeping one previous generation
      try {
        if (statSync(file).size > LOG_MAX) {
          const prev = `${file}.1`;
          rmSync(prev, { force: true });
          renameSync(file, prev);
        }
      } catch { /* racing a rotation is harmless */ }
    } catch { /* logging must never take the sidecar down */ }
  }
}

/** For tests: the pinned manifest as data. */
export const sidecarManifest = manifest as Manifest;
