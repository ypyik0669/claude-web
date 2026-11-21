import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeBridgeDriver, ClaudeBridgeServer, type BridgeOptions } from './claude-bridge.js';
import { BridgeError, CliOutput, bridgeEnv, cliArgs, loopRisk, makeWorkDir, synthesizeEvents, toCliTurn } from './claude-bridge-core.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-bridge.fake-cli.mjs');
const KEY = 'test-key-123';

let tmp: string;
let servers: ClaudeBridgeServer[] = [];

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-bridge-')); });
afterEach(async () => {
  for (const s of servers) await s.stop();
  servers = [];
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const SERVER_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: tmp, USERPROFILE: tmp,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:3090/gw', ANTHROPIC_API_KEY: 'sk-should-not-pass', ANTHROPIC_AUTH_TOKEN: 'x',
  CLAUDE_WEB_DIR: '/x', CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', OPENAI_API_KEY: 'sk-o', SECRET_THING: 'nope',
};

async function bridge(extra: Partial<BridgeOptions> = {}) {
  const s = new ClaudeBridgeServer({
    key: KEY, cli: () => ({ command: process.execPath, args: [FAKE] }), env: { ...SERVER_ENV, HOME: tmp, USERPROFILE: tmp },
    ownPorts: () => [3090], managedSettings: [path.join(tmp, 'managed-settings.json')], workRoot: path.join(tmp, 'work'),
    models: () => ['opus', 'sonnet'], ...extra,
  });
  servers.push(s);
  const port = await s.start();
  return { s, url: `http://127.0.0.1:${port}` };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, ...headers }, body: JSON.stringify(body),
});
const ask = (text: string, extra: Record<string, unknown> = {}) => ({ model: 'sonnet', max_tokens: 100, messages: [{ role: 'user', content: text }], ...extra });

function parseSse(text: string): any[] {
  return text.split('\n\n').filter((c) => c.trim()).map((c) => JSON.parse(c.split('\n').find((l) => l.startsWith('data: '))!.slice(6)));
}

