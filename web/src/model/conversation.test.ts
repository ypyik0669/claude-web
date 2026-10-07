import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyMessage, applyTranscript, createConversation, decodeAttachments, sessionRefMarker, findChainUuidBefore, prependTranscript, setConversationClock, turnItems, walkTools, type AssistantItem, type Conversation, type UserItem } from './conversation';
import { ERROR_HINT } from './health';

const FIXTURE = path.join(__dirname, '__fixtures__', 'tools.jsonl');
const USER_UUID = '11111111-2222-4333-8444-555555555555';

function loadFixture(): any[] {
  return fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  setConversationClock(() => now);
});

describe('fixture replay (real SDK stream: Read/Glob/Grep/Bash/WebFetch/TodoWrite + image Read)', () => {
  const msgs = loadFixture();

  function byName(c: Conversation) {
    const m: Record<string, ReturnType<typeof Array.from<any>>> = {};
    for (const { tool } of walkTools(c.items)) (m[tool.name] ??= []).push(tool);
    return m;
  }

  it('live replay produces one turn with every tool resolved', () => {
    const c = createConversation();
    for (const m of msgs) applyMessage(c, m);
    const tools = byName(c);
    expect(Object.keys(tools).sort()).toEqual(['Bash', 'Glob', 'Grep', 'Read', 'TodoWrite', 'WebFetch']);
    expect(tools.Read).toHaveLength(2);
    for (const { tool } of walkTools(c.items)) {
      expect(tool.status, tool.name).toBe('done');
      expect(tool.result, tool.name).toBeTruthy();
    }
    expect(c.lastResult?.isError).toBe(false);
    expect(c.lastResult?.errorKind).toBeUndefined();
    expect(c.runningTool).toBeNull();
    expect(c.streaming.size).toBe(0);
    expect(c.compacting).toBe(false);
  });

  it('keeps structured tool outputs and extracts images from tool_result', () => {
    const c = createConversation();
    applyTranscript(c, msgs);
    const tools = byName(c);
    const img = tools.Read.find((t: any) => t.result?.images?.length);
    expect(img, 'image Read').toBeTruthy();
    expect(img.result.images[0]).toMatch(/^data:image\/png;base64,/);
    expect((img.result.structured as any).type).toBe('image');
    const txt = tools.Read.find((t: any) => !t.result?.images);
    expect((txt.result.structured as any).type).toBe('text');
    expect((txt.result.structured as any).file.filePath).toMatch(/package\.json$/);
    expect(typeof (txt.result.structured as any).file.startLine).toBe('number');
    expect((tools.Grep[0].result.structured as any).mode).toBe('content');
    // official CLI reports numMatches; ccb reports numLines — the card accepts either
    const g = tools.Grep[0].result.structured as any;
    expect(typeof (g.numMatches ?? g.numLines)).toBe('number');
    expect((tools.Glob[0].result.structured as any).filenames.length).toBeGreaterThan(0);
    expect(typeof (tools.Bash[0].result.structured as any).stdout).toBe('string');
    expect((tools.WebFetch[0].result.structured as any).code).toBe(200);
    expect((tools.TodoWrite[0].result.structured as any).newTodos.length).toBe(2);
  });

  it('assistant items carry wrapper uuids and the merge is idempotent', () => {
    const c = createConversation();
    applyTranscript(c, msgs);
    const assistants = c.items.filter((i) => i.kind === 'assistant') as AssistantItem[];
    expect(assistants.length).toBeGreaterThan(0);
    for (const a of assistants) expect(a.uuid, a.id).toBeTruthy();
    const before = c.items.length;
    // re-applying the final assistant frames (what a late-joining client sees after transcript load) must not duplicate
    for (const m of msgs) if (m.type === 'assistant') applyMessage(c, m);
    expect(c.items.length).toBe(before);
    for (const { tool } of walkTools(c.items)) expect(tool.status).toBe('done');
  });

  it('records the client-minted uuid as the user item id (fork / rewind anchor)', () => {
    // the capture script sent with uuid; the server echoes user messages? No — the local echo is added by the store.
    // The transcript contains the uuid; here we simulate the store echo and check the chain helper.
    const c = createConversation();
    c.items.push({ kind: 'user', id: USER_UUID, text: 'prompt', images: [] });
    applyTranscript(c, msgs);
    const firstAssistant = c.items.find((i) => i.kind === 'assistant') as AssistantItem;
    expect(findChainUuidBefore(c, USER_UUID)).toBeNull(); // first message → fresh session
    expect(findChainUuidBefore(c, firstAssistant.id)).toBe(USER_UUID);
    expect(turnItems(c, USER_UUID).length).toBe(c.items.length);
  });
});

