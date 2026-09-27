import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { libraryId } from './ids.js';
import { OpenCodeSource } from './opencode-source.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, '__mocks__', 'opencode-cli.cmd');

const SESSIONS = [
  { id: 'ses-a', slug: 'a', projectID: 'p', directory: '/work/demo', path: 'work/demo', title: 'Session A', version: '1.14.33', time: { created: 100, updated: 300 } },
  { id: 'ses-b', slug: 'b', projectID: 'p', directory: '/work/demo', path: 'work/demo', title: 'Session B', version: '1.14.33', time: { created: 50, updated: 500 } },
  { id: 'ses-c', slug: 'c', projectID: 'p', directory: '/work/demo2', path: 'work/demo2', title: 'Session C (child)', version: '1.14.33', parentID: 'ses-a', time: { created: 10, updated: 20 } },
];

// Three turns for `ses-multi`, oldest first, used only by the read() pagination test below — kept
// separate from the shared fixture (opencode-messages.json) so its tool_use/thinking assertions stay
// unaffected.
const MULTI_TURN_MESSAGES = [1, 2, 3].flatMap((n) => [
  { info: { role: 'user', time: { created: n * 1000 }, id: `msg_u${n}`, sessionID: 'ses-multi' }, parts: [{ type: 'text', text: `turn ${n} user`, id: `prt_u${n}`, sessionID: 'ses-multi', messageID: `msg_u${n}` }] },
  { info: { role: 'assistant', time: { created: n * 1000 + 1, completed: n * 1000 + 2 }, id: `msg_a${n}`, sessionID: 'ses-multi' }, parts: [{ type: 'text', text: `turn ${n} assistant`, id: `prt_a${n}`, sessionID: 'ses-multi', messageID: `msg_a${n}` }] },
]);

