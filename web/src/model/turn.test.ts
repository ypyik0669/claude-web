import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyMessage, applyTranscript, createConversation, setConversationClock, type AssistantItem, type Item, type ResultItem, type ToolUseBlock, type UserItem } from './conversation';
import { fileChanges, sessionDiffStat } from './diffstat';
import { displayPath, fmtDuration, groupTurns, splitTurnBody, turnDone, turnMemo, turnStamp, turnSummary, turnSummaryParts, turnSummaryText, type TurnMemo } from './turn';

const FIXTURE = path.join(__dirname, '__fixtures__', 'tools.jsonl');
const loadFixture = (): any[] => fs.readFileSync(FIXTURE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  setConversationClock(() => now);
});

let n = 0;
const tool = (name: string, input: Record<string, unknown>, structured?: unknown, extra: Partial<ToolUseBlock> = {}): ToolUseBlock => ({
  type: 'tool_use', id: `tu${++n}`, name, input, children: [], status: 'done', result: { content: 'ok', isError: false, structured }, ...extra,
});
const asst = (...blocks: AssistantItem['blocks']): AssistantItem => ({ kind: 'assistant', id: `m${++n}`, blocks, streaming: false, parentToolUseId: null });
const user = (text: string, ts?: string, meta = false): UserItem => ({ kind: 'user', id: `u${++n}`, text, images: [], ts, meta });
const result = (durationMs: number, extra: Partial<ResultItem> = {}): ResultItem => ({ kind: 'result', id: `r${++n}`, subtype: 'success', durationMs, apiMs: 0, costUsd: 0, numTurns: 1, isError: false, ...extra });

describe('turnSummary against the captured stream (tools.jsonl)', () => {
  const msgs = loadFixture();

  it('live replay: one turn, the numbers the fixture has', () => {
    const c = createConversation();
    c.items.push({ kind: 'user', id: 'u-fixture', text: 'run the steps', images: [] });
    for (const m of msgs) applyMessage(c, m);
    const turns = groupTurns(c.items);
    expect(turns).toHaveLength(1);
    const [t] = turns;
    expect(t.user?.id).toBe('u-fixture');
    expect(t.result?.durationMs).toBe(26825);
    const s = turnSummary(t);
    // Read package.json + Read icon.png · Glob + Grep · Bash git log · WebFetch + TodoWrite
    expect(s).toEqual({ durationMs: 26825, reads: 2, edits: 0, commands: 1, searches: 2, others: 2, failed: 0, tools: 7 });
    expect(turnSummaryText(s)).toBe('已处理 27 秒 · 读了 2 个文件 · 搜索 2 次 · 运行 1 条命令 · 其它 2 步');
  });

  it('a transcript page that starts mid-turn (no user message) is one headless turn', () => {
    const c = createConversation();
    applyTranscript(c, msgs);
    const turns = groupTurns(c.items);
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toBeUndefined();
    expect(turnSummary(turns[0]).tools).toBe(7);
  });

  it('the fixture turn folds everything but the final answer', () => {
    const c = createConversation();
    applyTranscript(c, msgs);
    const [t] = groupTurns(c.items);
    const parts = splitTurnBody(t.body);
    expect(parts.work).toBe(true);
    // the final answer is the text after the last tool call ("DONE"); its thinking stays in the fold
    expect(parts.final.map((a) => a.blocks.map((b) => (b.type === 'text' ? b.text : b.type)))).toEqual([['DONE']]);
    const folded = parts.process.flatMap((i) => (i.kind === 'assistant' ? i.blocks.map((b) => (b.type === 'tool_use' ? b.name : b.type)) : [i.kind]));
    expect(folded.filter((x) => x !== 'thinking' && x !== 'text')).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'Read', 'WebFetch', 'TodoWrite', 'result']);
    expect(folded).toContain('thinking');
    expect(parts.tail).toEqual([]);
  });

  it('a second round nobody typed here (a goal 继续) is a turn of its own; the one still running stays open', () => {
    // review I1: round 1 is the captured turn (with its result); round 2 arrives right after it — GoalService sent
    // 「继续」 itself, which the SDK never echoes — and its command is still running
    const c = createConversation();
    c.items.push({ kind: 'user', id: 'u-goal', text: '/goal tidy', images: [] });
    for (const m of msgs) applyMessage(c, m);
    applyMessage(c, { type: 'assistant', uuid: 'a2', parent_tool_use_id: null, message: { id: 'msg_round2', role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: 'toolu_round2', name: 'Bash', input: { command: 'npm run build' } }] } });
    const turns = groupTurns(c.items);
    expect(turns.map((t) => [t.id, !!t.user, !!t.result])).toEqual([['u-goal', true, true], ['cont-msg_round2', false, false]]);
    const [one, two] = turns;
    // each round has its own numbers: round 1 is the fixture's alone, round 2 has its one command
    expect(turnSummary(one)).toMatchObject({ durationMs: 26825, commands: 1, tools: 7 });
    expect(turnSummary(two)).toMatchObject({ commands: 1, tools: 1 });
    // while the conversation runs: round 1 is done (folds), round 2 — the last — is not, its running step in view
    expect(turnDone(one, { last: false, live: true })).toBe(true);
    expect(turnDone(two, { last: true, live: true })).toBe(false);
    // the result of round 2 closes it; nothing running → everything folds
    applyMessage(c, { type: 'result', subtype: 'success', uuid: 'r2', duration_ms: 4000, duration_api_ms: 1, is_error: false, num_turns: 1, total_cost_usd: 0, usage: {} });
    const after = groupTurns(c.items);
    expect(after).toHaveLength(2);
    expect(after[1].result?.durationMs).toBe(4000);
    expect(turnSummary(after[1]).durationMs).toBe(4000);
    expect(turnDone(after[1], { last: true, live: false })).toBe(true);
  });
});