describe('health signals', () => {
  const base = { session_id: 's', uuid: 'u' };

  it('compact_boundary → percent freed; status compacting toggles', () => {
    const c = createConversation();
    applyMessage(c, { ...base, type: 'system', subtype: 'status', status: 'compacting' });
    expect(c.compacting).toBe(true);
    applyMessage(c, { ...base, type: 'system', subtype: 'compact_boundary', uuid: 'cb', compact_metadata: { trigger: 'auto', pre_tokens: 100_000, post_tokens: 40_000 } });
    expect(c.compacting).toBe(false);
    const sys = c.items.find((i) => i.kind === 'system' && i.subtype === 'compact') as any;
    expect(sys.text).toBe('上下文已自动压缩 · 释放 60%');
    applyMessage(c, { ...base, type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'boom' });
    expect(c.items.some((i) => i.kind === 'system' && i.subtype === 'compact_failed' && /boom/.test(i.text))).toBe(true);
  });

  it('api_retry and error results are classified', () => {
    const c = createConversation();
    applyMessage(c, { ...base, type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 2000, error_status: 429, error: 'rate_limit' });
    const retry = c.items.find((i) => i.kind === 'system' && i.subtype === 'retry') as any;
    expect(retry.data.kind).toBe('throttled');
    expect(retry.data.hint).toBeUndefined(); // a 429 usually clears by itself
    // a rejected key: what to check is said at once, under the first of the CLI's ten retries only
    applyMessage(c, { ...base, uuid: 'r401a', type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 600, error_status: 401, error: 'authentication_failed' });
    applyMessage(c, { ...base, uuid: 'r401b', type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 1200, error_status: 401, error: 'authentication_failed' });
    const r401 = c.items.filter((i) => i.kind === 'system' && i.subtype === 'retry' && (i as any).data.status === 401) as any[];
    expect(r401.map((i) => i.data.hint)).toEqual([ERROR_HINT.credential, undefined]);
    applyMessage(c, { ...base, type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'API Error: 401 authentication_error', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 });
    expect(c.lastResult?.errorKind).toBe('credential');
    applyMessage(c, { ...base, type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'prompt_too_long', errors: ['prompt is too long'], duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 });
    expect(c.lastResult?.errorKind).toBe('context');
    applyMessage(c, { ...base, type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'ok', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 });
    expect(c.lastResult?.errorKind).toBeUndefined();
  });

  it('a result the server marked cost_unknown (non-Claude model / Codex / ACP) carries costUnknown — never shown as $0', () => {
    const c = createConversation();
    applyMessage(c, { ...base, type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, cost_unknown: true });
    expect(c.lastResult?.costUnknown).toBe(true);
    applyMessage(c, { ...base, type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0.5 });
    expect(c.lastResult?.costUnknown).toBeFalsy();
  });

  it('rate_limit_event rejected → quota state + notice; later error result inherits quota kind', () => {
    const c = createConversation();
    applyMessage(c, { ...base, type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(now / 1000) + 3600, rateLimitType: 'five_hour', utilization: 1 } });
    expect(c.rateLimit?.status).toBe('rejected');
    expect(c.items.some((i) => i.kind === 'system' && i.subtype === 'rate_limit' && /5 小时/.test(i.text))).toBe(true);
    applyMessage(c, { ...base, type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'limit', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 });
    expect(c.lastResult?.errorKind).toBe('quota');
  });

  it('tool_progress marks the running tool; tool_result clears it; result clears everything', () => {
    const c = createConversation();
    applyMessage(c, { ...base, type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 5' } }] }, parent_tool_use_id: null });
    expect(c.runningTool?.name).toBe('Bash');
    expect(c.lastModelCallAt).toBe(now);
    now += 4000;
    applyMessage(c, { ...base, type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 4 });
    expect(c.toolIndex.get('t1')?.status).toBe('running');
    expect(c.runningTool?.elapsed).toBe(4);
    expect(c.lastEventAt).toBe(now);
    applyMessage(c, { ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] }, parent_tool_use_id: null, tool_use_result: { stdout: 'done', stderr: '', interrupted: false } });
    expect(c.runningTool).toBeNull();
    expect(c.toolIndex.get('t1')?.status).toBe('done');
  });

  it('refusal fallback evicts retracted frames; conversation_reset clears', () => {
    const c = createConversation();
    applyMessage(c, { ...base, type: 'assistant', uuid: 'bad', message: { id: 'mbad', role: 'assistant', content: [{ type: 'text', text: 'partial refusal' }] }, parent_tool_use_id: null });
    applyMessage(c, { ...base, type: 'system', subtype: 'model_refusal_fallback', uuid: 'rf', trigger: 'refusal', direction: 'retry', original_model: 'a', fallback_model: 'b', request_id: null, retracted_message_uuids: ['bad'], content: '' });
    expect(c.items.some((i) => i.kind === 'assistant' && i.id === 'mbad')).toBe(false);
    expect(c.items.some((i) => i.kind === 'system' && i.subtype === 'refusal')).toBe(true);
    // a late duplicate of the retracted frame is ignored
    applyMessage(c, { ...base, type: 'assistant', uuid: 'bad', message: { id: 'mbad', role: 'assistant', content: [{ type: 'text', text: 'partial refusal' }] }, parent_tool_use_id: null });
    expect(c.items.some((i) => i.kind === 'assistant' && i.id === 'mbad')).toBe(false);
    applyMessage(c, { ...base, type: 'conversation_reset', new_conversation_id: 'n', uuid: 'r' });
    expect(c.items.length).toBe(1);
    expect((c.items[0] as any).subtype).toBe('reset');
  });

  it('supersedes on an assistant frame evicts the named messages', () => {
    const c = createConversation();
    applyMessage(c, { ...base, type: 'assistant', uuid: 'old', message: { id: 'mold', role: 'assistant', content: [{ type: 'text', text: 'x' }] }, parent_tool_use_id: null });
    applyMessage(c, { ...base, type: 'assistant', uuid: 'new', supersedes: ['old'], message: { id: 'mnew', role: 'assistant', content: [{ type: 'text', text: 'y' }] }, parent_tool_use_id: null });
    expect(c.items.map((i) => i.id)).toEqual(['mnew']);
  });
});

