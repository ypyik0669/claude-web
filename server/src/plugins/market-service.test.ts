import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeZip } from '../import/zip.js';
import { MetaStore } from '../meta/store.js';
import { PluginMarketService, normalizeMarketConfig } from './market-service.js';
import { parseSignedMarketCatalog, sha256Hex, verifyArchiveSignature } from './market.js';
import { PluginService } from './service.js';

const manifest = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  id,
  name: 'Hello market',
  version: '1.0.0',
  main: 'index.js',
  hooks: [],
  permissions: {},
  ...extra,
});

const entry = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: 'Hello market',
  author: 'Example',
  description: 'A tiny test plugin',
  categories: ['tool'],
  version: '1.0.0',
  downloads: 1,
  url: 'https://example.com/plugin.zip',
  kind: 'executable',
  hooks: [],
  permissions: {},
  ...overrides,
});

let tmp = '';
let pluginsDir = '';
let meta: MetaStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-plugin-market-'));
  pluginsDir = path.join(tmp, 'plugins');
  meta = new MetaStore(path.join(tmp, 'meta.json'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey,
    pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    b64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

const signCatalog = (entries: unknown[], privateKey: crypto.KeyObject) =>
  crypto.sign(null, Buffer.from(JSON.stringify(entries), 'utf8'), privateKey).toString('base64');

async function writeZip(entries: Record<string, string | Buffer>): Promise<string> {
  const file = path.join(tmp, `pkg-${Math.random().toString(36).slice(2)}.zip`);
  await fs.writeFile(file, makeZip(entries));
  return file;
}

describe('plugin market catalog signatures', () => {
  it('verifies an Ed25519 signature over the entries (PEM or base64 SPKI)', () => {
    const k = keys();
    const entries = [entry('com.example.one', { sha256: 'c'.repeat(64) })];
    const body = JSON.stringify({ entries, signature: signCatalog(entries, k.privateKey) });
    expect(parseSignedMarketCatalog(body, k.pem).signed).toBe(true);
    expect(parseSignedMarketCatalog(body, k.b64).signed).toBe(true);
    expect(parseSignedMarketCatalog(body, k.pem).catalog.entries[0]?.id).toBe('com.example.one');
  });

  it('refuses a missing or wrong signature when a public key is configured', () => {
    const k = keys();
    const entries = [entry('com.example.one')];
    const sig = signCatalog(entries, k.privateKey);
    expect(() => parseSignedMarketCatalog(JSON.stringify({ entries }), k.pem)).toThrow(/没有签名/);
    expect(() => parseSignedMarketCatalog(JSON.stringify({ entries: [...entries, entry('com.example.two')], signature: sig }), k.pem)).toThrow(/签名不对/);
    const other = keys();
    expect(() => parseSignedMarketCatalog(JSON.stringify({ entries, signature: signCatalog(entries, other.privateKey) }), k.pem)).toThrow(/签名不对/);
  });

  it('accepts an unsigned catalog only when no key is configured, and drops bad entries', () => {
    const r = parseSignedMarketCatalog(JSON.stringify({ entries: [entry('ok'), { ...entry('bad'), url: 'http://example.com/x' }] }));
    expect(r.signed).toBe(false);
    expect(r.catalog.entries.map((e) => e.id)).toEqual(['ok']);
    expect(r.catalog.errors).toHaveLength(1);
  });

  it('validates the market setting (https URL, Ed25519 key)', () => {
    const k = keys();
    expect(normalizeMarketConfig({ url: 'https://example.com/market.json', publicKey: k.pem })).toMatchObject({ url: 'https://example.com/market.json' });
    expect(() => normalizeMarketConfig({ url: 'http://example.com/market.json' })).toThrow(/https/);
    expect(() => normalizeMarketConfig({ url: 'https://user:pass@example.com/market.json' })).toThrow(/https/);
    expect(() => normalizeMarketConfig({ publicKey: 'not-a-key' })).toThrow(/Ed25519/);
  });

  it('verifies an archive signature against the exact bytes', () => {
    const k = keys();
    const bytes = Buffer.from('package bytes');
    const sig = crypto.sign(null, bytes, k.privateKey).toString('base64');
    expect(verifyArchiveSignature(bytes, sig, k.pem)).toBe(true);
    expect(verifyArchiveSignature(Buffer.from('tampered'), sig, k.pem)).toBe(false);
  });
});

describe('plugin market cache and install', () => {
  it('refreshes a signed catalog, caches it on disk and installs an entry by id', async () => {
    const k = keys();
    const zip = makeZip({ 'plugin.json': manifest('com.example.market'), 'index.js': 'module.exports = {};' });
    const entries = [entry('com.example.market', { sha256: sha256Hex(zip), signature: crypto.sign(null, zip, k.privateKey).toString('base64') })];
    const body = JSON.stringify({ entries, signature: signCatalog(entries, k.privateKey) });
    const calls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://example.com/market.json') return new Response(body, { status: 200 });
      if (url === 'https://example.com/plugin.zip') return new Response(zip, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: fakeFetch });
    await svc.setConfig({ url: 'https://example.com/market.json', publicKey: k.pem });
    const refreshed = await svc.refresh();
    expect(refreshed.signed).toBe(true);
    expect(refreshed.entries.map((e) => e.id)).toEqual(['com.example.market']);

    // a new service instance reads the disk cache (no network)
    const cached = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: fakeFetch });
    const status = await cached.status();
    expect(status.entries.map((e) => e.id)).toEqual(['com.example.market']);
    expect(status.fetchedAt).toBeTypeOf('number');

    expect(status.entries[0]?.verified).toBe(true);
    // verified by the configured key: no acknowledgement needed
    const installed = await cached.install({ id: 'com.example.market' });
    expect(installed).toMatchObject({ id: 'com.example.market', kind: 'executable', file: 'com.example.market', verified: true });
    const files = await fs.readdir(path.join(pluginsDir, 'com.example.market'));
    expect(files.sort()).toEqual(['index.js', 'plugin.json']);
    expect(calls).toEqual(['https://example.com/market.json', 'https://example.com/plugin.zip']);
  });

  it('keeps the last good cache when a refresh fails', async () => {
    const entries = [entry('com.example.cached')];
    const body = JSON.stringify({ entries });
    let fail = false;
    const fakeFetch = (async () => {
      if (fail) throw new Error('offline');
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: fakeFetch });
    await svc.setConfig({ url: 'https://example.com/market.json' });
    await svc.refresh();
    fail = true;
    await expect(svc.refresh()).rejects.toThrow(/offline/);
    expect((await svc.status()).entries.map((e) => e.id)).toEqual(['com.example.cached']);
  });

  it('netguard: a catalog on a private address is refused; a redirect to cloud metadata is never followed', async () => {
    const answers: Record<string, string> = { 'market.example.com': '93.184.216.34', 'intranet.example.com': '10.0.0.5' };
    const lookup = async (host: string) => [{ address: answers[host] ?? '169.254.169.254', family: 4 }];
    const calls: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: 'https://metadata.example.com/latest' } });
    }) as typeof fetch;
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: fakeFetch, lookup });
    await svc.setConfig({ url: 'https://intranet.example.com/market.json' });
    await expect(svc.refresh()).rejects.toThrow();
    expect(calls).toEqual([]);
    await svc.setConfig({ url: 'https://market.example.com/market.json' });
    await expect(svc.refresh()).rejects.toThrow();
    expect(calls).toEqual(['https://market.example.com/market.json']);
  });

  it('installs a declarative JSON package (data only)', async () => {
    const file = path.join(tmp, 'declarative.json');
    const json = JSON.stringify({
      id: 'com.example.decl',
      name: 'Declarative',
      sources: [{ id: 'src', name: 'Src', endpoint: 'https://api.example.com', protocol: 'openai', auth: 'none', models: [] }],
    });
    await fs.writeFile(file, json);
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1' });
    const installed = await svc.install({ path: file, acknowledgeUnverified: true });
    expect(installed).toMatchObject({ id: 'com.example.decl', kind: 'declarative', file: 'com.example.decl.json' });
    expect(JSON.parse(await fs.readFile(path.join(pluginsDir, 'com.example.decl.json'), 'utf8')).id).toBe('com.example.decl');
  });
});

