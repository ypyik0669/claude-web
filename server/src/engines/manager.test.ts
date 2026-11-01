// 引擎安装 (spec §9): a download whose SHA-256 differs from the one the release published is thrown away —
// nothing is installed, nothing is recorded.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineManager, platformKey } from './manager.js';
import { handleEngineRequest } from './handlers.js';
import { PINS, pinFor, pinsFrom, type PinTable } from './manifests/pins.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const assetName = () => {
  const os_ = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return `cli-proxy-api_9.9.9_${os_}_${arch}${process.platform === 'win32' ? '.exe' : ''}`;
};

function setup(release: (name: string, body: Buffer) => object, extra: Record<string, string> = {}, pins?: PinTable) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-engines-'));
  dirs.push(root);
  const body = Buffer.from('#!/bin/sh\necho fake engine\n');
  const name = assetName();
  const rel = release(name, body);
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url);
    if (url.includes('api.github.com')) return new Response(JSON.stringify(rel), { status: 200 });
    if (extra[url] !== undefined) return new Response(extra[url], { status: 200 });
    if (url.endsWith(name)) return new Response(body, { status: 200 });
    return new Response('nope', { status: 404 });
  });
  const state: any = {};
  let saves = 0;
  const meta: any = { engineState: () => state, saveChannels: async () => { saves++; } };
  const providers: any = { upsert: async () => ({}), remove: async () => {}, refreshModels: async () => {}, list: () => [] };
  // no bundled engines: a shell started from the installed app inherits CLAUDE_WEB_ENGINES, whose CLIProxyAPI would count as installed
  const mgr = new EngineManager({ meta, providers, root, bundledDir: '', ...(pins ? { pins } : {}) });
  return { mgr, root, state, urls, body, name, saves: () => saves };
}

const wrong = 'sha256:' + '0'.repeat(64);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('EngineManager login catalog', () => {
  it('maps engine sign-in ids to the hub catalog ids, for both engines', () => {
    const s = setup((name, body) => ({ tag_name: 'v9.9.9', assets: [{ name, browser_download_url: `https://dl.example/${name}`, size: body.length }] }));
    const list = s.mgr.loginProviders();
    expect(list).toEqual(expect.arrayContaining([
      expect.objectContaining({ engine: 'cliproxyapi', provider: 'anthropic', catalogId: 'claude' }),
      expect.objectContaining({ engine: 'cliproxyapi', provider: 'xai', catalogId: 'grok' }),
      expect.objectContaining({ engine: 'magpie', provider: 'mimo-app', catalogId: 'mimo' }),
      expect.objectContaining({ engine: 'magpie', provider: 'trae-cn', catalogId: 'trae' }),
      expect.objectContaining({ engine: 'magpie', provider: 'qoder', catalogId: 'qoder' }),
    ]));
  });
});

describe('EngineManager bundled builds', () => {
  it('reports the build carried by the installer as installed, with its version, and never asks GitHub', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-engines-data-'));
    const bundled = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-engines-bundled-'));
    dirs.push(root, bundled);
    const dir = path.join(bundled, `${process.platform}-${process.arch}`, 'magpie');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `magpie${process.platform === 'win32' ? '.exe' : ''}`), 'fake');
    fs.writeFileSync(path.join(dir, 'version.txt'), 'v0.1.1803\n');
    vi.stubGlobal('fetch', async () => { throw new Error('no network'); });
    const state: any = {};
    const meta: any = { engineState: () => state, saveChannels: async () => {} };
    const providers: any = { upsert: async () => ({}), remove: async () => {}, refreshModels: async () => {}, list: () => [] };
    const mgr = new EngineManager({ meta, providers, root, bundledDir: bundled });
    const st = await mgr.status('magpie');
    expect(st).toMatchObject({ id: 'magpie', installed: true, bundled: true, version: 'v0.1.1803', health: 'stopped' });
    expect(st.verified).toBeUndefined();
  });
});

