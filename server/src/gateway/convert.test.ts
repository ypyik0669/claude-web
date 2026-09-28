import { describe, expect, it } from 'vitest';
import { buildOutbound, inboundStreamRenderer, joinUrl, outboundStreamParser, parseInbound, parseOutboundResponse, renderInboundResponse, supported } from './convert.js';
import { SseParser } from './sse.js';
import { collect, type IrEvent } from './ir.js';
import { sanitizeSchema } from './gemini.js';

// Fixtures follow the documented shapes of each API.
const anthropicReq = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  system: [{ type: 'text', text: 'You are terse.', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'get_weather', description: 'Weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#' } }],
  tool_choice: { type: 'auto' },
  messages: [
    { role: 'user', content: 'Weather in Paris?' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }, { type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '18C sunny' }] }, { type: 'text', text: 'And tomorrow?' }] },
  ],
  stream: true,
};

const events = (sseText: string) => { const p = new SseParser(); return [...p.feed(sseText), ...p.end()]; };
const run = (outbound: 'anthropic' | 'openai' | 'gemini', sseText: string): IrEvent[] => {
  const parser = outboundStreamParser(outbound, 'm');
  const out: IrEvent[] = [];
  for (const e of events(sseText)) out.push(...parser.feed(e));
  out.push(...parser.end());
  return out;
};
const sse = (objs: unknown[], named = false) => objs.map((o: any) => `${named ? `event: ${o.type}\n` : ''}data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`).join('');

describe('routing table', () => {
  it('passthrough on same protocol, the six translation directions, 400 for the rest', () => {
    expect(supported('anthropic', 'anthropic')).toBe(true);
    expect(supported('responses', 'openai')).toBe(true);
    for (const [i, o] of [['anthropic', 'openai'], ['anthropic', 'gemini'], ['openai', 'anthropic'], ['responses', 'anthropic'], ['gemini', 'anthropic'], ['openai', 'gemini']] as const) expect(supported(i, o)).toBe(true);
    expect(supported('gemini', 'openai')).toBe(false);
    expect(supported('responses', 'gemini')).toBe(false);
  });
  it('joinUrl drops a duplicated version segment', () => {
    expect(joinUrl('https://api.openai.com/v1/', '/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    expect(joinUrl('https://open.bigmodel.cn/api/paas/v4', '/v1/chat/completions')).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    expect(joinUrl('https://relay.example', '/v1/messages?beta=true')).toBe('https://relay.example/v1/messages?beta=true');
    expect(joinUrl('https://generativelanguage.googleapis.com', '/v1beta/models/x:generateContent')).toBe('https://generativelanguage.googleapis.com/v1beta/models/x:generateContent');
  });
});

describe('anthropic in → openai out', () => {
  it('request: system, tools, tool_use / tool_result, thinking dropped', () => {
    const ir = parseInbound('anthropic', anthropicReq, { stream: true });
    const { path, body } = buildOutbound('openai', { ...ir, model: 'gpt-4.1' });
    expect(path).toBe('/v1/chat/completions');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are terse.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Weather in Paris?' });
    expect(body.messages[2]).toEqual({ role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: '18C sunny' });
    expect(body.messages[4]).toEqual({ role: 'user', content: 'And tomorrow?' });
    expect(body.tools[0].function.name).toBe('get_weather');
    expect(body.tool_choice).toBe('auto');
    expect(body.max_tokens).toBe(1024);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(JSON.stringify(body)).not.toContain('thinking');
    // reasoning-family models take max_completion_tokens
    expect(buildOutbound('openai', { ...ir, model: 'gpt-5' }).body.max_completion_tokens).toBe(1024);
  });
  it('non-stream response', () => {
    const ir = parseOutboundResponse('openai', { id: 'chatcmpl-1', object: 'chat.completion', model: 'gpt-4.1', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Rome"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 40 } } }, 'gpt-4.1');
    const out = renderInboundResponse('anthropic', ir, 'claude-sonnet-4-5', new Set());
    expect(out.type).toBe('message');
    expect(out.model).toBe('claude-sonnet-4-5');
    expect(out.content).toEqual([{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: 'Rome' } }]);
    expect(out.stop_reason).toBe('tool_use');
    expect(out.usage).toEqual({ input_tokens: 60, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 });
  });
  it('stream: chat chunks → message_start / content_block_* / message_delta / message_stop', () => {
    const up = sse([
      { id: 'c1', object: 'chat.completion.chunk', model: 'gpt-4.1', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }, finish_reason: null }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } },
      '[DONE]',
    ]);
    const ir = run('openai', up);
    const r = inboundStreamRenderer('anthropic', 'claude-x', { includeUsage: false, customTools: new Set() });
    const text = ir.map((e) => r.push(e)).join('') + r.end();
    const evs = events(text);
    expect(evs.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    const json = evs.map((e) => JSON.parse(e.data));
    expect(json[5].content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} });
    expect(json[6].delta).toEqual({ type: 'input_json_delta', partial_json: '{"city":' });
    expect(json[9].delta.stop_reason).toBe('tool_use');
    expect(json[9].usage.output_tokens).toBe(5);
    expect(json[9].usage.input_tokens).toBe(12);
  });
});

