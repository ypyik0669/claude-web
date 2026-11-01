// 托管程序 (spec 2026-10-26 §3.2): CLIProxyAPI and Magpie — download from their GitHub releases, verify SHA-256,
// keep the previous build for rollback, run on 127.0.0.1 with an allocated port and keys of our own (encrypted in
// meta like every other secret), health-check, stop with the whole process tree, and register the running gateway
// as an Anthropic-compatible provider. A copy the user already runs is connected instead of installed again.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { dataDir } from '../files/service.js';
import { tr } from '../i18n/index.js';
import type { MetaStore } from '../meta/store.js';
import type { ProviderService } from '../providers/service.js';
import type { SecretService } from '../secrets/service.js';
import { freePort, unpack } from '../upstreams/sidecar.js';
import { planModels } from '../channels/plan.js';
import { proxy } from '../net/proxy.js';
import { MANIFESTS, type EngineManifest } from './manifests/index.js';
import { PINS, pinFor, type PinTable } from './manifests/pins.js';
import { startProcess, stopTree, tailLog } from './process.js';
import type { EngineId, EngineLoginImportResult, EngineLoginProvider, EngineLoginSession, EngineStatus } from './types.js';

const READY_MS = 30_000;
const HEALTH_MS = 30_000;
const DETECT_TTL = 10_000;

/**
 * verified: pinned = the hash this app ships (manifests/pins.ts); release = the user confirmed a file that matched the
 * release's own checksum; recorded = the user confirmed a file whose release publishes no checksum. confirmed marks a
 * build the user accepted (builds from before SEC-09 recorded 'release' without asking).
 */
interface Build { entry: string; sha256: string; verified: 'pinned' | 'release' | 'recorded'; asset: string; at: number; confirmed?: boolean }
interface EngineState {
  version?: string;
  previousVersion?: string;
  builds?: Record<string, Build>;
  port?: number;
  webPort?: number;
  webKey?: string;
  clientKey?: string;
  managementKey?: string;
  providerId?: string;
  mode?: 'managed' | 'connected';
  connectedPort?: number;
  /** it was running when the server last stopped (started again at startup) */
  autoStart?: boolean;
}

interface Runtime {
  child: ChildProcess;
  port: number;
  health: EngineStatus['health'];
  detail?: string;
  stopping: boolean;
  monitor?: NodeJS.Timeout;
  fails: number;
}

interface GhAsset { name: string; browser_download_url: string; size?: number; digest?: string | null }
interface GhRelease { tag_name: string; assets: GhAsset[] }

export interface EngineDeps {
  meta: MetaStore;
  secrets?: SecretService;
  providers: Pick<ProviderService, 'upsert' | 'remove' | 'refreshModels' | 'list'>;
  /** default <dataDir>/engines */
  root?: string;
  /** builds that travel with the desktop app (`CLAUDE_WEB_ENGINES`, <resources>/engines): <platform>/<id>/<entry> */
  bundledDir?: string;
  /** SHA-256 pinned per version / platform (default: manifests/pins.ts, read from bundled.json) */
  pins?: PinTable;
}

const exe = process.platform === 'win32' ? '.exe' : '';
const OS_WORDS: Record<string, RegExp> = { win32: /(windows|win64|win32|[-_.]win[-_.])/i, darwin: /(darwin|macos|[-_.]mac[-_.]|osx)/i, linux: /linux/i };
const ARCH_WORDS: Record<string, RegExp> = { x64: /(amd64|x86_64|x64)/i, arm64: /(arm64|aarch64)/i };
const NOT_A_BUILD = /(\.(sha256|sha512|sig|asc|txt|json|deb|rpm|dmg|pkg|msi|appimage|apk|sbom|pem)$)|checksums|sha256sums|installer|setup/i;
const isArchive = (name: string) => /\.zip$/i.test(name) ? 'zip' as const : /\.(tar\.gz|tgz)$/i.test(name) ? 'tar.gz' as const : null;

export const platformKey = () => `${process.platform}-${process.arch}`;

/**
 * No SHA-256 pinned in this app for this version and the user has not confirmed this file (review E2, SEC-09):
 * nothing is installed. releaseSha256 = the release's own checksum, which the file matches (a mismatch is refused
 * outright); it comes from the same place as the file, so it is shown, not trusted.
 */
export class UnverifiedBuild extends Error {
  constructor(readonly info: { version: string; asset: string; sha256: string; releaseSha256?: string }, name: string) {
    super(info.releaseSha256
      ? tr('{name} {version} 没有本应用固定的校验值，要你确认后才安装（文件的 SHA-256：{sha256}，和发布里附带的校验值一致）', { name, version: info.version, sha256: info.sha256 })
      : tr('{name} {version} 的发布没有附带 SHA-256，要你确认后才安装（文件的 SHA-256：{sha256}）', { name, version: info.version, sha256: info.sha256 }));
  }
}

export interface InstallOptions {
  /**
   * the user confirmed a build whose hash this app does not pin; takes effect only together with `sha256` (the
   * exact hash they were shown) — never a blanket "install anything"
   */
  allowUnverified?: boolean;
  /** the hash the user was shown; the download must still have it */
  sha256?: string;
}

/** Did the user accept this exact file? allowUnverified alone is not consent: the hash they saw must match. */
export const consented = (opts: InstallOptions, hash: string): boolean =>
  opts.allowUnverified === true && typeof opts.sha256 === 'string' && opts.sha256.trim().toLowerCase() === hash;

