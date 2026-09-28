import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Provider } from '../protocol.js';
import { MetaStore } from '../meta/store.js';
import { ProviderService, needsModelRefresh, MODEL_REFRESH_MAX_AGE } from './service.js';

// A fake `/v1/models`: the bearer key picks the behaviour; every request is held 40 ms so overlapping
// requests can be counted (the concurrency cap).
let srv: http.Server;
let base = '';
let inFlight = 0;
let maxInFlight = 0;
const hits: string[] = [];
beforeAll(async () => {
  srv = http.createServer((q, s) => {
    const key = String(q.headers.authorization ?? '').replace(/^Bearer /, '');
    hits.push(`${key} ${q.url}`);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight--;
      if (key === 'k-bad') { s.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"invalid key"}}'); return; }
      const n = Number(/k-(\d+)/.exec(key)?.[1] ?? 1);
      s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: Array.from({ length: n }, (_, i) => ({ id: `m-${key}-${i}` })) }));
    }, 40);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(() => { srv.close(); srv.closeAllConnections?.(); });

const dirs: string[] = [];
afterEach(async () => {
  hits.length = 0;
  maxInFlight = 0;
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
async function service() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-refresh-'));
  dirs.push(d);
  const meta = new MetaStore(path.join(d, 'meta.json'));
  await meta.load();
  return { meta, svc: new ProviderService(meta) };
}

describe('providers.refreshModels', () => {
  it('pulls every non-gateway profile, at most 4 at a time, and stores models + modelsAt', async () => {
    const { meta, svc } = await service();
    const ids: string[] = [];
    for (let i = 1; i <= 7; i++) ids.push((await meta.upsertProvider({ name: `p${i}`, type: i % 2 ? 'anthropic' : 'openai', baseUrl: base, apiKey: `k-${i}` })).id);
    const gw = await meta.upsertProvider({ name: 'gw', type: 'gateway', baseUrl: '', gatewayGroupId: 'g1' });
    const t0 = Date.now();
    const res = await svc.refreshModels();
    expect(res.map((r) => r.id).sort()).toEqual([...ids].sort()); // the gateway profile is not probed
    expect(res.every((r) => r.ok)).toBe(true);
    expect(res.find((r) => r.name === 'p3')?.count).toBe(3);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(hits.every((h) => h.endsWith('/v1/models'))).toBe(true); // model list only, never a chat request
    const p5 = meta.provider(ids[4])!;
    expect(p5.models).toEqual(['m-k-5-0', 'm-k-5-1', 'm-k-5-2', 'm-k-5-3', 'm-k-5-4']);
    expect(p5.modelsAt).toBeGreaterThanOrEqual(t0);
    expect(meta.provider(gw.id)!.modelsAt).toBeUndefined();
  });

  it('a failure records modelsError and keeps the previous list; a later success clears it', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'relay', type: 'anthropic', baseUrl: base, apiKey: 'k-bad', models: ['old-a', 'old-b'], modelsAt: 1 });
    const [r] = await svc.refreshModels([p.id]);
    expect(r).toMatchObject({ id: p.id, ok: false, count: 0 });
    expect(r.error).toContain('invalid key');
    expect(meta.provider(p.id)).toMatchObject({ models: ['old-a', 'old-b'], modelsAt: 1, modelsError: expect.stringContaining('invalid key') });
    await meta.upsertProvider({ id: p.id, apiKey: 'k-2' });
    const [r2] = await svc.refreshModels([p.id]);
    expect(r2).toMatchObject({ ok: true, count: 2 });
    expect(meta.provider(p.id)!.modelsError).toBeUndefined();
    expect(meta.provider(p.id)!.models).toEqual(['m-k-2-0', 'm-k-2-1']);
  });

  it('only the requested ids; unknown ids and profiles without a key report an error', async () => {
    const { meta, svc } = await service();
    const a = await meta.upsertProvider({ name: 'a', type: 'anthropic', baseUrl: base, apiKey: 'k-1' });
    await meta.upsertProvider({ name: 'b', type: 'anthropic', baseUrl: base, apiKey: 'k-2' });
    const nokey = await meta.upsertProvider({ name: 'nokey', type: 'openai', baseUrl: base });
    const res = await svc.refreshModels([a.id, nokey.id, 'nope']);
    expect(res.map((r) => r.id)).toEqual([a.id, nokey.id, 'nope']);
    expect(res[0].ok).toBe(true);
    expect(res[1]).toMatchObject({ ok: false, error: '没有 API Key' });
    expect(res[2]).toMatchObject({ ok: false, error: '没有这个供应商档案' });
    expect(hits).toHaveLength(1);
  });
});

describe('needsModelRefresh (startup auto refresh)', () => {
  const now = 10 * MODEL_REFRESH_MAX_AGE;
  const p = (x: Partial<Provider>): Provider => ({ id: 'p', name: 'p', type: 'anthropic', baseUrl: 'https://r.example', apiKey: 'enc:dpapi:x', createdAt: 0, ...x });
  it('never pulled → due', () => expect(needsModelRefresh(p({}), now)).toBe(true));
  it('pulled within 24 h → not due', () => expect(needsModelRefresh(p({ modelsAt: now - MODEL_REFRESH_MAX_AGE + 60_000 }), now)).toBe(false));
  it('older than 24 h → due', () => expect(needsModelRefresh(p({ modelsAt: now - MODEL_REFRESH_MAX_AGE - 1 }), now)).toBe(true));
  it('gateway profiles and profiles without a key are never due', () => {
    expect(needsModelRefresh(p({ type: 'gateway', apiKey: '' }), now)).toBe(false);
    expect(needsModelRefresh(p({ apiKey: '' }), now)).toBe(false);
  });
  it('the service schedules only the due ones, after a delay', async () => {
    const { meta, svc } = await service();
    const fresh = await meta.upsertProvider({ name: 'fresh', type: 'anthropic', baseUrl: base, apiKey: 'k-1', models: ['x'], modelsAt: Date.now() });
    const stale = await meta.upsertProvider({ name: 'stale', type: 'anthropic', baseUrl: base, apiKey: 'k-2', modelsAt: Date.now() - MODEL_REFRESH_MAX_AGE - 1000 });
    const res = await svc.autoRefreshModels(0);
    expect(res.map((r) => r.id)).toEqual([stale.id]);
    expect(meta.provider(fresh.id)!.models).toEqual(['x']);
  });
});
