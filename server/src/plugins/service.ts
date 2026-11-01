// PluginService: what is under <dataDir>/plugins, which plugins are on, and the approval of an executable
// plugin's permissions (bound to a hash of its manifest AND of every file in its folder: changed permissions or
// changed code have to be approved again; the code is re-hashed before every spawn).
// Without Node's permission model ('process' isolation) a plugin could read and write every file the user can:
// it runs only after a separate per-plugin opt-in, and never when it asks for secrets.
// State lives in meta.json settings (`plugins.state`) — never the secrets themselves.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { MetaStore } from '../meta/store.js';
import type { SecretService } from '../secrets/service.js';
import { dataDir } from '../files/service.js';
import { loadDeclarativeDir, parseSource, setPluginSources, type LoadedDeclarative } from './declarative.js';
import { PluginMarketService, type PluginInstallInput } from './market-service.js';
import { PluginRunner, readManifest } from './runtime.js';
import type { DeclarativeSource, PluginHook, PluginInstallCheck, PluginInstallResult, PluginListResult, PluginManifest, PluginMarketConfig, PluginMarketStatus, PluginView } from './protocol.js';
import { tr } from '../i18n/index.js';

interface PluginState {
  enabled: boolean;
  /** manifest + code */
  approvedHash?: string;
  /** manifest only: tells "the code changed" apart from "the permissions changed" */
  permsHash?: string;
  /** the approvedHash the user allowed to run without file access limits ('process' isolation) */
  unrestrictedHash?: string;
}
const STATE_KEY = 'plugins.state';

export const pluginsDir = () => path.join(dataDir(), 'plugins');

const manifestHash = (m: PluginManifest) =>
  crypto.createHash('sha256').update(JSON.stringify({ main: m.main, hooks: [...m.hooks].sort(), permissions: m.permissions })).digest('hex').slice(0, 24);
const approvalHash = (m: PluginManifest, code: string) =>
  crypto.createHash('sha256').update(manifestHash(m) + ':' + code).digest('hex').slice(0, 24);

const MAX_CODE_FILES = 5000;
const MAX_CODE_BYTES = 200 * 1024 * 1024;

/** A hash of every file under the plugin's folder (relative path + bytes; a symlink by its target text). */
export async function codeHash(dir: string): Promise<string> {
  const h = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;
  const walk = async (rel: string): Promise<void> => {
    const names = (await fs.readdir(path.join(dir, rel))).sort();
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      const abs = path.join(dir, r);
      const st = await fs.lstat(abs);
      if (++files > MAX_CODE_FILES) throw new Error('plugin folder has too many files');
      if (st.isSymbolicLink()) { h.update(`L\0${r}\0${await fs.readlink(abs)}\0`); continue; }
      if (st.isDirectory()) { h.update(`D\0${r}\0`); await walk(r); continue; }
      if (!st.isFile()) continue;
      bytes += st.size;
      if (bytes > MAX_CODE_BYTES) throw new Error('plugin folder is too large');
      const buf = await fs.readFile(abs);
      h.update(`F\0${r}\0${buf.length}\0`);
      h.update(buf);
    }
  };
  await walk('');
  return h.digest('hex');
}

interface Executable { folder: string; dir: string; manifest?: PluginManifest; error?: string; runner?: PluginRunner; code?: string; watcher?: FSWatcher }

export class PluginService {
  private declarative: LoadedDeclarative[] = [];
  private executables: Executable[] = [];
  /** sources an executable plugin's `sources` hook returned, by plugin id */
  private provided = new Map<string, DeclarativeSource[]>();
  private warnings: string[] = [];
  /** remote market: config, cache, verified install (writes the files; installPlugin reloads) */
  readonly market: PluginMarketService;