describe('turnDone', () => {
  const running = () => tool('Bash', { command: 'npm test' }, undefined, { status: 'running', result: undefined });
  it('the last turn never folds while the conversation runs, even with a result', () => {
    const [t] = groupTurns([user('go'), asst(tool('Read', { file_path: '/w/a' })), result(10)]);
    expect(turnDone(t, { last: true, live: true })).toBe(false);
    expect(turnDone(t, { last: true, live: false })).toBe(true);
  });
  it('a turn before a steer message is not done while its tools still run (or its text still streams)', () => {
    const turns = groupTurns([user('go'), asst(running()), user('also do x')]);
    expect(turnDone(turns[0], { last: false, live: true })).toBe(false);
    const streaming = groupTurns([user('go'), { ...asst(tool('Read', { file_path: '/w/a' }), { type: 'text', text: 'so' }), streaming: true }, user('also')]);
    expect(turnDone(streaming[0], { last: false, live: true })).toBe(false);
    const finished = groupTurns([user('go'), asst(tool('Read', { file_path: '/w/a' })), user('also')]);
    expect(turnDone(finished[0], { last: false, live: true })).toBe(true);
    // nothing runs any more: a step left running (an interrupted turn) does not keep it open
    expect(turnDone(turns[0], { last: false, live: false })).toBe(true);
  });
});

