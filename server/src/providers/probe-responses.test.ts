import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MetaStore } from '../meta/store.js';
import { ProviderService } from './service.js';

// A fake OpenAI-compatible relay: models + chat always work; /v1/responses behaves per `mode`.
let srv: http.Server;
let base = '';
let mode: 'ok' | 'missing' | 'model' | 'down' = 'ok';
const hits: string[] = [];
beforeAll(async () => {
  srv = http.createServer((q, s) => {
    let body = '';
    q.on('data', (c) => { body += c; });
    q.on('end', () => {
      hits.push(`${q.method} ${q.url}`);
      if (q.method === 'GET') { s.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[{"id":"gpt-5.6"},{"id":"deepseek-v4"}]}'); return; }
      if (q.url?.endsWith('/chat/completions')) { s.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"c","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}'); return; }
      const j = JSON.parse(body || '{}');
      if (mode === 'missing') { s.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"Invalid URL (POST /v1/responses)"}}'); return; }
      if (mode === 'model') { s.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"no such model","code":"model_not_found"}}'); return; }
      if (mode === 'down') { s.writeHead(503, { 'content-type': 'application/json' }).end('{"error":{"message":"busy"}}'); return; }
      s.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'r', object: 'response', status: 'completed', model: j.model, output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(() => { srv.close(); srv.closeAllConnections?.(); });

const dirs: string[] = [];
afterEach(async () => { hits.length = 0; mode = 'ok'; for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }); });
async function service() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-probe-'));
  dirs.push(d);
  const meta = new MetaStore(path.join(d, 'meta.json'));
  await meta.load();
  return { meta, svc: new ProviderService(meta) };
}

describe('probe of an openai profile whose default model is gpt-*: /v1/responses too', () => {
  it('reports the Responses check next to the chat check, and a working endpoint clears a stale noResponsesApi', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'relay', type: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-x', defaultModel: 'gpt-5.6', noResponsesApi: true });
    const r = await svc.probe(p.id);
    expect(r.ok).toBe(true);
    expect(r.chat).toMatchObject({ ok: true });
    expect(r.responses).toMatchObject({ ok: true, model: 'gpt-5.6' });
    expect(hits).toContain('POST /v1/responses');
    expect(meta.provider(p.id)!.noResponsesApi).toBeUndefined();
  });
  it('no /v1/responses (404 Invalid URL) → reported and remembered; the profile still passes (chat works)', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'relay', type: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-x', defaultModel: 'gpt-5.6' });
    mode = 'missing';
    const r = await svc.probe(p.id);
    expect(r.ok).toBe(true);
    expect(r.responses).toMatchObject({ ok: false, status: 404 });
    expect(meta.provider(p.id)!.noResponsesApi).toBe(true);
  });
  it('a model error or an outage on /v1/responses is reported but not remembered', async () => {
    const { meta, svc } = await service();
    const p = await meta.upsertProvider({ name: 'relay', type: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-x', defaultModel: 'gpt-5.6' });
    for (const m of ['model', 'down'] as const) {
      mode = m;
      const r = await svc.probe(p.id);
      expect(r.responses).toMatchObject({ ok: false });
      expect(meta.provider(p.id)!.noResponsesApi).toBeUndefined();
    }
  });
  it('non-gpt default model, or the shim / Responses switch off: no Responses request', async () => {
    const { meta, svc } = await service();
    const a = await meta.upsertProvider({ name: 'ds', type: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-x', defaultModel: 'deepseek-v4' });
    expect((await svc.probe(a.id)).responses).toBeUndefined();
    const b = await meta.upsertProvider({ name: 'gpt-off', type: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-x', defaultModel: 'gpt-5.6', responsesApi: false });
    expect((await svc.probe(b.id)).responses).toBeUndefined();
    expect(hits).not.toContain('POST /v1/responses');
  });
});