describe('EngineManager install verification', () => {
  it('a GitHub asset digest that does not match refuses the install and leaves nothing behind', async () => {
    const s = setup((name, body) => ({ tag_name: 'v9.9.9', assets: [{ name, browser_download_url: `https://dl.example/${name}`, size: body.length, digest: wrong }] }));
    await expect(s.mgr.install('cliproxyapi')).rejects.toThrow(/SHA-256|校验/);
    expect(s.urls.some((u) => u.startsWith('https://dl.example/'))).toBe(true);
    expect(s.state.cliproxyapi?.version).toBeUndefined();
    const left = fs.existsSync(path.join(s.root, 'cliproxyapi')) ? fs.readdirSync(path.join(s.root, 'cliproxyapi')) : [];
    expect(left).toEqual([]); // no version folder, no leftover temp folder
  });

  it('a checksums.txt that does not match refuses too; a matching one is not the reason a refusal happens', async () => {
    const s = setup((name) => ({ tag_name: 'v9.9.9', assets: [
      { name, browser_download_url: `https://dl.example/${name}` },
      { name: 'checksums.txt', browser_download_url: 'https://dl.example/checksums.txt' },
    ] }), { 'https://dl.example/checksums.txt': `${'a'.repeat(64)}  ${assetName()}\n` });
    await expect(s.mgr.install('cliproxyapi')).rejects.toThrow(/SHA-256|校验/);
    expect(s.state.cliproxyapi?.version).toBeUndefined();
  });

  it('a release with no published SHA-256 installs nothing until the user confirms that file (review E2)', async () => {
    const s = setup((name, body) => ({ tag_name: 'v9.9.9', assets: [{ name, browser_download_url: `https://dl.example/${name}`, size: body.length }] }));
    const asked = await s.mgr.install('cliproxyapi');
    expect(asked.confirm).toEqual({ version: 'v9.9.9', asset: s.name, sha256: sha(s.body) });
    expect(asked.installed).toBe(false);
    expect(s.state.cliproxyapi?.version).toBeUndefined();
    expect(fs.existsSync(path.join(s.root, 'cliproxyapi', 'v9.9.9'))).toBe(false);
    // consent to another file's hash is not consent to this one
    const other = await s.mgr.install('cliproxyapi', undefined, { allowUnverified: true, sha256: 'f'.repeat(64) });
    expect(other.confirm?.sha256).toBe(sha(s.body));
    expect(s.state.cliproxyapi?.version).toBeUndefined();
    const done = await s.mgr.install('cliproxyapi', undefined, { allowUnverified: true, sha256: sha(s.body) });
    expect(done.confirm).toBeUndefined();
    expect(done).toMatchObject({ installed: true, version: 'v9.9.9', verified: 'recorded', sha256: sha(s.body) });
  });

  it('an incomplete download (size differs) is refused before hashing', async () => {
    const s = setup((name, body) => ({ tag_name: 'v9.9.9', assets: [{ name, browser_download_url: `https://dl.example/${name}`, size: body.length + 1, digest: `sha256:${sha(body)}` }] }));
    await expect(s.mgr.install('cliproxyapi')).rejects.toThrow();
    expect(s.state.cliproxyapi?.version).toBeUndefined();
  });
});

