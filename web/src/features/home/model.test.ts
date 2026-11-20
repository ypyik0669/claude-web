import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import {
  CHECKLIST, CHECKLIST_KEY, STARTERS, agoText, applyStarter, checklistView, engineNotice, firstTime, initialCwd, projectHasConversations, readChecklist, reconcileChecklist,
} from './model';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const min = 60_000, hour = 3600_000, day = 86400_000;
const S = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: `t-${id}`, cwd: 'C:/code/app', lastModified: NOW - hour, ...over });

describe('starters (redesign 2026-11: three, only filled in, never sent, only for a project with no conversation)', () => {
  it('are the three of the mockup, in order', () => {
    expect(STARTERS.map((s) => s.label)).toEqual(['讲讲这个项目的结构', '找一个 bug 并修好', '给最近的改动补测试']);
    for (const s of STARTERS) expect(s.text.length).toBeGreaterThan(s.label.length - 1);
  });
  it('show while the project in the box has no conversation (its folder or one under it, on that machine)', () => {
    const list = [S('a', { cwd: String.raw`C:\code\app\web` }), S('b', { cwd: '/srv/x', peer: { id: 'mac', name: 'Mac' } as SessionSummary['peer'] })];
    expect(projectHasConversations({ cwd: 'C:/code/app' }, list)).toBe(true);
    expect(projectHasConversations({ cwd: String.raw`c:\Code\App\web` }, list)).toBe(true);
    expect(projectHasConversations({ cwd: 'C:/code/other' }, list)).toBe(false);
    expect(projectHasConversations({ cwd: '/srv/x' }, list)).toBe(false); // that one is the Mac's
    expect(projectHasConversations({ cwd: '/srv/x', peer: 'mac' }, list)).toBe(true);
    // listed under the project by its group folder
    expect(projectHasConversations({ cwd: 'D:/proj' }, [S('c', { cwd: 'E:/tmp/wt' })], { c: { groupCwd: 'D:/proj' } })).toBe(true);
    // no folder chosen: nothing to say (no starters)
    expect(projectHasConversations({ cwd: '' }, [])).toBe(true);
  });
  it('the 入门清单 is the first time’s: no conversation on this computer yet, once the list has come', () => {
    expect(firstTime({ listed: false, sessions: [] })).toBe(false);
    expect(firstTime({ listed: true, sessions: [] })).toBe(true);
    expect(firstTime({ listed: true, sessions: [S('a')] })).toBe(false);
    expect(firstTime({ listed: true, sessions: [S('b', { peer: { id: 'mac', name: 'Mac' } as SessionSummary['peer'] })] })).toBe(true);
  });
  it('fill an empty box, replace another starter, and never throw away what was typed', () => {
    const [a, b] = STARTERS;
    expect(applyStarter('', a.text)).toBe(a.text);
    expect(applyStarter('   ', a.text)).toBe(a.text);
    expect(applyStarter(b.text, a.text)).toBe(a.text);
    expect(applyStarter('修一下登录页', a.text)).toBe(`修一下登录页\n${a.text}`);
  });
});

describe('入门清单 (settings[onboarding.checklist])', () => {
  it('the four steps of the spec', () => {
    expect(CHECKLIST_KEY).toBe('onboarding.checklist');
    expect(CHECKLIST.map((c) => c.id)).toEqual(['project', 'send', 'review', 'palette']);
  });
  it('reads anything safely', () => {
    expect(readChecklist(undefined)).toEqual({ done: [] });
    expect(readChecklist('x')).toEqual({ done: [] });
    expect(readChecklist({ done: ['review', 'nope', 'review'], dismissed: true })).toEqual({ done: ['review'], dismissed: true });
  });
  it('a project completes its step by itself; the rest only when they happen in this app (review 7 M8)', () => {
    expect(reconcileChecklist({ done: [] }, { projects: 0 })).toBeNull();
    // the CLI's old conversations do not make 发出第一个任务 done: only a message sent from here does
    expect(reconcileChecklist({ done: [] }, { projects: 1 })).toEqual({ done: ['project'] });
    expect(reconcileChecklist({ done: ['project'] }, { projects: 1, event: 'send' })).toEqual({ done: ['project', 'send'] });
    expect(reconcileChecklist({ done: ['project'] }, { projects: 1, event: 'palette' })).toEqual({ done: ['project', 'palette'] });
    // nothing new → no write
    expect(reconcileChecklist({ done: ['project', 'send'] }, { projects: 2 })).toBeNull();
    // dismissed / finished: never written again
    expect(reconcileChecklist({ done: [], dismissed: true }, { projects: 1, event: 'review' })).toBeNull();
    expect(reconcileChecklist({ done: ['project', 'send', 'review', 'palette'] }, { projects: 0 })).toBeNull();
  });
  it('the first read stamps since (older stores too), once; dismissed / finished lists are left alone (re-review M-7)', () => {
    expect(readChecklist({ done: ['project'], since: 123 })).toEqual({ done: ['project'], since: 123 });
    expect(readChecklist({ done: [], since: 'x' })).toEqual({ done: [] });
    expect(reconcileChecklist({ done: [] }, { projects: 0, now: 500 })).toEqual({ done: [], since: 500 });
    expect(reconcileChecklist({ done: ['project'] }, { projects: 1, now: 500 })).toEqual({ done: ['project'], since: 500 });
    expect(reconcileChecklist({ done: ['project'], since: 100 }, { projects: 1, now: 500 })).toBeNull();
    expect(reconcileChecklist({ done: ['project'], since: 100 }, { projects: 1, event: 'send', now: 500 })).toEqual({ done: ['project', 'send'], since: 100 });
    expect(reconcileChecklist({ done: [], dismissed: true }, { projects: 0, now: 500 })).toBeNull();
    expect(reconcileChecklist({ done: ['project', 'send', 'review', 'palette'] }, { projects: 0, now: 500 })).toBeNull();
  });
  it('once recorded a step stays done (removing the last project does not bring the card back)', () => {
    const v = checklistView({ done: ['project', 'send', 'review', 'palette'] });
    expect(v.visible).toBe(false);
    expect(checklistView({ done: ['project'] }).items[0].done).toBe(true);
  });
  it('the view: count, the next step, gone for good when finished or dismissed', () => {
    const v = checklistView({ done: ['project', 'send'] });
    expect(v).toMatchObject({ done: 2, total: 4, next: 'review', visible: true });
    expect(checklistView({ done: ['send'] }).next).toBe('project');
    expect(checklistView({ done: [], dismissed: true }).visible).toBe(false);
  });
});

