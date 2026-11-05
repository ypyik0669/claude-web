import { describe, expect, it } from 'vitest';
import * as A from './anthropic.js';
import * as R from './openai-responses.js';
import { buildOutbound } from './convert.js';
import { SseParser } from './sse.js';
import type { IrEvent } from './ir.js';

// a structurally valid Fernet token: what OpenAI's encrypted_content looks like (signature.ts isValidGptReasoning)
const fernet = () => Buffer.concat([Buffer.from([0x80]), Buffer.from([0, 0, 0, 0, 0x69, 0x0a, 0x0b, 0x0c]), Buffer.alloc(16, 2), Buffer.alloc(32, 3), Buffer.alloc(32, 4)]).toString('base64url');

// Claude Code → gateway → a Codex account: the strength and the turn's reasoning must reach Codex
describe('Anthropic client ⇄ Codex (Responses) reasoning', () => {
  const enc = fernet();
  const anthropicBody = {
    model: 'gpt-5.1-codex',
    max_tokens: 32000,
    stream: true,
    output_config: { effort: 'high' },
    system: [{ type: 'text', text: 'You are Claude Code.' }],
    messages: [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Look at the failing test first.', signature: enc },
        { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'npm test' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '1 failed' }] },
    ],
  };

  it('sends effort + summary + include, and puts the reasoning item back before the tool call', () => {
    const ir = A.parseRequest(anthropicBody);
    const { body } = buildOutbound('responses', ir, { reasoning: true });
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.store).toBe(false);
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Look at the failing test first.' }], encrypted_content: enc },
      { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"npm test"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '1 failed' },
    ]);
  });

  it('max maps to xhigh; no effort asked → only the summary', () => {
    const ir = A.parseRequest({ ...anthropicBody, output_config: undefined });
    expect(buildOutbound('responses', ir, { reasoning: true }).body.reasoning).toEqual({ summary: 'auto' });
    expect(buildOutbound('responses', { ...ir, effort: 'max' }, { reasoning: true }).body.reasoning.effort).toBe('xhigh');
  });

  it('the cache shim (reasoning off) and non-reasoning models get none of it', () => {
    const ir = A.parseRequest(anthropicBody);
    const shim = buildOutbound('responses', ir).body;
    expect(shim.reasoning).toBeUndefined();
    expect(shim.include).toBeUndefined();
    expect(buildOutbound('responses', { ...ir, model: 'gpt-4o' }, { reasoning: true }).body.reasoning).toBeUndefined();
  });

  it('other formats never see the Codex reasoning', () => {
    const ir = A.parseRequest(anthropicBody);
    for (const o of ['anthropic', 'openai', 'gemini'] as const) expect(JSON.stringify(buildOutbound(o, { ...ir, model: 'm' }).body)).not.toContain(enc);
  });

  it('an unsigned or Claude-signed thinking block is still dropped', () => {
    const ir = A.parseRequest({ ...anthropicBody, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: '' }, { type: 'text', text: 'hi' }] }] });
    expect(ir.messages[0].parts).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('stream: summary deltas → thinking, encrypted_content → signature_delta, one block per reasoning item', () => {
    const p = new R.ResponsesStreamParser();
    const ev = (o: any) => p.feed({ data: JSON.stringify(o) });
    const events: IrEvent[] = [
      ...ev({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.1-codex' } }),
      ...ev({ type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } }),
      ...ev({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: 'Plan A.' }),
      ...ev({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 1, delta: 'Plan B.' }),
      ...ev({ type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan A.' }, { type: 'summary_text', text: 'Plan B.' }], encrypted_content: enc } }),
      ...ev({ type: 'response.output_item.added', item: { id: 'rs_2', type: 'reasoning' } }),
      ...ev({ type: 'response.output_item.done', item: { id: 'rs_2', type: 'reasoning', summary: [], encrypted_content: enc } }),
      ...ev({ type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_2', name: 'Bash', arguments: '' } }),
      ...ev({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"command":"ls"}' }),
      ...ev({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } }),
    ];
    expect(events.filter((e) => e.t === 'thinking').map((e: any) => e.text).join('')).toBe('Plan A.\n\nPlan B.');
    const r = new A.AnthropicStreamRenderer('gpt-5.1-codex');
    const sse = events.map((e) => r.push(e)).join('');
    const blocks: any[] = [];
    const sp = new SseParser();
    for (const m of [...sp.feed(sse), ...sp.end()]) {
      const j = JSON.parse(m.data);
      if (j.type === 'content_block_start') blocks[j.index] = { ...j.content_block };
      if (j.type === 'content_block_delta' && j.delta.type === 'thinking_delta') blocks[j.index].thinking += j.delta.thinking;
      if (j.type === 'content_block_delta' && j.delta.type === 'signature_delta') blocks[j.index].signature += j.delta.signature;
    }
    expect(blocks.map((b) => b.type)).toEqual(['thinking', 'thinking', 'tool_use']);
    expect(blocks[0]).toMatchObject({ thinking: 'Plan A.\n\nPlan B.', signature: enc });
    expect(blocks[1]).toMatchObject({ thinking: '', signature: enc });
  });

  it('non-stream: reasoning item → thinking block with the signature', () => {
    const ir = R.parseResponse({ id: 'resp_1', status: 'completed', output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Hmm.' }], encrypted_content: enc },
      { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
    ] });
    expect(A.renderResponse(ir, 'gpt-5.1-codex').content).toEqual([{ type: 'thinking', thinking: 'Hmm.', signature: enc }, { type: 'text', text: 'Done.' }]);
  });
});
