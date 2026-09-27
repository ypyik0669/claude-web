import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { libraryId } from './ids.js';
import { OpenCodeSource } from './opencode-source.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const SESSIONS = [
  { id: 'ses-a', slug: 'a', projectID: 'p', directory: '/work/demo', path: 'work/demo', title: 'Session A', version: '1.14.33', time: { created: 100, updated: 300 } },
  { id: 'ses-b', slug: 'b', projectID: 'p', directory: '/work/demo', path: 'work/demo', title: 'Session B', version: '1.14.33', time: { created: 50, updated: 500 } },
  { id: 'ses-c', slug: 'c', projectID: 'p', directory: '/work/demo2', path: 'work/demo2', title: 'Session C (child)', version: '1.14.33', parentID: 'ses-a', time: { created: 10, updated: 20 } },
];

/** A minimal in-memory stand-in for `opencode serve`'s HTTP API, routed the way the brief describes. */
function startMock(o: { includeDelete: boolean }) {
  let deleteCalls = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/doc') {
      const methods: Record<string, unknown> = { patch: { operationId: 'session.update' } };
      if (o.includeDelete) methods.delete = { operationId: 'session.delete' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ openapi: '3.1.1', paths: { '/session/{id}': methods } }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SESSIONS));
      return;
    }
    const msgMatch = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (req.method === 'GET' && msgMatch) {
      const raw = await fs.readFile(path.join(here, '__fixtures__', 'opencode-messages.json'), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(raw);
      return;
    }
    const idMatch = /^\/session\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'PATCH' && idMatch) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, body: JSON.parse(body || '{}') })); });
      return;
    }
    if (req.method === 'DELETE' && idMatch) {
      deleteCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise<{ baseUrl: string; close: () => Promise<void>; deleteCalls: () => number }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
        deleteCalls: () => deleteCalls,
      });
    });
  });
}

describe('OpenCodeSource (mock opencode serve)', () => {
  let sources: OpenCodeSource[] = [];
  let mocks: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(sources.map((s) => s.close()));
    await Promise.all(mocks.map((m) => m.close()));
    sources = [];
    mocks = [];
  });

  it('lists sessions newest-updated first and maps fields, including a parentId', async () => {
    const mock = await startMock({ includeDelete: true });
    mocks.push(mock);
    const src = new OpenCodeSource(() => ({ command: 'opencode', env: {} }), { baseUrl: mock.baseUrl });
    sources.push(src);

    const { items } = await src.list({ limit: 10 });
    expect(items.map((i) => i.sessionId)).toEqual([
      libraryId('opencode', 'ses-b'),
      libraryId('opencode', 'ses-a'),
      libraryId('opencode', 'ses-c'),
    ]);
    const a = items.find((i) => i.sessionId === libraryId('opencode', 'ses-a'))!;
    expect(a.title).toBe('Session A');
    expect(a.cwd).toBe('/work/demo');
    expect(a.lastModified).toBe(300);
    expect(a.createdAt).toBe(100);
    expect(a.agent).toBe('opencode');
    expect(a.source).toBe('opencode');
    const c = items.find((i) => i.sessionId === libraryId('opencode', 'ses-c'))!;
    expect(c.parentId).toBe(libraryId('opencode', 'ses-a'));
  });

  it('reads the fixture into user -> assistant(tool_use/tool_result, thinking) -> result', async () => {
    const mock = await startMock({ includeDelete: true });
    mocks.push(mock);
    const src = new OpenCodeSource(() => ({ command: 'opencode', env: {} }), { baseUrl: mock.baseUrl });
    sources.push(src);

    const { messages } = await src.read('ses-a', { limit: 20 });
    const types = messages.map((m: any) => m.type);
    expect(types[0]).toBe('user');
    expect(types).toContain('assistant');
    expect(types[types.length - 1]).toBe('result');

    const toolUse = messages.find((m: any) => m.type === 'assistant' && m.message?.content?.some((c: any) => c.type === 'tool_use'));
    expect(toolUse).toBeTruthy();
    const block = toolUse.message.content.find((c: any) => c.type === 'tool_use');
    expect(block.name).toBe('Bash'); // mapToolName('bash') -> Bash
    expect(block.input.command).toBe('ls -la');

    const toolResult = messages.find((m: any) => m.type === 'user' && m.message?.content?.[0]?.type === 'tool_result');
    expect(toolResult).toBeTruthy();
    expect(toolResult.message.content[0].tool_use_id).toBe(block.id);
    expect(toolResult.message.content[0].is_error).toBe(false);

    const thinkingText = JSON.stringify(messages);
    expect(thinkingText).toContain('The user wants a directory listing');
    expect(thinkingText).toContain("There's a single README.md file");
  });

  it('reports caps.delete = false and never calls DELETE when /doc omits it', async () => {
    const mock = await startMock({ includeDelete: false });
    mocks.push(mock);
    const src = new OpenCodeSource(() => ({ command: 'opencode', env: {} }), { baseUrl: mock.baseUrl });
    sources.push(src);

    const status = await src.status();
    expect(status.enabled).toBe(true);
    await src.list({ limit: 10 });
    await src.read('ses-a', { limit: 20 });
    expect(src.caps.delete).toBe(false);
    expect(src.caps.rename).toBe(true); // /doc's methods still include patch
    expect(mock.deleteCalls()).toBe(0);
  });

  it('reports a broken launch as not enabled, without throwing, and list() degrades to empty', async () => {
    const src = new OpenCodeSource(() => ({ command: 'definitely-not-a-real-opencode-binary-xyz', env: {} }));
    sources.push(src);

    const status = await src.status();
    expect(status.enabled).toBe(false);
    const listed = await src.list({ limit: 10 });
    expect(listed.items).toEqual([]);
  });
});
