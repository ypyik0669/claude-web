// The local model missing (2026-11-21: a copy of the data folder without privacy-model/ refused every request with a
// 503 the CLI retried and called temporary, although every type that was on has rules of its own). Only a type the
// model is needed for (names, addresses — types.ts NEEDS_MODEL) may stop a request, with a 400 that says what to do and
// nothing sent; everything else goes out masked by the rules. Both ways a conversation reaches an upstream: the privacy
// relay (an Anthropic-format relay as the provider) and a gateway group.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../gateway/audit.js';
import { GatewayService } from '../gateway/service.js';
import { setLocale } from '../i18n/index.js';
import { MetaStore } from '../meta/store.js';
import { PrivacyModel } from './model/index.js';
import { categoryLabel, PrivacyFailed, PrivacyModelUnavailable, PrivacyService, privacyErrorStatus } from './service.js';
import { modelNeededFor, type PrivacyAction, type PrivacyCategory } from './types.js';

const ANT_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
const CARD = '4111 1111 1111 1111';
const ID = '11010519491231002X';
const NAME = 'Rina Kowalczyk';
const TEXT = `deploy with ${ANT_KEY}, card ${CARD}, id ${ID}, ask ${NAME} about it`;
const SECRETS = [ANT_KEY, CARD, ID];

/** meta.json's `privacy` as the copied data folder had it: 用本地模型查找 on, only types with rules of their own on */
const userConfig = (actions: Partial<Record<PrivacyCategory, PrivacyAction>> = {}) => ({
  enabled: true, skipLocal: true, standby: true, output: true,
  model: { enabled: true, minScore: 0.8 },
  actions: { api_key: 'redact', private_key: 'redact', jwt: 'redact', password: 'redact', email: 'off', phone: 'off', id_card: 'redact', bank_card: 'redact', name: 'off', address: 'off', custom: 'redact', ...actions },
  words: [], patterns: [], allow: [],
});

const tmp: string[] = [];
afterAll(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmpDir = (tag: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `cw-${tag}-`)); tmp.push(d); return d; };
/** the real model class over a data folder whose privacy-model/ the copy left out */
const noModel = () => new PrivacyModel(path.join(tmpDir('no-model'), 'privacy-model'));
const mk = (cfg: any, model: any = noModel()) => new PrivacyService({ privacyConfig: () => cfg, savePrivacy: async () => {} } as any, { model });
const body = () => Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: TEXT }] }));
/** a model that is there (or says it is not) and runs `find` */
const stub = (o: { missing?: 'files' | 'runtime' | 'downloading'; find?: (t: string[]) => Promise<any[][]> }) => ({
  listen() {}, installed: () => true, runtime: () => true,
  missing: () => o.missing ?? null,
  find: o.find ?? (async (t: string[]) => t.map(() => [])),
  status: () => ({ id: 'astrlink-guard', name: 'AstrLink Guard', size: 1, runtime: true, installed: true }),
});
const guardFor = (p: PrivacyService) => p.forRequest({ url: 'https://relay.example.com', source: 'relay.example.com' })!;

describe('which types need the local model', () => {
  it('names and addresses set to redact or block, with 隐私保护 and 用本地模型查找 both on', () => {
    expect(modelNeededFor(userConfig())).toEqual([]);
    expect(modelNeededFor(userConfig({ address: 'redact' }))).toEqual(['address']);
    expect(modelNeededFor(userConfig({ name: 'block', address: 'redact' }))).toEqual(['name', 'address']);
    // a warn type goes out as it is anyway: nothing to protect without the model
    expect(modelNeededFor(userConfig({ name: 'warn' }))).toEqual([]);
    expect(modelNeededFor({ ...userConfig({ name: 'redact' }), model: { enabled: false, minScore: 0.8 } })).toEqual([]);
    expect(modelNeededFor({ ...userConfig({ name: 'redact' }), enabled: false })).toEqual([]);
  });
});

