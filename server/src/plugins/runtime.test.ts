import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseManifest } from './manifest';
import { BOOTSTRAP, childArgs, childEnv, permissionFlag, PluginRunner, withResolved } from './runtime';

const manifest = (extra: Record<string, unknown> = {}) => parseManifest({ id: 'probe', main: 'index.js', hooks: ['source-provider'], ...extra });

describe('child command line and environment', () => {
  it('limits reads / writes, grants processes / workers only when declared, caps the heap', () => {
    const m = manifest();
    const a = childArgs({ flag: '--permission', read: ['/p', '/p/*'], write: ['/d', '/d/*'], manifest: m, entry: '/p/index.js' });
    expect(a).toEqual(['--permission', '--allow-fs-read=/p', '--allow-fs-read=/p/*', '--allow-fs-write=/d', '--allow-fs-write=/d/*', '--max-old-space-size=256', '-e', BOOTSTRAP, '--', '/p/index.js']);
    const g = childArgs({ flag: '--permission', read: [], write: [], manifest: manifest({ permissions: { childProcess: true, workers: true }, maxMemoryMb: 64 }), entry: 'e' });
    expect(g).toContain('--allow-child-process');
    expect(g).toContain('--allow-worker');
    expect(g).toContain('--max-old-space-size=64');
    // without the permission model: still the heap cap, never an --allow flag; the bootstrap is always inline
    expect(childArgs({ flag: null, read: ['/p'], write: ['/d'], manifest: m, entry: 'e' })).toEqual(['--max-old-space-size=256', '-e', BOOTSTRAP, '--', 'e']);
  });

  it('manifest: grants must be booleans; memory within bounds', () => {
    expect(() => manifest({ permissions: { childProcess: 'yes' } })).toThrow();
    expect(() => manifest({ maxMemoryMb: 4096 })).toThrow();
    expect(manifest({ permissions: {} }).permissions.childProcess).toBeUndefined();
  });

  it('a minimal environment: no keys, no PATH unless it may start programs', () => {
    const from = { SystemRoot: 'C:\\Windows', PATH: '/bin', ANTHROPIC_API_KEY: 'k', CLAUDE_WEB_TOKEN: 't', HTTPS_PROXY: 'http://u:p@x' } as NodeJS.ProcessEnv;
    const e = childEnv(manifest(), '/data/probe', from);
    expect(e).toMatchObject({ SystemRoot: 'C:\\Windows', CW_PLUGIN_ID: 'probe', CW_PLUGIN_DATA: '/data/probe' });
    expect(e.PATH).toBeUndefined();
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.CLAUDE_WEB_TOKEN).toBeUndefined();
    expect(e.HTTPS_PROXY).toBeUndefined();
    expect(e.CW_PLUGIN_ALLOW).toBeUndefined();
    const g = childEnv(manifest({ permissions: { childProcess: true } }), undefined, from);
    expect(g.PATH).toBe('/bin');
    expect(g.CW_PLUGIN_ALLOW).toBe('child_process');
    expect(g.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe.runIf(!!permissionFlag() && !process.versions.electron)('a real child under the permission model', () => {
  let root = '';
  let pluginDir = '';
  let dataDir = '';
  let outside = '';
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-plugin-rt-'));
    pluginDir = path.join(root, 'plugins', 'probe');
    dataDir = path.join(root, 'plugins', '.data', 'probe');
    outside = path.join(root, 'outside.txt');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(outside, 'private');
    fs.writeFileSync(path.join(pluginDir, 'index.js'), [
      "const fs = require('fs'); const path = require('path');",
      'const tryIt = (f) => { try { return String(f()); } catch (e) { return "denied:" + (e.code || e.message); } };',
      'exports.sources = async (p, host) => { p.host = host; return {',
      '  writeData: tryIt(() => { fs.writeFileSync(path.join(process.env.CW_PLUGIN_DATA, "x.txt"), "ok"); return fs.readFileSync(path.join(process.env.CW_PLUGIN_DATA, "x.txt"), "utf8"); }),',
      '  writeOwn: tryIt(() => fs.writeFileSync(path.join(__dirname, "hack.js"), "x")),',
      '  readOutside: tryIt(() => fs.readFileSync(p.outside, "utf8")),',
      '  writeOutside: tryIt(() => fs.writeFileSync(p.outside, "x")),',
      "  childProcess: tryIt(() => require('child_process')),",
      "  worker: tryIt(() => require('worker_threads')),",
      '  metadata: await p.host.fetch("https://169.254.169.254/latest/meta-data").then((r) => "status:" + r.status, (e) => "denied:" + e.message),',
      '  envKeys: Object.keys(process.env).filter((k) => /KEY|TOKEN|PROXY|ANTHROPIC|CLAUDE/i.test(k)).join(","),',
      '}; };',
    ].join('\n'));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  it('writes only to its data folder; reads nothing outside; no processes / workers', async () => {
    const runner = new PluginRunner(pluginDir, manifest({ permissions: { network: ['*'] } }), { dataDir, secret: async () => undefined });
    try {
      const r = await runner.call<Record<string, string>>('source-provider', { outside });
      expect(r.writeData).toBe('ok');
      expect(r.writeOwn).toMatch(/^denied:/);
      expect(r.readOutside).toMatch(/^denied:/);
      expect(r.writeOutside).toMatch(/^denied:/);
      expect(r.childProcess).toMatch(/^denied:/);
      expect(r.worker).toMatch(/^denied:/);
      expect(r.envKeys).toBe('');
      expect(r.metadata).toMatch(/^denied:.*169\.254\.169\.254/);
      expect(fs.readFileSync(outside, 'utf8')).toBe('private');
    } finally {
      const child = (runner as unknown as { child: import('node:child_process').ChildProcess | null }).child;
      const gone = child && child.exitCode === null ? new Promise((r) => child.once('exit', r)) : null;
      runner.stop();
      await gone;
    }
  }, 45_000); // above the runner's own 10 s start + 10 s call limits: a loaded machine fails with its reason, not a test timeout

  // macOS: os.tmpdir() is /var/folders/…, a symlink to /private/var/folders/…; Node's permission model compares
  // resolved paths, so allow-paths given only through the link denied the plugin its own entry file (it exited 1)
  it('the same, with its folders reached through a symlink / junction', async () => {
    const link = `${root}-link`;
    fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    const runner = new PluginRunner(path.join(link, 'plugins', 'probe'), manifest({ permissions: { network: ['*'] } }), { dataDir: path.join(link, 'plugins', '.data', 'probe-link'), secret: async () => undefined });
    try {
      const r = await runner.call<Record<string, string>>('source-provider', { outside: path.join(link, 'outside.txt') });
      expect(r.writeData).toBe('ok');
      expect(r.writeOwn).toMatch(/^denied:/);
      expect(r.readOutside).toMatch(/^denied:/);
      expect(r.writeOutside).toMatch(/^denied:/);
    } finally {
      const child = (runner as unknown as { child: import('node:child_process').ChildProcess | null }).child;
      const gone = child && child.exitCode === null ? new Promise((r) => child.once('exit', r)) : null;
      runner.stop();
      await gone;
      fs.rmSync(link, { recursive: false, force: true });
    }
  }, 45_000);
});

describe('withResolved', () => {
  it('adds the resolved form of a path under a link, also for a path that does not exist yet', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-resolve-'));
    const link = `${real}-link`;
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const realReal = fs.realpathSync.native(real);
      expect(withResolved(path.join(link, 'a'))).toEqual([path.join(link, 'a'), path.join(realReal, 'a')]);
      expect(withResolved(path.join(link, 'not', 'yet', '*'))).toEqual([path.join(link, 'not', 'yet', '*'), path.join(realReal, 'not', 'yet', '*')]);
      expect(withResolved(realReal)).toEqual([realReal]);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

// SEC-02: net.Socket reached without require('net') — tty's streams extend it, so its connect() opened a TCP socket
describe('a real child cannot open sockets through a side door', () => {
  let root = '';
  let server: import('node:net').Server;
  let port = 0;
  const seen: string[] = [];
  beforeAll(async () => {
    const net = await import('node:net');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-plugin-net-'));
    fs.writeFileSync(path.join(root, 'index.js'), [
      'const tryIt = async (f) => { try { const s = f(); if (s && s.on) s.on("error", () => {}); await new Promise((r) => setTimeout(r, 300)); return "ran"; } catch (e) { return "denied:" + (e.code || e.message); } };',
      "const tty = require('tty');",
      'const Socket = Object.getPrototypeOf(tty.ReadStream);',
      'exports.sources = async (p) => ({',
      '  ttyReadProto: await tryIt(() => new (Object.getPrototypeOf(tty.ReadStream.prototype).constructor)().connect(p.port, "127.0.0.1")),',
      '  ttyWriteProto: await tryIt(() => new (Object.getPrototypeOf(tty.WriteStream.prototype).constructor)().connect(p.port, "127.0.0.1")),',
      '  socketCtor: await tryIt(() => new Socket().connect({ port: p.port, host: "127.0.0.1" })),',
      '  stdinCtor: await tryIt(() => { const C = process.stdin && process.stdin.constructor; return C && C.prototype.connect ? new C().connect(p.port, "127.0.0.1") : null; }),',
      '});',
    ].join('\n'));
    server = net.createServer((s) => { seen.push('connection'); s.destroy(); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as import('node:net').AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('net.Socket via tty / stdin connects nowhere', async () => {
    const runner = new PluginRunner(root, manifest(), { unrestrictedAllowed: () => true, secret: async () => undefined });
    try {
      const r = await runner.call<Record<string, string>>('source-provider', { port });
      expect(r.ttyReadProto).toMatch(/^denied:/);
      expect(r.ttyWriteProto).toMatch(/^denied:/);
      expect(r.socketCtor).toMatch(/^denied:/);
      await new Promise((res) => setTimeout(res, 300));
      expect(seen).toEqual([]);
    } finally {
      const child = (runner as unknown as { child: import('node:child_process').ChildProcess | null }).child;
      const gone = child && child.exitCode === null ? new Promise((res) => child.once('exit', res)) : null;
      runner.stop();
      await gone;
    }
  }, 45_000);
});