describe('plugin archive extraction safety', () => {
  it('refuses a path traversal entry and writes nothing outside the plugins directory', async () => {
    const evil = path.resolve(pluginsDir, '..', 'evil.txt');
    const file = await writeZip({ '../evil.txt': 'pwned', 'plugin.json': manifest('com.example.evil'), 'index.js': '' });
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1' });
    await expect(svc.install({ path: file, acknowledgeUnverified: true })).rejects.toThrow(/不安全的路径/);
    await expect(fs.access(evil)).rejects.toThrow();
    await expect(fs.access(path.join(pluginsDir, 'com.example.evil'))).rejects.toThrow();
  });

  it('refuses absolute paths and drive letters', async () => {
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1' });
    for (const bad of ['/tmp/evil.txt', 'C:\\Windows\\evil.txt', '..\\evil.txt']) {
      const file = await writeZip({ [bad]: 'x', 'plugin.json': manifest('com.example.bad') });
      await expect(svc.install({ path: file, acknowledgeUnverified: true })).rejects.toThrow(/不安全的路径/);
    }
  });

  it('refuses a manifest id that could escape or hide the plugin folder', async () => {
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1' });
    for (const id of ['..', '.', '.hidden']) {
      const file = await writeZip({ 'plugin.json': manifest(id), 'index.js': '' });
      await expect(svc.install({ path: file, acknowledgeUnverified: true })).rejects.toThrow(/id/);
    }
  });

  it('refuses a SHA-256 mismatch before extracting anything', async () => {
    const file = await writeZip({ 'plugin.json': manifest('com.example.hash'), 'index.js': '' });
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1' });
    await expect(svc.install({ path: file, sha256: 'a'.repeat(64), acknowledgeUnverified: true })).rejects.toThrow(/校验值不对/);
    await expect(fs.access(path.join(pluginsDir, 'com.example.hash'))).rejects.toThrow();
  });
});

