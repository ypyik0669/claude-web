// onnxruntime-node for the local model, downloaded inside the app (no npm, no terminal, no restart). The package and
// its one runtime dependency (onnxruntime-common) are fetched from the npm registry at pinned versions, each tarball
// checked against the registry's published sha512 `dist.integrity`, extracted with the safe tar reader (no traversal,
// no links) keeping only this machine's native binaries, staged in a temp folder and renamed into
// `<data>/privacy-model/runtime/node_modules/…`. The model then loads it with createRequire from that folder.
//
// Pinned 2026-10-28. onnxruntime-node ≥ 1.24 ships no darwin-x64 binaries, so Intel Macs get 1.23.2 (the last with
// them). The package's postinstall only fetches the optional CUDA providers on linux-x64 (CPU works without them): not run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { extractTarGzFile } from './archive.js';
import { guardedFetch } from '../../net/netguard.js';
import { tr } from '../../i18n/index.js';
import { fetchVerified } from './download.js';

export interface RuntimePackage { name: string; version: string; size: number; integrity: string }

export const NPM_REGISTRY = 'https://registry.npmjs.org/';

const ORT_1_31_1: RuntimePackage[] = [
  { name: 'onnxruntime-node', version: '1.31.1', size: 115391311, integrity: 'sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==' },
  { name: 'onnxruntime-common', version: '1.31.1', size: 72322, integrity: 'sha512-F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==' },
];
const ORT_1_23_2: RuntimePackage[] = [
  { name: 'onnxruntime-node', version: '1.23.2', size: 97134627, integrity: 'sha512-OBTsG0W8ddBVOeVVVychpVBS87A9YV5sa2hJ6lc025T97Le+J4v++PwSC4XFs1C62SWyNdof0Mh4KvnZgtt4aw==' },
  { name: 'onnxruntime-common', version: '1.23.2', size: 65554, integrity: 'sha512-5LFsC9Dukzp2WV6kNHYLNzp8sT6V02IubLCbzw2Xd6X5GOlr65gAX6xiJwyi2URJol/s71gaQLC5F2C25AAR2w==' },
];

/** platform-arch → the packages to fetch (the first is onnxruntime-node). Others: not available. */
export const ORT_RUNTIMES: Record<string, RuntimePackage[]> = {
  'win32-x64': ORT_1_31_1,
  'win32-arm64': ORT_1_31_1,
  'darwin-arm64': ORT_1_31_1,
  'linux-x64': ORT_1_31_1,
  'linux-arm64': ORT_1_31_1,
  'darwin-x64': ORT_1_23_2,
};

export const tarballUrl = (registry: string, p: RuntimePackage) => `${registry.replace(/\/?$/, '/')}${p.name}/-/${p.name}-${p.version}.tgz`;

/** The native binding inside the package, as onnxruntime-node's dist/binding.js requires it. */
export const bindingRel = (platform: string, arch: string) => `bin/napi-v6/${platform}/${arch}/onnxruntime_binding.node`;

export interface RuntimeOptions {
  registry?: string;
  /** null: no runtime for this platform */
  packages?: RuntimePackage[] | null;
  platform?: string;
  arch?: string;
  /** default: the process fetch behind the egress guard (public internet only), through the app's proxy */
  fetchImpl?: typeof fetch;
}

const stamp = (pkgs: RuntimePackage[]) => pkgs.map((p) => `${p.name}@${p.version} ${p.integrity}`).join('\n');

/** The downloaded runtime: `<root>/runtime`. `root` null: none (no data dir). */
export class OrtRuntime {
  readonly packages: RuntimePackage[] | null;
  private platform: string;
  private arch: string;

