import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyMessage, applyTranscript, createConversation, decodeAttachments, findChainUuidBefore, setConversationClock, turnItems, walkTools, type AssistantItem, type Conversation, type UserItem } from './conversation';

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
    applyMessage(c, { ...base, type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'API Error: 401 authentication_error', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 });
    expect(c.lastResult?.errorKind).toBe('credential');
    applyMessage(c, { ...base, type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'prompt_too_long', errors: ['prompt is too long'], duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 });
    expect(c.lastResult?.errorKind).toBe('context');
    applyMessage(c, { ...base, type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'ok', duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0 });
    expect(c.lastResult?.errorKind).toBeUndefined();
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