describe('turnMemo (review I2: a reloaded conversation must not keep showing the old objects)', () => {
  const msgs = loadFixture();
  it('the same turn content from a reloaded conversation is worked out again, on the new tool blocks', () => {
    const load = () => {
      const c = createConversation();
      applyTranscript(c, [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'go' } }, ...msgs.filter((m) => m.type !== 'result')]);
      return c;
    };
    const a = load();
    const [ta] = groupTurns(a.items);
    const m1 = turnMemo(undefined, ta, true, 0);
    expect(turnMemo(m1, groupTurns(a.items)[0], true, 0)).toBe(m1); // nothing changed: kept
    // loadHistory on an open conversation (reconnect, Mission Control, …) builds a new conversation, same content
    const b = load();
    const [tb] = groupTurns(b.items);
    expect(tb.body.length).toBe(ta.body.length);
    const m2 = turnMemo(m1, tb, true, 0);
    expect(m2).not.toBe(m1);
    const steps = m2.parts.process.flatMap((i) => (i.kind === 'assistant' ? i.blocks.filter((x): x is ToolUseBlock => x.type === 'tool_use') : []));
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) expect(s).toBe(b.toolIndex.get(s.id)); // loadSubagent writes children into these
    // a running (volatile) turn is redone on every version
    expect(turnMemo(m2, tb, false, 7)).not.toBe(m2);
  });

  it('a subagent loaded into a finished turn counts: its edits show in 「改了 N 个」 and the change card (review M-1)', () => {
    const c = createConversation();
    applyTranscript(c, [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'delegate' } },
      { type: 'assistant', uuid: 'a1', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'ag', name: 'Agent', input: { prompt: 'p' } }] } },
      { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag', content: 'agentId: abcdef1234' }] } },
      { type: 'assistant', uuid: 'a2', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: 'next' } },
    ]);
    const [t1] = groupTurns(c.items);
    const m1 = turnMemo(undefined, t1, true, 0);
    expect(m1.changes).toHaveLength(0);
    // what loadSubagent does: the Agent step's children filled in place, nothing else changes
    const sub = createConversation();
    applyTranscript(sub, [
      { type: 'assistant', uuid: 's1', message: { id: 'sm1', role: 'assistant', content: [{ type: 'tool_use', id: 'se', name: 'Edit', input: { file_path: '/w/a.txt', old_string: 'a', new_string: 'b' } }] } },
      { type: 'user', uuid: 's2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'se', content: 'ok' }] } },
    ]);
    c.toolIndex.get('ag')!.children = sub.items;
    const [t1b] = groupTurns(c.items);
    const m2 = turnMemo(m1, t1b, true, 0);
    expect(m2).not.toBe(m1);
    expect(m2.changes.map((r) => r.path)).toEqual(['/w/a.txt']);
    expect(m2.summary?.edits).toBe(1);
    expect(turnMemo(m2, groupTurns(c.items)[0], true, 0)).toBe(m2);
  });

  it('turnStamp: a finished earlier turn is not redone on every event; the last one and an unfinished one are (review M-2)', () => {
    expect(turnStamp({ last: false, done: true, version: 41 })).toBe(0);
    expect(turnStamp({ last: false, done: true, version: 42 })).toBe(0);
    expect(turnStamp({ last: true, done: true, version: 42 })).toBe(42);
    expect(turnStamp({ last: false, done: false, version: 42 })).toBe(42);
    // 200 finished turns while the last one streams: every earlier turn's memo is kept across events
    const c = createConversation();
    for (let i = 0; i < 200; i++) {
      c.items.push({ kind: 'user', id: `u${i}`, text: 'go', images: [] });
      for (const m of msgs) applyMessage(c, JSON.parse(JSON.stringify(m).replace(/"(toolu_[A-Za-z0-9]+|msg_[A-Za-z0-9]+)"/g, (_s: string, id: string) => `"${id}_${i}"`)));
    }
    const frame = (memos: TurnMemo[], version: number) => {
      const turns = groupTurns(c.items);
      return turns.map((t, i) => { const last = i === turns.length - 1; const done = turnDone(t, { last, live: true }); return turnMemo(memos[i], t, done, turnStamp({ last, done, version })); });
    };
    const a = frame([], 1);
    const b = frame(a, 2);
    const kept = b.filter((m, i) => m === a[i]).length;
    expect(kept).toBe(199);
  });
});

describe('groupTurns', () => {
  it('splits at each non-meta user message; meta messages stay in the turn', () => {
    const u1 = user('first'), u2 = user('second');
    const a1 = asst({ type: 'text', text: 'one' }), a2 = asst({ type: 'text', text: 'two' });
    const reminder = user('<system-reminder>x</system-reminder>', undefined, true);
    const r1 = result(1000);
    const turns = groupTurns([u1, a1, reminder, r1, u2, a2]);
    expect(turns.map((t) => [t.id, t.user?.id, t.body.map((i) => i.id), t.result?.id])).toEqual([
      [u1.id, u1.id, [a1.id, reminder.id, r1.id], r1.id],
      [u2.id, u2.id, [a2.id], undefined],
    ]);
  });

  it('empty → no turns', () => {
    expect(groupTurns([])).toEqual([]);
  });

  it('after a result, anything but a user message opens a headless continuation turn', () => {
    const u1 = user('first');
    const a1 = asst(tool('Bash', { command: 'ls' })), r1 = result(1000);
    const a2 = asst(tool('Bash', { command: 'npm test' })), r2 = result(2000);
    const note: Item = { kind: 'system', id: 'note', subtype: 'notification', text: 'x' };
    const u2 = user('second'), a3 = asst({ type: 'text', text: 'ok' });
    const turns = groupTurns([u1, a1, r1, a2, r2, note, u2, a3]);
    expect(turns.map((t) => [t.id, t.user?.id, t.body.map((i) => i.id), t.result?.id])).toEqual([
      [u1.id, u1.id, [a1.id, r1.id], r1.id],
      [`cont-${a2.id}`, undefined, [a2.id, r2.id], r2.id],
      ['cont-note', undefined, ['note'], undefined],
      [u2.id, u2.id, [a3.id], undefined],
    ]);
  });
});

