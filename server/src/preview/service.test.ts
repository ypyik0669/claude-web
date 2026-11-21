import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PreviewService, portFree } from './service.js';

const SERVER_JS = `const http = require('http');
const port = Number(process.env.PORT);
http.createServer((q, s) => s.end('hello ' + process.env.GREETING)).listen(port, '127.0.0.1', () => console.log('listening on ' + port));`;

const roots: string[] = [];
const svc = new PreviewService({ waitMs: 15_000 });
afterAll(async () => { await svc.stopAll(); for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const project = (configs: unknown[]) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-preview-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'server.js'), SERVER_JS);
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'launch.json'), JSON.stringify({ configurations: configs }));
  return root;
};
const freePort = () => new Promise<number>((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

describe('preview servers', () => {
  it('starts a configuration, waits for its port, keeps its output, stops it', async () => {
    const port = await freePort();
    const root = project([{ name: 'web', program: 'server.js', port, env: { GREETING: 'preview' } }]);
    const r = await svc.start(root);
    expect(r).toMatchObject({ name: 'web', port, url: `http://localhost:${port}` });
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('hello preview');
    expect((await svc.start(root, 'web')).already).toBe(true);
    expect(svc.list(root)).toEqual({ configs: [{ name: 'web', port, command: 'node server.js', url: `http://localhost:${port}` }] });
    // another spelling of the same folder (Windows: case) is the same project
    if (process.platform === 'win32') expect((await svc.start(root.toUpperCase(), 'web')).already).toBe(true);
    expect(svc.logs(root)).toContain(`listening on ${port}`);
    expect(await svc.stop(root, 'web')).toBe(true);
    await expect.poll(() => portFree(port), { timeout: 5000 }).toBe(true);
  }, 30_000);

  it('a taken port: autoPort picks another (as PORT); unset says how to fix it; false refuses', async () => {
    const port = await freePort();
    const holder = net.createServer().listen(port, '127.0.0.1');
    await new Promise((res) => holder.once('listening', res));
    try {
      const auto = project([{ name: 'a', program: 'server.js', port, autoPort: true }]);
      const r = await svc.start(auto);
      expect(r.port).not.toBe(port);
      await svc.stop(auto);
      await expect(svc.start(project([{ name: 'u', program: 'server.js', port }]))).rejects.toThrow(/autoPort": true/);
      await expect(svc.start(project([{ name: 'f', program: 'server.js', port, autoPort: false }]))).rejects.toThrow(/autoPort: false/);
    } finally { holder.close(); }
  }, 30_000);

  it('a port browsers refuse (6000): refused saying why; with autoPort a free one is taken', async () => {
    await expect(svc.start(project([{ name: 'x', program: 'server.js', port: 6000 }]))).rejects.toThrow(/ERR_UNSAFE_PORT/);
    const auto = project([{ name: 'y', program: 'server.js', port: 6000, autoPort: true }]);
    const r = await svc.start(auto);
    expect(r.port).not.toBe(6000);
    expect(r.url).toBe(`http://localhost:${r.port}`);
    await svc.stop(auto);
  }, 30_000);

  it('no launch.json, an unknown name, a server that dies: each says so', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-preview-'));
    roots.push(bare);
    await expect(svc.start(bare)).rejects.toThrow(/No \.claude\/launch\.json/);
    const root = project([{ name: 'web', program: 'server.js', port: await freePort() }]);
    await expect(svc.start(root, 'api')).rejects.toThrow(/No configuration "api"/);
    fs.writeFileSync(path.join(root, 'boom.js'), "console.error('cannot start'); process.exit(3);");
    const dies = project([{ name: 'boom', program: 'boom.js', port: await freePort() }]);
    fs.copyFileSync(path.join(root, 'boom.js'), path.join(dies, 'boom.js'));
    await expect(svc.start(dies)).rejects.toThrow(/exited \(code 3\)[\s\S]*cannot start/);
  }, 30_000);

  it('a port taken on ::1 or the wildcard counts as taken', async () => {
    const port = await freePort();
    const v6 = net.createServer();
    const ok = await new Promise<boolean>((res) => { v6.once('error', () => res(false)); v6.listen(port, '::1', () => res(true)); });
    if (!ok) return; // no IPv6 here
    try { expect(await portFree(port)).toBe(false); } finally { v6.close(); }
  });

  it('a server that listens on ::1 only (Vite on localhost) is seen when its port opens', async () => {
    const port = await freePort();
    const probe = net.createServer();
    const v6 = await new Promise<boolean>((res) => { probe.once('error', () => res(false)); probe.listen(0, '::1', () => res(true)); });
    probe.close();
    if (!v6) return;
    const root = project([{ name: 'v6', program: 'v6.js', port }]);
    fs.writeFileSync(path.join(root, 'v6.js'), "require('http').createServer((q,s)=>s.end('v6')).listen(Number(process.env.PORT), '::1')");
    expect((await svc.start(root)).port).toBe(port);
    await svc.stop(root);
  }, 30_000);

  it('two starts at once: one server, the second is told it is already running', async () => {
    const root = project([{ name: 'web', program: 'server.js', port: await freePort(), autoPort: true }]);
    const [a, b] = await Promise.all([svc.start(root), svc.start(root)]);
    expect(a.port).toBe(b.port);
    expect([a.already, b.already].filter(Boolean)).toHaveLength(1);
    await svc.stop(root);
    await expect.poll(() => portFree(a.port), { timeout: 5000 }).toBe(true);
  }, 30_000);

  it('a cwd outside the project is refused', async () => {
    const root = project([{ name: 'out', program: 'server.js', port: await freePort(), cwd: '../..' }]);
    await expect(svc.start(root)).rejects.toThrow(/inside the project/);
  });

  it.runIf(process.platform === 'win32')('Windows: a .cmd program (npm-style) starts, and an & in its arguments stays an argument', async () => {
    const port = await freePort();
    const root = project([{ name: 'cmd', runtimeExecutable: 'run.cmd', runtimeArgs: ['a&echo INJECTED>injected.txt'], port }]);
    fs.writeFileSync(path.join(root, 'run.cmd'), '@echo off\r\nnode "%~dp0server.js" %*\r\n');
    const prevPath = process.env.PATH;
    process.env.PATH = `${root};${prevPath}`;
    try {
      expect((await svc.start(root)).port).toBe(port);
      expect(fs.existsSync(path.join(root, 'injected.txt'))).toBe(false);
      await svc.stop(root);
    } finally { process.env.PATH = prevPath; }
  }, 30_000);
});

describe('the browser page lists them', () => {
  it('no launch.json → null; one → its configurations, none running', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-preview-'));
    roots.push(bare);
    expect(svc.list(bare)).toBeNull();
    const root = project([{ name: 'web', program: 'server.js', port: 4321 }, { name: 'docs', program: 'server.js', port: 4322 }]);
    expect(svc.list(root)).toEqual({ configs: [{ name: 'web', port: 4321, command: 'node server.js' }, { name: 'docs', port: 4322, command: 'node server.js' }] });
  });
});
