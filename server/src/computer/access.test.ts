import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { PermissionRequestEvent } from '../protocol.js';
import { ACCESS_TOOL, ASK_TIMEOUT_MS, COMPUTER_SERVER, ComputerAccess, cleanRequest } from './access.js';
import { COMPUTER_ASK_PATH, handleComputerAsk } from './http.js';
import { computerAllowedTools, computerClaudeMcpServer, computerSupported, configureComputerMcp } from './launcher.js';
import { askHost } from './mcp.js';
import { TOOL_NAMES } from './tools.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** An access service with what it told the windows. */
function make(over: ConstructorParameters<typeof ComputerAccess>[0] = {}) {
  const access = new ComputerAccess(over);
  const asked: PermissionRequestEvent[] = [];
  const resolved: string[] = [];
  access.on('permission', (e) => asked.push(e));
  access.on('permissionResolved', (id) => resolved.push(id));
  return { access, asked, resolved };
}

describe('操控电脑: the user is asked by this app, whatever the conversation lets through', () => {
  it('the names: agents know the server as `computer` (`computer-use` is reserved by the engines)', () => {
    expect(COMPUTER_SERVER).toBe('computer');
    expect(ACCESS_TOOL).toBe('mcp__computer__request_access');
    // answered before Node's fetch stops waiting for the headers (five minutes)
    expect(ASK_TIMEOUT_MS).toBeLessThan(5 * 60_000);
  });

  it('a request becomes a permission card of that conversation; allow grants, deny says no with the user\'s words', async () => {
    const { access, asked, resolved } = make();
    const p = access.ask('conv-1', { apps: ['Notepad', '记事本'], reason: 'write the note', clipboardWrite: true });
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ sessionId: 'conv-1', toolName: 'mcp__computer__request_access', input: { apps: ['Notepad', '记事本'], reason: 'write the note', clipboardWrite: true } });
    expect(asked[0].suggestions).toBeUndefined(); // nothing to "always allow"
    expect(access.pendingFor('conv-1')).toEqual([asked[0]]);
    expect(access.pendingFor('conv-2')).toEqual([]);
    expect(access.respond('no-such-id', { behavior: 'allow' })).toBe(false);
    expect(access.respond(asked[0].requestId, { behavior: 'allow' })).toBe(true);
    expect(await p).toEqual({ granted: true });
    expect(resolved).toEqual([asked[0].requestId]);
    expect(access.pendingFor('conv-1')).toEqual([]);
    expect(access.respond(asked[0].requestId, { behavior: 'allow' })).toBe(false); // answered once

    const q = access.ask('conv-1', { apps: ['Excel'], reason: 'fill the sheet' });
    await tick();
    access.respond(asked[1].requestId, { behavior: 'deny', message: '  不要动我的表格 ' });
    const said = await q;
    expect(said.granted).toBe(false);
    expect((said as { message: string }).message).toContain('The user declined: 不要动我的表格.');
    expect((said as { message: string }).message).toContain('Nothing was granted');
    const r = access.ask('conv-1', { apps: ['Excel'], reason: 'x' });
    await tick();
    access.respond(asked[2].requestId, { behavior: 'deny', message: '' });
    expect(((await r) as { message: string }).message).toMatch(/^The user declined\. Nothing was granted/);
  });

  it('nobody answering is a no; so is a conversation that is not open here, and a caller that went away', async () => {
    const { access, asked, resolved } = make({ timeoutMs: 30, knows: (sid) => sid === 'open-here' });
    const late = await access.ask('open-here', { apps: ['Notepad'], reason: 'r' });
    expect(late.granted).toBe(false);
    expect((late as { message: string }).message).toContain('did not answer');
    expect(resolved).toHaveLength(1); // the card is taken away
    expect(access.respond(asked[0].requestId, { behavior: 'allow' })).toBe(false); // too late to say yes

    const stranger = await access.ask('some-other-id', { apps: ['Notepad'], reason: 'r' });
    expect(stranger.granted).toBe(false);
    expect((stranger as { message: string }).message).toContain('not open in Claude Web');
    expect((await access.ask('', { apps: ['Notepad'], reason: 'r' })).granted).toBe(false);
    expect(asked).toHaveLength(1); // nobody was shown anything for those

    const gone = new AbortController();
    const p = access.ask('open-here', { apps: ['Notepad'], reason: 'r' }, gone.signal);
    await tick();
    expect(access.pendingFor('open-here')).toHaveLength(1);
    gone.abort();
    expect((await p).granted).toBe(false);
    expect(access.pendingFor('open-here')).toEqual([]);

    // the conversation closing withdraws what it asked
    const open = make();
    const a = open.access.ask('c', { apps: ['A'], reason: 'r' });
    const b = open.access.ask('c', { apps: ['B'], reason: 'r' });
    const other = open.access.ask('d', { apps: ['C'], reason: 'r' });
    await tick();
    open.access.drop('c');
    expect((await a).granted).toBe(false);
    expect((await b).granted).toBe(false);
    expect(open.access.pendingFor('d')).toHaveLength(1);
    open.access.respond(open.asked[2].requestId, { behavior: 'allow' });
    expect((await other).granted).toBe(true);
  });

  it('what the card shows is made sure of: a few short names, one sentence, real flags', () => {
    expect(cleanRequest({ apps: [' Notepad ', 'Notepad', 7, '', 'x'.repeat(200)], reason: '  write\n the   note ', clipboardRead: 'yes', systemKeyCombos: true, extra: 1 }))
      .toEqual({ apps: ['Notepad', 'x'.repeat(80)], reason: 'write the note', systemKeyCombos: true });
    expect(cleanRequest({ apps: Array.from({ length: 50 }, (_, i) => `app${i}`), reason: 'r'.repeat(900) })).toMatchObject({ apps: { length: 20 }, reason: 'r'.repeat(500) });
    expect(cleanRequest({ apps: ['Notepad'] })).toEqual({ apps: ['Notepad'], reason: '' });
    for (const bad of [null, 'x', {}, { apps: 'Notepad' }, { apps: [] }, { apps: [1, null] }]) expect(cleanRequest(bad)).toBeNull();
  });

  it('the secret is per start', () => {
    const a = new ComputerAccess();
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(new ComputerAccess().token).not.toBe(a.token);
    expect(a.tokenOk(a.token)).toBe(true);
    expect(a.tokenOk('')).toBe(false);
    expect(a.tokenOk(`${a.token}0`)).toBe(false);
  });
});