describe('the local model missing: the guard', () => {
  it('only types with rules of their own on (the reported settings): masked by the rules and sent, the model never asked', async () => {
    let asked = 0;
    const model = noModel();
    const find = model.find.bind(model);
    model.find = (t, s) => { asked++; return find(t, s); };
    const p = mk(userConfig(), model);
    expect(p.model.missing()).toBe('files');
    const g = guardFor(p);
    await g.prepare(body());
    const out = g.body(body()).toString('utf8');
    for (const v of SECRETS) expect(out).not.toContain(v);
    expect(out).toMatch(/\{\{API_KEY_[a-f0-9]{8}\}\}/);
    expect(out).toMatch(/\{\{BANK_CARD_[a-f0-9]{8}\}\}/);
    expect(out).toMatch(/\{\{ID_CARD_[a-f0-9]{8}\}\}/);
    expect(asked).toBe(0);
  });

  it('a type only the model finds on: refused with a 400 that says what to do — never sent without it', async () => {
    for (const actions of [{ name: 'redact' }, { address: 'block' }] as const) {
      const p = mk(userConfig(actions));
      const e = await guardFor(p).prepare(body()).catch((x) => x);
      expect(e).toBeInstanceOf(PrivacyModelUnavailable);
      expect(e).toBeInstanceOf(PrivacyFailed); // still the fail-closed family
      expect(e.status).toBe(400);
      expect(privacyErrorStatus(e)).toBe(400);
      const cat = Object.keys(actions)[0] as PrivacyCategory;
      expect(e.message).toContain(categoryLabel(cat));
      expect(e.message).toContain('它的文件不在这台电脑上');
      expect(e.message).toContain('模型看板 › 隐私');
      expect(e.message).toContain('重试也一样');
      for (const v of [...SECRETS, NAME]) expect(e.message).not.toContain(v);
    }
  });

  it('names on but no text in the body for the model to read: nothing it could protect, so not refused', async () => {
    await expect(guardFor(mk(userConfig({ name: 'redact' }))).prepare(Buffer.from('{"model":"m","messages":[]}'))).resolves.toBeUndefined();
  });

  it('the runtime missing, or still downloading: each said so', async () => {
    const runtime = await guardFor(mk(userConfig({ name: 'redact' }), stub({ missing: 'runtime' }))).prepare(body()).catch((x) => x);
    expect(runtime.status).toBe(400);
    expect(runtime.message).toContain('它的运行库不在这台电脑上');
    const dl = await guardFor(mk(userConfig({ name: 'redact' }), stub({ missing: 'downloading' }))).prepare(body()).catch((x) => x);
    expect(dl.status).toBe(400);
    expect(dl.message).toContain('模型还在下载');
  });

  it('the model there but failing: rule types go on with the rules alone; names on → refused, with its error', async () => {
    const boom = stub({ find: async () => { throw new Error('session crashed'); } });
    const g = guardFor(mk(userConfig(), boom));
    await g.prepare(body());
    const out = g.body(body()).toString('utf8');
    for (const v of SECRETS) expect(out).not.toContain(v);
    const e = await guardFor(mk(userConfig({ name: 'redact' }), boom)).prepare(body()).catch((x) => x);
    expect(e).toBeInstanceOf(PrivacyModelUnavailable);
    expect(e.message).toContain('session crashed');
  });

  it('in English too', async () => {
    setLocale('en');
    try {
      const e = await guardFor(mk(userConfig({ name: 'redact', address: 'redact' }))).prepare(body()).catch((x) => x);
      expect(e.message).toBe("The request was not sent: privacy protection needs the local model to find Person names and Addresses, but its files aren't on this computer, so retrying won't help. Download the local model again under Model hub › Privacy, or turn off “Find with a local model”.");
    } finally { setLocale('zh'); }
  });
});

