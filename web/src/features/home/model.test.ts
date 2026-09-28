import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import {
  CHECKLIST, CHECKLIST_KEY, STARTERS, agoText, applyStarter, checklistView, engineNotice, homeRows, homeTabs, initialCwd, readChecklist, reconcileChecklist, waitingText,
} from './model';
import { nextRunText } from '@/features/automation/schedule-text';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const min = 60_000, hour = 3600_000, day = 86400_000;
const S = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: `t-${id}`, cwd: 'C:/code/app', lastModified: NOW - hour, ...over });

describe('starters (spec §5.8: four, only filled in, never sent)', () => {
  it('are the four of the spec, in order', () => {
    expect(STARTERS.map((s) => s.label)).toEqual(['讲讲这个项目的结构', '找一个 bug 并修好', '给最近的改动补测试', '先出方案再动手']);
    for (const s of STARTERS) expect(s.text.length).toBeGreaterThan(s.label.length - 1);
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

describe('the start page lists (最近任务 / 定时任务 / 已归档)', () => {
  const ws = [{ id: 'w', path: 'C:/code/app', name: 'app' }];
  it('recent: top-level, not archived, newest first, five at most; project name or folder, agent name, time', () => {
    const list = [
      S('a', { lastModified: NOW - 4 * min }),
      S('b', { lastModified: NOW - 2 * day, cwd: 'D:/misc/tool', agent: 'codex' }),
      S('c', { lastModified: NOW - 10 * min, parentId: 'a' }),
      S('d', { lastModified: NOW - hour }),
      S('e', { lastModified: NOW - day }),
      S('f', { lastModified: NOW - 3 * day }),
      S('g', { lastModified: NOW - 4 * day }),
      S('h', { lastModified: NOW - 5 * min }),
    ];
    const r = homeRows('recent', { sessions: list, meta: { h: { archived: true } }, workspaces: ws, agents: [{ kind: 'codex', name: 'Codex' }], now: NOW });
    expect(r.rows.map((x) => x.id)).toEqual(['a', 'd', 'e', 'b', 'f']);
    expect(r.more).toBe(1);
    expect(r.rows[0]).toMatchObject({ where: 'app', when: '4 分钟前' });
    expect(r.rows[3]).toMatchObject({ where: 'tool', agent: 'Codex', when: '2 天前' });
  });
  it('archived: only archived ones (meta or the source’s own flag)', () => {
    const r = homeRows('archived', { sessions: [S('a'), S('b', { archived: true }), S('c')], meta: { c: { archived: true } }, workspaces: ws, now: NOW });
    expect(r.rows.map((x) => x.id).sort()).toEqual(['b', 'c']);
  });
  it('a conversation on another machine says which machine', () => {
    const r = homeRows('recent', { sessions: [S('peer_m~x', { peer: { id: 'm', name: '台式机' } })], meta: {}, workspaces: ws, now: NOW });
    expect(r.rows[0].where).toBe('台式机 · app');
  });
  it('the status on the right: what the sidebar row says, in words for a wider row', () => {
    const r = homeRows('recent', {
      sessions: [S('run'), S('ask'), S('err'), S('diff'), S('plain')], meta: {}, workspaces: ws, now: NOW,
      status: {
        run: { state: 'running' },
        ask: { state: 'waiting', pending: [{ toolName: 'Bash' }] },
        err: { state: 'error', error: 'boom' },
        diff: { state: 'idle', diff: { added: 42, removed: 7 } },
      },
    });
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x.status]));
    expect(by.run).toMatchObject({ kind: 'running', label: '运行中' });
    expect(by.ask).toMatchObject({ kind: 'confirm', label: '等你确认一条命令' });
    expect(by.err).toMatchObject({ kind: 'error' });
    expect(by.diff).toMatchObject({ kind: 'diff', added: 42, removed: 7 });
    expect(by.plain).toBeNull();
  });
  it('schedules: name, project, what runs when; paused and failing ones say so', () => {
    const r = homeRows('schedules', {
      sessions: [], meta: {}, workspaces: ws, now: NOW,
      schedules: [
        { id: 's1', name: '每日 CI', cwd: 'C:/code/app', cron: '0 9 * * 1-5', enabled: true, nextRunAt: NOW + 5 * hour, prompt: '' },
        { id: 's2', name: '整理', cwd: 'C:/code/app', everyMinutes: 240, enabled: false, prompt: '' },
        { id: 's3', name: '坏的', cwd: 'C:/code/app', everyMinutes: 60, enabled: true, lastError: 'no cwd', prompt: '' },
      ] as never,
    });
    // the period in words, the expression in the tooltip; the next run as nextRunText says it (schedule-text.test.ts)
    expect(r.rows.map((x) => [x.title, x.where, x.when])).toEqual([['每日 CI', 'app', '工作日 09:00'], ['整理', 'app', '每 4 小时'], ['坏的', 'app', '每小时']]);
    expect(r.rows[0].whenTitle).toBe('cron：0 9 * * 1-5');
    expect(r.rows[1].whenTitle).toBeUndefined();
    expect(r.rows[0].status).toMatchObject({ kind: 'time', label: nextRunText(NOW + 5 * hour, NOW) });
    expect(r.rows[1].status).toMatchObject({ kind: 'paused', label: '已暂停' });
    expect(r.rows[2].status).toMatchObject({ kind: 'error' });
  });
  it('tabs carry their counts', () => {
    expect(homeTabs({ schedules: 3 }).map((t) => [t.id, t.n])).toEqual([['recent', undefined], ['schedules', 3], ['archived', undefined]]);
  });
  it('what a waiting request is, in words', () => {
    expect(waitingText([{ toolName: 'Bash' }])).toBe('等你确认一条命令');
    expect(waitingText([{ toolName: 'Edit' }])).toBe('等你确认一处修改');
    expect(waitingText([{ toolName: 'ExitPlanMode' }])).toBe('等你确认方案');
    expect(waitingText([{ toolName: 'AskUserQuestion' }])).toBe('有问题问你');
    expect(waitingText([{ toolName: 'mcp__x' }, { toolName: 'Bash' }])).toBe('等你确认 2 个操作');
    expect(waitingText([])).toBe('等你确认');
  });
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
  it('not logged in with no provider: log in, or add one', () => {
    expect(engineNotice({ auth: { loggedIn: false }, providers: 0, engine: 'ok' })).toEqual({ kind: 'login', text: '还没登录 Claude。', actions: ['login', 'provider'] });
  });
  it('no runtime found: says so, and where to look (settings) — before any login question', () => {
    expect(engineNotice({ auth: null, providers: 0, engine: 'missing' })).toMatchObject({ kind: 'engine', actions: ['runtime'] });
    expect(engineNotice({ auth: { loggedIn: true }, providers: 3, engine: 'missing' })).toMatchObject({ kind: 'engine' });
    expect(engineNotice({ auth: null, providers: 0, engine: 'missing' })!.text).not.toMatch(/引擎|档案/);
  });
});
