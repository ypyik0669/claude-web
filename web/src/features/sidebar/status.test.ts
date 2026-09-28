import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import { accountName, needsYou, pageRows, planLabel, rangeIds, rowStatus, shortAgo, todayCost } from './status';

const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();
const MIN = 60_000, HOUR = 3600_000, DAY = 86400_000;
const s = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: id, cwd: '/w', lastModified: NOW - DAY, ...o });

describe('rowStatus: one status at the end of a row, by priority', () => {
  const base = { lastModified: NOW - 2 * DAY, now: NOW };

  it('a permission request beats everything: 待确认', () => {
    const r = rowStatus({ ...base, state: 'error', pending: [{ toolName: 'Bash' }], diff: { added: 3, removed: 1 }, tag: 'Codex' });
    expect(r).toMatchObject({ kind: 'confirm', label: '待确认' });
  });

  it('only questions pending → 提问; a plan to approve counts as 待确认', () => {
    expect(rowStatus({ ...base, pending: [{ toolName: 'AskUserQuestion' }] })).toMatchObject({ kind: 'ask', label: '提问' });
    expect(rowStatus({ ...base, pending: [{ toolName: 'AskUserQuestion' }, { toolName: 'ExitPlanMode' }] }).kind).toBe('confirm');
    expect(rowStatus({ ...base, pending: [{ toolName: 'ExitPlanMode' }] }).kind).toBe('confirm');
  });

  it("'waiting' without the request itself (another window holds it) is still 待确认", () => {
    expect(rowStatus({ ...base, state: 'waiting' }).kind).toBe('confirm');
  });

  it('出错 beats running, the diff and the time; its title carries the error', () => {
    const r = rowStatus({ ...base, state: 'error', error: 'spawn ENOENT', diff: { added: 1, removed: 0 } });
    expect(r).toMatchObject({ kind: 'error', label: '出错' });
    expect(r.title).toContain('spawn ENOENT');
  });

  it('running / starting → spinner (运行中)', () => {
    expect(rowStatus({ ...base, state: 'running', diff: { added: 5, removed: 5 } }).kind).toBe('running');
    expect(rowStatus({ ...base, state: 'starting' }).kind).toBe('running');
  });

  it('idle / history with edits → +N −M; nothing changed → falls through', () => {
    expect(rowStatus({ ...base, state: 'idle', diff: { added: 42, removed: 7 } })).toMatchObject({ kind: 'diff', added: 42, removed: 7, label: '+42 −7' });
    expect(rowStatus({ ...base, state: 'history', diff: { added: 0, removed: 0 } }).kind).toBe('time');
  });

  it('a non-Claude agent shows its name in gray instead of the time', () => {
    expect(rowStatus({ ...base, tag: 'Codex' })).toMatchObject({ kind: 'tag', label: 'Codex' });
    expect(rowStatus({ ...base, tag: 'Codex', diff: { added: 1, removed: 2 } }).kind).toBe('diff');
  });

  it('otherwise the relative time', () => {
    expect(rowStatus({ ...base })).toMatchObject({ kind: 'time', label: '2 天' });
    expect(rowStatus({ ...base, state: 'closed' }).kind).toBe('time');
  });
});

describe('shortAgo: compact relative time for a narrow column', () => {
  it('minutes, hours, days, weeks, then a date', () => {
    expect(shortAgo(NOW - 20_000, NOW)).toBe('刚刚');
    expect(shortAgo(NOW - 5 * MIN, NOW)).toBe('5 分钟');
    expect(shortAgo(NOW - 3 * HOUR, NOW)).toBe('3 小时');
    expect(shortAgo(NOW - 6 * DAY, NOW)).toBe('6 天');
    expect(shortAgo(NOW - 15 * DAY, NOW)).toBe('2 周');
    expect(shortAgo(new Date(2026, 1, 3).getTime(), NOW)).toBe('2/3');
    expect(shortAgo(new Date(2025, 10, 3).getTime(), NOW)).toBe('2025/11');
    expect(shortAgo(0, NOW)).toBe('');
  });
});