/** The build for this OS / CPU among a release's assets (the manifest's preference first, archives before bare files). */
export function pickAsset(m: Pick<EngineManifest, 'prefer'>, assets: GhAsset[], platform = process.platform, arch = process.arch): GhAsset | null {
  const os = OS_WORDS[platform];
  const cpu = ARCH_WORDS[arch];
  if (!os || !cpu) return null;
  const fits = assets.filter((a) => os.test(a.name) && cpu.test(a.name) && !NOT_A_BUILD.test(a.name));
  const score = (a: GhAsset) => (m.prefer?.test(a.name) ? 0 : 2) + (isArchive(a.name) ? 0 : 1);
  return fits.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))[0] ?? null;
}

async function portFree(port: number): Promise<boolean> {
  const srv = net.createServer();
  try {
    await new Promise<void>((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', () => r()); });
    await new Promise<void>((r) => srv.close(() => r()));
    return true;
  } catch {
    return false;
  }
}

/** Find the executable anywhere (three levels) under `dir`. */
async function findEntry(dir: string, entry: string, depth = 0): Promise<string | null> {
  const names = new Set([`${entry}${exe}`, entry]);
  let items: import('node:fs').Dirent[] = [];
  try { items = await fs.readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const d of items) if (d.isFile() && names.has(d.name)) return path.join(dir, d.name);
  // CLIProxyAPI's archives have been seen as CLIProxyAPI*/cli-proxy-api*; accept the entry as a name prefix too
  for (const d of items) if (d.isFile() && d.name.toLowerCase().startsWith(entry.toLowerCase()) && (!exe || d.name.toLowerCase().endsWith(exe))) return path.join(dir, d.name);
  if (depth >= 3) return null;
  for (const d of items) if (d.isDirectory()) { const hit = await findEntry(path.join(dir, d.name), entry, depth + 1); if (hit) return hit; }
  return null;
}

export class EngineManager extends EventEmitter {
  readonly root: string;
  private readonly bundledRoot: string;
  private readonly pins: PinTable;
  private runs = new Map<EngineId, Runtime>();
  private busy = new Map<EngineId, Promise<unknown>>();
  private detected = new Map<EngineId, { at: number; hit: { port: number; version?: string } | null }>();
  private restarts = new Map<EngineId, number[]>();

  constructor(private deps: EngineDeps) {
    super();
    this.root = deps.root ?? path.join(dataDir(), 'engines');
    this.bundledRoot = deps.bundledDir ?? process.env.CLAUDE_WEB_ENGINES ?? '';
    this.pins = deps.pins ?? PINS;
  }

  private state(id: EngineId): EngineState {
    const all = this.deps.meta.engineState();
    return (all[id] ??= {}) as EngineState;
  }
  private async save() { await this.deps.meta.saveChannels(); }

  /**
   * Subscriptions the engines can sign in to, as the engine's own code defines them. The hub does not reimplement
   * vendor protocols: CLIProxyAPI's management API and Magpie's web sign-in API keep the accounts and serve the models.
   * Catalog ids map them back to the provider cards (mimo-app → mimo, trae-cn → trae).
   */
  loginProviders(): EngineLoginProvider[] {
    const rows: Omit<EngineLoginProvider, 'engine'>[] = [
      // CLIProxyAPI (v7/v8 management endpoints; older builds answer 404 for what they do not know)
      { provider: 'anthropic', catalogId: 'claude', name: 'Claude', method: 'browser' },
      { provider: 'codex', catalogId: 'codex', name: 'Codex', method: 'browser' },
      { provider: 'antigravity', catalogId: 'antigravity', name: 'Antigravity', method: 'browser' },
      { provider: 'kimi', catalogId: 'kimi', name: 'Kimi', method: 'device' },
      { provider: 'xai', catalogId: 'grok', name: 'Grok', method: 'device' },
      // Magpie's web sign-in (plugins included; a plugin that isn't installed says so when it is started)
      { provider: 'gemini', catalogId: 'gemini', name: 'Gemini', method: 'browser' },
      { provider: 'antigravity', catalogId: 'antigravity', name: 'Antigravity', method: 'browser' },
      { provider: 'grok', catalogId: 'grok', name: 'Grok', method: 'browser' },
      { provider: 'copilot', catalogId: 'copilot', name: 'GitHub Copilot', method: 'device' },
      { provider: 'qoder', catalogId: 'qoder', name: 'Qoder', method: 'browser' },
      { provider: 'qoder-cn', catalogId: 'qoder', name: 'Qoder CN', method: 'browser' },
      { provider: 'trae-cn', catalogId: 'trae', name: 'Trae CN', method: 'browser' },
      { provider: 'workbuddy', catalogId: 'workbuddy', name: 'WorkBuddy', method: 'browser' },
      { provider: 'zcode', catalogId: 'zcode', name: 'ZCode', method: 'browser' },
      { provider: 'kiro', catalogId: 'kiro', name: 'Kiro', method: 'browser' },
      { provider: 'devin', catalogId: 'devin', name: 'Devin', method: 'browser' },
      { provider: 'factory', catalogId: 'factory', name: 'Factory', method: 'browser' },
      { provider: 'mimo-app', catalogId: 'mimo', name: 'Xiaomi MiMo', method: 'browser' },
      { provider: 'cline', catalogId: 'cline', name: 'Cline', method: 'browser' },
      { provider: 'claude', catalogId: 'claude', name: 'Claude', method: 'browser' },
      { provider: 'codex', catalogId: 'codex', name: 'Codex', method: 'browser' },
    ];
    const cpa = rows.slice(0, 5).map((r) => ({ ...r, engine: 'cliproxyapi' as const }));
    const magpie = rows.slice(5).map((r) => ({ ...r, engine: 'magpie' as const }));
    return [...cpa, ...magpie];
  }

  private loginDef(id: EngineId, provider: string): EngineLoginProvider {
    const p = this.loginProviders().find((x) => x.engine === id && x.provider === provider);
    if (!p) throw new Error(tr('这个托管程序不认识这个登录方式'));
    return p;
  }

  private loginSessions = new Map<string, {
    view: EngineLoginSession;
    backendState?: string;
    backendId?: string;
    webPort?: number;
    webKey?: string;
  }>();

  private async engineJson(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<any> {
    let r: Response;
    try {
      r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      throw new Error(tr('连不上托管程序：{message}', { message: e?.message ?? String(e) }));
    }
    const text = await r.text().catch(() => '');
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* a non-JSON error */ }
    if (!r.ok) throw new Error(tr('托管程序说：{message}', { message: String(j?.error ?? j?.message ?? text.slice(0, 240) ?? `HTTP ${r.status}`).slice(0, 240) }));
    return j;
  }

  /** Start the vendor sign-in in the engine's own account store. The engine's gateway serves the models afterwards. */
  async loginBegin(id: EngineId, provider: string): Promise<EngineLoginSession> {
    const def = this.loginDef(id, provider);
    await this.start(id);
    const st = this.state(id);
    const now = Date.now();
    if (id === 'cliproxyapi') {
      if (st.mode === 'connected') throw new Error(tr('这个 CLIProxyAPI 不是 claude-web 启动的，请用它自己的管理页登录'));
      const key = await this.reveal(st.managementKey);
      const path = provider === 'anthropic' ? 'anthropic-auth-url'
        : provider === 'codex' ? 'codex-auth-url'
          : provider === 'antigravity' ? 'antigravity-auth-url'
            : provider === 'kimi' ? 'kimi-auth-url'
              : provider === 'xai' ? 'xai-auth-url'
                : '';
      if (!path) throw new Error(tr('这个版本的 CLIProxyAPI 没有这个登录入口'));
      const j = await this.engineJson(`http://127.0.0.1:${st.port}/v0/management/${path}?is_webui=true`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      });
      if (!j?.url) throw new Error(tr('CLIProxyAPI 没有返回登录地址'));
      const view: EngineLoginSession = {
        id: `el_${crypto.randomBytes(6).toString('hex')}`, engine: id, provider, catalogId: def.catalogId,
        state: 'pending', url: String(j.url), at: now,
        ...(j.user_code ? { userCode: String(j.user_code) } : {}),
        ...(j.flow === 'device' ? { message: tr('在浏览器里输入这个代码') } : {}),
      };
      this.loginSessions.set(view.id, { view, backendState: typeof j.state === 'string' ? j.state : undefined });
      return view;
    }
    if (st.mode === 'connected' || !st.webPort) throw new Error(tr('这个 Magpie 不是 claude-web 启动的，登录入口在 Magpie 自己的窗口里'));
    const key = await this.reveal(st.webKey).catch(() => '');
    const base = `http://127.0.0.1:${st.webPort}`;
    const headers = { 'content-type': 'application/json', cookie: `magpie_web_${st.webPort}=${key}` };
    let j: any;
    try {
      j = await this.engineJson(`${base}/api/signin`, { method: 'POST', headers, body: JSON.stringify({ agent: provider }) });
    } catch (e: any) {
      // A retired built-in now lives on its community plugin: Magpie's plugin sign-in takes a method index,
      // while /api/signin only drives the built-in. Most plugins have one (0); a prompt it needs is shown as an error.
      if (!/plugin/i.test(String(e?.message ?? ''))) throw e;
      const hint = await this.engineJson(`${base}/api/plugin-signin/prompt`, { method: 'POST', headers, body: JSON.stringify({ provider, method: 0, inputs: {} }) });
      if (hint?.prompt) throw new Error(tr('这个 Magpie 插件登录先要回答一个问题：{q}', { q: String(hint.prompt?.label ?? hint.prompt?.key ?? hint.prompt) }));
      j = await this.engineJson(`${base}/api/plugin-signin`, { method: 'POST', headers, body: JSON.stringify({ provider, method: 0, inputs: hint?.inputs ?? {} }) });
    }
    if (!j?.id) throw new Error(tr('Magpie 没有返回登录编号'));
    const view: EngineLoginSession = {
      id: `el_${crypto.randomBytes(6).toString('hex')}`, engine: id, provider, catalogId: def.catalogId,
      state: 'pending', ...(j.url ? { url: String(j.url) } : {}),
      ...(j.code ? { userCode: String(j.code) } : {}),
      ...(j.instructions ? { message: String(j.instructions) } : {}),
      at: now,
    };
    this.loginSessions.set(view.id, { view, backendId: String(j.id), webPort: st.webPort, webKey: key });
    return view;
  }

  async loginStatus(id: EngineId, loginId: string): Promise<EngineLoginSession> {
    const s = this.loginSessions.get(loginId);
    if (!s || s.view.engine !== id) throw new Error(tr('这个登录已经结束了'));
    if (s.view.state !== 'pending') return s.view;
    const st = this.state(id);
    try {
      if (id === 'cliproxyapi') {
        const key = await this.reveal(st.managementKey);
        const j = await this.engineJson(`http://127.0.0.1:${st.port}/v0/management/get-auth-status?state=${encodeURIComponent(s.backendState ?? '')}`, { headers: { authorization: `Bearer ${key}` } });
        const status = String(j?.status ?? '');
        if (status === 'ok') s.view = { ...s.view, state: 'done' };
        else if (status === 'error') s.view = { ...s.view, state: 'error', message: String(j?.error ?? tr('登录没有完成')) };
        else s.view = { ...s.view, message: tr('等待浏览器授权…') };
      } else {
        const j = await this.engineJson(`http://127.0.0.1:${s.webPort}/api/signin/${encodeURIComponent(s.backendId ?? '')}`, {
          headers: { cookie: `magpie_web_${s.webPort}=${s.webKey}` },
        });
        const state = String(j?.state ?? '');
        if (state === 'done') s.view = { ...s.view, state: 'done', ...(j.user ? { message: String(j.user) } : {}) };
        else if (state === 'failed' || state === 'error') s.view = { ...s.view, state: 'error', message: String(j?.error ?? j?.message ?? tr('登录没有完成')) };
        else if (state === 'canceled' || state === 'cancelled') s.view = { ...s.view, state: 'cancelled' };
        else s.view = { ...s.view, ...(j?.url ? { url: String(j.url) } : {}), ...(j?.code ? { userCode: String(j.code) } : {}), message: tr('等待浏览器授权…') };
      }
      if (s.view.state === 'done') {
        const pid = st.providerId;
        if (pid) void this.deps.providers.refreshModels([pid]).catch(() => {});
        this.emit('changed', id);
      }
    } catch (e: any) {
      s.view = { ...s.view, state: 'error', message: e?.message ?? String(e) };
    }
    return s.view;
  }

  /**
   * Import an export into Magpie's account store. Magpie accepts Sub2API / CLIProxyAPI / Codex / Claude / Antigravity
   * files (`/api/signin/import`), so the user's existing accounts do not have to be signed in again.
   */
  async loginImport(id: EngineId, provider: string, text: string): Promise<EngineLoginImportResult> {
    const def = this.loginDef(id, provider);
    if (id !== 'magpie') throw new Error(tr('只有 Magpie 能从文件导入账号'));
    if (!text.trim()) throw new Error(tr('这个文件是空的'));
    if (text.length > 8 * 1024 * 1024) throw new Error(tr('这个文件太大了（最多 8 MB）'));
    await this.start(id);
    const st = this.state(id);
    if (st.mode === 'connected' || !st.webPort) throw new Error(tr('这个 Magpie 不是 claude-web 启动的，导入入口在 Magpie 自己的窗口里'));
    const key = await this.reveal(st.webKey).catch(() => '');
    const j = await this.engineJson(`http://127.0.0.1:${st.webPort}/api/signin/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `magpie_web_${st.webPort}=${key}` },
      body: JSON.stringify({ Agent: provider, Files: [text] }),
    }, 180_000);
    const results = Array.isArray(j?.results) ? j.results as EngineLoginImportResult['results'] : [];
    const imported = results.filter((r) => !r.error && r.status !== 'failed').length;
    if (!imported && results.some((r) => r.error)) throw new Error(String(results.find((r) => r.error)?.error));
    if (!results.length) throw new Error(tr('这个文件里没有可导入的账号'));
    if (st.providerId) void this.deps.providers.refreshModels([st.providerId]).catch(() => {});
    this.emit('changed', id);
    return { imported, results };
  }

  async loginCancel(id: EngineId, loginId: string): Promise<void> {
    const s = this.loginSessions.get(loginId);
    if (!s || s.view.engine !== id || s.view.state !== 'pending') return;
    const st = this.state(id);
    try {
      if (id === 'cliproxyapi') {
        const key = await this.reveal(st.managementKey);
        await fetch(`http://127.0.0.1:${st.port}/v0/management/oauth-session?state=${encodeURIComponent(s.backendState ?? '')}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
      } else {
        await fetch(`http://127.0.0.1:${s.webPort}/api/signin/${encodeURIComponent(s.backendId ?? '')}/cancel`, { method: 'POST', headers: { cookie: `magpie_web_${s.webPort}=${s.webKey}` }, signal: AbortSignal.timeout(10000) });
      }
    } catch { /* the engine may have stopped; the local session is cancelled anyway */ }
    s.view = { ...s.view, state: 'cancelled' };
  }

  private async protect(plain: string, id: string): Promise<string> {
    return this.deps.secrets ? this.deps.secrets.protect(plain, `engine-${id}`) : plain;
  }
  private async reveal(v: string | undefined): Promise<string> {
    if (!v) return '';
    return this.deps.secrets ? this.deps.secrets.reveal(v) : v;
  }

  /** One operation per engine at a time (an install and a start racing would both download / spawn). */
  private serial<T>(id: EngineId, fn: () => Promise<T>): Promise<T> {
    const prev = this.busy.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.busy.set(id, next);
    return next.finally(() => { if (this.busy.get(id) === next) this.busy.delete(id); });
  }

  private manifest(id: EngineId): EngineManifest {
    const m = MANIFESTS[id];
    if (!m) throw new Error(tr('没有这个托管程序：{id}', { id }));
    return m;
  }

  private binary(id: EngineId, version = this.state(id).version): string | null {
    if (!version) return null;
    const b = this.state(id).builds?.[version];
    if (!b) return null;
    const p = path.join(this.root, id, version, b.entry);
    return existsSync(p) ? p : null;
  }

  /** The build that came with the desktop installer (electron-builder extraResources → <resources>/engines). */
  private bundledDir(id: EngineId): string | null {
    return this.bundledRoot ? path.join(this.bundledRoot, platformKey(), id) : null;
  }

  private bundledBinary(id: EngineId): string | null {
    const dir = this.bundledDir(id);
    if (!dir) return null;
    const p = path.join(dir, `${this.manifest(id).entry}${exe}`);
    return existsSync(p) ? p : null;
  }

  private bundledVersion(id: EngineId): string | undefined {
    const dir = this.bundledDir(id);
    if (!dir) return undefined;
    try {
      const v = readFileSync(path.join(dir, 'version.txt'), 'utf8').trim();
      return v || undefined;
    } catch {
      return undefined;
    }
  }

  // ---- status ----

  private async detect(id: EngineId): Promise<{ port: number; version?: string } | null> {
    const hit = this.detected.get(id);
    if (hit && Date.now() - hit.at < DETECT_TTL) return hit.hit;
    const m = this.manifest(id);
    const found = await m.detect(m.defaultPort).catch(() => null);
    const out = found ? { port: m.defaultPort, ...found } : null;
    this.detected.set(id, { at: Date.now(), hit: out });
    return out;
  }

  private warnings(id: EngineId): string[] {
    const st = this.state(id);
    const out: string[] = [];
    for (const w of this.manifest(id).warnings) if (w === 'self-update') out.push(tr('Magpie 会在后台自己更新，实际运行的版本可能和这里装的不同'));
    const b = st.version && this.binary(id) ? st.builds?.[st.version] : undefined;
    if (b?.verified === 'release') out.push(tr('这个版本没有本应用固定的校验值：安装时你确认了文件的哈希（和发布里附带的一致）'));
    if (b?.verified === 'recorded') out.push(tr('这个版本的发布没有附带 SHA-256：首次安装时记下了文件的哈希，只能保证之后没被换过'));
    return out;
  }

  async status(id: EngineId): Promise<EngineStatus> {
    const m = this.manifest(id);
    const st = this.state(id);
    const run = this.runs.get(id);
    const managed = !!this.binary(id);
    const bundled = !managed && !!this.bundledBinary(id);
    const installed = managed || bundled;
    const version = managed ? st.version : bundled ? this.bundledVersion(id) : undefined;
    let health: EngineStatus['health'] = run?.health ?? 'stopped';
    let detail = run?.detail;
    let running = !!run && run.health !== 'stopped';
    let port = run?.port ?? st.port;
    if (st.mode === 'connected' && st.connectedPort) {
      port = st.connectedPort;
      const alive = await m.detect(st.connectedPort).catch(() => null);
      running = !!alive;
      health = alive ? 'ok' : 'error';
      detail = alive ? undefined : tr('连不上 127.0.0.1:{port} 上的 {name}', { port: st.connectedPort, name: m.name });
    }
    const detected = !running && st.mode !== 'connected' ? await this.detect(id) : null;
    const b = managed && st.version ? st.builds?.[st.version] : undefined;
    return {
      id,
      name: m.name,
      repo: m.repo,
      platform: platformKey(),
      installed,
      running,
      ...(st.mode ? { mode: st.mode } : {}),
      ...(installed && version ? { version } : {}),
      ...(bundled ? { bundled: true } : {}),
      ...(st.previousVersion ? { previousVersion: st.previousVersion } : {}),
      ...(b ? { verified: b.verified, sha256: b.sha256 } : {}),
      ...(port ? { port } : {}),
      ...(id === 'magpie' && st.mode !== 'connected' && st.webPort ? { webPort: st.webPort } : {}),
      health,
      ...(detail ? { detail } : {}),
      ...(detected ? { detected } : {}),
      ...(st.providerId && this.deps.providers.list().some((p) => p.id === st.providerId) ? { providerId: st.providerId } : {}),
      warnings: this.warnings(id),
    };
  }

  async statuses(): Promise<EngineStatus[]> {
    return Promise.all((Object.keys(MANIFESTS) as EngineId[]).map((id) => this.status(id)));
  }

  // ---- install / upgrade / rollback ----

  private async release(m: EngineManifest, tag?: string): Promise<GhRelease> {
    const url = tag ? `https://api.github.com/repos/${m.repo}/releases/tags/${encodeURIComponent(tag)}` : `https://api.github.com/repos/${m.repo}/releases/latest`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'claude-web' }, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new Error(tr('读不到 {name} 的发布列表：{message}', { name: m.name, message: (e as Error).message }));
    }
    if (!res.ok) throw new Error(tr('读不到 {name} 的发布列表：HTTP {status}', { name: m.name, status: res.status }));
    const j = await res.json() as GhRelease;
    if (!j?.tag_name || !Array.isArray(j.assets)) throw new Error(tr('{name} 的发布信息格式不对', { name: m.name }));
    return j;
  }

  /** The release's own SHA-256 for this asset: GitHub's asset digest, else a checksums file published with it. */
  private async releaseHash(rel: GhRelease, asset: GhAsset): Promise<string | null> {
    if (asset.digest && /^sha256:[0-9a-f]{64}$/i.test(asset.digest)) return asset.digest.slice(7).toLowerCase();
    const sums = rel.assets.find((a) => a.name === `${asset.name}.sha256`) ?? rel.assets.find((a) => /(checksums?|sha256sums?)(\.txt)?$/i.test(a.name));
    if (!sums) return null;
    try {
      const text = await (await fetch(sums.browser_download_url, { signal: AbortSignal.timeout(20_000) })).text();
      for (const line of text.split(/\r?\n/)) {
        const mm = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
        if (mm && (mm[2].trim() === asset.name || path.basename(mm[2].trim()) === asset.name)) return mm[1].toLowerCase();
      }
      // a `<asset>.sha256` file holding only the hash
      const only = /^([0-9a-f]{64})\b/i.exec(text.trim());
      return sums.name === `${asset.name}.sha256` && only ? only[1].toLowerCase() : null;
    } catch {
      return null;
    }
  }

  install(id: EngineId, tag?: string, opts: InstallOptions = {}): Promise<EngineStatus> {
    return this.serial(id, async () => {
      try {
        await this.installNow(id, tag, opts);
      } catch (e) {
        if (e instanceof UnverifiedBuild) return { ...(await this.status(id)), confirm: e.info };
        throw e;
      }
      return this.status(id);
    });
  }

  private async installNow(id: EngineId, tag?: string, opts: InstallOptions = {}): Promise<string> {
    const m = this.manifest(id);
    const st = this.state(id);
    this.emit('progress', id, 'release');
    const rel = await this.release(m, tag ?? m.pin);
    const version = rel.tag_name;
    if (this.binary(id, version)) {
      if (st.version !== version) { st.previousVersion = st.version; st.version = version; await this.save(); }
      return version;
    }
    // a hash this app pins for the version names the file too; the release's own checksum is only shown (SEC-09)
    const pin = pinFor(this.pins, id, version, platformKey());
    const asset = pin ? rel.assets.find((a) => a.name === pin.asset) ?? null : pickAsset(m, rel.assets);
    if (!asset && pin) throw new Error(tr('{name} {version} 的发布里没有 {asset}（本应用固定了它的校验值），已停止', { name: m.name, version, asset: pin.asset }));
    if (!asset) throw new Error(tr('{name} {version} 没有这个平台（{platform}）的版本', { name: m.name, version, platform: platformKey() }));
    const releaseSha = pin ? null : await this.releaseHash(rel, asset);
    const dir = path.join(this.root, id);
    const tmp = path.join(dir, `.tmp-${crypto.randomBytes(4).toString('hex')}`);
    await fs.mkdir(tmp, { recursive: true });
    try {
      let res: Response;
      this.emit('progress', id, 'download');
      try {
        res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(10 * 60_000) });
      } catch (e) {
        throw new Error(tr('下载 {name} 失败：{message}', { name: m.name, message: (e as Error).message }));
      }
      if (!res.ok) throw new Error(tr('下载 {name} 失败：HTTP {status}', { name: m.name, status: res.status }));
      const buf = Buffer.from(await res.arrayBuffer());
      if (asset.size && buf.length !== asset.size) throw new Error(tr('{name} 下载不完整（{got} / {want} 字节）', { name: m.name, got: buf.length, want: asset.size }));
      this.emit('progress', id, 'verify');
      const hash = crypto.createHash('sha256').update(buf).digest('hex');
      if (pin) {
        if (hash !== pin.sha256) throw new Error(tr('{name} 校验失败（SHA-256 和本应用固定的不一致），已丢弃', { name: m.name }));
      } else {
        if (releaseSha && hash !== releaseSha) throw new Error(tr('{name} 校验失败（SHA-256 和发布的不一致），已丢弃', { name: m.name }));
        // a hash the user accepted earlier for the same file must still match
        const before = st.builds?.[version];
        const accepted = !!before && before.asset === asset.name && (before.verified !== 'release' || before.confirmed === true);
        if (accepted && before.sha256 !== hash) throw new Error(tr('{name} 的文件和上次安装时记下的哈希不一致，已丢弃', { name: m.name }));
        // nothing pinned and not the file the user already accepted: ask first, showing this file's hash
        if (!(accepted && before.sha256 === hash) && !consented(opts, hash)) {
          throw new UnverifiedBuild({ version, asset: asset.name, sha256: hash, ...(releaseSha ? { releaseSha256: releaseSha } : {}) }, m.name);
        }
      }
      const kind = isArchive(asset.name);
      const dl = path.join(tmp, kind === 'zip' ? 'download.zip' : kind ? 'download.tar.gz' : `${m.entry}${exe}`);
      await fs.writeFile(dl, buf);
      if (kind) {
        this.emit('progress', id, 'unpack');
        const out = path.join(tmp, 'x');
        await fs.mkdir(out, { recursive: true });
        await unpack(kind, dl, out);
      }
      const found = kind ? await findEntry(path.join(tmp, 'x'), m.entry) : dl;
      if (!found) throw new Error(tr('{name} 的安装包里没有找到 {entry}', { name: m.name, entry: m.entry }));
      const entryName = `${m.entry}${exe}`;
      const dest = path.join(dir, version);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.mkdir(dest, { recursive: true });
      // the whole folder the executable came from (some builds ship files next to it)
      if (kind) await fs.cp(path.dirname(found), dest, { recursive: true });
      else await fs.copyFile(found, path.join(dest, entryName));
      if (path.basename(found) !== entryName && kind) await fs.rename(path.join(dest, path.basename(found)), path.join(dest, entryName));
      await fs.chmod(path.join(dest, entryName), 0o755).catch(() => {});
      st.builds = { ...(st.builds ?? {}), [version]: { entry: entryName, sha256: hash, verified: pin ? 'pinned' : releaseSha ? 'release' : 'recorded', asset: asset.name, at: Date.now(), ...(pin ? {} : { confirmed: true }) } };
      if (st.version && st.version !== version) st.previousVersion = st.version;
      st.version = version;
      // keep the current and the previous build only
      for (const v of Object.keys(st.builds)) {
        if (v === st.version || v === st.previousVersion) continue;
        delete st.builds[v];
        await fs.rm(path.join(dir, v), { recursive: true, force: true }).catch(() => {});
      }
      await this.save();
      return version;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  upgrade(id: EngineId, opts: InstallOptions = {}): Promise<EngineStatus> {
    return this.serial(id, async () => {
      const st = this.state(id);
      const was = st.version;
      const running = this.runs.has(id);
      let now: string;
      try {
        now = await this.installNow(id, undefined, opts);
      } catch (e) {
        // not pinned: the UI shows the hash and, on a yes, sends engines.upgrade again with it (nothing changed here)
        if (e instanceof UnverifiedBuild) return { ...(await this.status(id)), confirm: e.info };
        throw e;
      }
      if (now === was) return this.status(id);
      if (running) {
        await this.stopNow(id, false);
        try {
          await this.startNow(id);
        } catch (e) {
          // the new build does not come up: back to the one that did
          st.version = was;
          st.previousVersion = now;
          await this.save();
          await this.startNow(id).catch(() => {});
          throw new Error(tr('新版本启动失败，已回到 {version}：{message}', { version: was ?? '?', message: (e as Error).message }));
        }
      }
      return this.status(id);
    });
  }

  rollback(id: EngineId): Promise<EngineStatus> {
    return this.serial(id, async () => {
      const st = this.state(id);
      if (!st.previousVersion || !this.binary(id, st.previousVersion)) throw new Error(tr('没有可以回退的上一个版本'));
      const running = this.runs.has(id);
      if (running) await this.stopNow(id, false);
      [st.version, st.previousVersion] = [st.previousVersion, st.version];
      await this.save();
      if (running) await this.startNow(id);
      return this.status(id);
    });
  }

  // ---- run ----

  start(id: EngineId): Promise<EngineStatus> {
    return this.serial(id, async () => {
      try {
        await this.startNow(id);
      } catch (e) {
        // nothing installed yet and the download needs the user's confirmation: the UI asks, installs, starts again
        if (e instanceof UnverifiedBuild) return { ...(await this.status(id)), confirm: e.info };
        throw e;
      }
      return this.status(id);
    });
  }

  private async keys(id: EngineId, m: EngineManifest): Promise<{ clientKey: string; managementKey: string }> {
    const st = this.state(id);
    let clientKey = m.fixedClientKey ?? await this.reveal(st.clientKey).catch(() => '');
    if (!clientKey) {
      clientKey = `cw-${crypto.randomBytes(24).toString('hex')}`;
      st.clientKey = await this.protect(clientKey, id);
    }
    let managementKey = '';
    if (m.managementKey) {
      managementKey = await this.reveal(st.managementKey).catch(() => '');
      if (!managementKey) {
        managementKey = crypto.randomBytes(24).toString('hex');
        st.managementKey = await this.protect(managementKey, `${id}-management`);
      }
    }
    await this.save();
    return { clientKey, managementKey };
  }

  private async startNow(id: EngineId): Promise<void> {
    const m = this.manifest(id);
    const st = this.state(id);
    if (st.mode === 'connected') {
      const port = st.connectedPort ?? m.defaultPort;
      if (!(await m.detect(port))) throw new Error(tr('连不上 127.0.0.1:{port} 上的 {name}', { port, name: m.name }));
      return;
    }
    if (this.runs.get(id)?.health === 'ok') return;
    // a build the installer carried is used as-is; only a missing one is downloaded
    let bin = this.binary(id) ?? this.bundledBinary(id);
    if (!bin) {
      await this.installNow(id);
      bin = this.binary(id);
    }
    if (!bin) throw new Error(tr('{name} 没有装好', { name: m.name }));
    const { clientKey, managementKey } = await this.keys(id, m);
    this.emit('progress', id, 'start');
    // the port it had last time when it is free (the provider's address stays the same), else a new one
    const port = st.port && st.port !== m.defaultPort && await portFree(st.port) ? st.port : await freePort();
    if (st.port !== port) { st.port = port; await this.save(); }
    // Magpie's web page carries the vendor sign-ins; keep it on a port of our own and a key we know.
    let webPort: number | undefined;
    let webKey: string | undefined;
    if (id === 'magpie') {
      webPort = st.webPort && await portFree(st.webPort) ? st.webPort : await freePort();
      if (st.webPort !== webPort) { st.webPort = webPort; await this.save(); }
      webKey = await this.reveal(st.webKey).catch(() => '');
      if (!webKey) {
        webKey = crypto.randomBytes(16).toString('hex');
        st.webKey = await this.protect(webKey, 'magpie-web');
        await this.save();
      }
    }
    const dir = path.join(this.root, id, 'data');
    await fs.mkdir(dir, { recursive: true });
    const ctx = { port, dir, clientKey, managementKey, ...(webPort ? { webPort } : {}), ...(webKey ? { webKey } : {}) };
    if (m.prepare) await m.prepare(ctx);
    // the proxy `network.proxy` decides is the only one the engine is handed (engineEnv)
    await proxy.refresh().catch(() => {});
    const child = startProcess(bin, m.args(ctx), { cwd: dir, env: m.env(ctx), root: this.root, id });
    const run: Runtime = { child, port, health: 'starting', stopping: false, fails: 0 };
    this.runs.set(id, run);
    let spawnError = '';
    child.once('error', (e) => { spawnError = e.message; });
    child.once('exit', (code, signal) => {
      if (this.runs.get(id) !== run) return;
      this.clearMonitor(run);
      this.runs.delete(id);
      this.emit('changed', id);
      if (run.stopping) return;
      this.crashed(id, tr('{name} 退出了（{code}）', { name: m.name, code: code ?? signal ?? '?' }));
    });
    const deadline = Date.now() + READY_MS;
    while (Date.now() < deadline) {
      if (this.runs.get(id) !== run) throw new Error(spawnError || tr('{name} 启动后马上退出了，看看日志', { name: m.name }));
      if (await m.health({ port, clientKey }).catch(() => false)) {
        run.health = 'ok';
        run.detail = undefined;
        this.monitor(id, run, m, clientKey);
        st.autoStart = true;
        await this.save();
        await this.register(id, m.baseUrl(port), clientKey);
        this.emit('changed', id);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    run.stopping = true;
    await stopTree(child);
    this.runs.delete(id);
    throw new Error(tr('{name} 30 秒内没有就绪，看看日志', { name: m.name }));
  }

  /** Unexpected exit: up to three restarts within ten minutes (2 s, 4 s, 8 s apart), then it stays down with the reason. */
  private crashed(id: EngineId, why: string): void {
    const now = Date.now();
    const recent = (this.restarts.get(id) ?? []).filter((t) => now - t < 10 * 60_000);
    this.detected.delete(id);
    if (recent.length >= 3) {
      this.restarts.set(id, recent);
      this.emit('crash', id, why);
      return;
    }
    recent.push(now);
    this.restarts.set(id, recent);
    const t = setTimeout(() => {
      if (this.runs.has(id) || !this.state(id).autoStart) return;
      void this.start(id).catch((e) => this.emit('crash', id, (e as Error).message));
    }, 1000 * 2 ** recent.length);
    t.unref?.();
  }

  private monitor(id: EngineId, run: Runtime, m: EngineManifest, clientKey: string): void {
    this.clearMonitor(run);
    run.monitor = setInterval(() => {
      if (this.runs.get(id) !== run) return;
      void m.health({ port: run.port, clientKey }).catch(() => false).then((ok) => {
        if (ok) { run.fails = 0; if (run.health !== 'ok') { run.health = 'ok'; run.detail = undefined; this.emit('changed', id); } return; }
        run.fails += 1;
        if (run.fails >= 3 && run.health === 'ok') {
          run.health = 'error';
          run.detail = tr('连续 3 次健康检查没有回应');
          this.emit('changed', id);
        }
      });
    }, HEALTH_MS);
    run.monitor.unref?.();
  }

  private clearMonitor(run: Runtime) { if (run.monitor) { clearInterval(run.monitor); run.monitor = undefined; } }

  /** Point an Anthropic-format provider at the gateway (the same profile every time; its address follows the port). */
  private async register(id: EngineId, baseUrl: string, key: string): Promise<void> {
    const m = this.manifest(id);
    const st = this.state(id);
    const exists = st.providerId && this.deps.providers.list().some((p) => p.id === st.providerId);
    // Provider.authStyle (spec §5.1): magpie takes Bearer or x-api-key; unknown for CLIProxyAPI (unset = both headers)
    const auth: { authStyle?: 'both' } = m.id === 'magpie' ? { authStyle: 'both' } : {};
    const saved = await this.deps.providers.upsert({ ...(exists ? { id: st.providerId } : {}), name: m.name, type: 'anthropic', baseUrl, apiKey: key, ...auth });
    st.providerId = saved.id;
    this.deps.meta.channelLinks()[saved.id] = { catalogId: id, engine: id };
    await this.save();
    // the model list in the background: the source shows up at once, its models a moment later
    void this.deps.providers.refreshModels([saved.id]).then(async ([r]) => {
      const p = this.deps.providers.list().find((x) => x.id === saved.id);
      // a default model / family map the first time (the user's own choice later is kept)
      if (r?.ok && p && !p.defaultModel && p.models?.length) await this.deps.providers.upsert({ id: p.id, ...planModels('anthropic', p.models) });
      this.emit('changed', id);
    }).catch(() => {});
  }

  stop(id: EngineId): Promise<EngineStatus> {
    return this.serial(id, async () => { await this.stopNow(id, true); return this.status(id); });
  }

  private async stopNow(id: EngineId, byUser: boolean): Promise<void> {
    const st = this.state(id);
    if (byUser) { st.autoStart = false; await this.save(); }
    const run = this.runs.get(id);
    if (!run) return;
    run.stopping = true;
    this.clearMonitor(run);
    await stopTree(run.child);
    if (this.runs.get(id) === run) this.runs.delete(id);
    this.detected.delete(id);
    this.emit('changed', id);
  }

  /** Server shutdown: stop what we started, but remember it should come back. */
  async stopAll(): Promise<void> {
    for (const [id, run] of [...this.runs]) {
      run.stopping = true;
      this.clearMonitor(run);
      await stopTree(run.child).catch(() => {});
      this.runs.delete(id);
    }
  }

  /** Server start: bring back the engines that were running. */
  async resume(): Promise<void> {
    for (const id of Object.keys(MANIFESTS) as EngineId[]) {
      const st = this.state(id);
      if (st.mode !== 'connected' && st.autoStart && (this.binary(id) || this.bundledBinary(id))) await this.start(id).catch((e) => console.error(`[engines] ${id}: ${(e as Error).message}`));
    }
  }

  uninstall(id: EngineId): Promise<EngineStatus> {
    return this.serial(id, async () => {
      await this.stopNow(id, true);
      await this.forgetProvider(id);
      await fs.rm(path.join(this.root, id), { recursive: true, force: true });
      delete this.deps.meta.engineState()[id];
      await this.save();
      this.detected.delete(id);
      return this.status(id);
    });
  }

  /** Stop using it as a source (the build stays installed). */
  disconnect(id: EngineId): Promise<EngineStatus> {
    return this.serial(id, async () => {
      await this.stopNow(id, true);
      await this.forgetProvider(id);
      const st = this.state(id);
      if (st.mode === 'connected') { delete st.mode; delete st.connectedPort; delete st.clientKey; }
      await this.save();
      return this.status(id);
    });
  }

  private async forgetProvider(id: EngineId): Promise<void> {
    const st = this.state(id);
    if (st.providerId) {
      if (this.deps.providers.list().some((p) => p.id === st.providerId)) await this.deps.providers.remove(st.providerId);
      delete this.deps.meta.channelLinks()[st.providerId];
      delete st.providerId;
    }
  }

  /** Use a copy the user already runs: check it answers (and the key works), then register it. */
  connect(id: EngineId, port?: number, key?: string): Promise<EngineStatus> {
    return this.serial(id, async () => {
      const m = this.manifest(id);
      const p = port ?? m.defaultPort;
      if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error(tr('端口不对'));
      if (!(await m.detect(p))) throw new Error(tr('127.0.0.1:{port} 上没有找到 {name}', { port: p, name: m.name }));
      const clientKey = key?.trim() || m.fixedClientKey;
      if (!clientKey) throw new Error(tr('连接 {name} 需要它的客户端 Key（配置里 access.api-keys 的一项）', { name: m.name }));
      if (!(await m.health({ port: p, clientKey }).catch(() => false))) throw new Error(tr('{name} 拒绝了这个 Key，或者没有回应', { name: m.name }));
      if (this.runs.has(id)) await this.stopNow(id, true);
      const st = this.state(id);
      st.mode = 'connected';
      st.connectedPort = p;
      st.clientKey = await this.protect(clientKey, id);
      await this.save();
      await this.register(id, m.baseUrl(p), clientKey);
      this.detected.delete(id);
      return this.status(id);
    });
  }

  logs(id: EngineId, lines = 200): Promise<string> {
    this.manifest(id);
    return tailLog(this.root, id, Math.max(1, Math.min(5000, lines)));
  }
}
