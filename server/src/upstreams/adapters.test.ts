import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { GeminiAdapter } from './gemini.js';
import { WorkBuddyAdapter } from './workbuddy.js';

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

const servers: http.Server[] = [];
async function fake(handler: Handler): Promise<{ url: string; hits: Hit[]; set(next: Handler): void }> {
  const hits: Hit[] = [];
  const h = { fn: handler };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }); h.fn(req, res, body); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  servers.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as any).port}`, hits, set: (next) => { h.fn = next; } };
}
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});

const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

describe('GeminiAdapter', () => {
  const make = async () => {
    const items = [
      { id: 1, label: 'Main', status: 'enabled', health: 'ok' },
      { id: 2, label: 'Old', status: 'enabled', health: 'dead', last_error: '登录态失效' },
    ];
    const f = await fake((req, res, body) => {
      const url = req.url ?? '';
      if (url === '/admin/api/config') return json(res, 200, { models: ['gemini-3.6-flash', 'gemini-3.1-pro'], config: {} });
      if (url === '/admin/api/cookies' && req.method === 'GET') return json(res, 200, { items, total: items.length, enabled: 2 });
      if (url === '/admin/api/cookies' && req.method === 'POST') {
        const j = JSON.parse(body);
        items.push({ id: 3, label: j.label, status: 'enabled', health: 'unknown' });
        return json(res, 200, { id: 3 });
      }
      if (url === '/admin/api/cookies/3' && req.method === 'PATCH') {
        const j = JSON.parse(body);
        const it = items.find((x) => x.id === 3)!;
        if (j.label) it.label = j.label;
        if (j.status) it.status = j.status;
        return json(res, 200, { ok: true });
      }
      if (url === '/admin/api/cookies/3' && req.method === 'DELETE') {
        const i = items.findIndex((x) => x.id === 3);
        if (i >= 0) items.splice(i, 1);
        return json(res, 200, { ok: true });
      }
      if (url === '/admin/api/cookies/3/check') return json(res, 200, { ok: true, detail: '登录态有效' });
      if (url === '/admin/api/cookies/3/rotate') return json(res, 200, { ok: true, detail: '保活成功' });
      return json(res, 404, { error: 'no' });
    });
    return { f, a: new GeminiAdapter(null, fetch, { baseUrl: f.url }) };
  };

  it('lists, adds, checks, keeps alive and removes an account', async () => {
    const { f, a } = await make();
    const list = await a.listAccounts();
    expect(list.map((x) => [x.remoteId, x.health, x.lastError])).toEqual([
      ['1', 'ok', undefined],
      ['2', 'expired', '登录态失效'],
    ]);
    expect(await a.models()).toEqual(['gemini-3.6-flash', 'gemini-3.1-pro']);

    const added = await a.addAccount({ credential: { cookies: [{ name: '__Secure-1PSID', value: 'x' }] }, name: 'New' });
    expect(added).toMatchObject({ remoteId: '3', name: 'New', enabled: true });
    expect(f.hits.find((h) => h.url === '/admin/api/cookies' && h.method === 'POST')!.body).toContain('__Secure-1PSID=x');

    expect(await a.updateAccount('3', { enabled: false })).toMatchObject({ enabled: false, health: 'disabled' });
    expect((await a.checkAccount('3')).health).toBe('ok');
    expect(await a.runTask('3', 'keepalive')).toMatchObject({ ok: true, detail: '保活成功' });
    expect((await a.runTask('1', 'checkin')).ok).toBe(false);

    await a.removeAccount('3');
    expect((await a.listAccounts()).some((x) => x.remoteId === '3')).toBe(false);
  });

  it('uses the admin token, never the data key, and exposes the /v1 endpoint', async () => {
    const { f, a } = await make();
    await a.listAccounts();
    const auth = String(f.hits[0].headers.authorization ?? '');
    expect(auth.startsWith('Bearer ')).toBe(true);
    expect(auth).not.toBe(`Bearer ${a.apiKey}`);
    expect(await a.endpoint()).toEqual({ baseUrl: `${f.url}/v1`, apiKey: a.apiKey });
  });
});

describe('WorkBuddyAdapter', () => {
  const make = async () => {
    const accounts = [{ uid: 'u1', nickname: 'Nick', disabled: false, cooling: false, credits: 10, credits_total: 20 }];
    const f = await fake((req, res, body) => {
      const url = req.url ?? '';
      if (url === '/healthz') return json(res, 200, { ok: true });
      if (url === '/panel/api/overview') return json(res, 200, { version: '1.13.0', total: 1, healthy: 1, accounts });
      if (url === '/panel/api/import/cockpit' && req.method === 'POST') {
        expect(body).toContain('accessToken');
        expect(body).toContain('refreshToken');
        return json(res, 200, { ok: true, imported: 1 });
      }
      if (url === '/v1/models') return json(res, 200, { data: [{ id: 'glm-5.2' }] });
      if (url.endsWith('/disable')) { accounts[0].disabled = true; return json(res, 200, { ok: true }); }
      if (url.endsWith('/revive')) { accounts[0].disabled = false; return json(res, 200, { ok: true }); }
      if (url.endsWith('/remove')) return json(res, 200, { ok: true });
      if (url.endsWith('/balance')) { accounts[0].credits = 12; return json(res, 200, { ok: true, credits: 12, credits_total: 20 }); }
      if (url.endsWith('/checkin')) return json(res, 200, { ok: true, checkin_done: true });
      if (url.endsWith('/tasks/auto_all')) return json(res, 200, { ok: true, results: [] });
      if (url.includes('_all')) return json(res, 200, { ok: true, started: true });
      if (url === '/panel/api/login/start') return json(res, 200, { ok: true, url: 'https://login.example/x', state: 'st1', realm: 'cn' });
      if (url.startsWith('/panel/api/login/poll')) return json(res, 200, { done: true, uid: 'u1' });
      return json(res, 404, { error: 'no' });
    });
    return { f, a: new WorkBuddyAdapter(null, fetch, { baseUrl: f.url }) };
  };

  it('an account WorkBuddy banned (re-login required) reads 要重新登录, not 正常 or just disabled (2026-11-03)', async () => {
    const f = await fake((req, res) => {
      if (req.url === '/panel/api/overview') return json(res, 200, { accounts: [{ uid: 'u1', nickname: 'Nick', disabled: true, disabled_reason: 'account banned by upstream (11140 request illegal), re-login required', credits: 350, credits_total: 350 }] });
      return json(res, 404, {});
    });
    const [acc] = await new WorkBuddyAdapter(null, fetch, { baseUrl: f.url }).listAccounts();
    expect(acc).toMatchObject({ health: 'expired', enabled: false });
    expect(acc.lastError).toMatch(/11140 request illegal.*重新扫码登录/);
  });

  it('syncs the pool, imports cockpit JSON and runs tasks', async () => {
    const { f, a } = await make();
    const list = await a.listAccounts();
    expect(list[0]).toMatchObject({ remoteId: 'u1', name: 'Nick', enabled: true, health: 'ok' });
    expect(list[0].quota?.credits).toEqual({ remaining: 10, total: 20, unit: 'credits' });
    expect(await a.models()).toEqual(['glm-5.2']);

    const added = await a.addAccount({ credential: JSON.stringify([{ uid: 'u2', accessToken: 'at', refreshToken: 'rt' }]) });
    // the fake pool only knows u1; the import still happened
    expect(added.remoteId).toBe('u2');
    expect(f.hits.some((h) => h.url === '/panel/api/import/cockpit')).toBe(true);

    expect(await a.updateAccount('u1', { enabled: false })).toMatchObject({ enabled: false, health: 'disabled' });
    expect(await a.updateAccount('u1', { enabled: true })).toMatchObject({ enabled: true, health: 'ok' });
    expect((await a.checkAccount('u1')).quota?.credits?.remaining).toBe(12);
    expect((await a.runTask('u1', 'quota-refresh')).quota?.credits?.remaining).toBe(12);
    expect(await a.runTask('u1', 'growth')).toMatchObject({ ok: true });
    expect(await a.runTask('u1', 'checkin')).toMatchObject({ ok: true, checkin_done: true });
    expect(await a.runTask('u1', 'keepalive')).toMatchObject({ ok: true, started: true });
    expect(await a.runTask('u1', 'lottery')).toMatchObject({ ok: true });

    expect(await a.startLogin('global')).toMatchObject({ url: 'https://login.example/x', state: 'st1' });
    expect(await a.pollLogin('st1')).toMatchObject({ done: true, uid: 'u1' });
    expect(await a.endpoint()).toEqual({ baseUrl: `${f.url}/v1`, apiKey: a.apiKey });
    expect(String(f.hits[0].headers.authorization)).toBe(`Bearer ${a.apiKey}`);
  });

  it('treats a sidecar with an empty pool as up (healthz 503), but not a missing one', async () => {
    const f = await fake((req, res) => {
      if (req.url === '/healthz') return json(res, 503, { healthy: 0, total: 0, service: 'workbuddy2api' });
      return json(res, 404, { error: 'no' });
    });
    const port = Number(new URL(f.url).port);
    let spec: any;
    const manager = { start: async (_id: string, s: any) => { spec = s; }, status: () => ({ port }) } as any;
    const a = new WorkBuddyAdapter(manager, fetch);
    await a.ensureReady();
    expect(await spec.health(port)).toBe(true);
    f.set((_q, res) => json(res, 404, { error: 'no' }));
    expect(await spec.health(port)).toBe(false);
  });
});
