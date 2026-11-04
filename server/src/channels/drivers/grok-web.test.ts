import { afterEach, describe, expect, it } from 'vitest';
import { extractToolCalls, flatten, grokBody, parseCredential, parseLine } from './grok-web-core.js';
import { GrokWebServer, decodeKey, encodeKey } from './grok-web.js';

describe('grok-web credential', () => {
  it('takes the bare sso, sso=…, a whole Cookie header, and a trailing ua= with semicolons in it', () => {
    expect(parseCredential('abc.DEF-123')).toEqual({ sso: 'abc.DEF-123' });
    expect(parseCredential('sso=xyz')).toEqual({ sso: 'xyz' });
    expect(parseCredential('Cookie: a=1; sso=xyz; cf_clearance=cf; __cf_bm=bm')).toEqual({ sso: 'xyz', cfClearance: 'cf', cfBm: 'bm' });
    expect(parseCredential('sso=xyz; ua=Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143')).toEqual({ sso: 'xyz', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/143' });
    expect(parseCredential('a=1; b=2')).toBeNull();
    expect(parseCredential('')).toBeNull();
  });
  it('round-trips through the profile key', () => {
    const c = { sso: 's', cfClearance: 'c', ua: 'U; A' };
    expect(decodeKey(`Bearer ${encodeKey(c)}`)).toEqual(c);
    expect(decodeKey('sso=raw')).toEqual({ sso: 'raw' });
  });
});

describe('grok-web protocol', () => {
  it('sends a lone user turn as is, and flattens a conversation with tools and results', () => {
    expect(flatten({ messages: [{ role: 'user', content: 'hi' }] })).toBe('hi');
    const m = flatten({
      tools: [{ type: 'function', function: { name: 'Read', description: 'read', parameters: {} } }],
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'open a' }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', function: { name: 'Read', arguments: '{"p":"a"}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'A!' },
      ],
    });
    expect(m).toContain('[system]: be brief');
    expect(m).toContain('# Tools');
    expect(m).toContain('<tool_call>{"name":"Read","arguments":{"p":"a"}}</tool_call>');
    expect(m).toContain('[tool result t1]: A!');
    expect(grokBody({ model: 'grok-4.20-heavy', messages: [{ role: 'user', content: 'x' }] })).toMatchObject({ modeId: 'heavy', temporary: true, message: 'x' });
    expect(grokBody({ model: 'nope', messages: [] }).modeId).toBe('auto');
  });
  it('reads the NDJSON stream: text, thinking, images, errors', () => {
    expect(parseLine('{"result":{"response":{"token":"Hel","isThinking":false}}}')).toEqual([{ kind: 'text', text: 'Hel' }]);
    expect(parseLine('data: {"result":{"response":{"token":"hmm","isThinking":true}}}')).toEqual([{ kind: 'thinking', text: 'hmm' }]);
    expect(parseLine('{"result":{"response":{"modelResponse":{"generatedImageUrls":["users/1/a.png"]}}}}')[0]).toMatchObject({ kind: 'text', text: expect.stringContaining('https://assets.grok.com/users/1/a.png') });
    expect(parseLine('{"error":{"code":429,"message":"slow down"}}')).toEqual([{ kind: 'error', message: 'slow down', status: 429 }]);
    expect(parseLine('not json')).toEqual([]);
  });
  it('turns <tool_call> blocks into tool calls', () => {
    const r = extractToolCalls('Let me look.\n<tool_call>{"name":"Read","arguments":{"p":"a"}}</tool_call>');
    expect(r.content).toBe('Let me look.');
    expect(r.calls).toEqual([{ id: expect.stringMatching(/^call_/), name: 'Read', arguments: '{"p":"a"}' }]);
    expect(extractToolCalls('<tool_call>broken</tool_call>').calls).toEqual([]);
  });
});

describe('GrokWebServer', () => {
  let server: GrokWebServer | null = null;
  afterEach(async () => { await server?.stop(); server = null; });

  const fakeGrok = (lines: string[], status = 200, seen: { url?: string; body?: any; cookie?: string } = {}) => (async (url: any, init: any) => {
    seen.url = String(url);
    seen.body = JSON.parse(init.body);
    seen.cookie = init.headers.cookie;
    if (status !== 200) return new Response('nope', { status });
    return new Response(lines.join('\n'), { status: 200 });
  }) as typeof fetch;

  it('streams OpenAI chunks with reasoning, using the cookie it was sent', async () => {
    const seen: any = {};
    server = new GrokWebServer(fakeGrok(['{"result":{"response":{"token":"think","isThinking":true}}}', '{"result":{"response":{"token":"Hi"}}}', '{"result":{"response":{"token":" there"}}}'], 200, seen));
    const port = await server.start();
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${encodeKey({ sso: 'S1' })}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'grok-4.20-fast', stream: true, messages: [{ role: 'user', content: 'hey' }] }) });
    const text = await r.text();
    expect(seen.url).toBe('https://grok.com/rest/app-chat/conversations/new');
    expect(seen.body.modeId).toBe('fast');
    expect(seen.cookie).toContain('sso=S1');
    expect(text).toContain('"reasoning_content":"think"');
    expect(text).toContain('"content":"Hi"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('holds the text back when tools are given and answers with tool_calls', async () => {
    server = new GrokWebServer(fakeGrok(['{"result":{"response":{"token":"<tool_call>{\\"name\\":\\"Bash\\",\\"arguments\\":{\\"cmd\\":\\"ls\\"}}</tool_call>"}}}']));
    const port = await server.start();
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer sso=S2' }, body: JSON.stringify({ model: 'grok-4.20', tools: [{ type: 'function', function: { name: 'Bash', parameters: {} } }], messages: [{ role: 'user', content: 'ls' }] }) });
    const j = await r.json();
    expect(j.choices[0].finish_reason).toBe('tool_calls');
    expect(j.choices[0].message.tool_calls[0].function).toEqual({ name: 'Bash', arguments: '{"cmd":"ls"}' });
  });

  it('passes grok.com failures on with their status, and refuses a request without a cookie', async () => {
    server = new GrokWebServer(fakeGrok([], 401));
    const port = await server.start();
    const bad = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer sso=S3' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
    expect(bad.status).toBe(401);
    const none = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(none.status).toBe(401);
    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    expect(models.data.map((m: any) => m.id)).toContain('grok-4.20');
  });
});
