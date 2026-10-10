import { describe, expect, it } from 'vitest';
import { createConversation, type AssistantItem, type Conversation, type TaskInfo, type ToolUseBlock, type UserItem } from '@/model/conversation';
import { elapsedText, lingerPhase, runStatus, swapCount, type StepLabeler } from './run-status';

const label: StepLabeler = (name, input) => {
  if (name === 'Read') return { verb: '读取文件:', arg: String(input.file_path ?? ''), category: 'read' };
  if (name === 'Edit') return { verb: '编辑文件:', arg: String(input.file_path ?? ''), category: 'edit' };
  if (name === 'Bash') return { verb: '运行命令:', arg: String(input.command ?? ''), category: 'cmd' };
  if (name === 'ExitPlanMode') return { verb: '请求批准计划', arg: '', category: 'plan' };
  return { verb: '', arg: '', category: 'other' };
};

const tool = (id: string, name: string, input: Record<string, unknown>, status: ToolUseBlock['status'] = 'running'): ToolUseBlock => ({ type: 'tool_use', id, name, input, children: [], status });
const user = (id: string, meta = false): UserItem => ({ kind: 'user', id, text: 'hi', images: [], meta });
const assistant = (id: string, blocks: AssistantItem['blocks']): AssistantItem => ({ kind: 'assistant', id, blocks, streaming: false, parentToolUseId: null });
const task = (id: string, status: TaskInfo['status']): TaskInfo => ({ id, description: id, status, startedAt: 1 });

/** a conversation with one turn in flight: the user's message, then the given tool calls (the last one running) */
function conv(tools: ToolUseBlock[], patch: Partial<Conversation> = {}): Conversation {
  const c = createConversation();
  c.items = [user('u1'), ...(tools.length ? [assistant('a1', tools)] : [])];
  for (const t of tools) c.toolIndex.set(t.id, t);
  const running = tools.find((t) => t.status === 'running');
  if (running) c.runningTool = { id: running.id, name: running.name, since: 5000 };
  return Object.assign(c, patch);
}