describe('anthropic in → gemini out', () => {
  it('request: contents / systemInstruction / functionDeclarations with sanitized schema', () => {
    const ir = parseInbound('anthropic', anthropicReq, { stream: false });
    const { path, body } = buildOutbound('gemini', { ...ir, model: 'gemini-2.5-flash', stream: false });
    expect(path).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are terse.' }] });
    expect(body.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(body.contents[1].parts[1]).toEqual({ functionCall: { name: 'get_weather', args: { city: 'Paris' } }, thoughtSignature: 'skip_thought_signature_validator' });
    expect(body.contents[2].parts[0]).toEqual({ functionResponse: { name: 'get_weather', response: { output: '18C sunny' } } });
    expect(body.tools[0].functionDeclarations[0].parameters).toEqual({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] });
    expect(body.generationConfig.maxOutputTokens).toBe(1024);
    expect(buildOutbound('gemini', { ...ir, model: 'gemini-2.5-flash', stream: true }).path).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
  });
  it('schema sanitizer: nullable unions, const, unsupported keys', () => {
    expect(sanitizeSchema({ type: ['string', 'null'], const: 'x', default: 'y', examples: [] })).toEqual({ type: 'string', nullable: true, enum: ['x'] });
  });
  it('stream: gemini candidates → anthropic events, function call with args', () => {
    const up = [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Sure' }] }, index: 0 }], modelVersion: 'gemini-2.5-flash', responseId: 'r1' },
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Oslo' } } }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 4, totalTokenCount: 34 } },
    ].map((o) => `data: ${JSON.stringify(o)}\r\n\r\n`).join('');
    const ir = run('gemini', up);
    const res = collect(ir);
    expect(res.parts[0]).toEqual({ type: 'text', text: 'Sure' });
    expect(res.parts[1]).toMatchObject({ type: 'tool_call', name: 'get_weather', args: { city: 'Oslo' } });
    expect(res.stop).toBe('tool_use');
    expect(res.usage).toMatchObject({ input: 30, output: 4 });
    const r = inboundStreamRenderer('anthropic', 'claude-x', { includeUsage: false, customTools: new Set() });
    const out = events(ir.map((e) => r.push(e)).join('') + r.end()).map((e) => JSON.parse(e.data));
    expect(out.at(-2).delta.stop_reason).toBe('tool_use');
    expect(out.find((e) => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta').delta.partial_json).toBe('{"city":"Oslo"}');
  });
  it('non-stream response', () => {
    const ir = parseOutboundResponse('gemini', { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text: 'ok' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3, cachedContentTokenCount: 4 } }, 'g');
    const out = renderInboundResponse('anthropic', ir, 'claude-x', new Set());
    expect(out.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(out.stop_reason).toBe('max_tokens');
    expect(out.usage).toMatchObject({ input_tokens: 6, output_tokens: 5, cache_read_input_tokens: 4 });
  });
});

describe('openai in → anthropic out', () => {
  const chatReq = {
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ls', arguments: '{"dir":"."}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
    ],
    tools: [{ type: 'function', function: { name: 'ls', parameters: { type: 'object', properties: { dir: { type: 'string' } } } } }],
    tool_choice: 'required',
    max_tokens: 50,
    stop: 'END',
    stream: true,
    stream_options: { include_usage: true },
  };
  it('request', () => {
    const ir = parseInbound('openai', chatReq, { stream: true });
    const { path, body } = buildOutbound('anthropic', ir);
    expect(path).toBe('/v1/messages');
    expect(body.system).toBe('Be brief.');
    expect(body.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(body.messages[1]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'ls', input: { dir: '.' } }] });
    expect(body.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt' }] });
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(body.stop_sequences).toEqual(['END']);
    expect(body.max_tokens).toBe(50);
    expect(body.stream).toBe(true);
  });
  it('stream: anthropic events → chat chunks + usage chunk + [DONE]', () => {
    const up = sse([
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'secret' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'ls', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"dir":"/"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ], true);
    const ir = run('anthropic', up);
    const r = inboundStreamRenderer('openai', 'claude-sonnet-4-5', { includeUsage: true, customTools: new Set() });
    const evs = events(ir.map((e) => r.push(e)).join('') + r.end());
    expect(evs.at(-1)!.data).toBe('[DONE]');
    const chunks = evs.slice(0, -1).map((e) => JSON.parse(e.data));
    expect(chunks[0].choices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks.map((c) => c.choices[0]?.delta?.content).filter(Boolean).join('')).toBe('Hi');
    expect(JSON.stringify(chunks)).not.toContain('secret');
    const tc = chunks.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.id);
    expect(tc.choices[0].delta.tool_calls[0]).toEqual({ index: 0, id: 'toolu_2', type: 'function', function: { name: 'ls', arguments: '' } });
    expect(chunks.find((c) => c.choices[0]?.finish_reason).choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.at(-1).usage).toEqual({ prompt_tokens: 25, completion_tokens: 9, total_tokens: 34, prompt_tokens_details: { cached_tokens: 5 } });
  });
  it('non-stream response', () => {
    const ir = parseOutboundResponse('anthropic', { id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'Yo' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }, 'x');
    const out = renderInboundResponse('openai', ir, 'claude-x', new Set());
    expect(out.object).toBe('chat.completion');
    expect(out.choices[0]).toMatchObject({ message: { role: 'assistant', content: 'Yo' }, finish_reason: 'stop' });
    expect(out.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 1 });
  });
});

