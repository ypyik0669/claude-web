import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { MetaStore } from '../meta/store.js';
import { GatewayService } from './service.js';

const make = async (members: { accountId?: string; upstreamGroupId?: string; providerId?: string }[]) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gwst-'));
  const meta = new MetaStore(path.join(dir, 'meta.json'));
  await meta.load();
  meta.gatewayGroups().push({ id: 'g', name: 'g', strategy: 'failover', members });
  const kinds: Record<string, string> = { acct_1: 'gemini', acct_2: 'workbuddy', acct_3: 'claude' };
  const upstreams = {
    store: { get: (id: string) => (kinds[id] ? { id, kind: kinds[id] } : undefined) },
    groups: () => [
      { id: 'pool_1', kind: 'gemini', name: 'p', strategy: 'failover', members: [], enabled: true, createdAt: 1 },
      { id: 'pool_2', kind: 'claude', name: 'c', strategy: 'failover', members: [], enabled: true, createdAt: 1 },
    ],
    familyModels: (kind: string) => (kind === 'gemini' ? ['gemini-3.6-flash'] : []),
  };
  return new GatewayService({ meta, member: () => null, upstreams, firstByteMs: 400, nonStreamMs: 3000 } as never);
};

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = http.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close((e) => e ? reject(e) : resolve(port));
  });
});

describe('gateway status: stable loopback endpoint', () => {
  it('keeps the configured loopback port across service instances', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gwlocal-'));
    const meta = new MetaStore(path.join(dir, 'meta.json'));
    await meta.load();
    const port = await freePort();
    meta.gatewayConfig().localPort = port;
    const deps = { meta, member: () => null } as never;
    const first = new GatewayService(deps);
    await first.init();
    await first.setEnabled(true);
    expect(first.status()).toMatchObject({ localPort: port, localRunning: true, localBaseUrl: `http://127.0.0.1:${port}` });
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/api/pair`)).status).toBe(404);
    await first.stop();
    const second = new GatewayService(deps);
    await second.init();
    expect(second.status()).toMatchObject({ localPort: port, localRunning: true, localBaseUrl: `http://127.0.0.1:${port}` });
    await second.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the working listener when a new port cannot start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gwlocal-keep-'));
    const meta = new MetaStore(path.join(dir, 'meta.json'));
    await meta.load();
    const good = await freePort();
    const bad = await freePort();
    meta.gatewayConfig().localPort = good;
    const gw = new GatewayService({ meta, member: () => null } as never);
    await gw.init();
    await gw.setEnabled(true);
    const holder = http.createServer().listen(bad, '127.0.0.1');
    await expect(gw.setLocalPort(bad)).rejects.toThrow('本机地址');
    expect(gw.status()).toMatchObject({ localPort: good, localRunning: true });
    expect(meta.gatewayConfig().localPort).toBe(good);
    expect((await fetch(`http://127.0.0.1:${good}/healthz`)).status).toBe(200);
    // and a failed switch does not poison the next one
    const other = await freePort();
    expect((await gw.setLocalPort(other)).localPort).toBe(other);
    expect((await fetch(`http://127.0.0.1:${other}/healthz`)).status).toBe(200);
    await gw.stop();
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not persist a port that is already occupied', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-gwlocal-conflict-'));
    const meta = new MetaStore(path.join(dir, 'meta.json'));
    await meta.load();
    const port = await freePort();
    const holder = http.createServer().listen(port, '127.0.0.1');
    const gw = new GatewayService({ meta, member: () => null } as never);
    await expect(gw.setLocalPort(port)).rejects.toThrow('本机地址');
    expect(meta.gatewayConfig().localPort).toBeUndefined();
    expect(gw.status().localError).toContain(String(port));
    await gw.stop();
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('gateway status: pool models reach the model menu', () => {
  it('a single sidecar account member is keyed a:<id>', async () => {
    const st = (await make([{ accountId: 'acct_1' }])).status();
    expect(st.poolModels).toEqual({ 'a:acct_1': ['gemini-3.6-flash'] });
  });

  it('a whole pool is keyed u:<id>', async () => {
    const st = (await make([{ upstreamGroupId: 'pool_1' }])).status();
    expect(st.poolModels).toEqual({ 'u:pool_1': ['gemini-3.6-flash'] });
  });
});

describe('syncProfiles: every group is a provider profile', () => {
  it('creates one gateway profile per group, idempotently', async () => {
    const gw = await make([{ accountId: 'acct_1' }]);
    await gw.syncProfiles();
    const meta = (gw as unknown as { deps: { meta: MetaStore } }).deps.meta;
    const list = meta.providers().filter((p) => p.type === 'gateway');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ type: 'gateway', gatewayGroupId: 'g' });
    await gw.syncProfiles();
    expect(meta.providers().filter((p) => p.type === 'gateway')).toHaveLength(1);
  });

  it('a dismissed group is not created again — until an account is added to it', async () => {
    const gw = await make([{ accountId: 'acct_1' }]);
    const meta = (gw as unknown as { deps: { meta: MetaStore } }).deps.meta;
    meta.gatewayConfig().dismissedProfiles = ['g'];
    meta.gatewayConfig().dismissedMembers = { g: ['a:acct_1'] };
    await gw.syncProfiles();
    expect(meta.providers().filter((p) => p.type === 'gateway')).toHaveLength(0);
    // a WorkBuddy account added to it later (user report 2026-11-03): back in the menu, the dismissal forgotten
    meta.gatewayGroups()[0].members.push({ accountId: 'acct_2' });
    await gw.syncProfiles();
    expect(meta.providers().filter((p) => p.type === 'gateway')).toHaveLength(1);
    expect(meta.gatewayConfig().dismissedProfiles).toEqual([]);
  });
  it('a dismissal from before members were recorded: a group with accounts comes back, an empty one stays out', async () => {
    const gw = await make([{ accountId: 'acct_1' }]);
    const meta = (gw as unknown as { deps: { meta: MetaStore } }).deps.meta;
    meta.gatewayConfig().dismissedProfiles = ['g'];
    await gw.syncProfiles();
    expect(meta.providers().filter((p) => p.type === 'gateway')).toHaveLength(1);
    const empty = await make([]);
    const m2 = (empty as unknown as { deps: { meta: MetaStore } }).deps.meta;
    m2.gatewayConfig().dismissedProfiles = ['g'];
    await empty.syncProfiles();
    expect(m2.providers().filter((p) => p.type === 'gateway')).toHaveLength(0);
  });

  it('a removed group takes its auto profile with it', async () => {
    const gw = await make([{ accountId: 'acct_1' }]);
    const meta = (gw as unknown as { deps: { meta: MetaStore } }).deps.meta;
    await gw.syncProfiles();
    expect(meta.providers().some((p) => p.type === 'gateway')).toBe(true);
    await gw.removeGroup('g');
    expect(meta.providers().some((p) => p.type === 'gateway')).toBe(false);
  });
});

