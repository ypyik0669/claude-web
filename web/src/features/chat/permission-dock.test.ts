import { describe, expect, it } from 'vitest';
import type { PermissionRequestEvent } from '@shared';
import type { AssistantItem, Item, ToolUseBlock } from '@/model/conversation';
import { alwaysDetails, alwaysLabel, DOCK_COOLDOWN_MS, dockAction, dockDecide, denyResponse, dockKind, isSlashCommand, permissionTitle, primaryKey, waitingToolIds, type DockSeen } from './permission-dock';

const req = (toolName: string, input: Record<string, unknown> = {}, extra: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent => ({ requestId: `r-${toolName}`, sessionId: 's', toolName, input, ...extra });

describe('dockAction: Enter / send in the composer while a card sits above it', () => {
  const bash = req('Bash', { command: 'npm test' });
  const T = 100_000;
  /** the card has been on screen long enough, and the box was empty when it came */
  const settled = (p: PermissionRequestEvent, extra: Partial<DockSeen> = {}): DockSeen => ({ requestId: p.requestId, shownAt: T - DOCK_COOLDOWN_MS - 1, carried: false, ...extra });
  const enter = (p: PermissionRequestEvent | undefined, text: string, o: { attachments?: boolean; seen?: DockSeen | null; repeat?: boolean; ctrl?: boolean; now?: number } = {}) =>
    dockAction(p, { text, attachments: !!o.attachments, seen: o.seen === undefined && p ? settled(p) : o.seen, now: o.now ?? T, enter: { repeat: o.repeat, ctrl: o.ctrl } });
  const click = (p: PermissionRequestEvent | undefined, text: string, o: { attachments?: boolean; seen?: DockSeen | null } = {}) =>
    dockAction(p, { text, attachments: !!o.attachments, seen: o.seen === undefined && p ? settled(p) : o.seen, now: T });

  it('no card → a normal send', () => {
    expect(enter(undefined, 'hi')).toBe('send');
    expect(click(undefined, 'hi')).toBe('send');
  });
  it('words typed while the card is up → deny with them as the reason (the old card\'s 拒绝理由 field)', () => {
    expect(enter(bash, '先别跑测试，看一下 lint')).toBe('deny');
    expect(click(bash, '先别跑测试，看一下 lint')).toBe('deny');
    expect(enter(req('ExitPlanMode', { plan: 'x' }), '第二步换个做法')).toBe('deny');
    expect(enter(req('AskUserQuestion', { questions: [] }), '都不要')).toBe('deny');
  });
  it('an empty box, once the card has been on screen a moment → the card\'s main button', () => {
    expect(enter(bash, '')).toBe('primary');
    expect(enter(bash, '  \n ')).toBe('primary');
    expect(enter(req('AskUserQuestion', { questions: [] }), '')).toBe('primary');
  });
  it('only attachments, no words → sent as a message after the turn, as before (never an approval)', () => {
    expect(enter(bash, '', { attachments: true })).toBe('send');
  });

  // review I3: an Enter meant for something else must not answer a card
  it('an empty Enter within the first moments of a card (or the next one taking its place) does nothing', () => {
    expect(enter(bash, '', { seen: { requestId: bash.requestId, shownAt: T - 100, carried: false } })).toBe('ignore');
    expect(enter(bash, '', { seen: { requestId: bash.requestId, shownAt: T - DOCK_COOLDOWN_MS + 1, carried: false } })).toBe('ignore');
    // the card that was seen is another one (the next one just docked; not recorded yet)
    expect(enter(bash, '', { seen: { requestId: 'r-before', shownAt: 0, carried: false } })).toBe('ignore');
    expect(enter(bash, '', { seen: null })).toBe('ignore');
  });
  it('a held-down Enter (key repeat) never answers anything', () => {
    expect(enter(bash, '', { repeat: true })).toBe('ignore');
    expect(enter(bash, '拒绝理由', { repeat: true })).toBe('ignore');
  });
  it('words that were in the box before the card came are sent (queued) as before, not a deny', () => {
    const carried = settled(bash, { carried: true });
    expect(enter(bash, '下一步把 README 也改了', { seen: carried })).toBe('send');
    expect(click(bash, '下一步把 README 也改了', { seen: carried })).toBe('send');
    // …and after that, an empty Enter means what it always means (allow, past the cool-down): taking the queued
    // words back as the reason is the card's button, never an Enter whose meaning depends on hidden state
    const queued = settled(bash, { queued: { id: 'q1', text: '下一步把 README 也改了' } });
    expect(enter(bash, '', { seen: queued })).toBe('primary');
    expect(enter(bash, '', { seen: { ...queued, shownAt: T - 10 } })).toBe('ignore');
    // (a click on send with an empty box does nothing)
    expect(click(bash, '', { seen: queued })).toBe('ignore');
  });
  it('a slash command is always an ordinary send (/compact, /model, /goal …)', () => {
    expect(enter(bash, '/compact')).toBe('send');
    expect(enter(bash, '  /goal 把测试补齐')).toBe('send');
    expect(click(req('ExitPlanMode', { plan: 'x' }), '/model opus')).toBe('send');
  });
  it('only a command name counts as a slash command — a path is an answer to the card (review M-10)', () => {
    expect(enter(bash, '/usr/bin 下没有这个，换个做法')).toBe('deny');
    expect(enter(bash, '/ 不对')).toBe('deny');
    expect(enter(bash, '/tmp/x.log 看一下')).toBe('deny');
    for (const c of ['/compact', '/goal 把测试补齐', '/model opus', '/plugin:cmd arg', '/mcp__srv__tool', '/effort high\n再说']) expect(isSlashCommand(c), c).toBe(true);
    for (const c of ['/usr/bin', '/ 空格', '/1abc', '//x', 'compact', '/中文命令']) expect(isSlashCommand(c), c).toBe(false);
  });
  it('an ignored Enter says why when the user should know: too soon, or an empty Enter on a plan (review M-6)', () => {
    const plan = req('ExitPlanMode', { plan: 'x' });
    const at = (p: PermissionRequestEvent, shownAt: number, o: { repeat?: boolean; ctrl?: boolean } = {}) =>
      dockDecide(p, { text: '', attachments: false, seen: { requestId: p.requestId, shownAt, carried: false }, now: T, enter: o });
    expect(at(bash, T - 10)).toEqual({ act: 'ignore', why: 'soon' });
    expect(at(plan, T - 10)).toEqual({ act: 'ignore', why: 'soon' });
    expect(at(plan, T - DOCK_COOLDOWN_MS - 1)).toEqual({ act: 'ignore', why: 'plan' });
    expect(at(plan, T - DOCK_COOLDOWN_MS - 1, { ctrl: true })).toEqual({ act: 'primary' });
    // a held-down key says nothing (it would repeat the note many times a second)
    expect(at(bash, T - 10, { repeat: true })).toEqual({ act: 'ignore' });
    expect(at(bash, T - DOCK_COOLDOWN_MS - 1)).toEqual({ act: 'primary' });
  });
  it('a plan is approved by a click or Ctrl+Enter only; an empty Enter does nothing', () => {
    const plan = req('ExitPlanMode', { plan: 'x' });
    expect(enter(plan, '')).toBe('ignore');
    expect(enter(plan, '', { ctrl: true })).toBe('primary');
    expect(enter(plan, '', { ctrl: true, seen: { requestId: plan.requestId, shownAt: T - 10, carried: false } })).toBe('ignore');
    expect(enter(plan, '改第二步', { ctrl: true })).toBe('deny');
  });
  // 操控电脑 asking which applications it may control: the whole desktop is behind that yes, so it is a click on the
  // card — no key gives it, however long the card has been there
  it('操控电脑\'s access request is never approved from the keyboard: Enter and Ctrl+Enter do nothing, and say so', () => {
    const access = req('mcp__computer__request_access', { apps: ['记事本'], reason: '写一段话' });
    expect(enter(access, '')).toBe('ignore');
    expect(enter(access, '', { ctrl: true })).toBe('ignore');
    expect(enter(access, '  \n')).toBe('ignore');
    expect(click(access, '')).toBe('ignore');
    const at = (shownAt: number, o: { repeat?: boolean; ctrl?: boolean } = {}) =>
      dockDecide(access, { text: '', attachments: false, seen: { requestId: access.requestId, shownAt, carried: false }, now: T, enter: o });
    expect(at(T - DOCK_COOLDOWN_MS - 1)).toEqual({ act: 'ignore', why: 'access' });
    expect(at(T - DOCK_COOLDOWN_MS - 1, { ctrl: true })).toEqual({ act: 'ignore', why: 'access' });
    expect(at(T - 60_000)).toEqual({ act: 'ignore', why: 'access' });
    expect(at(T - 10)).toEqual({ act: 'ignore', why: 'soon' });
    expect(at(T - DOCK_COOLDOWN_MS - 1, { repeat: true })).toEqual({ act: 'ignore' });
    // words are a no with a reason, like on every card; what was typed before it came is still an ordinary message
    expect(enter(access, '别动我的记事本')).toBe('deny');
    expect(click(access, '别动我的记事本')).toBe('deny');
    expect(enter(access, '看这个', { attachments: true })).toBe('blocked');
    expect(enter(access, '先把上一步做完', { seen: settled(access, { carried: true }) })).toBe('send');
    expect(enter(access, '/compact')).toBe('send');
    // its other tools (were another host to ask about one) are ordinary tool cards
    expect(enter(req('mcp__computer__left_click', { coordinate: [1, 2] }), '')).toBe('primary');
  });
  it('words and attachments together (typed while the card is up) cannot go as a deny: blocked, with a note (review M2)', () => {
    expect(enter(bash, '看这个报错', { attachments: true })).toBe('blocked');
    expect(click(bash, '看这个报错', { attachments: true })).toBe('blocked');
    // before the card came: an ordinary message, attachments and all
    expect(enter(bash, '看这个报错', { attachments: true, seen: settled(bash, { carried: true }) })).toBe('send');
  });
  it('the send button never approves (an empty box cannot be sent anyway)', () => {
    expect(click(bash, '')).toBe('ignore');
  });
});

describe('primaryKey (review M3: one conversation in two panes)', () => {
  it('each pane\'s card has its own main button', () => {
    expect(primaryKey('pane-a|tile-1', 'r1')).not.toBe(primaryKey('pane-b|tile-2', 'r1'));
    expect(primaryKey('pane-a|tile-1', 'r1')).toBe(primaryKey('pane-a|tile-1', 'r1'));
  });
});

describe('denyResponse', () => {
  it('the typed words are the message; an empty box keeps each card\'s old default', () => {
    expect(denyResponse(req('Bash'), '  换成 pnpm  ')).toEqual({ behavior: 'deny', message: '换成 pnpm' });
    expect(denyResponse(req('Bash'), '')).toEqual({ behavior: 'deny', message: '用户拒绝了这次操作' });
    expect(denyResponse(req('ExitPlanMode'), '')).toEqual({ behavior: 'deny', message: '用户要求修改计划' });
    expect(denyResponse(req('AskUserQuestion'), '')).toEqual({ behavior: 'deny', message: '用户取消了提问' });
    // 操控电脑: the server words the refusal for the model itself — only what the user typed is added to it
    expect(denyResponse(req('mcp__computer__request_access'), '')).toEqual({ behavior: 'deny', message: '' });
    expect(denyResponse(req('mcp__computer__request_access'), ' 只许用画图 ')).toEqual({ behavior: 'deny', message: '只许用画图' });
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
  it('操控电脑: the access request is its own kind of card, titled with the application', () => {
    expect(dockKind(req('mcp__computer__request_access'))).toBe('access');
    expect(dockKind(req('mcp__computer__left_click'))).toBe('tool');
    expect(dockKind(req('mcp__other__request_access'))).toBe('tool'); // another server's tool of the same name
    expect(permissionTitle(req('mcp__computer__request_access', { apps: ['记事本'] }))).toBe('Claude 想操控这台电脑上的 记事本');
    expect(permissionTitle(req('mcp__computer__request_access', { apps: ['记事本', '画图'] }))).toBe('Claude 想操控这台电脑上的 2 个应用');
    // its other tools are not asked about here; asked by another host, they read as what they do, not as 「computer 的 key」
    expect(permissionTitle(req('mcp__computer__left_click', { coordinate: [3, 4] }))).toBe('Claude 想点击屏幕');
    expect(permissionTitle(req('mcp__computer__type', { text: 'hi' }))).toBe('Claude 想用键盘输入');
    expect(permissionTitle(req('mcp__computer__screenshot'))).toBe('Claude 想看屏幕');
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
    expect(alwaysLabel([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'a' }, { toolName: 'Bash', ruleContent: 'b' }], behavior: 'allow', destination: 'localSettings' }])).toBe('总是允许 2 条规则');
  });
  // review M4: the button writes every suggestion, so its words cover every one
  it('several suggestions → 「等 N 项」, and the tooltip lists each with where it is written', () => {
    const s = [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
      { type: 'addDirectories', directories: ['/w/other'], destination: 'session' },
    ];
    expect(alwaysLabel(s)).toBe('总是允许 npm test 等 2 项');
    expect(alwaysDetails(s)).toEqual(['允许规则 Bash(npm test:*) · 写入本项目的本地设置', '允许访问目录 /w/other · 只在这个对话里']);
    expect(alwaysDetails([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])).toEqual(['切换到「自动接受改动」模式 · 只在这个对话里']);
    expect(alwaysDetails([{ type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'userSettings' }])).toEqual(['允许规则 WebFetch(domain:example.com) · 写入你的用户设置']);
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
  it('Codex: a file-change approval names the item; its steps are `<item>:<path>` (review M5)', () => {
    const a = { ...tool('Edit', 'pending'), id: 'item-7:src/a.ts' }, b = { ...tool('Write', 'pending'), id: 'item-7:src/b.ts' }, other = { ...tool('Edit', 'pending'), id: 'item-70:src/c.ts' };
    expect([...waitingToolIds([req('Edit', {}, { toolUseId: 'item-7' })], [asst(a, b, other)])].sort()).toEqual(['item-7', 'item-7:src/a.ts', 'item-7:src/b.ts']);
  });
  it('questions and plans have no step to mark; nothing pending → empty', () => {
    expect(waitingToolIds([], []).size).toBe(0);
  });
});