describe('claude bridge: request mapping', () => {
  it('turns a Messages body into one stream-json user line, history folded into text', () => {
    const t = toCliTurn({
      model: 'claude-opus-4-7', system: [{ type: 'text', text: 'Be brief.' }], stream: true,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: 'what now?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      ],
    });
    expect(t.system).toBe('Be brief.');
    expect(t.stream).toBe(true);
    const line = JSON.parse(t.input);
    expect(line.type).toBe('user');
    const c = line.message.content;
    expect(c[0].text).toContain('<conversation_history>');
    expect(c[0].text).toContain('[assistant]\nhello');
    expect(c[1]).toEqual({ type: 'text', text: 'what now?' });
    expect(c[2].type).toBe('image');
  });

  it('refuses what the CLI cannot do honestly: tools, prefill, bad model ids', () => {
    expect(() => toCliTurn(ask('x', { tools: [{ name: 'a', input_schema: {} }] }))).toThrow(/tool use is not supported/);
    expect(() => toCliTurn(ask('x', { tools: [{ name: 'a' }], tool_choice: { type: 'none' } }))).not.toThrow();
    expect(() => toCliTurn({ model: 'sonnet', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] })).toThrow(BridgeError);
    expect(() => toCliTurn({ model: 'a b; rm', messages: [{ role: 'user', content: 'a' }] })).toThrow(/model/);
  });

  it('runs the CLI without tools, MCP, user settings or session files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-bridge-args-'));
    try {
      const work = makeWorkDir(root, 'sys');
      const a = cliArgs({ model: 'opus' }, work);
      expect(a).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']));
      expect(a[a.indexOf('--tools') + 1]).toBe('');
      expect(a[a.indexOf('--setting-sources') + 1]).toBe('project');
      // no JSON on the command line (cmd.exe would mangle its quotes): both configs are files
      expect(a.some((x) => x.includes('{'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(a[a.indexOf('--settings') + 1], 'utf8')).env.ANTHROPIC_BASE_URL).toBe('');
      expect(JSON.parse(fs.readFileSync(a[a.indexOf('--mcp-config') + 1], 'utf8'))).toEqual({ mcpServers: {} });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('claude bridge: loop guard', () => {
  it('the CLI env is an allow-list: no ANTHROPIC_*, CLAUDE_WEB_*, CLAUDE_CODE_ENTRYPOINT, OPENAI_* or unknown vars', () => {
    const env = bridgeEnv(SERVER_ENV);
    expect(Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE_WEB_|OPENAI_|SECRET_)/.test(k) || k === 'CLAUDE_CODE_ENTRYPOINT')).toEqual([]);
    expect(env.PATH).toBe(SERVER_ENV.PATH);
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    expect(loopRisk(env, [3090], [])).toBeNull();
  });

  it('refuses a proxy on our own port and managed settings that send Claude Code to a local address', () => {
    expect(loopRisk({ HTTPS_PROXY: 'http://127.0.0.1:3090' }, [3090], [])).toMatch(/claude-web itself/);
    expect(loopRisk({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, [3090], [])).toBeNull();
    expect(loopRisk({ ANTHROPIC_BASE_URL: 'https://x' }, [], [])).toMatch(/ANTHROPIC_BASE_URL/);
    const managed = path.join(tmp, 'managed.json');
    fs.writeFileSync(managed, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://localhost:3090' } }));
    expect(loopRisk({}, [], [managed])).toMatch(/managed settings/);
  });

  it('answers 508 to a request carrying the bridge loop header, and when managed settings point back at us', async () => {
    const managed = path.join(tmp, 'managed-settings.json');
    const { url } = await bridge();
    const looped = await post(url, ask('hi'), { 'x-claude-web-bridge': '1' });
    expect(looped.status).toBe(508);
    fs.writeFileSync(managed, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3090' } }));
    const r = await post(url, ask('hi'));
    expect(r.status).toBe(508);
    expect((await r.json()).error.message).toMatch(/loop/);
  });

  it('the CLI it starts sees none of the server env it must not, and runs in an empty temp folder', async () => {
    const { url } = await bridge();
    const r = await post(url, { ...ask('MODE:report'), system: 'SYS-PROMPT' });
    expect(r.status).toBe(200);
    const report = JSON.parse((await r.json()).content[0].text);
    expect(report.env.filter((k: string) => /^(ANTHROPIC_|CLAUDE_WEB_|OPENAI_|SECRET_)/i.test(k) || /^CLAUDE_CODE_ENTRYPOINT$/i.test(k))).toEqual([]);
    expect(report.system).toBe('SYS-PROMPT');
    expect(report.argv).toContain('--no-session-persistence');
    expect(fs.realpathSync(path.dirname(report.cwd))).toBe(fs.realpathSync(path.join(tmp, 'work')));
    // the run folder is gone afterwards
    await new Promise((res) => setTimeout(res, 100));
    expect(fs.existsSync(report.cwd)).toBe(false);
  });
});

describe('claude bridge: serving', () => {
  it('a kept port fetch refuses (6000, picked before) is dropped for a free one', async () => {
    const s = new ClaudeBridgeServer({ key: KEY, models: () => ['opus'] });
    servers.push(s);
    const port = await s.start(6000);
    expect(port).not.toBe(6000);
    expect((await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200);
  });

  it('needs the key, lists models', async () => {
    const { url } = await bridge();
    expect((await fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })).status).toBe(401);
    const models = await (await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } })).json();
    expect(models.data.map((m: any) => m.id)).toEqual(['opus', 'sonnet']);
  });

  it('non-streaming: one Anthropic message with usage', async () => {
    const { url } = await bridge();
    const r = await post(url, ask('hello there'));
    expect(r.status).toBe(200);
    const m = await r.json();
    expect(m).toMatchObject({ type: 'message', role: 'assistant', model: 'sonnet', stop_reason: 'end_turn', content: [{ type: 'text', text: 'echo: hello there' }] });
    expect(m.usage).toMatchObject({ input_tokens: 7, output_tokens: 4 });
  });

  it('streaming: passes the CLI stream events through as SSE', async () => {
    const { url } = await bridge();
    const r = await post(url, ask('stream me', { stream: true }));
    expect(r.headers.get('content-type')).toMatch(/event-stream/);
    const evs = parseSse(await r.text());
    expect(evs.map((e) => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(evs.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text).join('')).toBe('echo: stream me');
  });

  it('an older CLI without stream events: the SSE is rebuilt from the final message', async () => {
    const { url } = await bridge();
    const evs = parseSse(await (await post(url, ask('MODE:legacy', { stream: true }))).text());
    expect(evs[0].type).toBe('message_start');
    expect(evs.at(-1).type).toBe('message_stop');
    expect(evs.find((e) => e.type === 'content_block_delta').delta.text).toBe('echo: MODE:legacy');
  });

  it('a CLI error becomes an Anthropic error (not logged in → 401)', async () => {
    const { url } = await bridge();
    const r = await post(url, ask('MODE:error'));
    expect(r.status).toBe(401);
    expect((await r.json()).error).toMatchObject({ type: 'authentication_error', message: expect.stringMatching(/login/) });
  });

  it('times out a CLI that stops answering and kills it', async () => {
    const { url, s } = await bridge({ idleMs: 300 });
    const r = await post(url, ask('MODE:hang'));
    expect(r.status).toBe(504);
    expect(s.active).toBe(0);
  });

  it('bounds concurrency: beyond the limit is 429 with retry-after', async () => {
    const { url } = await bridge({ maxConcurrent: 1 });
    const first = post(url, ask('MODE:slow'));
    await new Promise((res) => setTimeout(res, 100));
    const second = await post(url, ask('again'));
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('5');
    expect((await first).status).toBe(200);
    expect((await post(url, ask('after'))).status).toBe(200);
  });

  it('the stream accumulator keeps only the first API message', () => {
    const seen: string[] = [];
    const o = new CliOutput('m', (e) => seen.push(e.type));
    const ev = (event: any) => o.line(JSON.stringify({ type: 'stream_event', event }));
    ev({ type: 'message_start', message: { id: 'a', usage: { input_tokens: 1 } } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } });
    ev({ type: 'message_stop' });
    ev({ type: 'message_start', message: { id: 'b' } });
    expect(o.result()!.content).toEqual([{ type: 'text', text: 'x' }]);
    expect(seen).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'message_stop']);
    expect(synthesizeEvents(o.result()!).at(-1).type).toBe('message_stop');
  });
});