describe('user messages', () => {
  it('decodes attachment markers and image blocks', () => {
    const c = createConversation();
    applyMessage(c, { type: 'user', uuid: 'u2', session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'look at this\n\n<attached kind="file" name="a.txt" path="C:\\x\\a.txt" size="12" />' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] } });
    const u = c.items[0] as UserItem;
    expect(u.text).toBe('look at this');
    expect(u.attachments).toEqual([{ kind: 'file', name: 'a.txt', path: 'C:\\x\\a.txt', size: 12 }]);
    expect(u.images[0]).toBe('data:image/png;base64,AAAA');
    expect(u.id).toBe('u2');
  });

  it('decodeAttachments turns session-ref markers (raw and server-expanded) into session chips', () => {
    const raw = `look at this\n\n${sessionRefMarker('codex-1', 'a "quoted" <title> & more')}`;
    const r = decodeAttachments(raw);
    expect(r.text).toBe('look at this');
    expect(r.attachments).toEqual([{ kind: 'session', name: 'a "quoted" <title> & more', sessionId: 'codex-1', error: undefined }]);
    const expanded = decodeAttachments('hi\n\n<referenced-session id="s-2" title="T">\n# briefing\nline\n</referenced-session>\n<referenced-session id="s-3" title="U" error="无法读取：gone" />');
    expect(expanded.text).toBe('hi');
    expect(expanded.attachments.map((a) => [a.sessionId, a.name, a.error])).toEqual([['s-2', 'T', undefined], ['s-3', 'U', '无法读取：gone']]);
  });

  it('decodeAttachments round-trips text-kind markers with inlined content', () => {
    const r = decodeAttachments('hello\n\n<attached kind="text" name="paste.txt" size="5">abcde</attached>');
    expect(r.text).toBe('hello');
    expect(r.attachments[0]).toEqual({ kind: 'text', name: 'paste.txt', size: 5, path: undefined });
  });

  it('flags system reminders as meta', () => {
    const c = createConversation();
    applyMessage(c, { type: 'user', uuid: 'u3', session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } });
    expect((c.items[0] as UserItem).meta).toBe(true);
  });

  it("hides the CLI's synthetic answer to its own resume nudge, keeps synthetic API errors (real transcript after a provider switch)", () => {
    const c = createConversation();
    applyTranscript(c, [
      { type: 'user', uuid: 'u1', parent_tool_use_id: null, message: { role: 'user', content: '你是什么模型' } },
      { type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'text', text: '我是 Claude Opus 4.6' }] } },
      { type: 'user', uuid: 'u2', isMeta: true, parent_tool_use_id: null, message: { role: 'user', content: 'Continue from where you left off.' } },
      { type: 'assistant', uuid: 'a2', parent_tool_use_id: null, message: { id: 'm2', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
      { type: 'user', uuid: 'u3', parent_tool_use_id: null, message: { role: 'user', content: '再问一次' } },
      { type: 'assistant', uuid: 'a3', parent_tool_use_id: null, message: { id: 'm3', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 429 Too Many Requests' }] } },
    ] as any[]);
    const texts = c.items.filter((i) => i.kind === 'assistant').map((i) => (i as AssistantItem).blocks.map((b: any) => b.text).join(''));
    expect(texts).toEqual(['我是 Claude Opus 4.6', 'API Error: 429 Too Many Requests']);
  });
});