describe('openai (responses) in → anthropic out', () => {
  const respReq = {
    model: 'gpt-5-codex',
    instructions: 'You are Codex.',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'env: windows' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'xxx', summary: [] },
      { type: 'function_call', call_id: 'call_a', name: 'shell', arguments: '{"command":["ls"]}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'a b' },
      { type: 'custom_tool_call', call_id: 'call_b', name: 'apply_patch', input: '*** Begin Patch' },
      { type: 'custom_tool_call_output', call_id: 'call_b', output: 'Done' },
    ],
    tools: [
      { type: 'function', name: 'shell', description: 'Run', parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } } },
      { type: 'custom', name: 'apply_patch', description: 'Patch files', format: { type: 'grammar', syntax: 'lark', definition: 'start: x' } },
      { type: 'web_search' },
    ],
    tool_choice: 'auto',
    stream: true,
  };
  it('request', () => {
    const ir = parseInbound('responses', respReq, { stream: true });
    const { body } = buildOutbound('anthropic', { ...ir, model: 'claude-sonnet-4-5' });
    expect(body.system).toBe('You are Codex.\n\nenv: windows');
    expect(body.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'list files' }] });
    expect(body.messages[1].content[0]).toEqual({ type: 'tool_use', id: 'call_a', name: 'shell', input: { command: ['ls'] } });
    expect(body.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'call_a', content: 'a b' });
    expect(body.messages[3].content[0]).toEqual({ type: 'tool_use', id: 'call_b', name: 'apply_patch', input: { input: '*** Begin Patch' } });
    expect(body.tools.map((t: any) => t.name)).toEqual(['shell', 'apply_patch']);
    expect(body.tools[1].description).toContain('start: x');
    expect(JSON.stringify(body)).not.toContain('encrypted_content');
  });
  it('stream: anthropic events → response.* events ending in response.completed', () => {
    const up = sse([
      { type: 'message_start', message: { id: 'msg_1', model: 'claude', usage: { input_tokens: 11, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Running' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_s', name: 'shell', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":["dir"]}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_p', name: 'apply_patch', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"input":"*** Begin Patch"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ], true);
    const ir = run('anthropic', up);
    const r = inboundStreamRenderer('responses', 'gpt-5-codex', { includeUsage: false, customTools: new Set(['apply_patch']) });
    const evs = events(ir.map((e) => r.push(e)).join('') + r.end());
    const types = evs.map((e) => e.event);
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types).toContain('response.function_call_arguments.delta');
    expect(types.at(-1)).toBe('response.completed');
    const data = evs.map((e) => JSON.parse(e.data));
    expect(data.every((d, i) => d.sequence_number === i && d.type === types[i])).toBe(true);
    const done = data.filter((d) => d.type === 'response.output_item.done').map((d) => d.item);
    expect(done[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: 'Running' }] });
    expect(done[1]).toMatchObject({ type: 'function_call', call_id: 'toolu_s', name: 'shell', arguments: '{"command":["dir"]}' });
    expect(done[2]).toMatchObject({ type: 'custom_tool_call', call_id: 'toolu_p', name: 'apply_patch', input: '*** Begin Patch' });
    const completed = data.at(-1).response;
    expect(completed.status).toBe('completed');
    expect(completed.output).toHaveLength(3);
    expect(completed.usage).toMatchObject({ input_tokens: 11, output_tokens: 20 });
  });
  it('non-stream response', () => {
    const ir = parseOutboundResponse('anthropic', { id: 'msg_1', content: [{ type: 'text', text: 'hello' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }, 'x');
    const out = renderInboundResponse('responses', ir, 'gpt-5-codex', new Set());
    expect(out.object).toBe('response');
    expect(out.status).toBe('incomplete');
    expect(out.output[0]).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] });
  });
});

