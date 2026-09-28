import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyMessage, applyTranscript, createConversation, setConversationClock, type AssistantItem, type Item, type ResultItem, type ToolUseBlock, type UserItem } from './conversation';
import { fileChanges, sessionDiffStat } from './diffstat';
import { displayPath, fmtDuration, groupTurns, splitTurnBody, turnSummary, turnSummaryText } from './turn';

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
    expect(s).toEqual({ durationMs: 26825, reads: 2, edits: 0, commands: 1, searches: 2, others: 2, tools: 7 });
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
});

describe('turnSummary', () => {
  it('reads count distinct files, edits the files the change card lists (subagents included), commands every call', () => {
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
    expect(s).toEqual({ durationMs: 102_000, reads: 2, edits: 2, commands: 2, searches: 0, others: 2, tools: 9 });
    expect(turnSummaryText(s)).toBe('已处理 1 分 42 秒 · 读了 2 个文件 · 改了 2 个 · 运行 2 条命令 · 其它 2 步');
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