describe('turnSummary', () => {
  // What counts: the turn's own top-level calls that worked. A call that failed or was refused is 「失败」, not 「读了 /
  // 运行」 (review M1). 「改了 N 个」 is the change card's rows — a subagent's edits included (they are this turn's
  // changes, and the card / header count them) — while a subagent's own reads and commands are not counted.
  it('reads count distinct files, edits the files the change card lists (subagents included), commands the ones that ran', () => {
    const sub = asst(tool('Edit', { file_path: '/w/sub.ts', old_string: 'a', new_string: 'b' }));
    const items: Item[] = [
      user('go', '2026-09-28T10:00:00.000Z'),
      asst(
        tool('Read', { file_path: '/w/a.ts' }),
        tool('Read', { file_path: '/w/a.ts', offset: 10 }),
        tool('Read', { file_path: '/w/b.ts' }),
        tool('Bash', { command: 'npm test' }),
        tool('Bash', { command: 'npm test' }, undefined, { status: 'error', result: { content: 'exit 1', isError: true } }),
        tool('Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' }),
        tool('Edit', { file_path: '/w/c.ts', old_string: 'x', new_string: 'y' }, undefined, { status: 'error', result: { content: 'no', isError: true } }),
        tool('Agent', { prompt: 'p' }, undefined, { children: [sub] }),
        tool('mcp__github__list_issues', {}),
      ),
      { ...asst({ type: 'text', text: 'done' }), ts: '2026-09-28T10:01:42.000Z' },
    ];
    const [t] = groupTurns(items);
    const s = turnSummary(t);
    // the failed Bash and the failed Edit are 「失败 2 个」, not a command run / a file changed
    expect(s).toEqual({ durationMs: 102_000, reads: 2, edits: 2, commands: 1, searches: 0, others: 2, failed: 2, tools: 9 });
    expect(turnSummaryText(s)).toBe('已处理 1 分 42 秒 · 失败 2 个 · 读了 2 个文件 · 改了 2 个 · 运行 1 条命令 · 其它 2 步');
    expect(turnSummaryParts(s).filter((p) => p.err).map((p) => p.text)).toEqual(['失败 2 个']);
  });

  it('a refused command, a missing file and reading a background shell are not 「运行 2 条命令 · 读了 1 个文件」', () => {
    const refused = tool('Bash', { command: 'rm -rf build' }, undefined, { status: 'error', result: { content: "The user doesn't want to proceed with this tool use.", isError: true } });
    const missing = tool('Read', { file_path: '/w/nope.ts' }, undefined, { status: 'error', result: { content: 'File does not exist.', isError: true } });
    const [t] = groupTurns([user('go'), asst(refused, missing, tool('BashOutput', { bash_id: 'b1' }), tool('KillShell', { shell_id: 'b1' }))]);
    const s = turnSummary(t);
    expect(s).toMatchObject({ reads: 0, commands: 0, others: 2, failed: 2, tools: 4 });
    expect(turnSummaryText(s)).toBe('已处理 · 失败 2 个 · 其它 2 步');
  });

  it("a subagent's edits count, its reads and commands do not", () => {
    const sub = asst(tool('Read', { file_path: '/w/x.ts' }), tool('Bash', { command: 'ls' }), tool('Write', { file_path: '/w/y.ts', content: 'a' }));
    const [t] = groupTurns([user('go'), asst(tool('Agent', { prompt: 'p' }, undefined, { children: [sub] }))]);
    expect(turnSummary(t)).toMatchObject({ reads: 0, commands: 0, edits: 1, others: 1, tools: 1 });
  });

  it('the result duration wins over timestamps; no duration → no number', () => {
    const items: Item[] = [user('go', '2026-09-28T10:00:00.000Z'), { ...asst(tool('Bash', { command: 'ls' })), ts: '2026-09-28T10:00:05.000Z' }, result(3_400)];
    expect(turnSummary(groupTurns(items)[0]).durationMs).toBe(3_400);
    const bare = groupTurns([user('go'), asst(tool('Write', { file_path: '/w/n.ts', content: 'a' }))])[0];
    expect(turnSummary(bare).durationMs).toBeUndefined();
    expect(turnSummaryText(turnSummary(bare))).toBe('已处理 · 改了 1 个文件');
  });
});