describe('needsYou: what waits for a human, across open sessions, the list and orchestration', () => {
  const sessions = [
    s('a', { title: 'needs a yes', lastModified: NOW - 5 * MIN }),
    s('b', { title: 'crashed', lastModified: NOW - MIN }),
    s('c', { title: 'fine' }),
    s('d', { title: 'waiting elsewhere', live: 'waiting', lastModified: NOW - 2 * MIN }),
    s('peer_x~e', { title: 'offline machine', live: 'waiting', peer: { id: 'x', name: 'X', offline: true } }),
    s('peer_x~f', { title: 'remote ask', live: 'waiting', peer: { id: 'x', name: 'X' } }),
  ];
  const open = {
    a: { state: 'waiting' as const, pending: [{ toolName: 'Bash' }] },
    b: { state: 'error' as const, pending: [], error: 'boom' },
    c: { state: 'idle' as const, pending: [] },
    g: { state: 'running' as const, pending: [{ toolName: 'AskUserQuestion' }] }, // open but not listed yet
  };
  const orch = [{ runId: 'r1', runName: 'Nightly', nodeId: 'n1', title: '合并前看一眼', kind: 'approval' as const, since: NOW - HOUR }];

  it('permission requests and questions first, then orchestration waits, then errors', () => {
    const items = needsYou({ sessions, open, orch });
    expect(items.map((i) => (i.kind === 'orch' ? `orch:${i.wait.nodeId}` : i.sessionId))).toEqual(['g', 'd', 'a', 'peer_x~f', 'orch:n1', 'b']);
  });

  it('carries the title (the id head when the list has not got the session yet) and the status', () => {
    const items = needsYou({ sessions, open, orch: [] });
    const a = items.find((i) => i.kind === 'session' && i.sessionId === 'a');
    expect(a).toMatchObject({ title: 'needs a yes', status: { kind: 'confirm' } });
    expect(items.find((i) => i.kind === 'session' && i.sessionId === 'g')).toMatchObject({ title: 'g', status: { kind: 'ask' } });
  });

  it('an offline machine cannot be answered from here: not listed', () => {
    expect(needsYou({ sessions, open, orch: [] }).some((i) => i.kind === 'session' && i.sessionId === 'peer_x~e')).toBe(false);
  });

  it('a dismissed error stays hidden until the error changes; a request can not be dismissed', () => {
    const dismissed = new Set(['b:boom', 'a:']);
    const ids = needsYou({ sessions, open, orch: [], dismissed }).map((i) => (i.kind === 'session' ? i.sessionId : ''));
    expect(ids).not.toContain('b');
    expect(ids).toContain('a');
    const changed = { ...open, b: { state: 'error' as const, pending: [], error: 'other' } };
    expect(needsYou({ sessions, open: changed, orch: [], dismissed }).some((i) => i.kind === 'session' && i.sessionId === 'b')).toBe(true);
  });
});

describe('pageRows: the first N of a group, plus the rows that must stay visible', () => {
  const items = Array.from({ length: 12 }, (_, i) => s(`r${i}`));
  it('cuts at the limit and counts what is hidden', () => {
    const r = pageRows(items, 5);
    expect(r.rows.map((x) => x.sessionId)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    expect(r.hidden).toBe(7);
  });
  it('keeps the active / running / waiting rows beyond the cut, in order', () => {
    const r = pageRows(items, 3, (x) => x.sessionId === 'r9' || x.sessionId === 'r1');
    expect(r.rows.map((x) => x.sessionId)).toEqual(['r0', 'r1', 'r2', 'r9']);
    expect(r.hidden).toBe(8);
  });
});

describe('rangeIds: Shift-click selects everything between the anchor and the row', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('either direction, inclusive', () => {
    expect(rangeIds(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeIds(order, 'e', 'c')).toEqual(['c', 'd', 'e']);
  });
  it('no anchor (or one no longer on screen) → just the row', () => {
    expect(rangeIds(order, null, 'c')).toEqual(['c']);
    expect(rangeIds(order, 'zz', 'c')).toEqual(['c']);
  });
});

describe('todayCost: the account popover', () => {
  const row = (ts: number, o: Record<string, unknown> = {}) => ({ ts, costUsd: 0.5, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, ...o });
  it("sums this local day's session rows; gateway rows (the same traffic, per call) are not added twice", () => {
    const midnight = new Date(2026, 8, 28).getTime();
    const r = todayCost([row(midnight - 1), row(midnight + 1), row(NOW - 1), row(NOW - 2, { kind: 'gateway', costUsd: 9 })], NOW);
    expect(r).toEqual({ cost: 1, unknown: 0, calls: 2 });
  });
  it('an unknown price is counted, not added as $0 (rows that used no tokens do not count)', () => {
    const r = todayCost([row(NOW - 1, { costUsd: 0, costUnknown: true }), row(NOW - 1, { costUsd: 0, costUnknown: true, input: 0, output: 0 }), row(NOW - 3)], NOW);
    expect(r).toEqual({ cost: 0.5, unknown: 1, calls: 3 });
  });
});

describe('account row', () => {
  it('planLabel names the subscription the way people say it', () => {
    expect(planLabel('max')).toBe('Max 套餐');
    expect(planLabel('pro')).toBe('Pro 套餐');
    expect(planLabel('team')).toBe('Team 套餐');
    expect(planLabel('enterprise')).toBe('Enterprise');
    expect(planLabel('something_new')).toBe('something_new');
    expect(planLabel(undefined)).toBe('');
  });
  it('accountName: the email name, the org, or what else there is to work with', () => {
    expect(accountName({ loggedIn: true, email: 'ypy@example.com' }, 0)).toEqual({ name: 'ypy', initial: 'Y', signedIn: true });
    expect(accountName({ loggedIn: true, orgName: 'Acme' }, 0)).toEqual({ name: 'Acme', initial: 'A', signedIn: true });
    expect(accountName({ loggedIn: true }, 0)).toEqual({ name: 'Claude 账号', initial: 'C', signedIn: true });
    expect(accountName({ loggedIn: false }, 2)).toEqual({ name: '2 个供应商', initial: '', signedIn: false });
    expect(accountName({ loggedIn: false }, 0)).toEqual({ name: '未登录', initial: '', signedIn: false });
    expect(accountName(null, 0)).toEqual({ name: '账号', initial: '', signedIn: false });
  });
});