  constructor(private root: string | null, private o: RuntimeOptions = {}) {
    this.platform = o.platform ?? process.platform;
    this.arch = o.arch ?? process.arch;
    this.packages = o.packages !== undefined ? o.packages : ORT_RUNTIMES[`${this.platform}-${this.arch}`] ?? null;
    // leftovers of an install or a removal that did not finish (a crash, a binary still loaded on Windows)
    if (root) {
      try {
        for (const n of fs.readdirSync(root)) if (/^runtime\.(tmp|old)-/.test(n)) fs.rmSync(path.join(root, n), { recursive: true, force: true });
        const dir = path.join(root, 'runtime');
        if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, '.ok'))) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* no folder yet, or still locked */ }
    }
  }

  dir(): string | null { return this.root ? path.join(this.root, 'runtime') : null; }
  supported(): boolean { return !!this.root && !!this.packages?.length; }
  size(): number { return (this.packages ?? []).reduce((a, p) => a + p.size, 0); }

  /** Everything in place and from these pinned tarballs. */
  installed(): boolean {
    const dir = this.dir();
    if (!dir || !this.packages?.length) return false;
    try {
      return fs.readFileSync(path.join(dir, '.ok'), 'utf8') === stamp(this.packages)
        && fs.existsSync(path.join(dir, 'node_modules', this.packages[0].name, bindingRel(this.platform, this.arch)));
    } catch { return false; }
  }

  /** onnxruntime-node's entry file in the downloaded runtime, or null. */
  resolve(): string | null {
    if (!this.installed()) return null;
    try { return createRequire(path.join(this.dir()!, 'package.json')).resolve('onnxruntime-node'); } catch { return null; }
  }

  /** Fetch, check, extract, swap in. Nothing is left behind on failure (the staging folder goes). */
  async install(o: { signal?: AbortSignal; onBytes?: (n: number) => void } = {}): Promise<void> {
    const dir = this.dir();
    const pkgs = this.packages;
    if (!dir || !pkgs?.length) throw new Error(tr('这台电脑的系统（{platform}）没有可下载的运行库', { platform: `${this.platform}-${this.arch}` }));
    const root = this.root!;
    await fs.promises.mkdir(root, { recursive: true });
    const stage = path.join(root, `runtime.tmp-${crypto.randomBytes(6).toString('hex')}`);
    const f = this.o.fetchImpl ?? (guardedFetch({ policy: 'public' }) as typeof fetch);
    try {
      let base = 0;
      for (const p of pkgs) {
        const tgz = path.join(stage, 'dl', `${p.name}-${p.version}.tgz`);
        await fetchVerified(tarballUrl(this.o.registry ?? NPM_REGISTRY, p), tgz, { size: p.size, integrity: p.integrity }, {
          signal: o.signal, fetchImpl: f, onBytes: (n) => o.onBytes?.(base + n),
        });
        base += p.size;
        o.signal?.throwIfAborted();
        const unpack = path.join(stage, 'unpack', p.name);
        const main = p === pkgs[0];
        const bin = `package/${bindingRel(this.platform, this.arch).split('/').slice(0, -1).join('/')}/`;
        await extractTarGzFile(tgz, unpack, {
          // onnxruntime-node: its JS and this machine's binaries only (the tarball carries every platform's)
          want: (rel) => rel.startsWith('package/') && (!main || rel === 'package/package.json' || rel.startsWith('package/dist/') || rel.startsWith(bin)),
        });
        await fs.promises.rm(tgz, { force: true });
        await fs.promises.mkdir(path.join(stage, 'node_modules'), { recursive: true });
        await fs.promises.rename(path.join(unpack, 'package'), path.join(stage, 'node_modules', p.name));
      }
      if (!fs.existsSync(path.join(stage, 'node_modules', pkgs[0].name, bindingRel(this.platform, this.arch)))) {
        throw new Error(tr('运行库里没有这台电脑能用的文件（{platform}）', { platform: `${this.platform}-${this.arch}` }));
      }
      await fs.promises.rm(path.join(stage, 'dl'), { recursive: true, force: true });
      await fs.promises.rm(path.join(stage, 'unpack'), { recursive: true, force: true });
      await fs.promises.writeFile(path.join(stage, '.ok'), stamp(pkgs), 'utf8');
      o.signal?.throwIfAborted();
      await this.clear();
      await fs.promises.rename(stage, dir);
    } catch (e) {
      await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
  }

  /**
   * Take the runtime away. Its `.ok` goes first (so it no longer counts as installed); on Windows a binary this process
   * has loaded cannot be deleted — then the folder is renamed aside (or left) and swept at the next start.
   */
  async remove(): Promise<void> { await this.clear().catch(() => {}); }

  private async clear() {
    const dir = this.dir();
    if (!dir || !fs.existsSync(dir)) return;
    await fs.promises.rm(path.join(dir, '.ok'), { force: true }).catch(() => {});
    const old = path.join(this.root!, `runtime.old-${crypto.randomBytes(6).toString('hex')}`);
    try {
      await fs.promises.rename(dir, old);
    } catch {
      // still locked: delete what can be deleted; an install needs the name free
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (fs.existsSync(dir)) throw new Error(tr('运行库正在使用，删不掉；重启 Claude Web 后再试'));
      return;
    }
    await fs.promises.rm(old, { recursive: true, force: true }).catch(() => {});
  }
}
