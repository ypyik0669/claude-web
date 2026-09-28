import { describe, expect, it } from 'vitest';
import type { PermissionRequestEvent } from '@shared';
import type { AssistantItem, Item, ToolUseBlock } from '@/model/conversation';
import { alwaysLabel, composerAct, denyResponse, dockKind, permissionTitle, waitingToolIds } from './permission-dock';

const req = (toolName: string, input: Record<string, unknown> = {}, extra: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent => ({ requestId: `r-${toolName}`, sessionId: 's', toolName, input, ...extra });

describe('composerAct: Enter / send in the composer while a card sits above it', () => {
  const bash = req('Bash', { command: 'npm test' });
  it('no card → a normal send', () => {
    expect(composerAct(undefined, { text: 'hi', attachments: false })).toBe('send');
    expect(composerAct(undefined, { text: '', attachments: false })).toBe('send');
  });
  it('words in the box → deny with them as the reason (the old card\'s 拒绝理由 field)', () => {
    expect(composerAct(bash, { text: '先别跑测试，看一下 lint', attachments: false })).toBe('deny');
    expect(composerAct(req('ExitPlanMode', { plan: 'x' }), { text: '第二步换个做法', attachments: true })).toBe('deny');
    expect(composerAct(req('AskUserQuestion', { questions: [] }), { text: '都不要', attachments: false })).toBe('deny');
  });
  it('an empty box → the card\'s main button (允许一次 ↵ / 批准 / 提交回答)', () => {
    expect(composerAct(bash, { text: '', attachments: false })).toBe('primary');
    expect(composerAct(bash, { text: '  \n ', attachments: false })).toBe('primary');
  });
  it('only attachments, no words → sent as a message after the turn, as before (never an approval)', () => {
    expect(composerAct(bash, { text: '', attachments: true })).toBe('send');
  });
});

describe('denyResponse', () => {
  it('the typed words are the message; an empty box keeps each card\'s old default', () => {
    expect(denyResponse(req('Bash'), '  换成 pnpm  ')).toEqual({ behavior: 'deny', message: '换成 pnpm' });
    expect(denyResponse(req('Bash'), '')).toEqual({ behavior: 'deny', message: '用户拒绝了这次操作' });
    expect(denyResponse(req('ExitPlanMode'), '')).toEqual({ behavior: 'deny', message: '用户要求修改计划' });
    expect(denyResponse(req('AskUserQuestion'), '')).toEqual({ behavior: 'deny', message: '用户取消了提问' });
  });
});

describe('dockKind / permissionTitle', () => {
  it('names what is being asked in words', () => {
    expect(dockKind(req('AskUserQuestion'))).toBe('ask');
    expect(dockKind(req('ExitPlanMode'))).toBe('plan');
    expect(dockKind(req('Bash'))).toBe('tool');
    expect(permissionTitle(req('Bash', { command: 'npm test' }))).toBe('Claude 想运行一条命令');
    expect(permissionTitle(req('PowerShell', { command: 'ls' }), 'Codex')).toBe('Codex 想运行一条命令');
    expect(permissionTitle(req('Edit', { file_path: 'C:\\w\\src\\todos.js' }))).toBe('Claude 想修改 todos.js');
    expect(permissionTitle(req('Write', { file_path: '/w/new.ts' }))).toBe('Claude 想写入 new.ts');
    expect(permissionTitle(req('Read', { file_path: '/w/.env' }))).toBe('Claude 想读取 .env');
    expect(permissionTitle(req('WebFetch', { url: 'https://example.com/a?b' }))).toBe('Claude 想访问 example.com');
    expect(permissionTitle(req('mcp__github__create_issue'))).toBe('Claude 想使用 github 的 create_issue');
    expect(permissionTitle(req('SomethingElse'))).toBe('Claude 想使用 SomethingElse');
    expect(permissionTitle(req('AskUserQuestion'))).toBe('Claude 有问题要问你');
    expect(permissionTitle(req('ExitPlanMode'))).toBe('Claude 想按这个计划开始动手');
  });
});

describe('alwaysLabel (总是允许 only when the request carries suggestions)', () => {
  it('none → no button', () => {
    expect(alwaysLabel(undefined)).toBeNull();
    expect(alwaysLabel([])).toBeNull();
  });
  it('one rule → names it', () => {
    expect(alwaysLabel([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' }])).toBe('总是允许 npm test');
    expect(alwaysLabel([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'node scripts/some-very-long-script-name.mjs --flag:*' }], behavior: 'allow', destination: 'localSettings' }])).toBe('总是允许 node scripts/some-very-lo…');
    expect(alwaysLabel([{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'localSettings' }])).toBe('总是允许 WebFetch');
  });
  it('the accept-edits mode / a directory / anything else', () => {
    expect(alwaysLabel([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])).toBe('这个对话里都允许改文件');
    expect(alwaysLabel([{ type: 'addDirectories', directories: ['/w/other'], destination: 'session' }])).toBe('总是允许这个目录');
    expect(alwaysLabel([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'a' }, { toolName: 'Bash', ruleContent: 'b' }], behavior: 'allow', destination: 'localSettings' }])).toBe('总是允许');
  });
});

describe('waitingToolIds (the step that shows 等你确认)', () => {
  let n = 0;
  const tool = (name: string, status: ToolUseBlock['status']): ToolUseBlock => ({ type: 'tool_use', id: `t${++n}`, name, input: {}, children: [], status });
  const asst = (...blocks: ToolUseBlock[]): AssistantItem => ({ kind: 'assistant', id: `m${++n}`, blocks, streaming: false, parentToolUseId: null });

  it('by the request\'s tool use id', () => {
    const t = tool('Bash', 'pending');
    expect([...waitingToolIds([req('Bash', {}, { toolUseId: t.id })], [asst(t)])]).toEqual([t.id]);
  });
  it('without an id: the last unfinished call of that tool', () => {
    const done = tool('Bash', 'done'), a = tool('Bash', 'pending'), b = tool('Read', 'pending');
    const items: Item[] = [asst(done, a, b)];
    expect([...waitingToolIds([req('Bash')], items)]).toEqual([a.id]);
    expect([...waitingToolIds([req('Edit')], items)]).toEqual([]);
  });
  it('questions and plans have no step to mark; nothing pending → empty', () => {
    expect(waitingToolIds([], []).size).toBe(0);
  });
});