describe('heavy prompt notice (a sidecar re-sends everything every turn)', () => {
  it('says it once per conversation, and re-arms after a compact brought it back down', async () => {
    const gw = await make([{ accountId: 'acct_1' }]);
    const heard: { sessionId: string; bytes: number; via: string }[] = [];
    gw.on('promptHeavy', (e: { sessionId: string; bytes: number; via: string }) => heard.push(e));
    const ctx = (sid: string) => ({ req: { headers: { 'x-claude-code-session-id': sid } } });
    const note = (gw as unknown as { noteHeavyPrompt(c: unknown, b: number, via: string): void }).noteHeavyPrompt.bind(gw);
    note(ctx('s1'), 200_000, 'sidecar:gemini');
    note(ctx('s1'), 210_000, 'sidecar:gemini'); // same conversation: not again
    expect(heard).toHaveLength(1);
    expect(heard[0]).toEqual({ sessionId: 's1', bytes: 200_000, via: 'gemini' });
    note(ctx('s2'), 190_000, 'sidecar:workbuddy'); // another conversation gets its own notice, naming its member
    expect(heard).toHaveLength(2);
    expect(heard[1].via).toBe('workbuddy');
    // the caller clears the mark when a request comes back under the limit (the else branch in attempt)
    (gw as unknown as { heavyNotified: Set<string> }).heavyNotified.delete('s1');
    note(ctx('s1'), 205_000, 'sidecar:gemini');
    expect(heard).toHaveLength(3);
  });
});

describe('gateway endpoint: a sidecar-only group gets the lean tool set', () => {
  const ready = (gw: GatewayService) => {
    gw.port = 1234;
    // enabled() = gatewayConfig().enabled && this.key (loaded in start(); set directly here)
    (gw as unknown as { deps: { meta: MetaStore } }).deps.meta.gatewayConfig().enabled = true;
    (gw as unknown as { key: string }).key = 'k';
    return gw;
  };

  it('gemini / workbuddy accounts only → leanTools', async () => {
    expect(ready(await make([{ accountId: 'acct_1' }, { accountId: 'acct_2' }])).endpoint('g')?.leanTools).toBe(true);
  });

  it('a sidecar pool only → leanTools', async () => {
    expect(ready(await make([{ upstreamGroupId: 'pool_1' }])).endpoint('g')?.leanTools).toBe(true);
  });

  it('a mixed group (or a Claude member) keeps the full tool set', async () => {
    expect(ready(await make([{ accountId: 'acct_1' }, { accountId: 'acct_3' }])).endpoint('g')?.leanTools).toBe(false);
    expect(ready(await make([{ upstreamGroupId: 'pool_2' }])).endpoint('g')?.leanTools).toBe(false);
    expect(ready(await make([{ providerId: 'p1' }])).endpoint('g')?.leanTools).toBe(false);
  });
});