describe('claude bridge: the source', () => {
  function fakeProviders() {
    const list: any[] = [];
    return {
      list: () => list,
      refreshModels: async () => [],
      upsert: async (p: any) => {
        const cur = p.id ? list.find((x) => x.id === p.id) : undefined;
        if (cur) { Object.assign(cur, p); return cur; }
        const saved = { id: `p${list.length + 1}`, ...p };
        list.push(saved);
        return saved;
      },
      remove: async (id: string) => { const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); },
    };
  }
  function fakeMeta() {
    const links: Record<string, any> = {};
    return { channelLinks: () => links, saveChannels: async () => {} } as any;
  }

  it('add → an anthropic profile on 127.0.0.1 with its own key, listed as a subscription source; remove undoes it', async () => {
    const providers = fakeProviders();
    const meta = fakeMeta();
    const d = new ClaudeBridgeDriver({ providers: providers as any, meta, server: (key) => { const s = new ClaudeBridgeServer({ key, cli: () => ({ command: process.execPath, args: [FAKE] }), env: { PATH: process.env.PATH }, ownPorts: () => [], managedSettings: [], workRoot: path.join(tmp, 'w') }); servers.push(s); return s; } });
    expect(await d.add({ id: 'claude-bridge' } as any, {})).toBe('claude-bridge');
    const p = providers.list()[0];
    expect(p.type).toBe('anthropic');
    expect(p.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(meta.channelLinks()[p.id]).toEqual({ catalogId: 'claude-bridge', engine: 'claude-bridge' });
    const [src] = d.list({ providers: providers.list(), links: meta.channelLinks(), upstream: { accounts: [] } as any, engines: [], catalog: [] });
    expect(src).toMatchObject({ id: 'claude-bridge', category: 'subscription', health: 'ready', catalogId: 'claude-bridge' });
    // the profile's endpoint answers with the stored key
    const r = await fetch(`${p.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': p.apiKey }, body: JSON.stringify(ask('via profile')) });
    expect((await r.json()).content[0].text).toBe('echo: via profile');
    await d.remove();
    expect(providers.list()).toEqual([]);
    expect(meta.channelLinks()).toEqual({});
  });

  it('add refuses (and creates nothing) when the loop guard says no', async () => {
    const providers = fakeProviders();
    const managed = path.join(tmp, 'm.json');
    fs.writeFileSync(managed, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }));
    const d = new ClaudeBridgeDriver({ providers: providers as any, meta: fakeMeta(), server: (key) => new ClaudeBridgeServer({ key, cli: () => ({ command: process.execPath, args: [FAKE] }), env: {}, ownPorts: () => [], managedSettings: [managed] }) });
    await expect(d.add({ id: 'claude-bridge' } as any, {})).rejects.toThrow();
    expect(providers.list()).toEqual([]);
  });
});