describe('POST /api/computer/ask, and the MCP process asking through it', () => {
  let server: http.Server;
  let url = '';
  let env: ReturnType<typeof make>;
  let remote = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-computer-ask-'));

  beforeAll(async () => {
    env = make({ knows: (sid) => sid !== 'closed-conv' });
    server = http.createServer((req, res) => {
      (req.socket as any).cwRemote = remote; // (set per request: the test's fetch keeps its connection)
      if (!handleComputerAsk(env.access, req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown, token = env.access.token, method = 'POST') => fetch(`${url}${COMPUTER_ASK_PATH}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  const answerNext = async (behavior: 'allow' | 'deny') => {
    const n = env.asked.length;
    for (let i = 0; i < 200 && env.asked.length === n; i++) await tick();
    env.access.respond(env.asked[env.asked.length - 1].requestId, behavior === 'allow' ? { behavior } : { behavior, message: 'no' });
  };

  it('waits for the user and answers with their word', async () => {
    const yes = post({ sessionId: 'conv-9', apps: ['Notepad'], reason: 'write' });
    await answerNext('allow');
    const r = await yes;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ granted: true });
    expect(env.asked[env.asked.length - 1]).toMatchObject({ sessionId: 'conv-9', input: { apps: ['Notepad'], reason: 'write' } });
    const no = post({ sessionId: 'conv-9', apps: ['Notepad'], reason: 'write' });
    await answerNext('deny');
    expect(await (await no).json()).toMatchObject({ granted: false });
  });

  it('only for this start\'s secret, only POST, only a request that names applications; not there on the remote listener', async () => {
    const before = env.asked.length;
    expect((await post({ sessionId: 's', apps: ['A'], reason: 'r' }, 'wrong')).status).toBe(401);
    expect((await post({ sessionId: 's', apps: ['A'], reason: 'r' }, '')).status).toBe(401);
    expect((await post(null, env.access.token, 'GET')).status).toBe(405);
    expect((await post('not json')).status).toBe(400);
    expect((await post({ sessionId: 's', apps: [] })).status).toBe(400);
    expect((await post({ sessionId: 's', apps: ['A'], reason: 'x'.repeat(40_000) })).status).toBe(413);
    remote = true;
    try { expect((await post({ sessionId: 's', apps: ['A'], reason: 'r' })).status).toBe(404); } finally { remote = false; }
    expect(env.asked).toHaveLength(before); // nobody was shown anything
  });

  it('the caller going away takes the card with it', async () => {
    const before = env.asked.length;
    const gone = new AbortController();
    const p = fetch(`${url}${COMPUTER_ASK_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.access.token}` }, body: JSON.stringify({ sessionId: 'conv-gone', apps: ['A'], reason: 'r' }), signal: gone.signal }).catch(() => null);
    for (let i = 0; i < 200 && env.asked.length === before; i++) await tick();
    expect(env.access.pendingFor('conv-gone')).toHaveLength(1);
    gone.abort();
    await p;
    for (let i = 0; i < 200 && env.access.pendingFor('conv-gone').length; i++) await tick();
    expect(env.access.pendingFor('conv-gone')).toEqual([]);
  });

  it('askHost (the MCP process\'s side): the secret from its file, the conversation\'s id, and every failure a no the model can read', async () => {
    const file = path.join(dir, 'x.token');
    fs.writeFileSync(file, `${env.access.token}\n`);
    const ask = { apps: ['Notepad'], reason: 'write the note', clipboardRead: false, clipboardWrite: true, systemKeyCombos: false };
    const yes = askHost({ CW_COMPUTER_ASK_URL: `${url}/`, CW_COMPUTER_TOKEN_FILE: file, CW_SESSION_ID: 'conv-mcp' }, ask);
    await answerNext('allow');
    expect(await yes).toEqual({ granted: true });
    expect(env.asked[env.asked.length - 1]).toMatchObject({ sessionId: 'conv-mcp', input: { apps: ['Notepad'], reason: 'write the note', clipboardWrite: true } });
    const no = askHost({ CW_COMPUTER_ASK_URL: url, CW_COMPUTER_TOKEN: env.access.token, CW_SESSION_ID: 'conv-mcp' }, ask);
    await answerNext('deny');
    expect(await no).toMatchObject({ granted: false, message: expect.stringContaining('The user declined: no') });
    // a conversation this server does not have open
    expect(await askHost({ CW_COMPUTER_ASK_URL: url, CW_COMPUTER_TOKEN: env.access.token, CW_SESSION_ID: 'closed-conv' }, ask)).toMatchObject({ granted: false, message: expect.stringContaining('not open in Claude Web') });
    // a wrong secret, a file that is gone, nothing listening, no address: each a no
    expect(await askHost({ CW_COMPUTER_ASK_URL: url, CW_COMPUTER_TOKEN: 'wrong', CW_SESSION_ID: 's' }, ask)).toMatchObject({ granted: false, message: expect.stringContaining('HTTP 401') });
    expect(await askHost({ CW_COMPUTER_ASK_URL: url, CW_COMPUTER_TOKEN_FILE: path.join(dir, 'missing.token'), CW_SESSION_ID: 's' }, ask)).toMatchObject({ granted: false, message: expect.stringContaining('secret could not be read') });
    expect(await askHost({ CW_COMPUTER_ASK_URL: 'http://127.0.0.1:9', CW_COMPUTER_TOKEN: 't', CW_SESSION_ID: 's' }, ask)).toMatchObject({ granted: false, message: expect.stringContaining('could not be reached') });
    expect(await askHost({}, ask)).toMatchObject({ granted: false });
    // an answer that is not a clear yes is a no
    const odd = (async () => new Response(JSON.stringify({ granted: 'true' }), { status: 200 })) as unknown as typeof fetch;
    expect((await askHost({ CW_COMPUTER_ASK_URL: url, CW_COMPUTER_TOKEN: 't' }, ask, odd)).granted).toBe(false);
  });
});

describe('handing the `computer` server to a conversation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-computer-launch-'));
  afterAll(() => { configureComputerMcp(null, dir); fs.rmSync(dir, { recursive: true, force: true }); });

  it('nothing before the server is listening; on Windows the entry, where to ask, the secret as a file — never inline', () => {
    configureComputerMcp(null, dir);
    expect(computerClaudeMcpServer({ sessionId: 's' }, { platform: 'win32' })).toEqual({});
    expect(computerAllowedTools({ platform: 'win32' })).toEqual([]);
    configureComputerMcp({ url: 'http://127.0.0.1:45678', token: 't'.repeat(64) }, dir);
    const s = computerClaudeMcpServer({ sessionId: 'conv-7' }, { platform: 'win32', execPath: 'C:/node.exe' });
    expect(Object.keys(s)).toEqual(['computer']);
    expect(s.computer.command).toBe('C:/node.exe');
    expect(s.computer.args[s.computer.args.length - 1]).toMatch(/computer[\\/]mcp\.(ts|js)$/);
    expect(s.computer.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', CW_COMPUTER_ASK_URL: 'http://127.0.0.1:45678', CW_SESSION_ID: 'conv-7', CW_COMPUTER_TOKEN_FILE: path.join(dir, `${process.pid}.token`) });
    expect(s.computer.env.CLAUDE_WEB_DIR).toBeTruthy();
    // this object ends up on the CLI's command line
    expect(JSON.stringify(s)).not.toContain('t'.repeat(64));
    expect(fs.readFileSync(path.join(dir, `${process.pid}.token`), 'utf8')).toBe('t'.repeat(64));
    // under plain node this process is not the desktop app: no executable is named as "ours"
    expect('CW_COMPUTER_SELF_EXE' in s.computer.env).toBe(!!process.versions.electron);
  });

  it('every tool of it runs without the agent\'s own prompt (the user approves the applications instead); other platforms get nothing', () => {
    configureComputerMcp({ url: 'http://127.0.0.1:45678', token: 'x' }, dir);
    expect(computerAllowedTools({ platform: 'win32' })).toEqual(TOOL_NAMES.map((t) => `mcp__computer__${t}`));
    expect(computerAllowedTools({ platform: 'win32' })).toContain('mcp__computer__request_access');
    for (const platform of ['darwin', 'linux'] as const) {
      expect(computerSupported(platform)).toBe(false);
      expect(computerClaudeMcpServer({ sessionId: 's' }, { platform })).toEqual({});
      expect(computerAllowedTools({ platform })).toEqual([]);
    }
    configureComputerMcp(null, dir);
    expect(fs.existsSync(path.join(dir, `${process.pid}.token`))).toBe(false);
  });
});