describe('the local model missing: what the CLI gets', () => {
  const servers: http.Server[] = [];
  const gateways: GatewayService[] = [];
  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((g) => g.stop()));
    await Promise.all(servers.splice(0).map((s) => { s.closeAllConnections(); return new Promise((r) => s.close(r)); }));
  });
  const listen = async (h: http.RequestListener) => {
    const s = http.createServer(h);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return (s.address() as AddressInfo).port;
  };

  /** An Anthropic-format relay that records what reaches it, and the gateway in front of it with privacy on. */
  const setup = async () => {
    const seen: string[] = [];
    const upPort = await listen((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        seen.push(b);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
      });
    });
    const upstream = `http://127.0.0.1:${upPort}`;
    const dir = tmpDir('gw-privacy');
    const meta = new MetaStore(path.join(dir, 'meta.json'));
    const relay = await meta.upsertProvider({ name: 'Relay', type: 'anthropic', baseUrl: upstream, apiKey: 'sk-relay' });
    // the test's upstream is on 127.0.0.1: 本机跳过 off so it is processed like the cloud relay it stands for
    const cfg: any = { ...userConfig(), skipLocal: false };
    const privacy = mk(cfg);
    const gw = new GatewayService({ meta, member: (id) => meta.provider(id) ?? null, privacy, audit: new AuditLog(path.join(dir, 'audit'), () => meta.gatewayAudit()), firstByteMs: 2000, nonStreamMs: 5000 });
    gateways.push(gw);
    gw.port = await listen((req, res) => { if (!gw.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))) res.writeHead(418).end(); });
    await gw.setEnabled(true);
    const key = gw.revealKey();
    await gw.upsertGroup({ id: 'main', name: 'Main', strategy: 'failover', members: [{ providerId: relay.id }] });
    const send = async (url: string, headers: Record<string, string>) => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8, messages: [{ role: 'user', content: TEXT }] }) });
      return { status: r.status, retry: r.headers.get('x-should-retry'), text: await r.text() };
    };
    return {
      privacy, seen,
      // a conversation on the relay provider: its base URL is the privacy relay (how the reported request went)
      viaRelay: () => send(`${gw.privacyBase(upstream)}/v1/messages`, { 'x-api-key': 'sk-relay' }),
      // a conversation on a gateway group
      viaGroup: () => send(`http://127.0.0.1:${gw.port}/gateway/main/v1/messages`, { 'x-api-key': key }),
    };
  };

  for (const way of ['viaRelay', 'viaGroup'] as const) {
    it(`${way}: rule types go out masked; with 人名 on, a 400 that is not retried and nothing reaches the upstream`, async () => {
      const s = await setup();
      const ok = await s[way]();
      expect(ok.status).toBe(200);
      expect(s.seen).toHaveLength(1);
      for (const v of SECRETS) expect(s.seen[0]).not.toContain(v);
      expect(s.seen[0]).toMatch(/\{\{API_KEY_[a-f0-9]{8}\}\}/);

      await s.privacy.set({ actions: { name: 'redact' } });
      const r = await s[way]();
      expect(r.status).toBe(400);
      expect(r.retry).toBe('false');
      const err = JSON.parse(r.text);
      expect(err.type).toBe('error');
      expect(err.error.message).toContain('模型看板 › 隐私');
      expect(err.error.message).toContain(categoryLabel('name'));
      for (const v of [...SECRETS, NAME]) expect(r.text).not.toContain(v);
      // nothing more reached the upstream — not the masked text, not the raw one
      expect(s.seen).toHaveLength(1);
    });
  }
});

// The cache shim (a Codex / OpenAI-format conversation's way out) and the split route only ran the rules until
// 2026-11-21: names / addresses the user had the local model look for went out as they were. They ask it now, like
// the relay and the gateway, and refuse the same way when it is needed and missing.
describe('the cache shim asks the local model too', () => {
  const servers: http.Server[] = [];
  const gateways: GatewayService[] = [];
  afterEach(async () => {
    await Promise.all(gateways.splice(0).map((g) => g.stop()));
    await Promise.all(servers.splice(0).map((s) => { s.closeAllConnections(); return new Promise((r) => s.close(r)); }));
  });
  const listen = async (h: http.RequestListener) => {
    const s = http.createServer(h);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return (s.address() as AddressInfo).port;
  };
  const setup = async (model: any) => {
    const seen: string[] = [];
    const upPort = await listen((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        seen.push(b);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-x', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    const dir = tmpDir('shim-privacy');
    const meta = new MetaStore(path.join(dir, 'meta.json'));
    const p = await meta.upsertProvider({ name: 'DS', type: 'openai', baseUrl: `http://127.0.0.1:${upPort}`, apiKey: 'sk-ds' });
    // names on, 本机跳过 off (the test's upstream is on 127.0.0.1)
    const privacy = mk({ ...userConfig({ name: 'redact' }), skipLocal: false }, model);
    const gw = new GatewayService({ meta, member: (id) => meta.provider(id) ?? null, privacy, audit: new AuditLog(path.join(dir, 'audit'), () => meta.gatewayAudit()), firstByteMs: 2000, nonStreamMs: 5000 });
    gateways.push(gw);
    gw.port = await listen((req, res) => { if (!gw.handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))) res.writeHead(418).end(); });
    const send = async () => {
      const r = await fetch(`http://127.0.0.1:${gw.port}/gateway/~p/${p.id}/k/sess-1/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${gw.shim.keyFor(p.id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-x', messages: [{ role: 'user', content: TEXT }], stream: false }) });
      return { status: r.status, retry: r.headers.get('x-should-retry'), text: await r.text() };
    };
    return { seen, send, privacy };
  };

  it('a name only the model finds is masked before it leaves', async () => {
    const model = stub({ find: async (t) => t.map((s) => { const i = s.indexOf(NAME); return i >= 0 ? [{ start: i, end: i + NAME.length, category: 'name' }] : []; }) });
    const s = await setup(model);
    const r = await s.send();
    expect(r.status).toBe(200);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]).not.toContain(NAME);
    for (const v of SECRETS) expect(s.seen[0]).not.toContain(v);
  });

  it('the model missing with names on: a 400 that is not retried, nothing sent', async () => {
    const s = await setup(noModel());
    const r = await s.send();
    expect(r.status).toBe(400);
    expect(r.retry).toBe('false');
    expect(r.text).toContain('模型看板 › 隐私');
    expect(s.seen).toHaveLength(0);
  });
});