describe('a turn still in flight', () => {
  const at = '2026-09-03T10:00:00.000Z';
  const live = [
    { type: 'user', uuid: 'u1', session_id: 's', timestamp: at, parent_tool_use_id: null, message: { role: 'user', content: '跑一下测试' } },
    { type: 'assistant', uuid: 'a1', session_id: 's', parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
  ];

  it('marks the turn start so the composer can count up from it', () => {
    const c = createConversation();
    applyMessage(c, live[0]);
    expect(c.turnStartedAt).toBeTypeOf('number');
    applyMessage(c, { type: 'result', uuid: 'r1', session_id: 's', subtype: 'success', duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, num_turns: 1, is_error: false, result: 'ok' });
    expect(c.turnStartedAt).toBeUndefined();
  });

  it('does not put a green check on a command that is still running', () => {
    const running = createConversation();
    applyTranscript(running, live, { live: true });
    const tool = [...walkTools(running.items)][0].tool;
    expect(tool.status).not.toBe('done');
    expect(running.runningTool?.name).toBe('Bash');
    expect(running.turnStartedAt).toBe(Date.parse(at)); // from the transcript, not the replay clock

    // the same transcript replayed for a session that is NOT live is finished, as before
    const finished = createConversation();
    applyTranscript(finished, live);
    expect([...walkTools(finished.items)][0].tool.status).toBe('done');
    expect(finished.runningTool).toBeNull();
  });

  it('an earlier turn whose tool never got a result does not hijack the in-flight turn', () => {
    const early = '2026-09-03T09:00:00.000Z';
    const msgs = [
      // turn 1: the process died mid-command — no tool_result was ever written
      { type: 'user', uuid: 'u0', session_id: 's', timestamp: early, parent_tool_use_id: null, message: { role: 'user', content: '先构建' } },
      { type: 'assistant', uuid: 'a0', session_id: 's', timestamp: early, parent_tool_use_id: null, message: { id: 'm0', role: 'assistant', content: [{ type: 'tool_use', id: 't0', name: 'Bash', input: { command: 'npm run build' } }] } },
      // turn 2, in flight
      ...live,
      { type: 'assistant', uuid: 'a2', session_id: 's', timestamp: at, parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'x' } }] } },
      { type: 'user', uuid: 'r1', session_id: 's', timestamp: at, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    ];
    const c = createConversation();
    applyTranscript(c, msgs, { live: true });
    const st = Object.fromEntries([...walkTools(c.items)].map(({ tool }) => [tool.id, tool.status]));
    expect(st.t0).toBe('done'); // earlier turn is over
    expect(st.t1).toBe('done');
    expect(st.t2).not.toBe('done');
    expect(c.runningTool?.id).toBe('t2');
  });
});