// SEC-09: a checksum from the same release as the binary is not trust; only a hash this app ships installs silently.
describe('EngineManager pinned hashes (SEC-09)', () => {
  const pinned = (asset: string, sha256: string): PinTable => ({ cliproxyapi: { 'v9.9.9': { [platformKey()]: { asset, sha256 } } } });
  const plain = (name: string, body: Buffer, extra: object = {}) => ({ tag_name: 'v9.9.9', assets: [{ name, browser_download_url: `https://dl.example/${name}`, size: body.length, ...extra }] });

  it('reads the pins from bundled.json: its version, per platform, by the asset in the url', () => {
    expect(pinFor(PINS, 'cliproxyapi', 'v8.0.45', 'darwin-arm64')).toEqual({ asset: 'CLIProxyAPI_8.0.45_darwin_aarch64.tar.gz', sha256: '30a9cacbeada0a80ad1f40c2c25015244b7f4fbca8c3cc42af3c4e6ff5d2fbac' });
    expect(pinFor(PINS, 'magpie', 'v0.1.1803', 'win32-x64')?.asset).toBe('magpie-cli-windows-amd64.exe');
    expect(pinFor(PINS, 'cliproxyapi', 'v8.0.44', 'darwin-arm64')).toBeNull();
    const t = pinsFrom({
      x: { version: 'v1', platforms: { 'linux-x64': { url: 'https://h/a/b.tar.gz', sha256: 'A'.repeat(64) }, 'linux-arm64': { url: 'https://h/c', sha256: 'nope' } },
        pins: { v0: { 'linux-x64': { asset: 'old.tar.gz', sha256: 'b'.repeat(64) } } } },
    });
    expect(t).toEqual({ x: { v1: { 'linux-x64': { asset: 'b.tar.gz', sha256: 'a'.repeat(64) } }, v0: { 'linux-x64': { asset: 'old.tar.gz', sha256: 'b'.repeat(64) } } } });
  });

  it('a file matching the pinned hash installs without asking, as pinned, and the release checksum is not even read', async () => {
    const s = setup((name, body) => ({ tag_name: 'v9.9.9', assets: [
      { name, browser_download_url: `https://dl.example/${name}`, size: body.length },
      { name: 'checksums.txt', browser_download_url: 'https://dl.example/checksums.txt' },
    ] }), {}, pinned(assetName(), sha(Buffer.from('#!/bin/sh\necho fake engine\n'))));
    const st = await s.mgr.install('cliproxyapi');
    expect(st.confirm).toBeUndefined();
    expect(st).toMatchObject({ installed: true, version: 'v9.9.9', verified: 'pinned', sha256: sha(s.body) });
    expect(s.urls).not.toContain('https://dl.example/checksums.txt');
  });

  it('a file that differs from the pinned hash is refused, even when the release digest agrees and the user "confirmed" it', async () => {
    const s = setup((name, body) => plain(name, body, { digest: `sha256:${sha(body)}` }), {}, pinned(assetName(), 'c'.repeat(64)));
    await expect(s.mgr.install('cliproxyapi', undefined, { allowUnverified: true, sha256: sha(s.body) })).rejects.toThrow(/SHA-256|校验/);
    expect(s.state.cliproxyapi?.version).toBeUndefined();
  });

  it('a pinned version whose release lacks the pinned file stops instead of picking another', async () => {
    const s = setup((name, body) => plain(name, body), {}, pinned('CLIProxyAPI_9.9.9_other.tar.gz', 'c'.repeat(64)));
    await expect(s.mgr.install('cliproxyapi')).rejects.toThrow(/CLIProxyAPI_9\.9\.9_other/);
    expect(s.urls.some((u) => u.startsWith('https://dl.example/'))).toBe(false);
  });

  it('no pin: a matching release digest still asks, shows that it matches, and installs only the confirmed hash', async () => {
    const s = setup((name, body) => plain(name, body, { digest: `sha256:${sha(body)}` }), {}, {});
    const asked = await s.mgr.install('cliproxyapi');
    expect(asked.confirm).toEqual({ version: 'v9.9.9', asset: s.name, sha256: sha(s.body), releaseSha256: sha(s.body) });
    expect(asked.installed).toBe(false);
    // allowUnverified alone is not consent
    const blanket = await s.mgr.install('cliproxyapi', undefined, { allowUnverified: true });
    expect(blanket.confirm?.sha256).toBe(sha(s.body));
    expect(s.state.cliproxyapi?.version).toBeUndefined();
    const done = await s.mgr.install('cliproxyapi', undefined, { allowUnverified: true, sha256: sha(s.body).toUpperCase() });
    expect(done).toMatchObject({ installed: true, verified: 'release', sha256: sha(s.body) });
    expect(done.warnings.length).toBeGreaterThan(0);
  });

  it('a build recorded as "release" before SEC-09 (never confirmed) is asked about again on reinstall', async () => {
    const s = setup((name, body) => plain(name, body, { digest: `sha256:${sha(body)}` }), {}, {});
    s.state.cliproxyapi = { builds: { 'v9.9.9': { entry: 'x', sha256: sha(s.body), verified: 'release', asset: s.name, at: 1 } } };
    expect((await s.mgr.install('cliproxyapi')).confirm?.sha256).toBe(sha(s.body));
  });

  it('engines.start on an engine that is not installed answers with the hash to confirm instead of installing', async () => {
    const s = setup((name, body) => plain(name, body), {}, {});
    const st = await s.mgr.start('cliproxyapi');
    expect(st.confirm?.sha256).toBe(sha(s.body));
    expect(st.installed).toBe(false);
    expect(st.running).toBe(false);
  });

  it('the WS handler passes allowUnverified on only with a well-formed hash', async () => {
    const calls: any[] = [];
    const svc: any = { install: async (...a: any[]) => { calls.push(a); return {}; }, upgrade: async (...a: any[]) => { calls.push(a); return {}; } };
    await handleEngineRequest(svc, { kind: 'engines.install', id: 'magpie', allowUnverified: true });
    await handleEngineRequest(svc, { kind: 'engines.install', id: 'magpie', allowUnverified: true, sha256: 'xyz' });
    await handleEngineRequest(svc, { kind: 'engines.upgrade', id: 'magpie', allowUnverified: true, sha256: 'D'.repeat(64) });
    expect(calls).toEqual([['magpie', undefined, {}], ['magpie', undefined, {}], ['magpie', { allowUnverified: true, sha256: 'd'.repeat(64) }]]);
  });
});