/** A minimal in-memory stand-in for `opencode serve`'s HTTP API (`GET /session`, `GET /session/{id}/message` only — capability detection and delete no longer go through HTTP, see fix round 1). */
function startMock() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SESSIONS));
      return;
    }
    const msgMatch = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (req.method === 'GET' && msgMatch) {
      if (msgMatch[1] === 'ses-multi') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(MULTI_TURN_MESSAGES));
        return;
      }
      const raw = await fs.readFile(path.join(here, '__fixtures__', 'opencode-messages.json'), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(raw);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

// these tests spawn the .cmd fake CLI (cmd.exe → node), slow under a loaded full-suite run
describe('OpenCodeSource (mock opencode serve + fake opencode CLI)', { timeout: 20_000 }, () => {
  let sources: OpenCodeSource[] = [];
  let mocks: { close: () => Promise<void> }[] = [];
  let tmpFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(sources.map((s) => s.close()));
    await Promise.all(mocks.map((m) => m.close()));
    await Promise.all(tmpFiles.map((f) => fs.rm(f, { force: true })));
    sources = [];
    mocks = [];
    tmpFiles = [];
  });

  it('lists sessions newest-updated first and maps fields, including a parentId', async () => {
    const mock = await startMock();
    mocks.push(mock);
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '1' } }), { baseUrl: mock.baseUrl });
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
    const mock = await startMock();
    mocks.push(mock);
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '1' } }), { baseUrl: mock.baseUrl });
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

  it('list() pages with a limit smaller than the session count, no overlap between pages', async () => {
    const mock = await startMock();
    mocks.push(mock);
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '1' } }), { baseUrl: mock.baseUrl });
    sources.push(src);

    const page1 = await src.list({ limit: 2 });
    expect(page1.items.map((i) => i.sessionId)).toEqual([libraryId('opencode', 'ses-b'), libraryId('opencode', 'ses-a')]);
    expect(page1.next).toBeTruthy();

    const page2 = await src.list({ limit: 2, cursor: page1.next });
    expect(page2.items.map((i) => i.sessionId)).toEqual([libraryId('opencode', 'ses-c')]);
    expect(page2.next).toBeUndefined();

    // no session repeated across pages, and together they cover every session exactly once
    const all = [...page1.items, ...page2.items].map((i) => i.sessionId);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([libraryId('opencode', 'ses-a'), libraryId('opencode', 'ses-b'), libraryId('opencode', 'ses-c')].sort());
  });

  it('read() pages more turns than the page size, older page via next, chronological, no duplicates at the boundary', async () => {
    const mock = await startMock();
    mocks.push(mock);
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '1' } }), { baseUrl: mock.baseUrl });
    sources.push(src);

    // 3 turns total, page size 2: newest page = turns 2,3; older page (via next) = turn 1.
    const page1 = await src.read('ses-multi', { limit: 2 });
    const texts1 = page1.messages.filter((m: any) => m.type === 'user').map((m: any) => m.message.content[0].text);
    expect(texts1).toEqual(['turn 2 user', 'turn 3 user']); // chronological within the page
    expect(page1.next).toBeTruthy();
    expect(JSON.stringify(page1.messages)).not.toContain('turn 1');

    const page2 = await src.read('ses-multi', { limit: 2, cursor: page1.next });
    const texts2 = page2.messages.filter((m: any) => m.type === 'user').map((m: any) => m.message.content[0].text);
    expect(texts2).toEqual(['turn 1 user']);
    expect(page2.next).toBeUndefined();

    // no message text duplicated across the two pages
    const allTexts = [...texts1, ...texts2];
    expect(new Set(allTexts).size).toBe(allTexts.length);
    expect(allTexts.sort()).toEqual(['turn 1 user', 'turn 2 user', 'turn 3 user']);
  });

  it('close() during an in-flight start kills the process once it spawns instead of leaking it', async () => {
    const pidFile = path.join(os.tmpdir(), `cw-opencode-pid-${process.pid}-${Date.now()}.txt`);
    tmpFiles.push(pidFile);
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_SERVE_DELAY_MS: '300', FAKE_PID_FILE: pidFile } }));
    sources.push(src);

    const listPromise = src.list({ limit: 10 }); // kicks off ensure() -> spawnProc(), ~300ms from "listening"
    await src.close(); // races the in-flight start
    // ensure() rejected once the race was detected -> list() surfaces it (the library keeps its cache)
    await expect(listPromise).rejects.toThrow(/close\(\)/);

    // give the fake process time to reach its (delayed) "listening" point and be reaped by our race fix
    await new Promise((r) => setTimeout(r, 600));
    const pidText = await fs.readFile(pidFile, 'utf8');
    const pid = Number(pidText);
    expect(Number.isFinite(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  const waitPid = async (file: string) => {
    let pid = NaN;
    for (let i = 0; i < 100 && !Number.isFinite(pid); i++) {
      await new Promise((r) => setTimeout(r, 100));
      pid = Number(await fs.readFile(file, 'utf8').catch(() => 'x'));
    }
    return pid;
  };
  const waitDead = async (pid: number) => {
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); } catch { return true; }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  // the real tree on Windows is cmd.exe -> node -> opencode.exe: killing the top pid alone leaves
  // `opencode serve` (an unsecured HTTP server) running
  it.each([
    ['node-shim launcher', fakeCli],
    ['cmd.exe launcher', path.join(here, '__mocks__', 'opencode-cli-wrapped.cmd')],
  ])('close() kills the whole `opencode serve` tree (%s)', async (_name, command) => {
    const gcFile = path.join(os.tmpdir(), `cw-opencode-gc-${process.pid}-${Date.now()}.txt`);
    tmpFiles.push(gcFile);
    const src = new OpenCodeSource(() => ({ command, env: { FAKE_GRANDCHILD_PID_FILE: gcFile, FAKE_HAS_DELETE: '0' } }));
    sources.push(src);
    expect((await src.status()).enabled).toBe(true);
    const gc = await waitPid(gcFile);
    expect(Number.isFinite(gc)).toBe(true);
    await src.close();
    expect(await waitDead(gc)).toBe(true);
  });

  it('a `session delete` that hangs past its timeout is killed with its whole tree', async () => {
    const gcFile = path.join(os.tmpdir(), `cw-opencode-delgc-${process.pid}-${Date.now()}.txt`);
    tmpFiles.push(gcFile);
    const src = new OpenCodeSource(() => ({ command: path.join(here, '__mocks__', 'opencode-cli-wrapped.cmd'), env: { FAKE_DELETE_HANG_MS: '30000', FAKE_GRANDCHILD_PID_FILE: gcFile } }), { deleteTimeoutMs: 1500 });
    sources.push(src);
    await expect(src.remove('ses-a')).rejects.toThrow(/超时/);
    const gc = await waitPid(gcFile);
    expect(Number.isFinite(gc)).toBe(true);
    expect(await waitDead(gc)).toBe(true);
  });

  it('detects delete via `session --help` and remove() runs the official `session delete <id>` CLI', async () => {
    const argvFile = path.join(os.tmpdir(), `cw-opencode-delete-argv-${process.pid}-${Date.now()}.json`);
    tmpFiles.push(argvFile);
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '1', FAKE_ARGV_FILE: argvFile } }));
    sources.push(src);

    const status = await src.status();
    expect(status.enabled).toBe(true);
    await src.whenCapsProbed(); // the probe runs in the background; status() doesn't wait for it
    expect(src.caps).toEqual({ resume: true, rename: false, archive: false, delete: true, fork: false });

    await src.remove('ses-a');
    const recorded = JSON.parse(await fs.readFile(argvFile, 'utf8'));
    expect(recorded).toEqual(['session', 'delete', 'ses-a']);
  });

  it('caps.delete is false when `session --help` lists no delete subcommand, and no rename() exists', async () => {
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '0' } }));
    sources.push(src);

    const status = await src.status();
    expect(status.enabled).toBe(true);
    await src.whenCapsProbed();
    expect(src.caps.delete).toBe(false);
    expect(src.caps.rename).toBe(false);
    expect((src as any).rename).toBeUndefined();
  });

  it('remove() throws with the stderr tail when the CLI exits non-zero', async () => {
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_EXIT_CODE: '1' } }));
    sources.push(src);
    await expect(src.remove('ses-a')).rejects.toThrow(/fake delete failure/);
  });

  it('not installed: status disabled, list() / read() empty', async () => {
    const src = new OpenCodeSource(() => ({ command: 'definitely-not-a-real-opencode-binary-xyz', env: {} }));
    sources.push(src);

    const status = await src.status();
    expect(status.enabled).toBe(false);
    const listed = await src.list({ limit: 10 });
    expect(listed.items).toEqual([]);
    expect((await src.read('ses-a', { limit: 10 })).messages).toEqual([]);
  });

  it('a failed `session --help` probe backs off, then is retried', async () => {
    const mock = await startMock();
    mocks.push(mock);
    let launch = { command: path.join(here, '__mocks__', 'no-such-opencode.cmd'), env: {} as Record<string, string> };
    let retryMs = 300_000;
    const src = new OpenCodeSource(() => launch, { baseUrl: mock.baseUrl, get capsRetryMs() { return retryMs; } });
    sources.push(src);
    expect((await src.list({ limit: 10 })).items[0].caps?.delete).toBe(false);
    await src.whenCapsProbed();
    launch = { command: fakeCli, env: { FAKE_HAS_DELETE: '1' } };
    // within the back-off window: no new probe
    await src.list({ limit: 10 });
    await src.whenCapsProbed();
    expect(src.caps.delete).toBe(false);
    retryMs = 0;
    await src.list({ limit: 10 });
    await src.whenCapsProbed();
    expect((await src.list({ limit: 10 })).items[0].caps?.delete).toBe(true);
  });

  it('a hanging `session --help` never delays list(): caps stay delete:false meanwhile', async () => {
    const mock = await startMock();
    mocks.push(mock);
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '1', FAKE_HELP_HANG_MS: '4000' } }), { baseUrl: mock.baseUrl });
    sources.push(src);
    const t0 = Date.now();
    const { items } = await src.list({ limit: 10 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(items[0].caps?.delete).toBe(false);
    expect((await src.status()).enabled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('close() kills an in-flight `session --help` probe', async () => {
    const mock = await startMock();
    mocks.push(mock);
    const pidFile = path.join(os.tmpdir(), `cw-opencode-probe-pid-${process.pid}-${Date.now()}.txt`);
    tmpFiles.push(pidFile);
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HELP_HANG_MS: '15000', FAKE_PROBE_PID_FILE: pidFile } }), { baseUrl: mock.baseUrl });
    sources.push(src);
    await src.list({ limit: 10 }); // starts the probe in the background
    let pid = NaN;
    for (let i = 0; i < 100 && !Number.isFinite(pid); i++) {
      await new Promise((r) => setTimeout(r, 100));
      pid = Number(await fs.readFile(pidFile, 'utf8').catch(() => 'x'));
    }
    expect(Number.isFinite(pid)).toBe(true);
    await src.close();
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });

  it('one project failing its GET /session does not hide the others; all failing rejects', async () => {
    let failAll = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/project') { res.end(JSON.stringify([{ id: 'gone', worktree: '/gone' }, { id: 'global', worktree: '/' }])); return; }
      const dir = decodeURIComponent(String(req.headers['x-opencode-directory'] ?? ''));
      if (url.pathname === '/session' && dir === '/' && !failAll) { res.end(JSON.stringify([SESSIONS[0]])); return; }
      res.writeHead(500); res.end('boom');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    mocks.push({ close: () => new Promise((r) => server.close(() => r())) });
    const addr = server.address() as { port: number };
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '0' } }), { baseUrl: `http://127.0.0.1:${addr.port}` });
    sources.push(src);
    expect((await src.list({ limit: 10 })).items.map((s) => s.sessionId)).toEqual([libraryId('opencode', 'ses-a')]);
    failAll = true;
    await expect(src.list({ limit: 10 })).rejects.toThrow(/500/);
  });

  it('lists every project: GET /project, then GET /session per worktree via x-opencode-directory', async () => {
    // real serve: plain GET /session only answers for the project of serve's own cwd
    const byDir: Record<string, any[]> = {
      '/': [SESSIONS[0], SESSIONS[1]],
      'C:\\仓库\\app': [{ ...SESSIONS[2], id: 'ses-git', parentID: undefined, time: { created: 1, updated: 900 } }, SESSIONS[0]],
    };
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/project') { res.end(JSON.stringify([{ id: 'global', worktree: '/' }, { id: 'abc', worktree: 'C:\\仓库\\app' }])); return; }
      if (url.pathname === '/session') {
        const h = req.headers['x-opencode-directory'];
        const dir = typeof h === 'string' ? decodeURIComponent(h) : undefined;
        seen.push(dir);
        res.end(JSON.stringify(dir === undefined ? [] : byDir[dir] ?? []));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    mocks.push({ close: () => new Promise((r) => server.close(() => r())) });
    const addr = server.address() as { port: number };
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '0' } }), { baseUrl: `http://127.0.0.1:${addr.port}` });
    sources.push(src);
    const { items } = await src.list({ limit: 10 });
    expect(items.map((s) => s.sessionId)).toEqual([libraryId('opencode', 'ses-git'), libraryId('opencode', 'ses-b'), libraryId('opencode', 'ses-a')]);
    expect(seen).toEqual(['/', 'C:\\仓库\\app']);
  });

  it('installed but the server answers HTTP 500: list() and read() reject', async () => {
    const server = http.createServer((_req, res) => { res.writeHead(500); res.end('boom'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    mocks.push({ close: () => new Promise((r) => server.close(() => r())) });
    const addr = server.address() as { port: number };
    const src = new OpenCodeSource(() => ({ command: fakeCli, env: { FAKE_HAS_DELETE: '0' } }), { baseUrl: `http://127.0.0.1:${addr.port}` });
    sources.push(src);
    await expect(src.list({ limit: 10 })).rejects.toThrow(/500/);
    await expect(src.read('ses-a', { limit: 10 })).rejects.toThrow(/500/);
  });
});