describe('fmtDuration', () => {
  it('seconds, minutes, hours', () => {
    expect(fmtDuration(400)).toBe('1 秒');
    expect(fmtDuration(12_300)).toBe('12 秒');
    expect(fmtDuration(59_600)).toBe('1 分钟');
    expect(fmtDuration(102_000)).toBe('1 分 42 秒');
    expect(fmtDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3 小时 5 分');
  });
});

describe('splitTurnBody', () => {
  it('a turn without tool calls has nothing to fold', () => {
    const a = asst({ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' });
    const r = result(900);
    const parts = splitTurnBody([a, r]);
    expect(parts.work).toBe(false);
    expect(parts.process).toEqual([]);
    expect(parts.final).toEqual([]);
    expect(parts.tail).toEqual([a, r]);
  });

  it('text after the last tool is the answer; errors stay out of the fold', () => {
    const t1 = tool('Read', { file_path: '/w/a.ts' });
    const lead = asst({ type: 'text', text: 'looking' }, t1);
    const warn: Item = { kind: 'system', id: 'retry', subtype: 'retry', level: 'warn', text: 'API 重试 1/3' };
    const answer = asst({ type: 'thinking', thinking: 'ok' }, { type: 'text', text: 'fixed it' });
    const bad: Item = { kind: 'system', id: 'refusal', subtype: 'refusal', level: 'error', text: '模型拒答' };
    const err = result(10, { isError: true, text: 'boom' });
    const parts = splitTurnBody([lead, warn, answer, bad, err]);
    expect(parts.work).toBe(true);
    expect(parts.process.map((i) => i.id)).toEqual([lead.id, 'retry', answer.id]);
    expect((parts.process[2] as AssistantItem).blocks.map((b) => b.type)).toEqual(['thinking']);
    expect(parts.final.map((a) => [a.id, a.blocks.map((b) => b.type)])).toEqual([[answer.id, ['text']]]);
    expect(parts.tail.map((i) => i.id)).toEqual(['refusal', err.id]);
  });

  it('an assistant message that errored is never folded away', () => {
    const lead = asst(tool('Bash', { command: 'x' }));
    const failed: AssistantItem = { ...asst({ type: 'text', text: 'API Error: 401' }), error: 'authentication_failed' };
    const parts = splitTurnBody([lead, failed]);
    expect(parts.final.map((a) => a.id)).toEqual([failed.id]);
  });

  it('text in the same message after the tool call is the answer', () => {
    const t = tool('Read', { file_path: '/w/a.ts' });
    const one = asst({ type: 'text', text: 'first' }, t, { type: 'text', text: 'answer' });
    const parts = splitTurnBody([one]);
    expect((parts.process[0] as AssistantItem).blocks.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(parts.final[0].blocks).toEqual([{ type: 'text', text: 'answer' }]);
  });
});

describe('fileChanges', () => {
  it('one row per file with its lines, in first-touch order; the header total is their sum', () => {
    const items: Item[] = [asst(
      tool('Edit', { file_path: 'C:\\w\\src\\todos.js', old_string: 'a', new_string: 'b' }, { structuredPatch: [{ oldStart: 9, newStart: 9, lines: [' c', '-x', '+y', '+z'] }] }),
      tool('Write', { file_path: 'C:\\w\\test\\todos.test.js', content: 'a\nb\n' }, { type: 'create', structuredPatch: [], content: 'a\nb\n' }),
      tool('Edit', { file_path: 'c:/w/src/todos.js', old_string: 'keep\nold', new_string: 'keep\nnew\nmore' }),
    )];
    const rows = fileChanges(items);
    expect(rows.map((r) => [r.path, r.added, r.removed])).toEqual([
      ['c:/w/src/todos.js', 4, 2],
      ['C:\\w\\test\\todos.test.js', 2, 0],
    ]);
    const total = sessionDiffStat(items);
    expect(total).toEqual({ files: 2, added: rows.reduce((a, r) => a + r.added, 0), removed: rows.reduce((a, r) => a + r.removed, 0) });
  });
});

describe('displayPath', () => {
  it('relative to the project, forward slashes, the name apart', () => {
    expect(displayPath('C:\\w\\todo-api\\src\\todos.js', 'C:\\w\\todo-api')).toEqual({ dir: 'src/', name: 'todos.js' });
    expect(displayPath('c:/W/todo-api/README.md', 'C:\\w\\todo-api\\')).toEqual({ dir: '', name: 'README.md' });
    expect(displayPath('/home/me/other/x.ts', '/home/me/proj')).toEqual({ dir: '/home/me/other/', name: 'x.ts' });
    expect(displayPath('x.ts', '')).toEqual({ dir: '', name: 'x.ts' });
  });
});