describe('stream lanes', () => {
  it('a message that never got message_stop stops streaming when the next one starts on the same lane', () => {
    const c = createConversation();
    const se = (event: any) => ({ type: 'stream_event', uuid: `e${Math.random()}`, session_id: 's', parent_tool_use_id: null, event });
    applyMessage(c, se({ type: 'message_start', message: { id: 'mA', model: 'x' } }));
    applyMessage(c, se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    applyMessage(c, se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half an ans' } }));
    // connection dropped, the CLI retries: a fresh message on the same lane
    applyMessage(c, se({ type: 'message_start', message: { id: 'mB', model: 'x' } }));
    const [a, b] = c.items as AssistantItem[];
    expect(a.id).toBe('mA');
    expect(a.streaming).toBe(false);
    expect(b.id).toBe('mB');
    expect(b.streaming).toBe(true);
  });
});

describe('a turn synthesised from an ACP / Codex agent (server/src/agents/normalize.ts MessageSynth)', () => {
  // the synth streams text / thinking with its own block counter and sends a tool call as one whole `assistant`
  // frame of the same message; at the end it restates the turn's text and thinking, concatenated
  const se = (event: any) => ({ type: 'stream_event', uuid: `e${Math.random()}`, session_id: 's', parent_tool_use_id: null, event });
  const msgs = [
    se({ type: 'message_start', message: { id: 'mA', role: 'assistant', content: [] } }),
    se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thinking about it' } }),
    se({ type: 'content_block_stop', index: 0 }),
    se({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    se({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Echo: please use a tool' } }),
    se({ type: 'content_block_stop', index: 1 }),
    { type: 'assistant', uuid: 'a1', session_id: 's', parent_tool_use_id: null, message: { id: 'mA', role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'C:/x/package.json' } }] } },
    { type: 'user', uuid: 'u1', session_id: 's', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: '{"name":"x"}' }] }] } },
    se({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
    se({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: ' (read ok)' } }),
    se({ type: 'content_block_stop', index: 2 }),
    se({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }),
    se({ type: 'message_stop' }),
    { type: 'assistant', uuid: 'a2', session_id: 's', parent_tool_use_id: null, message: { id: 'mA', role: 'assistant', content: [{ type: 'thinking', thinking: 'thinking about it' }, { type: 'text', text: 'Echo: please use a tool (read ok)' }] } },
    { type: 'result', uuid: 'r1', session_id: 's', subtype: 'success', is_error: false, result: 'x', duration_ms: 46, duration_api_ms: 46, num_turns: 2, total_cost_usd: 0, cost_unknown: true },
  ];

  it('keeps the tool call where it happened: text streamed after it does not take its slot, and the closing restatement adds nothing', () => {
    const c = createConversation();
    for (const m of msgs) applyMessage(c, m);
    const a = c.items.find((i) => i.kind === 'assistant') as AssistantItem;
    expect(a.blocks.map((b) => (b.type === 'text' ? `text:${b.text}` : b.type === 'thinking' ? `thinking:${b.thinking}` : `${b.type}:${b.name}`))).toEqual([
      'thinking:thinking about it', 'text:Echo: please use a tool', 'tool_use:Read', 'text: (read ok)',
    ]);
    expect(c.toolIndex.get('call-1')?.status).toBe('done');
    expect(c.items.filter((i) => i.kind === 'assistant')).toHaveLength(1);
  });

  it('a Claude stream (tool blocks streamed at their own index) is laid out as before', () => {
    const c = createConversation();
    for (const m of loadFixture()) applyMessage(c, m);
    const a = c.items.find((i) => i.kind === 'assistant') as AssistantItem;
    expect(a.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
  });
});

