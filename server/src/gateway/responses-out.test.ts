import { describe, expect, it } from 'vitest';
import * as C from './openai-chat.js';
import * as R from './openai-responses.js';
import { SseParser } from './sse.js';
import type { IrEvent } from './ir.js';

// chat/completions (what ccb sends) → IR → Responses (what new-api's Codex affinity rule routes on), and back.
const chat = {
  model: 'gpt-5.6',
  max_tokens: 64000,
  stream: true,
  stream_options: { include_usage: true },
  thinking: { type: 'enabled' },
  messages: [
    { role: 'system', content: 'You are Claude Code.' },
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: 'Sure.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
    { role: 'user', content: [{ type: 'text', text: 'and this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ],
  tools: [{ type: 'function', function: { name: 'Bash', description: 'Run', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
  tool_choice: 'auto',
  temperature: 1,
};

describe('IR → Responses request', () => {
  it('instructions / input items / tools, store:false + prompt_cache_key; no sampling knobs for reasoning models', () => {
    const ir = C.parseRequest(chat);
    const body = R.renderRequest({ ...ir, model: 'gpt-5.6', stream: true }, { cacheKey: 'cw:s1' });
    expect(body).toMatchObject({ model: 'gpt-5.6', store: false, stream: true, prompt_cache_key: 'cw:s1', instructions: 'You are Claude Code.', max_output_tokens: 64000, parallel_tool_calls: true, tool_choice: 'auto' });
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sure.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and this' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    ]);
    expect(body.tools).toEqual([{ type: 'function', name: 'Bash', description: 'Run', parameters: { type: 'object', properties: { command: { type: 'string' } } }, strict: false }]);
    expect(body.temperature).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('thinking');
    expect(R.renderRequest({ ...ir, model: 'gpt-4.1', stream: false }).temperature).toBe(1);
    expect(R.renderRequest({ ...ir, model: 'gpt-4.1', stream: false }).prompt_cache_key).toBeUndefined();
  });
  it('is deterministic (same history → same bytes, so the prefix caches)', () => {
    const a = JSON.stringify(R.renderRequest({ ...C.parseRequest(chat), model: 'gpt-5.6', stream: true }, { cacheKey: 'k' }));
    const b = JSON.stringify(R.renderRequest({ ...C.parseRequest(JSON.parse(JSON.stringify(chat))), model: 'gpt-5.6', stream: true }, { cacheKey: 'k' }));
    expect(a).toBe(b);
  });
});

const sse = (objs: any[]) => objs.map((o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`).join('');
function toChat(upstream: string, includeUsage = true) {
  const p = new SseParser();
  const parser = new R.ResponsesStreamParser();
  const r = new C.ChatStreamRenderer('gpt-5.6', includeUsage);
  const ir: IrEvent[] = [];
  for (const e of [...p.feed(upstream), ...p.end()]) ir.push(...parser.feed(e));
  ir.push(...parser.end());
  const text = ir.map((e) => r.push(e)).join('') + r.end();
  const q = new SseParser();
  return { ir, events: [...q.feed(text), ...q.end()].map((e) => e.data) };
}

describe('Responses stream → chat.completion.chunk', () => {
  const up = sse([
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', summary: [] } },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Run' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'ning' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Running' }] } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'Bash', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"command":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '"ls"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 2, arguments: '{"command":"ls"}' },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'Bash', arguments: '{"command":"ls"}' } },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 20_000, input_tokens_details: { cached_tokens: 18_000 }, output_tokens: 30 } } },
  ]);
  it('text, tool call, finish_reason tool_calls, usage with prompt_tokens_details.cached_tokens, [DONE]', () => {
    const { events } = toChat(up);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks.every((c) => c.object === 'chat.completion.chunk' && c.model === 'gpt-5.6')).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('Running');
    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(calls[0]).toEqual({ index: 0, id: 'call_9', type: 'function', function: { name: 'Bash', arguments: '' } });
    expect(calls.slice(1).map((c: any) => c.function.arguments).join('')).toBe('{"command":"ls"}'); // deltas only, the .done repeat is not appended
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    expect(chunks.at(-1).usage).toEqual({ prompt_tokens: 20_000, completion_tokens: 30, total_tokens: 20_030, prompt_tokens_details: { cached_tokens: 18_000 } });
  });
  it('items that arrive only whole (no deltas) still come through', () => {
    const { events } = toChat(sse([
      { type: 'response.created', response: { id: 'r', model: 'gpt-5.6' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', content: [{ type: 'output_text', text: 'whole' }] } },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'f', call_id: 'c', name: 'Read', arguments: '{"p":1}' } },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } } },
    ]));
    const chunks = events.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('whole');
    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
    expect(calls.map((c: any) => c.function.arguments).join('')).toBe('{"p":1}');
  });
  it('incomplete (max_output_tokens) → finish_reason length; failed / cut short → an error chunk', () => {
    const inc = toChat(sse([{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_text.delta', item_id: 'm', delta: 'x' }, { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 1 } } }]));
    expect(inc.events.map((d) => (d === '[DONE]' ? null : JSON.parse(d))).find((c) => c?.choices?.[0]?.finish_reason)?.choices[0].finish_reason).toBe('length');
    const failed = toChat(sse([{ type: 'response.created', response: { id: 'r' } }, { type: 'response.failed', response: { status: 'failed', error: { message: 'boom' } } }]));
    expect(failed.events.join('')).toContain('boom');
    const cut = toChat(sse([{ type: 'response.created', response: { id: 'r' } }, { type: 'response.output_text.delta', item_id: 'm', delta: 'x' }]));
    expect(cut.ir.at(-1)).toMatchObject({ t: 'error' });
  });
});

describe('Responses JSON → chat.completion', () => {
  it('non-stream', () => {
    const ir = R.parseResponse({ id: 'resp_2', model: 'gpt-5.6', status: 'completed', output: [{ type: 'reasoning', id: 'r' }, { type: 'message', content: [{ type: 'output_text', text: 'hi' }] }, { type: 'function_call', call_id: 'c1', name: 'Ls', arguments: '{"a":1}' }], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2 } });
    expect(ir).toMatchObject({ parts: [{ type: 'text', text: 'hi' }, { type: 'tool_call', id: 'c1', name: 'Ls', args: { a: 1 } }], stop: 'tool_use', usage: { input: 6, cacheRead: 4, output: 2 } });
    const out = C.renderResponse(ir, 'gpt-5.6');
    expect(out.choices[0]).toMatchObject({ message: { content: 'hi', tool_calls: [{ id: 'c1', function: { name: 'Ls', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' });
    expect(out.usage.prompt_tokens_details.cached_tokens).toBe(4);
  });
});