describe('runStatus: what the tab on the composer says while a turn is in flight', () => {
  it('no step running: it is thinking', () => {
    const s = runStatus(conv([]), 'running', label);
    expect(s).toMatchObject({ kind: 'thinking', text: '思考中', target: '', done: 0, total: 0, tasks: 0 });
  });

  it('a read or an edit: the verb and the file\'s name (the whole path is too long for a tab)', () => {
    expect(runStatus(conv([tool('t1', 'Read', { file_path: 'C:\\repo\\src\\app\\App.tsx' })]), 'running', label)).toMatchObject({ kind: 'tool', text: '读取文件:', target: 'App.tsx' });
    expect(runStatus(conv([tool('t1', 'Edit', { file_path: '/repo/README.md' })]), 'running', label)).toMatchObject({ kind: 'tool', text: '编辑文件:', target: 'README.md' });
  });

  it('anything else: the argument as it is', () => {
    expect(runStatus(conv([tool('t1', 'Bash', { command: 'npm run build -w web' })]), 'running', label)).toMatchObject({ kind: 'tool', text: '运行命令:', target: 'npm run build -w web' });
  });

  it('a tool without a verb of its own goes by its name; one without an argument has no target', () => {
    expect(runStatus(conv([tool('t1', 'mcp__x__do', {})]), 'running', label)).toMatchObject({ kind: 'tool', text: 'mcp__x__do', target: '' });
    expect(runStatus(conv([tool('t1', 'ExitPlanMode', {})]), 'running', label)).toMatchObject({ text: '请求批准计划', target: '' });
  });

  it('a running tool the conversation does not have (yet) reads as thinking', () => {
    const c = conv([]);
    c.runningTool = { id: 'gone', name: 'Read', since: 1 };
    expect(runStatus(c, 'running', label).kind).toBe('thinking');
  });

  it('waiting for the user comes before the step; compacting before both', () => {
    const c = conv([tool('t1', 'Bash', { command: 'npm test' })]);
    expect(runStatus(c, 'waiting', label)).toMatchObject({ kind: 'waiting', text: '等待你的确认', target: '' });
    c.compacting = true;
    expect(runStatus(c, 'waiting', label)).toMatchObject({ kind: 'compacting', text: '压缩上下文', target: '' });
    expect(runStatus(c, 'running', label).kind).toBe('compacting');
  });

  it('counts this turn\'s steps: everything after the last message the user wrote, finished or failed = done', () => {
    const c = createConversation();
    const old = tool('o1', 'Read', { file_path: 'a' }, 'done');
    const t1 = tool('t1', 'Read', { file_path: 'a' }, 'done');
    const t2 = tool('t2', 'Bash', { command: 'x' }, 'error');
    const t3 = tool('t3', 'Edit', { file_path: 'b' }, 'running');
    c.items = [user('u0'), assistant('a0', [old]), user('u1'), assistant('a1', [{ type: 'text', text: 'ok' }, t1, t2]), user('m1', true), assistant('a2', [t3])];
    for (const t of [old, t1, t2, t3]) c.toolIndex.set(t.id, t);
    c.runningTool = { id: 't3', name: 'Edit', since: 9 };
    // the meta line (a tool result the CLI wrote as a user message) does not start a new turn
    expect(runStatus(c, 'running', label)).toMatchObject({ done: 2, total: 3 });
  });

  it('counts the sub-agents still running', () => {
    const c = conv([]);
    c.tasks = new Map([['a', task('a', 'running')], ['b', task('b', 'completed')], ['c', task('c', 'running')], ['d', task('d', 'failed')]]);
    expect(runStatus(c, 'running', label).tasks).toBe(2);
  });

  it('the clock starts with the turn; without that, with the step; without that, with the last thing heard', () => {
    const t = tool('t1', 'Bash', { command: 'x' });
    expect(runStatus(conv([t], { turnStartedAt: 1000, lastEventAt: 9000 }), 'running', label).since).toBe(1000);
    expect(runStatus(conv([t], { lastEventAt: 9000 }), 'running', label).since).toBe(5000);
    expect(runStatus(conv([], { lastEventAt: 9000 }), 'running', label).since).toBe(9000);
    expect(runStatus(conv([]), 'running', label).since).toBeUndefined();
  });

  it('key: the same words give the same key, other words another — the count and the clock are not part of it', () => {
    const a = runStatus(conv([tool('t1', 'Read', { file_path: '/r/a.ts' })], { turnStartedAt: 1 }), 'running', label);
    const again = runStatus(conv([tool('t9', 'Read', { file_path: '/other/a.ts' }, 'running'), tool('t8', 'Bash', { command: 'x' }, 'done')], { turnStartedAt: 777 }), 'running', label);
    const b = runStatus(conv([tool('t1', 'Read', { file_path: '/r/b.ts' })]), 'running', label);
    const thinking = runStatus(conv([]), 'running', label);
    expect(again.key).toBe(a.key);
    expect(b.key).not.toBe(a.key);
    expect(thinking.key).not.toBe(a.key);
    // a verb that ends where a target starts is not the same words
    const c1 = runStatus(conv([tool('t1', 'Bash', { command: 'ab' })]), 'running', (n, i) => ({ verb: 'x', arg: String(i.command), category: 'cmd' }));
    const c2 = runStatus(conv([tool('t1', 'Bash', { command: 'b' })]), 'running', (n, i) => ({ verb: 'xa', arg: String(i.command), category: 'cmd' }));
    expect(c1.key).not.toBe(c2.key);
  });
});

describe('elapsedText', () => {
  it('seconds, then minutes with two-digit seconds', () => {
    expect(elapsedText(0)).toBe('0:00');
    expect(elapsedText(59_400)).toBe('0:59');
    expect(elapsedText(59_600)).toBe('1:00');
    expect(elapsedText(65_000)).toBe('1:05');
    expect(elapsedText(3_725_000)).toBe('62:05');
  });
  it('a clock that runs backwards (the two clocks disagree) reads 0', () => {
    expect(elapsedText(-4000)).toBe('0:00');
  });
});

describe('lingerPhase: the tab stays for its leaving animation', () => {
  it('on: there — entering only when it came while the page was looking', () => {
    expect(lingerPhase({ on: true, shown: true, entering: false })).toBe('in');
    expect(lingerPhase({ on: true, shown: true, entering: true })).toBe('enter');
  });
  it('off: leaving while it is still shown, then gone', () => {
    expect(lingerPhase({ on: false, shown: true, entering: false })).toBe('out');
    expect(lingerPhase({ on: false, shown: true, entering: true })).toBe('out');
    expect(lingerPhase({ on: false, shown: false, entering: false })).toBe('gone');
  });
});

describe('swapCount: which words come in with the swap animation', () => {
  it('the first words do not (the tab itself comes in); every change after that does', () => {
    let s = swapCount(undefined, 'a');
    expect(s).toEqual({ key: 'a', n: 0 });
    s = swapCount(s, 'a');
    expect(s.n).toBe(0);
    s = swapCount(s, 'b');
    expect(s).toEqual({ key: 'b', n: 1 });
    s = swapCount(s, 'a'); // back to words it had before: still a change
    expect(s).toEqual({ key: 'a', n: 2 });
  });
  it('the same words return the same object (nothing to re-render for)', () => {
    const s = swapCount(undefined, 'a');
    expect(swapCount(s, 'a')).toBe(s);
  });
});