describe('thinking time (「思考了 12 秒」)', () => {
  const se = (event: any) => ({ type: 'stream_event', uuid: `e${Math.random()}`, session_id: 's', parent_tool_use_id: null, event });

  it('streamed: from the block start to its stop, kept when the final frame arrives', () => {
    const c = createConversation();
    applyMessage(c, se({ type: 'message_start', message: { id: 'mT', model: 'x' } }));
    applyMessage(c, se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    now += 4_000;
    applyMessage(c, se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }));
    now += 8_000;
    applyMessage(c, se({ type: 'content_block_stop', index: 0 }));
    applyMessage(c, { type: 'assistant', uuid: 'a', session_id: 's', parent_tool_use_id: null, message: { id: 'mT', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } });
    const b = (c.items[0] as AssistantItem).blocks[0] as any;
    expect(b.type).toBe('thinking');
    expect(b.ms).toBe(12_000);
  });

  it('transcript: from the line before it to the thinking line', () => {
    const c = createConversation();
    applyTranscript(c, [
      { type: 'user', uuid: 'u', session_id: 's', timestamp: '2026-09-28T10:00:00.000Z', parent_tool_use_id: null, message: { role: 'user', content: 'go' } },
      { type: 'assistant', uuid: 'a1', session_id: 's', timestamp: '2026-09-28T10:00:12.400Z', parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }] } },
      { type: 'assistant', uuid: 'a2', session_id: 's', timestamp: '2026-09-28T10:00:13.000Z', parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    const a = c.items[1] as AssistantItem;
    expect(a.blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
    expect((a.blocks[0] as any).ms).toBe(12_400);
  });

  it('no earlier time to count from → no number (the label falls back to words)', () => {
    const c = createConversation();
    applyTranscript(c, [{ type: 'assistant', uuid: 'a1', session_id: 's', timestamp: '2026-09-28T10:00:12.400Z', parent_tool_use_id: null, message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }] } }]);
    expect((c.items[0] as AssistantItem).blocks[0]).toEqual({ type: 'thinking', thinking: 'plan' });
  });
});

describe('prependTranscript (older history paging)', () => {
  const user = (uuid: string, text: string) => ({ type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content: text } });
  const asst = (uuid: string, id: string, content: any[]) => ({ type: 'assistant', uuid, parent_tool_use_id: null, message: { id, role: 'assistant', content } });

  it('puts the older page first', () => {
    const c = createConversation();
    applyTranscript(c, [user('u3', 'third'), asst('a3', 'm3', [{ type: 'text', text: 'three' }])]);
    prependTranscript(c, [user('u1', 'first'), asst('a1', 'm1', [{ type: 'text', text: 'one' }])]);
    expect(c.items.map((i) => i.id)).toEqual(['u1', 'm1', 'u3', 'm3']);
  });

  it('merges one API message split across the page boundary into a single item', () => {
    const c = createConversation();
    // newer page starts with the tool_use block of message mX; the older page ended with its text block
    applyTranscript(c, [asst('a2', 'mX', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]), user('u2', 'next')]);
    prependTranscript(c, [user('u1', 'go'), asst('a1', 'mX', [{ type: 'text', text: 'running ls' }])]);
    expect(c.items.map((i) => i.id)).toEqual(['u1', 'mX', 'u2']);
    const a = c.items[1] as AssistantItem;
    expect(a.blocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(c.toolIndex.get('t1')).toBe(a.blocks[1]);
  });

  it('drops items the newer page already has (overlapping pages)', () => {
    const c = createConversation();
    applyTranscript(c, [user('u2', 'b'), asst('a2', 'm2', [{ type: 'text', text: 'B' }])]);
    prependTranscript(c, [user('u1', 'a'), user('u2', 'b')]);
    expect(c.items.map((i) => i.id)).toEqual(['u1', 'u2', 'm2']);
  });

  it('keeps the live state of the newer page (running tool is not swept)', () => {
    const c = createConversation();
    applyTranscript(c, [user('u2', 'b'), asst('a2', 'm2', [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }])], { live: true });
    prependTranscript(c, [user('u1', 'a'), asst('a1', 'm1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }])]);
    expect(c.toolIndex.get('t2')!.status).toBe('pending');
    expect(c.runningTool?.id).toBe('t2');
    expect(c.toolIndex.get('t1')!.status).toBe('done');
  });
});