describe('times', () => {
  it('agoText', () => {
    expect(agoText(NOW - 20_000, NOW)).toBe('刚刚');
    expect(agoText(NOW - 10 * min, NOW)).toBe('10 分钟前');
    expect(agoText(NOW - 3 * hour, NOW)).toBe('3 小时前');
    expect(agoText(NOW - 30 * hour, NOW)).toBe('昨天');
    expect(agoText(NOW - 4 * day, NOW)).toBe('4 天前');
    expect(agoText(NOW - 40 * day, NOW)).toMatch(/^\d+\/\d+$/);
  });
});

describe('the project chip starts on the last project', () => {
  it('the remembered one, else the newest local conversation’s folder, else the first project', () => {
    expect(initialCwd({ stored: 'C:/x', sessions: [S('a')], workspaces: [] })).toBe('C:/x');
    expect(initialCwd({ stored: '', sessions: [S('p', { cwd: '/remote', peer: { id: 'm', name: 'm' } }), S('a', { cwd: 'C:/code/app' })], workspaces: [] })).toBe('C:/code/app');
    expect(initialCwd({ stored: null, sessions: [], workspaces: [{ path: 'C:/w' }] })).toBe('C:/w');
    expect(initialCwd({ stored: null, sessions: [], workspaces: [] })).toBe('');
  });
  it('a conversation counts as its project: the sidebar group, a worktree session as its repo; forks and orchestration worktrees are skipped (review 7 M10)', () => {
    const orch = S('o', { cwd: 'C:/Users/me/.claude-web/worktrees/app-1a2b3c4d/r1-n1-claude', lastModified: NOW });
    // an orchestration node records its run folder as the group
    expect(initialCwd({ stored: null, sessions: [orch], workspaces: [], meta: { o: { groupCwd: 'C:/code/app' } } })).toBe('C:/code/app');
    // without the record its worktree is not offered; the next conversation is
    expect(initialCwd({ stored: null, sessions: [orch, S('a', { cwd: 'C:/code/web' })], workspaces: [] })).toBe('C:/code/web');
    // a fork / sub-agent follows its parent: skipped
    expect(initialCwd({ stored: null, sessions: [S('f', { cwd: 'C:/tmp/fork', parentId: 'a', lastModified: NOW }), S('a', { cwd: 'C:/code/web' })], workspaces: [] })).toBe('C:/code/web');
    // Claude Code's own worktree → the repo
    expect(initialCwd({ stored: null, sessions: [S('w', { cwd: 'C:/code/app/.claude/worktrees/task-1' })], workspaces: [] })).toBe('C:/code/app');
  });
});

describe('the login / runtime notice: only when something is wrong (spec §5.8)', () => {
  it('nothing while it is fine or not known yet', () => {
    expect(engineNotice({ auth: null, providers: 0, engine: 'ok' })).toBeNull();
    expect(engineNotice({ auth: { loggedIn: true }, providers: 0, engine: 'ok' })).toBeNull();
    expect(engineNotice({ auth: { loggedIn: false }, providers: 2, engine: 'ok' })).toBeNull();
  });
  it('not logged in with no provider: connect a model first, the Claude login second', () => {
    expect(engineNotice({ auth: { loggedIn: false }, providers: 0, engine: 'ok' })).toEqual({ kind: 'login', text: '还没接模型：填一个 API Key，或者用 Claude 账号登录。', actions: ['provider', 'login'] });
  });
  it('no runtime found: says so, and where to look (settings) — before any login question', () => {
    expect(engineNotice({ auth: null, providers: 0, engine: 'missing' })).toMatchObject({ kind: 'engine', actions: ['runtime'] });
    expect(engineNotice({ auth: { loggedIn: true }, providers: 3, engine: 'missing' })).toMatchObject({ kind: 'engine' });
    expect(engineNotice({ auth: null, providers: 0, engine: 'missing' })!.text).not.toMatch(/引擎|档案/);
  });
});
