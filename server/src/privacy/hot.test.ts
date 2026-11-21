// Changed privacy settings apply at once (立即生效), the gzip'd request, and the local model's hook in the pipeline.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { PrivacyRelay } from './relay.js';
import { PrivacyFailed, PrivacyService } from './service.js';
import { DEFAULT_PRIVACY, type PrivacySettings } from './types.js';

const ANT_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
const mk = (cfg: any, model?: any) => new PrivacyService({ privacyConfig: () => cfg, savePrivacy: async () => {} } as any, model ? { model } : {});

describe('立即生效: routing once armed', () => {
  it('never on: nothing is routed; on once: everything is, and stays so while off', async () => {
    const cfg: any = { skipLocal: true };
    const p = mk(cfg);
    let armed = 0;
    p.onArm(() => armed++);
    expect(p.wants('https://api.anthropic.com')).toBe(false);
    await p.set({ enabled: true });
    expect(armed).toBe(1);
    expect(p.wants('https://api.anthropic.com')).toBe(true);
    // a local upstream too: the relay skips it per request while 本机跳过 is on, and masks it the moment it is off
    expect(p.wants('http://127.0.0.1:11434')).toBe(true);
    expect(p.forRequest({ url: 'http://127.0.0.1:11434', source: 'relay' })).toBeNull();
    await p.set({ enabled: false });
    expect(p.wants('https://api.anthropic.com')).toBe(true);
    expect(p.forRequest({ url: 'https://api.anthropic.com', source: 'relay' })).toBeNull();
    await p.set({ enabled: true });
    expect(armed).toBe(1);
    expect(p.status().routed).toBe(true);
    // 立即生效 off: back to routing only while on
    await p.set({ standby: false, enabled: false });
    expect(p.wants('https://api.anthropic.com')).toBe(false);
    expect(p.status().routed).toBe(false);
  });

  it('settings() never shows armedAt; new fields have defaults', () => {
    const p = mk({ enabled: true, armedAt: 1 });
    const s = p.settings() as any;
    expect(s.armedAt).toBeUndefined();
    expect(s.standby).toBe(true);
    expect(s.output).toBe(true);
    expect(s.model).toEqual({ enabled: false, minScore: 0.8 });
    expect(s.actions.name).toBe('off');
  });
});

describe('the relay applies a change to a running conversation', () => {
  const servers: http.Server[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))); });
  const listen = async (h: http.RequestListener) => {
    const s = http.createServer(h);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  };
  const setup = async (cfg: any) => {
    const privacy = mk(cfg);
    const seen: { body: string; enc?: string }[] = [];
    const upstream = await listen((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d) => parts.push(d));
      req.on('end', () => {
        seen.push({ body: Buffer.concat(parts).toString('utf8'), enc: req.headers['content-encoding'] as string | undefined });
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"content":[{"type":"text","text":"ok"}]}');
      });
    });
    let relayBase = '';
    const relay = new PrivacyRelay(privacy, () => relayBase);
    const root = await listen((req, res) => void relay.serve(req, res, new URL(req.url!, 'http://x')));
    relayBase = `${root}/gateway`;
    // the conversation's base URL is fixed when it starts
    const base = relay.base(upstream)!;
    const post = (body: Buffer, headers: Record<string, string> = {}) => fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    return { privacy, seen, post };
  };
  const body = (content: string) => Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content }] }));

  it('off: bytes as they were (even gzip); turned on: the very next request is masked', async () => {
    const cfg: any = { enabled: true, skipLocal: false };
    const { privacy, seen, post } = await setup(cfg);
    await privacy.set({ enabled: false });
    const gz = zlib.gzipSync(body(`key ${ANT_KEY}`));
    expect((await post(gz, { 'content-encoding': 'gzip' })).status).toBe(200);
    expect(seen[0].enc).toBe('gzip');
    await privacy.set({ enabled: true });
    expect((await post(body(`key ${ANT_KEY}`))).status).toBe(200);
    expect(seen[1].body).not.toContain(ANT_KEY);
  });

  it('a compressed request is opened, masked and sent plain', async () => {
    const { seen, post } = await setup({ enabled: true, skipLocal: false });
    for (const [enc, data] of [['gzip', zlib.gzipSync(body(`key ${ANT_KEY}`))], ['br', zlib.brotliCompressSync(body(`key ${ANT_KEY}`))]] as const) {
      const r = await post(data, { 'content-encoding': enc });
      expect(r.status).toBe(200);
    }
    for (const s of seen) {
      expect(s.enc).toBeUndefined();
      expect(s.body).toMatch(/\{\{API_KEY_[a-f0-9]{8}\}\}/);
      expect(s.body).not.toContain(ANT_KEY);
    }
  });

  it('an encoding it cannot open is refused (fail closed)', async () => {
    const { seen, post } = await setup({ enabled: true, skipLocal: false });
    const r = await post(Buffer.from('xx'), { 'content-encoding': 'compress' });
    expect(r.status).toBe(503);
    expect(seen).toHaveLength(0);
  });
});

describe('the local model in the pipeline', () => {
  const stub = (find: (texts: string[]) => Promise<any[][]>) => ({
    find, listen() {}, installed: () => true, runtime: () => true, missing: () => null,
    status: () => ({ id: 'astrlink-guard', name: 'AstrLink Guard', size: 1, runtime: true, installed: true }),
  });
  const on: Partial<PrivacySettings> = { enabled: true, skipLocal: false, actions: { ...DEFAULT_PRIVACY.actions, name: 'redact', address: 'redact' } };

  it('cannot be turned on before it can run', async () => {
    const p = mk({ enabled: true });
    await expect(p.set({ model: { enabled: true, minScore: 0.8 } })).rejects.toThrow();
  });

  it('what it finds is masked (by the type\'s action) and restored', async () => {
    const seenTexts: string[] = [];
    const model = stub(async (texts) => { seenTexts.push(...texts); return texts.map((t) => { const i = t.indexOf('Rina Kowalczyk'); return i < 0 ? [] : [{ start: i, end: i + 14, category: 'name' }]; }); });
    const cfg: any = { ...on };
    const p = mk(cfg, model);
    await p.set({ model: { enabled: true, minScore: 0.9 } });
    const g = p.forRequest({ source: 'relay', cloud: true })!;
    const b = Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'ask Rina Kowalczyk about it' }] }));
    await g.prepare(b);
    const out = g.body(b).toString('utf8');
    expect(out).not.toContain('Rina Kowalczyk');
    expect(out).toMatch(/\{\{NAME_[a-f0-9]{8}\}\}/);
    expect(seenTexts).toContain('ask Rina Kowalczyk about it');
    expect(seenTexts).not.toContain('m');
  });

  it('a model that fails while on refuses the request (names / addresses need it)', async () => {
    const p = mk({ ...on }, stub(async () => { throw new Error('no runtime'); }));
    await p.set({ model: { enabled: true, minScore: 0.8 } });
    const g = p.forRequest({ source: 'relay', cloud: true })!;
    const e = await g.prepare(Buffer.from('{"messages":[{"role":"user","content":"hi there"}]}')).catch((x) => x);
    expect(e).toBeInstanceOf(PrivacyFailed);
    expect(e.status).toBe(400);
    expect(e.message).toContain('no runtime');
  });

  it('privacy off or the model off: prepare does nothing', async () => {
    let called = 0;
    const p = mk({ ...on }, stub(async (t) => { called++; return t.map(() => []); }));
    const g = p.forRequest({ source: 'relay', cloud: true })!;
    await g.prepare(Buffer.from('{"messages":[{"role":"user","content":"hi there"}]}'));
    expect(called).toBe(0);
  });
});