  constructor(private deps: { meta: MetaStore; secrets?: SecretService; dir?: string; appVersion?: string; fetch?: typeof fetch; /** tests */ isolation?: 'permission' | 'process' }) {
    this.market = new PluginMarketService({
      meta: deps.meta,
      dir: () => this.dir,
      ...(deps.appVersion ? { appVersion: deps.appVersion } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  }

  get dir(): string { return this.deps.dir ?? pluginsDir(); }
  /** an executable plugin's own writable folder (.data/<id>, skipped by reload like every dot-folder) */
  private dataDirOf(id: string): string { return path.join(this.dir, '.data', id); }

  private state(): Record<string, PluginState> {
    const v = this.deps.meta.settings()[STATE_KEY];
    return v && typeof v === 'object' ? (v as Record<string, PluginState>) : {};
  }
  private async setState(id: string, patch: Partial<PluginState> | null) {
    const all = { ...this.state() };
    if (patch === null) delete all[id];
    else all[id] = { ...(all[id] ?? { enabled: false }), ...patch };
    await this.deps.meta.setSetting(STATE_KEY, all);
  }

  async init(): Promise<void> {
    // the bootstrap used to be written here (where any unrestricted plugin could rewrite it); it is inline now
    await fs.rm(path.join(this.dir, '.runtime'), { recursive: true, force: true }).catch(() => {});
    await this.reload();
  }

  async reload(): Promise<void> {
    for (const e of this.executables) { e.runner?.stop(); e.watcher?.close(); }
    this.warnings = [];
    this.declarative = await loadDeclarativeDir(this.dir);
    this.executables = [];
    let names: string[] = [];
    try { names = await fs.readdir(this.dir); } catch { /* none yet */ }
    for (const n of names.sort()) {
      if (n.startsWith('.')) continue;
      const dir = path.join(this.dir, n);
      try {
        if (!(await fs.stat(dir)).isDirectory()) continue;
      } catch { continue; }
      try {
        const manifest = await readManifest(dir);
        const e: Executable = { folder: n, dir, manifest };
        e.code = await codeHash(dir);
        e.runner = new PluginRunner(dir, manifest, {
          dataDir: this.dataDirOf(manifest.id),
          secret: (name) => this.secret(e, name),
          preflight: () => this.preflight(e),
          unrestrictedAllowed: () => this.unrestrictedOk(e),
          ...(this.deps.isolation ? { isolation: this.deps.isolation } : {}),
        });
        // the hash is checked before each start; a change while the process runs (a file it would load lazily) stops
        // it, so the next call starts again through that check
        try {
          // only a real change counts: macOS FSEvents also reports writes from just before the watch started
          e.watcher = watch(dir, { recursive: true }, () => {
            void codeHash(dir).then((h) => h, () => undefined).then((h) => {
              if (h === e.code) return;
              e.code = h;
              e.runner?.stop();
            });
          });
          e.watcher.on('error', () => { e.watcher?.close(); });
        } catch { /* no watching on this file system: the check before each start still holds */ }
        this.executables.push(e);
      } catch (e) {
        this.executables.push({ folder: n, dir, error: (e as Error).message });
      }
    }
    const ids = new Set<string>();
    for (const d of this.declarative) if (d.def) { if (ids.has(d.def.id)) this.warnings.push(tr('插件 id 重复：{id}', { id: d.def.id })); ids.add(d.def.id); }
    for (const e of this.executables) if (e.manifest) { if (ids.has(e.manifest.id)) this.warnings.push(tr('插件 id 重复：{id}', { id: e.manifest.id })); ids.add(e.manifest.id); }
    await this.refreshProvided();
    this.publish();
  }

  /**
   * An approved secret: `provider:<id>` is that provider's key (decrypted here, sent only to this child).
   * Only names the manifest declares, only for a plugin whose current manifest the user approved.
   */
  private async secret(e: Executable, name: string): Promise<string | undefined> {
    const m = e.manifest;
    if (!m || !this.enabled(m.id) || !this.approved(e)) return undefined;
    if (e.runner?.isolation !== 'permission') return undefined;
    if (!(m.permissions.secrets ?? []).includes(name)) return undefined;
    const pid = /^provider:(.+)$/.exec(name)?.[1];
    const p = pid ? this.deps.meta.provider(pid) : undefined;
    if (!p?.apiKey) return undefined;
    return this.deps.secrets ? this.deps.secrets.reveal(p.apiKey) : p.apiKey;
  }

  private enabled(id: string): boolean { return this.state()[id]?.enabled === true; }
  private hashOf(e: Executable): string | undefined { return e.manifest && e.code ? approvalHash(e.manifest, e.code) : undefined; }
  private approved(e: Executable): boolean {
    const h = this.hashOf(e);
    return !!h && !!e.manifest && this.state()[e.manifest.id]?.approvedHash === h;
  }
  private unrestrictedOk(e: Executable): boolean {
    const h = this.hashOf(e);
    return !!h && !!e.manifest && this.state()[e.manifest.id]?.unrestrictedHash === h;
  }
  /** enabled, approved, and (without the permission model) opted in and asking for no secrets */
  private runnable(e: Executable): e is Executable & { manifest: PluginManifest; runner: PluginRunner } {
    const m = e.manifest;
    if (!m || !e.runner || !this.enabled(m.id) || !this.approved(e)) return false;
    if (e.runner.isolation === 'process') return !(m.permissions.secrets ?? []).length && this.unrestrictedOk(e);
    return true;
  }
  /** Before every spawn: the code on disk must still be the code that was approved. */
  private async preflight(e: Executable): Promise<void> {
    try { e.code = await codeHash(e.dir); } catch (err) { e.code = undefined; throw err; }
    if (!this.approved(e)) throw new Error(tr('插件的代码变了，要重新确认'));
  }

  private async refreshProvided() {
    this.provided.clear();
    for (const e of this.executables) {
      const m = e.manifest;
      if (!this.runnable(e) || !m || !m.hooks.includes('source-provider')) continue;
      try {
        const list = await e.runner.call<unknown[]>('source-provider', {});
        // data only: everything goes through the same validation as a JSON file
        this.provided.set(m.id, (Array.isArray(list) ? list : []).flatMap((s) => { try { return [parseSource(s)]; } catch { return []; } }));
      } catch (err) {
        e.error = (err as Error).message;
      }
    }
  }

  private publish() {
    const list: { pluginId: string; source: DeclarativeSource }[] = [];
    for (const d of this.declarative) if (d.def && this.enabled(d.def.id)) for (const s of d.def.sources) list.push({ pluginId: d.def.id, source: s });
    for (const [id, srcs] of this.provided) for (const s of srcs) list.push({ pluginId: id, source: s });
    setPluginSources(list);
  }

  list(): PluginListResult {
    const st = this.state();
    const plugins: PluginView[] = [];
    for (const d of this.declarative) {
      if (!d.def) {
        plugins.push({ id: d.file, kind: 'declarative', name: d.file, file: d.file, enabled: false, approved: true, hooks: [], permissions: {}, sources: 0, models: 0, error: d.error });
        continue;
      }
      plugins.push({
        id: d.def.id, kind: 'declarative', name: d.def.name, version: d.def.version, description: d.def.description, file: d.file,
        enabled: st[d.def.id]?.enabled === true, approved: true, hooks: [], permissions: {},
        sources: d.def.sources.length, models: d.def.sources.reduce((n, s) => n + s.models.length, 0),
      });
    }
    for (const e of this.executables) {
      const m = e.manifest;
      if (!m) {
        plugins.push({ id: e.folder, kind: 'executable', name: e.folder, file: e.folder, enabled: false, approved: false, hooks: [], permissions: {}, sources: 0, models: 0, error: e.error });
        continue;
      }
      const provided = this.provided.get(m.id) ?? [];
      const approved = this.approved(e);
      plugins.push({
        id: m.id, kind: 'executable', name: m.name, version: m.version, description: m.description, file: e.folder,
        enabled: st[m.id]?.enabled === true, approved, hooks: m.hooks, permissions: m.permissions,
        ...(!approved && st[m.id]?.permsHash === manifestHash(m) ? { codeChanged: true } : {}),
        ...(this.unrestrictedOk(e) ? { unrestricted: true } : {}),
        sources: provided.length, models: provided.reduce((n, s) => n + s.models.length, 0),
        isolation: e.runner?.isolation, running: e.runner?.running, error: e.error, lastOutput: e.runner?.lastOutput() || undefined,
      });
    }
    return { plugins, dir: this.dir, warnings: this.warnings };
  }

  private find(id: string): { decl?: LoadedDeclarative; exe?: Executable } {
    const decl = this.declarative.find((d) => d.def?.id === id || d.file === id);
    if (decl) return { decl };
    const exe = this.executables.find((e) => e.manifest?.id === id || e.folder === id);
    if (exe) return { exe };
    throw new Error(tr('没有这个插件'));
  }

  /**
   * Turn on. An executable plugin needs `approve: true` (its permissions were shown to the user) the first time
   * and after its manifest or code changed. Without Node's permission model it also needs `allowUnrestricted`
   * (the user was told it can read and write every file they can), and one that asks for secrets is refused.
   */
  async enable(id: string, approve = false, allowUnrestricted = false): Promise<PluginListResult> {
    const { decl, exe } = this.find(id);
    if (decl) {
      if (!decl.def) throw new Error(decl.error ?? tr('插件文件无效'));
      await this.setState(decl.def.id, { enabled: true });
    } else if (exe) {
      if (!exe.manifest) throw new Error(exe.error ?? tr('插件文件无效'));
      const m = exe.manifest;
      exe.code = await codeHash(exe.dir);
      if (!this.approved(exe) && !approve) throw new Error(tr('先确认这个插件要的权限'));
      const hash = approvalHash(m, exe.code);
      let unrestrictedHash: string | undefined;
      if (exe.runner?.isolation === 'process') {
        if ((m.permissions.secrets ?? []).length) throw new Error(tr('这个插件要用密钥，但这里的 Node 不能限制它读写文件，所以不能运行'));
        if (!this.unrestrictedOk(exe) && !allowUnrestricted) throw new Error(tr('这个插件将能读写你能访问的所有文件'));
        unrestrictedHash = hash;
      }
      await this.setState(m.id, { enabled: true, approvedHash: hash, permsHash: manifestHash(m), unrestrictedHash });
    }
    await this.refreshProvided();
    this.publish();
    return this.list();
  }

  async disable(id: string): Promise<PluginListResult> {
    const { decl, exe } = this.find(id);
    const pid = decl?.def?.id ?? exe?.manifest?.id ?? id;
    exe?.runner?.stop();
    await this.setState(pid, { enabled: false });
    this.provided.delete(pid);
    this.publish();
    return this.list();
  }

  /** Delete the file / folder (only ever inside the plugins directory). */
  async remove(id: string): Promise<PluginListResult> {
    const { decl, exe } = this.find(id);
    const name = decl?.file ?? exe?.folder;
    if (!name) throw new Error(tr('没有这个插件'));
    const target = path.resolve(this.dir, name);
    const rel = path.relative(this.dir, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(tr('没有这个插件'));
    exe?.runner?.stop();
    await fs.rm(target, { recursive: true, force: true });
    if (exe?.manifest) await fs.rm(this.dataDirOf(exe.manifest.id), { recursive: true, force: true }).catch(() => {});
    await this.setState(decl?.def?.id ?? exe?.manifest?.id ?? id, null);
    await this.reload();
    return this.list();
  }

  /** Whether any enabled, approved plugin declares the hook (the gateway calls nothing when none does). */
  hasHook(hook: Exclude<PluginHook, 'source-provider'>): boolean {
    return this.executables.some((e) => this.runnable(e) && e.manifest.hooks.includes(hook));
  }

  /**
   * The gateway's extension points: every enabled, approved plugin declaring the hook, in name order. Each
   * call is isolated (a plugin that throws or times out is skipped, the request goes on unchanged).
   * gateway/service.ts calls `request-before` on each attempt's body after 隐私保护 redacted it, and
   * `response-after` on a whole non-streamed answer before it is restored (GatewayHookPayload).
   */
  async runHook<T>(hook: Exclude<PluginHook, 'source-provider'>, payload: T, onSkip?: (pluginId: string, why: 'too-large' | 'timeout' | 'error') => void): Promise<T> {
    let cur = payload;
    for (const e of this.executables) {
      if (!this.runnable(e) || !e.manifest.hooks.includes(hook)) {
        // approved once, enabled, but its code changed since (seen by the watcher before this call): reported like a
        // spawn refused for the same reason, so it does not depend on which noticed first
        const m = e.manifest;
        if (m && this.enabled(m.id) && m.hooks.includes(hook) && this.state()[m.id]?.approvedHash && !this.approved(e)) {
          e.error = tr('插件的代码变了，要重新确认');
          try { onSkip?.(m.id, 'error'); } catch { /* the caller's problem */ }
        }
        continue;
      }
      const m = e.manifest;
      try {
        const out = await e.runner.call<T | null>(hook, cur);
        if (out !== null && out !== undefined) cur = out;
      } catch (err) {
        const msg = (err as Error).message;
        e.error = msg;
        // the caller records it (the gateway: on the request's activity line), so a skip is never silent
        try { onSkip?.(m.id, /too large/i.test(msg) ? 'too-large' : /time(d)? ?out/i.test(msg) ? 'timeout' : 'error'); } catch { /* the caller's problem */ }
      }
    }
    return cur;
  }

  // ---- remote market (spec P7) ----
  marketStatus(): Promise<PluginMarketStatus> { return this.market.status(); }
  refreshMarket(): Promise<PluginMarketStatus> { return this.market.refresh(); }
  setMarketConfig(config: PluginMarketConfig): Promise<PluginMarketStatus> { return this.market.setConfig(config); }

  /** Download and verify a package without installing it (verified or not, and the SHA-256 of the bytes). */
  checkInstall(input: PluginInstallInput): Promise<PluginInstallCheck> { return this.market.check(input); }

  /** Install the package (files only — never executed here), then reload so it appears in the list. */
  async installPlugin(input: PluginInstallInput): Promise<PluginInstallResult> {
    const installed = await this.market.install(input);
    await this.reload();
    const list = this.list();
    return { installed, plugins: list.plugins, dir: list.dir, warnings: list.warnings };
  }

  stop(): void { for (const e of this.executables) { e.runner?.stop(); e.watcher?.close(); } }
}
