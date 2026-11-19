import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BgHistory, createScan, scanItems, scanLines } from './history.js';

// 跑过的 (2026-11-19): the background work a conversation ran, read back from Claude Code's own records — sub-agents and
// background commands from the transcript (an Agent / Task call and its result, a run_in_background Bash call, the
// <task-notification> that ended it), workflows from `<conversation>/workflows/<runId>.json`.

const SID = '11111111-2222-4333-8444-555555555555';
const T0 = Date.parse('2026-11-19T10:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const base = (sid = SID) => ({ sessionId: sid, cwd: sid.startsWith('bbbbbbbb') ? 'C:\\work\\notes-app' : 'C:\\work\\acme-shop', version: '2.1.283', isSidechain: false, userType: 'external' });

const call = (s: number, id: string, name: string, input: Record<string, unknown>, o: { sid?: string; sidechain?: boolean } = {}) => JSON.stringify({
  ...base(o.sid), ...(o.sidechain ? { isSidechain: true } : {}), type: 'assistant', timestamp: at(s), uuid: `a-${id}`,
  message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id, name, input }] },
});
const result = (s: number, id: string, toolUseResult: unknown, o: { sid?: string; content?: string; error?: boolean } = {}) => JSON.stringify({
  ...base(o.sid), type: 'user', timestamp: at(s), uuid: `u-${id}`,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: o.content ?? 'done', ...(o.error ? { is_error: true } : {}) }] },
  ...(toolUseResult === undefined ? {} : { toolUseResult }),
});
const noticeText = (taskId: string, toolUseId: string, status: string, usage?: { tokens: number; tools: number; ms: number }) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>C:\\tmp\\${taskId}.output</output-file>\n<status>${status}</status>\n<summary>Background "x" ${status}</summary>\n`
  + (usage ? `<usage><total_tokens>${usage.tokens}</total_tokens><tool_uses>${usage.tools}</tool_uses><duration_ms>${usage.ms}</duration_ms></usage>\n` : '')
  + '</task-notification>';
/** the CLI's queue line (written the moment the task ends) */
const queued = (s: number, taskId: string, toolUseId: string, status: string, usage?: { tokens: number; tools: number; ms: number }) =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(s), sessionId: SID, content: noticeText(taskId, toolUseId, status, usage) });
/** the same notification handed to the model in a later turn */
const told = (s: number, taskId: string, toolUseId: string, status: string) =>
  JSON.stringify({ ...base(), type: 'user', timestamp: at(s), uuid: `n-${taskId}-${s}`, message: { role: 'user', content: noticeText(taskId, toolUseId, status) } });
const said = (s: number, text: string) => JSON.stringify({ ...base(), type: 'assistant', timestamp: at(s), uuid: `t-${s}`, message: { role: 'assistant', content: [{ type: 'text', text }] } });

const scan = (lines: string[], o: Parameters<typeof scanItems>[1] = {}) => {
  const s = createScan(SID);
  scanLines(s, lines.join('\n') + '\n');
  return scanItems(s, o);
};

describe('a transcript\'s background work', () => {
  it('a sub-agent the turn waited for: its call, its result (time, tokens, tool calls, its own id)', () => {
    const items = scan([
      call(0, 'toolu_a1', 'Agent', { description: '查一下订单的数据结构', prompt: 'look', subagent_type: 'Explore' }),
      result(180, 'toolu_a1', { status: 'completed', agentId: 'a1b2c3d4e5f6a7b8c', agentType: 'Explore', totalDurationMs: 179500, totalTokens: 31395, totalToolUseCount: 12, usage: {} }),
    ]);
    expect(items).toEqual([{
      id: `${SID}|agent|a1b2c3d4e5f6a7b8c`, sessionId: SID, kind: 'agent', title: '查一下订单的数据结构', status: 'completed',
      startedAt: T0, endedAt: T0 + 180_000, cwd: 'C:\\work\\acme-shop', agentId: 'a1b2c3d4e5f6a7b8c', agentType: 'Explore', tokens: 31395, toolUses: 12,
    }]);
  });

  it('the old tool name (Task) counts the same', () => {
    const items = scan([call(0, 'toolu_t', 'Task', { description: 'old name', prompt: 'p', subagent_type: 'general-purpose' }), result(5, 'toolu_t', { status: 'completed', agentId: 'a0000000000000001', totalTokens: 9 })]);
    expect(items.map((i) => [i.kind, i.title, i.agentType, i.status])).toEqual([['agent', 'old name', 'general-purpose', 'completed']]);
  });

  it('a sub-agent sent to the background ends with its notification (its end time and usage)', () => {
    const items = scan([
      call(0, 'toolu_bg', 'Agent', { description: 'Profile lag', prompt: 'p', run_in_background: true }),
      result(1, 'toolu_bg', { isAsync: true, status: 'async_launched', agentId: 'aac87f0e42e10a617', description: 'Profile lag', resolvedModel: 'claude-opus-5-5' }),
      said(2, 'started it'),
      queued(400, 'aac87f0e42e10a617', 'toolu_bg', 'completed', { tokens: 100410, tools: 55, ms: 399000 }),
      told(420, 'aac87f0e42e10a617', 'toolu_bg', 'completed'),
    ]);
    expect(items).toEqual([expect.objectContaining({ kind: 'agent', title: 'Profile lag', agentId: 'aac87f0e42e10a617', status: 'completed', startedAt: T0, endedAt: T0 + 400_000, tokens: 100410, toolUses: 55, model: 'claude-opus-5-5' })]);
  });

  it('a background command: its description, its command line, how it ended', () => {
    const items = scan([
      call(0, 'toolu_sh', 'Bash', { command: 'npm run test:watch', description: 'Run the tests in watch mode', run_in_background: true }),
      result(1, 'toolu_sh', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bpae3hu0u' }),
      queued(2400, 'bpae3hu0u', 'toolu_sh', 'failed'),
    ]);
    expect(items).toEqual([expect.objectContaining({ id: `${SID}|shell|bpae3hu0u`, kind: 'shell', title: 'Run the tests in watch mode', command: 'npm run test:watch', status: 'failed', startedAt: T0, endedAt: T0 + 2_400_000 })]);
  });

  it('a command the turn waited for is not background work; nor is a sub-agent\'s own step', () => {
    const items = scan([
      call(0, 'toolu_fg', 'Bash', { command: 'git status' }),
      result(1, 'toolu_fg', { stdout: ' M a.ts', stderr: '', interrupted: false }),
      call(2, 'toolu_side', 'Bash', { command: 'npm run dev', run_in_background: true }, { sidechain: true }),
      result(3, 'toolu_side', { backgroundTaskId: 'bside0001' }),
    ]);
    expect(items).toEqual([]);
  });

  it('a stopped sub-agent is 已停止, one that errored failed', () => {
    const items = scan([
      call(0, 'toolu_x', 'Agent', { description: 'stopped one', prompt: 'p' }),
      result(9, 'toolu_x', 'Error: [Request interrupted by user for tool use]', { error: true, content: '[Request interrupted by user for tool use]' }),
      call(10, 'toolu_y', 'Agent', { description: 'broken one', prompt: 'p' }),
      result(12, 'toolu_y', 'Error: Agent type \'nope\' not found', { error: true, content: 'Agent type \'nope\' not found' }),
    ]);
    expect(items.map((i) => [i.title, i.status, i.endedAt])).toEqual([['broken one', 'failed', T0 + 12_000], ['stopped one', 'stopped', T0 + 9_000]]);
  });

  it('newest first; the same notification seen twice keeps its first time, a later one (it went on) wins', () => {
    const items = scan([
      call(0, 'toolu_1', 'Agent', { description: 'first', prompt: 'p', run_in_background: true }),
      result(1, 'toolu_1', { isAsync: true, status: 'async_launched', agentId: 'a1000000000000001' }),
      call(5, 'toolu_2', 'Bash', { command: 'sleep 1', run_in_background: true }),
      result(6, 'toolu_2', { backgroundTaskId: 'b2' }),
      queued(50, 'a1000000000000001', 'toolu_1', 'completed'),
      told(70, 'a1000000000000001', 'toolu_1', 'completed'),
      queued(90, 'b2', 'toolu_2', 'completed'),
      // the agent woke up again (its own background work reported) and ended for good later
      queued(300, 'a1000000000000001', 'toolu_1', 'failed'),
    ]);
    expect(items.map((i) => [i.kind, i.status, (i.endedAt! - T0) / 1000])).toEqual([['shell', 'completed', 90], ['agent', 'failed', 300]]);
  });

  it('one that never said it ended: 已停止 at the last word of the transcript — unless it is still running', () => {
    const lines = [
      call(0, 'toolu_dev', 'Bash', { command: 'npm run dev', description: 'Start the dev server', run_in_background: true }),
      result(1, 'toolu_dev', { backgroundTaskId: 'bdev00001' }),
      said(600, 'bye'),
    ];
    expect(scan(lines).map((i) => [i.status, i.endedAt])).toEqual([['stopped', T0 + 600_000]]);
    expect(scan(lines, { isRunning: (id) => id === 'bdev00001' })).toEqual([]);
  });

  it('reads on where it stopped: a call and its result in two reads', () => {
    const s = createScan(SID);
    scanLines(s, call(0, 'toolu_a', 'Agent', { description: 'split', prompt: 'p' }) + '\n');
    expect(scanItems(s)).toEqual([]);
    scanLines(s, result(30, 'toolu_a', { status: 'completed', agentId: 'a5000000000000005' }) + '\n');
    expect(scanItems(s).map((i) => i.title)).toEqual(['split']);
  });

  it('a long command line is cut; a command without a description is its own title', () => {
    const long = `node -e "${'x'.repeat(900)}"`;
    const items = scan([call(0, 'toolu_l', 'Bash', { command: long, run_in_background: true }), result(1, 'toolu_l', { backgroundTaskId: 'blong0001' }), queued(5, 'blong0001', 'toolu_l', 'completed')]);
    expect(items[0].title.length).toBeLessThanOrEqual(200);
    expect(items[0].title.startsWith('node -e')).toBe(true);
    expect(items[0].command!.length).toBeLessThanOrEqual(500);
  });
});

// ---- across conversations, from disk ----

let root: string;
let projects: string;
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const C = 'cccccccc-0000-4000-8000-00000000000c';
let fileA: string;

const run = (o: Record<string, unknown>) => ({
  runId: 'wf_1', taskId: 'wtask0001', workflowName: '结账模块重构', summary: 'Refactor the checkout', status: 'completed', startTime: T0, durationMs: 720_000,
  agentCount: 3, totalTokens: 214000, totalToolCalls: 88, script: 'x',
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: '分析' },
    { type: 'workflow_agent', index: 1, label: 'explore', phaseIndex: 1, state: 'done', startedAt: T0 + 1000, durationMs: 126_000, agentId: 'aw0000000000001' },
    { type: 'workflow_agent', index: 2, label: 'db', phaseIndex: 1, state: 'error', startedAt: T0 + 2000, durationMs: 144_000, error: 'boom' },
    { type: 'workflow_agent', index: 3, label: 'docs', phaseIndex: 1, state: 'start', queuedAt: T0 + 3000 },
  ],
  ...o,
});

function write(file: string, lines: string[], mtime: number) {
  writeFileSync(file, lines.join('\n') + '\n');
  utimesSync(file, mtime / 1000, mtime / 1000);
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'cw-bg-history-'));
  projects = path.join(root, 'projects');
  const p1 = path.join(projects, 'C--work-acme-shop');
  const p2 = path.join(projects, 'C--work-notes-app');
  mkdirSync(p1, { recursive: true });
  mkdirSync(p2, { recursive: true });
  // A (acme-shop): a workflow run on disk and a sub-agent, the most recent conversation
  fileA = path.join(p1, `${A}.jsonl`);
  write(fileA, [
    call(0, 'toolu_wf', 'Workflow', { script: 'x' }, { sid: A }),
    call(800, 'toolu_ag', 'Agent', { description: '找出慢查询', prompt: 'p', subagent_type: 'Explore' }, { sid: A }),
    result(1280, 'toolu_ag', { status: 'completed', agentId: 'aslow00000000001', totalTokens: 5000, totalToolUseCount: 4 }, { sid: A }),
  ], T0 + 1300_000);
  mkdirSync(path.join(p1, A, 'workflows'), { recursive: true });
  writeFileSync(path.join(p1, A, 'workflows', 'wf_1.json'), JSON.stringify(run({})));
  writeFileSync(path.join(p1, A, 'workflows', 'broken.json'), '{ half');
  // B (notes-app): two background commands a day earlier
  write(path.join(p2, `${B}.jsonl`), [
    call(-86_400, 'toolu_b1', 'Bash', { command: 'npm run test:watch', description: 'Watch the tests', run_in_background: true }, { sid: B }),
    result(-86_399, 'toolu_b1', { backgroundTaskId: 'bwatch001' }, { sid: B }),
    call(-86_000, 'toolu_b2', 'PowerShell', { command: 'Get-Process', description: 'List processes', run_in_background: true }, { sid: B }),
    result(-85_999, 'toolu_b2', { backgroundTaskId: 'bps000001' }, { sid: B }),
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(-85_990), sessionId: B, content: noticeText('bps000001', 'toolu_b2', 'completed') }),
    // never said it ended (its process went with the conversation's)
    call(-85_000, 'toolu_b3', 'Bash', { command: 'npx serve docs', description: 'Serve the docs', run_in_background: true }, { sid: B }),
    result(-84_999, 'toolu_b3', { backgroundTaskId: 'bdocs0001' }, { sid: B }),
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(-84_000), sessionId: B, content: noticeText('bwatch001', 'toolu_b1', 'killed') }),
  ], T0 - 84_000_000);
  // C: nothing in the background at all
  write(path.join(p2, `${C}.jsonl`), [said(-3600, 'hello')], T0 - 3_600_000);
  // a sub-agent transcript at the top of a project folder (an old CLI wrote them there): not a conversation
  write(path.join(p2, 'agent-a0000000000000099.jsonl'), [said(0, 'side')], T0);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const history = (o: Partial<ConstructorParameters<typeof BgHistory>[0]> = {}) => new BgHistory({ roots: () => [{ dir: projects }], filesTtlMs: 0, ...o });

describe('跑过的: every conversation\'s, newest first', () => {
  it('lists workflows, sub-agents and background commands across conversations', async () => {
    const page = await history().page({});
    expect(page.items.map((i) => [i.sessionId.slice(0, 1), i.kind, i.title, i.status])).toEqual([
      ['a', 'agent', '找出慢查询', 'completed'],
      ['a', 'workflow', '结账模块重构', 'completed'],
      ['b', 'shell', 'Serve the docs', 'stopped'],
      ['b', 'shell', 'List processes', 'completed'],
      ['b', 'shell', 'Watch the tests', 'stopped'],
    ]);
    expect(page.next).toBeUndefined();
    const wf = page.items[1];
    expect(wf).toMatchObject({ id: `${A}|workflow|wf_1`, runId: 'wf_1', startedAt: T0, endedAt: T0 + 720_000, agentCount: 3, failed: 1, tokens: 214000, toolUses: 88, cwd: 'C:\\work\\acme-shop' });
    // the one that never said it ended: about when its conversation last wrote anything
    expect(page.items[2]).toMatchObject({ endedAt: T0 - 84_000_000, cwd: 'C:\\work\\notes-app', command: 'npx serve docs' });
  });

  it('pages by time: a cursor for the next page, which goes on from there', async () => {
    const h = history();
    const one = await h.page({ limit: 3 });
    expect(one.items.map((i) => i.title)).toEqual(['找出慢查询', '结账模块重构', 'Serve the docs']);
    expect(one.next).toBeTruthy();
    const two = await h.page({ limit: 3, before: one.next });
    expect(two.items.map((i) => i.title)).toEqual(['List processes', 'Watch the tests']);
    expect(two.next).toBeUndefined();
  });

  it('by kind, by words (title, command line, folder, sub-agent type), by conversation', async () => {
    const h = history();
    expect((await h.page({ only: 'shell' })).items.map((i) => i.title)).toEqual(['Serve the docs', 'List processes', 'Watch the tests']);
    expect((await h.page({ only: 'workflow' })).items.map((i) => i.kind)).toEqual(['workflow']);
    expect((await h.page({ q: 'TEST:WATCH' })).items.map((i) => i.title)).toEqual(['Watch the tests']);
    expect((await h.page({ q: 'notes-app' })).items.length).toBe(3);
    expect((await h.page({ q: 'explore' })).items.map((i) => i.title)).toEqual(['找出慢查询']);
    // words that match a conversation's title (the window knows the titles): that conversation's
    expect((await h.page({ q: 'zzz', also: [B] })).items.length).toBe(3);
    expect((await h.page({ sessionId: A })).items.map((i) => i.kind)).toEqual(['agent', 'workflow']);
  });

  it('reads a transcript in small pieces the same as in one (lines across reads, a line longer than a read)', async () => {
    const whole = (await history().page({})).items;
    const bits = (await history({ chunkBytes: 37 }).page({})).items;
    expect(bits).toEqual(whole);
  });

  it('a task still running now is left out (it is 在跑)', async () => {
    const page = await history({ isRunning: (sid, id) => sid === B && id === 'bdocs0001' }).page({});
    expect(page.items.map((i) => i.title)).toEqual(['找出慢查询', '结账模块重构', 'List processes', 'Watch the tests']);
  });

  it('a transcript that grew is read on from where it was; one rewritten is read again', async () => {
    const h = history();
    expect((await h.page({ sessionId: A })).items.length).toBe(2);
    appendFileSync(fileA, [
      call(1400, 'toolu_more', 'Bash', { command: 'npm run build', description: 'Build it', run_in_background: true }, { sid: A }),
      result(1401, 'toolu_more', { backgroundTaskId: 'bbuild001' }, { sid: A }),
      queued(1500, 'bbuild001', 'toolu_more', 'completed'),
    ].join('\n') + '\n');
    utimesSync(fileA, (T0 + 1_500_000) / 1000, (T0 + 1_500_000) / 1000);
    expect((await h.page({ sessionId: A })).items.map((i) => i.title)).toEqual(['Build it', '找出慢查询', '结账模块重构']);
    write(fileA, [call(10, 'toolu_new', 'Agent', { description: 'only this', prompt: 'p' }, { sid: A }), result(20, 'toolu_new', { status: 'completed', agentId: 'anew0000000001' }, { sid: A })], T0 + 1_600_000);
    expect((await h.page({ sessionId: A, only: 'agent' })).items.map((i) => i.title)).toEqual(['only this']);
  });
});