describe('gemini in → anthropic out', () => {
  const gemReq = {
    systemInstruction: { parts: [{ text: 'Sys' }] },
    contents: [
      { role: 'user', parts: [{ text: 'read it' }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a' } }, thoughtSignature: 'abc' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'content' } } }] },
    ],
    tools: [{ functionDeclarations: [{ name: 'read_file', description: 'Read', parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } } } }] }],
    generationConfig: { maxOutputTokens: 100, temperature: 0.2 },
  };
  it('request: ids paired by order, schema types lower-cased', () => {
    const ir = parseInbound('gemini', gemReq, { stream: true, model: 'gemini-2.5-pro' });
    expect(ir.model).toBe('gemini-2.5-pro');
    const { body } = buildOutbound('anthropic', { ...ir, model: 'claude-sonnet-4-5' });
    const call = body.messages[1].content[0];
    const result = body.messages[2].content[0];
    expect(call.type).toBe('tool_use');
    expect(result).toEqual({ type: 'tool_result', tool_use_id: call.id, content: 'content' });
    expect(body.tools[0].input_schema).toEqual({ type: 'object', properties: { path: { type: 'string' } } });
    expect(body.temperature).toBe(0.2);
    expect(body.system).toBe('Sys');
  });
  it('stream: anthropic events → gemini chunks', () => {
    const up = sse([
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ], true);
    const r = inboundStreamRenderer('gemini', 'gemini-2.5-pro', { includeUsage: false, customTools: new Set() });
    const chunks = events(run('anthropic', up).map((e) => r.push(e)).join('') + r.end()).map((e) => JSON.parse(e.data));
    expect(chunks[0].candidates[0].content.parts[0]).toEqual({ text: 'ok' });
    expect(chunks[1].candidates[0].content.parts[0].functionCall).toEqual({ id: 't1', name: 'read_file', args: { path: 'b' } });
    expect(chunks.at(-1).candidates[0].finishReason).toBe('STOP');
    expect(chunks.at(-1).usageMetadata).toMatchObject({ promptTokenCount: 5, candidatesTokenCount: 3 });
  });
});

describe('openai in → gemini out', () => {
  it('request + non-stream response', () => {
    const ir = parseInbound('openai', { model: 'gpt', messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }], max_completion_tokens: 9 }, { stream: false });
    const { path, body } = buildOutbound('gemini', { ...ir, model: 'gemini-2.5-flash' });
    expect(path).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], systemInstruction: { parts: [{ text: 'S' }] }, generationConfig: { maxOutputTokens: 9 } });
    const res = parseOutboundResponse('gemini', { candidates: [{ content: { parts: [{ text: 'yo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } }, 'gemini-2.5-flash');
    const out = renderInboundResponse('openai', res, 'gpt', new Set());
    expect(out.choices[0].message.content).toBe('yo');
    expect(out.usage.total_tokens).toBe(3);
  });
  it('stream: gemini chunks → chat chunks', () => {
    const up = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'a' }] } }] })}\r\n\r\ndata: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'b' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } })}\r\n\r\n`;
    const r = inboundStreamRenderer('openai', 'gpt', { includeUsage: false, customTools: new Set() });
    const evs = events(run('gemini', up).map((e) => r.push(e)).join('') + r.end());
    expect(evs.at(-1)!.data).toBe('[DONE]');
    const chunks = evs.slice(0, -1).map((e) => JSON.parse(e.data));
    expect(chunks.map((c) => c.choices[0].delta.content ?? '').join('')).toBe('ab');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('stop');
  });
});

describe('stream robustness', () => {
  it('an upstream cut short becomes an error event, not a silent end', () => {
    const up = sse([{ type: 'message_start', message: { id: 'm', usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }], true);
    const ir = run('anthropic', up);
    expect(ir.at(-1)).toMatchObject({ t: 'error' });
  });
  it('SSE parser handles CRLF split across chunks and multi-line data', () => {
    const p = new SseParser();
    const a = p.feed('event: x\r');
    const b = p.feed('\ndata: 1\ndata: 2\r\n\r\n');
    expect([...a, ...b]).toEqual([{ event: 'x', data: '1\n2' }]);
  });
});
