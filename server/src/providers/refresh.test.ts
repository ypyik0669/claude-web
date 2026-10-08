import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Provider } from '../protocol.js';
import { MetaStore } from '../meta/store.js';
import { ProviderService, needsModelRefresh, MODEL_REFRESH_MAX_AGE, parseModelList } from './service.js';

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
    // a flaky route: the first request of this key loses its connection, the next one is answered
    if (key === 'k-flaky' && hits.filter((h) => h.startsWith('k-flaky ')).length === 1) { q.socket.destroy(); return; }
    if (key === 'k-dead') { q.socket.destroy(); return; }
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight--;
      if (key === 'k-500') { s.writeHead(500).end(); return; }
      if (key === 'k-empty') { s.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}'); return; }
      if (key === 'k-named') { s.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[{"id":"deepseek-flash","name":"DeepSeek-V4.1-Flash"},{"id":"deepseek-v4-pro","name":"DeepSeek-V4-Pro"}]}'); return; }
      if (key === 'k-effort') { s.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[{"id":"deepseek-flash","name":"DeepSeek-V4.1-Flash","effort":{"supported_levels":["low","high","max"],"default_level":"high"}},{"id":"deepseek-chat"}]}'); return; }
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

describe('refreshModels edge cases', () => {
  it('an error with an empty body falls back to HTTP <status>', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'x', type: 'openai', baseUrl: `${base}/v1`, apiKey: 'k-500' });
    const [r] = await svc.refreshModels([p.id]);
    expect(r.error).toBe('HTTP 500');
    expect(meta.provider(p.id)!.modelsError).toBe('HTTP 500');
  });
  it('200 with an empty list does not wipe a non-empty list', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'x', type: 'openai', baseUrl: `${base}/v1`, apiKey: 'k-empty', models: ['keep-me'], modelsAt: 5 });
    const [r] = await svc.refreshModels([p.id]);
    expect(r.ok).toBe(false);
    expect(meta.provider(p.id)).toMatchObject({ models: ['keep-me'], modelsAt: 5, modelsError: expect.stringContaining('空列表') });
    // nothing to lose: an empty list on a profile that had none is simply recorded
    const q = await meta.upsertProvider({ name: 'y', type: 'openai', baseUrl: `${base}/v1`, apiKey: 'k-empty' });
    const [r2] = await svc.refreshModels([q.id]);
    expect(r2).toMatchObject({ ok: true, count: 0 });
    expect(meta.provider(q.id)!.modelsAt).toBeGreaterThan(0);
  });
  it('a profile deleted while its list is being pulled stays deleted (no ghost)', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'doomed', type: 'anthropic', baseUrl: base, apiKey: 'k-3' });
    const run = svc.refreshModels([p.id]);
    await new Promise((r) => setTimeout(r, 10)); // request in flight (the fake holds it 40 ms)
    await meta.removeProvider(p.id);
    const [r] = await run;
    expect(meta.provider(p.id)).toBeUndefined();
    expect(meta.providers()).toHaveLength(0);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('已删除') });
  });
  it('probe() on a profile deleted meanwhile does not bring it back either', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'doomed', type: 'gemini', baseUrl: base, apiKey: 'k-2' });
    const run = svc.probe(p.id);
    await new Promise((r) => setTimeout(r, 10));
    await meta.removeProvider(p.id);
    await run;
    expect(meta.providers()).toHaveLength(0);
  });
  it('upsertProvider({mustExist}) is a no-op for a missing id', async () => {
    const { meta } = await service();
    expect(await meta.upsertProvider({ id: 'gone', models: ['x'] }, { mustExist: true })).toBeNull();
    expect(meta.providers()).toHaveLength(0);
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
  it('CW_NO_MODEL_REFRESH turns the startup refresh off', async () => {
    const { meta, svc } = await service();
    await meta.upsertProvider({ name: 'stale', type: 'anthropic', baseUrl: base, apiKey: 'k-2' });
    process.env.CW_NO_MODEL_REFRESH = '1';
    try { expect(await svc.autoRefreshModels(0)).toEqual([]); } finally { delete process.env.CW_NO_MODEL_REFRESH; }
    expect(hits).toHaveLength(0);
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

describe('providers.probe listOnly', () => {
  it('the model list alone: no chat request (the quick connect decides format and model from it first)', async () => {
    const { svc } = await service();
    const r = await svc.probe(undefined, { type: 'openai', baseUrl: base, apiKey: 'k-3' }, { listOnly: true });
    expect(r).toMatchObject({ ok: true, models: ['m-k-3-0', 'm-k-3-1', 'm-k-3-2'] });
    expect(hits).toEqual(['k-3 /v1/models']);
    const bad = await svc.probe(undefined, { type: 'openai', baseUrl: base, apiKey: 'k-bad' }, { listOnly: true });
    expect(bad).toMatchObject({ ok: false, status: 401 });
  });
});

describe('the model list on a flaky route', () => {
  it('a request that loses its connection is tried once more; an HTTP error is not', async () => {
    const { probeProvider } = await import('./service.js');
    const ok = await probeProvider({ type: 'openai', baseUrl: base, apiKey: 'k-flaky' }, 10);
    expect(ok.ok).toBe(true);
    expect(hits.filter((h) => h.startsWith('k-flaky '))).toHaveLength(2);
    const dead = await probeProvider({ type: 'openai', baseUrl: base, apiKey: 'k-dead' }, 10);
    expect(dead.ok).toBe(false);
    expect(hits.filter((h) => h.startsWith('k-dead '))).toHaveLength(2); // twice, then the error
    const bad = await probeProvider({ type: 'openai', baseUrl: base, apiKey: 'k-bad' }, 10);
    expect(bad).toMatchObject({ ok: false, status: 401 });
    expect(hits.filter((h) => h.startsWith('k-bad '))).toHaveLength(1);
  });
});

describe('model display names from the list', () => {
  it('a refresh stores the names with the list; a list without names clears old ones', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'DeepSeek', type: 'openai', baseUrl: base, apiKey: 'k-named' });
    await svc.refreshModels([p.id]);
    expect(meta.provider(p.id)).toMatchObject({ models: ['deepseek-flash', 'deepseek-v4-pro'], modelNames: { 'deepseek-flash': 'DeepSeek-V4.1-Flash', 'deepseek-v4-pro': 'DeepSeek-V4-Pro' } });
    await meta.upsertProvider({ id: p.id, apiKey: 'k-2' });
    await svc.refreshModels([p.id]);
    expect(meta.provider(p.id)!.modelNames).toBeUndefined();
  });
  it('DeepSeek / OpenRouter `name`, Anthropic `display_name`, Gemini `displayName`; a name equal to the id is not one', () => {
    expect(parseModelList([
      { id: 'deepseek-flash', object: 'model', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
      { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
      { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro' },
      { id: 'plain' },
      'bare-string',
    ])).toEqual({
      models: ['bare-string', 'claude-sonnet-5', 'deepseek-flash', 'deepseek-v4-pro', 'gemini-3-pro', 'plain'],
      modelNames: { 'deepseek-flash': 'DeepSeek-V4.1-Flash', 'claude-sonnet-5': 'Claude Sonnet 5', 'gemini-3-pro': 'Gemini 3 Pro' },
    });
    expect(parseModelList([{ id: 'a' }, { id: 'b' }])).toEqual({ models: ['a', 'b'] });
  });
});

describe('thinking-strength levels from the list, and models that only take the prompt way', () => {
  it('DeepSeek shape: effort.supported_levels / default_level, only the five levels we know, in order', () => {
    expect(parseModelList([
      { id: 'deepseek-flash', effort: { supported_levels: ['max', 'low', 'high'], default_level: 'high' } },
      { id: 'turbo-only', effort: { supported_levels: ['turbo'], default_level: 'turbo' } },
      { id: 'no-default', effort: { supported_levels: ['low', 'medium'] } },
      { id: 'bad-default', effort: { supported_levels: ['low', 'high'], default_level: 'ultra' } },
      { id: 'plain' },
    ])).toEqual({
      models: ['bad-default', 'deepseek-flash', 'no-default', 'plain', 'turbo-only'],
      modelEfforts: {
        'deepseek-flash': { levels: ['low', 'high', 'max'], default: 'high' },
        'no-default': { levels: ['low', 'medium'] },
        'bad-default': { levels: ['low', 'high'] },
      },
    });
  });

  it('a refresh stores the levels with the list; a list without them clears old ones', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'DeepSeek', type: 'openai', baseUrl: base, apiKey: 'k-effort' });
    await svc.refreshModels([p.id]);
    expect(meta.provider(p.id)!.modelEfforts).toEqual({ 'deepseek-flash': { levels: ['low', 'high', 'max'], default: 'high' } });
    await meta.upsertProvider({ id: p.id, apiKey: 'k-2' });
    await svc.refreshModels([p.id]);
    expect(meta.provider(p.id)!.modelEfforts).toBeUndefined();
  });

  it('保存后重新检测: promptEffortModels: null removes the record', async () => {
    const { meta } = await service();
    const p = await meta.upsertProvider({ name: 'X', type: 'openai', baseUrl: base, apiKey: 'k-1', promptEffortModels: ['gpt-x'] });
    expect(meta.provider(p.id)!.promptEffortModels).toEqual(['gpt-x']);
    await meta.upsertProvider({ id: p.id, promptEffortModels: null as unknown as undefined });
    expect('promptEffortModels' in meta.provider(p.id)!).toBe(false);
  });
});