describe('installing through PluginService', () => {
  it('installs a zip fixture, reloads the list, and still requires permission approval to enable', async () => {
    const zip = await writeZip({
      'repo-main/plugin.json': manifest('com.example.reload'),
      'repo-main/index.js': 'module.exports = { requestBefore: (x) => x };',
      'repo-main/lib/helper.js': 'module.exports = 1;',
    });
    const svc = new PluginService({ meta, dir: pluginsDir, appVersion: '0.4.1' });
    await svc.init();
    const res = await svc.installPlugin({ path: zip, acknowledgeUnverified: true });
    expect(res.installed).toMatchObject({ id: 'com.example.reload', kind: 'executable', file: 'com.example.reload' });
    const view = res.plugins.find((p) => p.id === 'com.example.reload');
    expect(view).toMatchObject({ kind: 'executable', enabled: false, approved: false });
    expect(await fs.readFile(path.join(pluginsDir, 'com.example.reload', 'plugin.json'), 'utf8')).toContain('com.example.reload');

    // an explicit reload finds it again
    await svc.reload();
    expect(svc.list().plugins.map((p) => p.id)).toContain('com.example.reload');
    await expect(svc.enable('com.example.reload')).rejects.toThrow(/确认/);
    await expect(svc.installPlugin({ path: zip, acknowledgeUnverified: true })).rejects.toThrow(/已经安装/);
  });

  it('installs a catalog entry by id through PluginService and reloads the installed list', async () => {
    const zip = makeZip({ 'plugin.json': manifest('com.example.byid'), 'index.js': 'module.exports = {};' });
    const body = JSON.stringify({ entries: [entry('com.example.byid', { sha256: sha256Hex(zip) })] });
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://example.com/market.json') return new Response(body, { status: 200 });
      if (url === 'https://example.com/plugin.zip') return new Response(zip, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const svc = new PluginService({ meta, dir: pluginsDir, appVersion: '0.4.1', fetch: fakeFetch });
    await svc.init();
    await svc.setMarketConfig({ url: 'https://example.com/market.json' });
    await svc.refreshMarket();
    await expect(svc.installPlugin({ id: 'com.example.byid' })).rejects.toThrow(/可信公钥/);
    const res = await svc.installPlugin({ id: 'com.example.byid', acknowledgeUnverified: true });
    expect(res.installed).toMatchObject({ id: 'com.example.byid', kind: 'executable', verified: false, sha256: sha256Hex(zip) });
    expect(res.plugins.find((p) => p.id === 'com.example.byid')).toMatchObject({ enabled: false, approved: false });
  });
});

describe('unverified packages (SEC-08)', () => {
  const marketFetch = (body: string, pkg: Buffer, calls: string[] = []) => (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === 'https://example.com/market.json') return new Response(body, { status: 200 });
    if (url.split('?')[0] === 'https://example.com/plugin.zip') return new Response(pkg, { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;

  it('marks every entry of a catalog without a key unverified and refuses to install without an acknowledgement', async () => {
    const zip = makeZip({ 'plugin.json': manifest('com.example.unsigned'), 'index.js': 'module.exports = {};' });
    const k = keys();
    // a signature on the entry cannot be checked without a key: still unverified
    const entries = [entry('com.example.unsigned', { signature: crypto.sign(null, zip, k.privateKey).toString('base64') })];
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: marketFetch(JSON.stringify({ entries }), zip) });
    await svc.setConfig({ url: 'https://example.com/market.json' });
    const st = await svc.refresh();
    expect(st.signed).toBe(false);
    expect(st.entries[0]?.verified).toBe(false);
    const check = await svc.check({ id: 'com.example.unsigned' });
    expect(check).toMatchObject({ verified: false, reason: 'unsigned-catalog', sha256: sha256Hex(zip), size: zip.length, kind: 'executable', id: 'com.example.unsigned' });
    await expect(fs.access(path.join(pluginsDir, 'com.example.unsigned'))).rejects.toThrow();
    await expect(svc.install({ id: 'com.example.unsigned' })).rejects.toThrow(/可信公钥/);
    await expect(svc.install({ id: 'com.example.unsigned', acknowledgeUnverified: false })).rejects.toThrow(/可信公钥/);
    await expect(fs.access(path.join(pluginsDir, 'com.example.unsigned'))).rejects.toThrow();
    const installed = await svc.install({ id: 'com.example.unsigned', acknowledgeUnverified: true, sha256: check.sha256 });
    expect(installed).toMatchObject({ id: 'com.example.unsigned', verified: false, sha256: check.sha256 });
  });

  it('under a configured key: drops entries without a signature or sha256, and refuses a bad entry signature', async () => {
    const k = keys();
    const zip = makeZip({ 'plugin.json': manifest('com.example.signed'), 'index.js': 'module.exports = {};' });
    const other = keys();
    const entries = [
      entry('com.example.bare'),
      entry('com.example.signed', { signature: crypto.sign(null, zip, other.privateKey).toString('base64') }),
    ];
    const parsed = parseSignedMarketCatalog(JSON.stringify({ entries, signature: signCatalog(entries, k.privateKey) }), k.pem);
    expect(parsed.catalog.entries.map((e) => e.id)).toEqual(['com.example.signed']);
    expect(parsed.catalog.errors).toEqual([{ index: 0, message: expect.stringMatching(/没有签名或校验值/) }]);

    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: marketFetch(JSON.stringify({ entries, signature: signCatalog(entries, k.privateKey) }), zip) });
    await svc.setConfig({ url: 'https://example.com/market.json', publicKey: k.pem });
    await svc.refresh();
    // an acknowledgement does not override a signature that fails under the key
    await expect(svc.install({ id: 'com.example.signed', acknowledgeUnverified: true })).rejects.toThrow(/签名不对/);
    await expect(svc.check({ id: 'com.example.signed' })).rejects.toThrow(/签名不对/);
    await expect(fs.access(path.join(pluginsDir, 'com.example.signed'))).rejects.toThrow();
  });

  it('a signed catalog whose entry pins only a sha256 is verified; a mismatching download is refused', async () => {
    const k = keys();
    const zip = makeZip({ 'plugin.json': manifest('com.example.pinned'), 'index.js': 'module.exports = {};' });
    const entries = [entry('com.example.pinned', { sha256: sha256Hex(zip) })];
    const body = JSON.stringify({ entries, signature: signCatalog(entries, k.privateKey) });
    const tampered = makeZip({ 'plugin.json': manifest('com.example.pinned'), 'index.js': 'evil();' });
    const bad = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: marketFetch(body, tampered) });
    await bad.setConfig({ url: 'https://example.com/market.json', publicKey: k.pem });
    await bad.refresh();
    await expect(bad.install({ id: 'com.example.pinned', acknowledgeUnverified: true })).rejects.toThrow(/校验值不对/);
    const good = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: marketFetch(body, zip) });
    expect(await good.check({ id: 'com.example.pinned' })).toMatchObject({ verified: true, sha256: sha256Hex(zip) });
    expect((await good.check({ id: 'com.example.pinned' })).reason).toBeUndefined();
    expect(await good.install({ id: 'com.example.pinned' })).toMatchObject({ verified: true });
  });

  it('install from a URL: check reports the sha256, install needs the acknowledgement and enforces an expected sha256', async () => {
    const zip = makeZip({ 'plugin.json': manifest('com.example.url'), 'index.js': 'module.exports = {};' });
    const calls: string[] = [];
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: marketFetch('{}', zip, calls) });
    const check = await svc.check({ url: 'https://example.com/plugin.zip?token=x' });
    expect(check).toMatchObject({ verified: false, reason: 'url', sha256: sha256Hex(zip), source: 'https://example.com/plugin.zip' });
    await expect(svc.install({ url: 'https://example.com/plugin.zip' })).rejects.toThrow(/可信公钥/);
    await expect(svc.install({ url: 'https://example.com/plugin.zip', sha256: 'b'.repeat(64), acknowledgeUnverified: true })).rejects.toThrow(/校验值不对/);
    await expect(svc.install({ url: 'https://example.com/plugin.zip', sha256: 'not-a-hash', acknowledgeUnverified: true })).rejects.toThrow(/校验值不合法/);
    await expect(fs.access(path.join(pluginsDir, 'com.example.url'))).rejects.toThrow();
    const installed = await svc.install({ url: 'https://example.com/plugin.zip', sha256: check.sha256.toUpperCase(), acknowledgeUnverified: true });
    expect(installed).toMatchObject({ id: 'com.example.url', verified: false, sha256: check.sha256 });
  });

  it('an id next to a url does not borrow the catalog entry\'s verification', async () => {
    const k = keys();
    const zip = makeZip({ 'plugin.json': manifest('com.example.mix'), 'index.js': 'module.exports = {};' });
    const entries = [entry('com.example.mix', { sha256: sha256Hex(zip) })];
    const svc = new PluginMarketService({ meta, dir: () => pluginsDir, appVersion: '0.4.1', fetch: marketFetch(JSON.stringify({ entries, signature: signCatalog(entries, k.privateKey) }), zip) });
    await svc.setConfig({ url: 'https://example.com/market.json', publicKey: k.pem });
    await svc.refresh();
    expect(await svc.check({ id: 'com.example.mix', url: 'https://example.com/plugin.zip' })).toMatchObject({ verified: false, reason: 'url' });
    await expect(svc.install({ id: 'com.example.mix', url: 'https://example.com/plugin.zip' })).rejects.toThrow(/可信公钥/);
  });

  it('the request handler only forwards a literal true acknowledgement', async () => {
    const { handlePluginRequest } = await import('./handlers.js');
    const file = await writeZip({ 'plugin.json': manifest('com.example.handler'), 'index.js': 'module.exports = {};' });
    const svc = new PluginService({ meta, dir: pluginsDir, appVersion: '0.4.1' });
    await svc.init();
    const check = await handlePluginRequest(svc, { kind: 'plugins.install.check', path: file }) as { verified: boolean; reason: string };
    expect(check).toMatchObject({ verified: false, reason: 'file' });
    await expect(handlePluginRequest(svc, { kind: 'plugins.install', path: file, acknowledgeUnverified: 'yes' as unknown as boolean })).rejects.toThrow(/可信公钥/);
    await expect(handlePluginRequest(svc, { kind: 'plugins.install', path: file, acknowledgeUnverified: true })).resolves.toMatchObject({ installed: { id: 'com.example.handler', verified: false } });
  });
});
