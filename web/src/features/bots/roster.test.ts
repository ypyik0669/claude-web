import { describe, expect, it } from 'vitest';
import type { BotStatus, InboxItem } from '@shared';
import { tr } from '@/i18n';
import { rosterView, rowTime, searchBots, soleBot, threadOnScreen } from './roster-model';

const sb = (id: string, extra: Partial<BotStatus> = {}): BotStatus => ({
  id, name: id, charter: { role: '', sources: [] }, cwd: '/', tier: 'balanced', policy: { rules: [] }, budget: {}, routines: [], outputs: [],
  createdAt: 0, updatedAt: 0, state: 'idle', todayUsd: 0, weekUsd: 0, pendingInbox: 0, trust: {}, unseen: 0, ...extra,
});
const item = (botId: string, extra: Partial<InboxItem> = {}): InboxItem => ({ id: `${botId}-i`, kind: 'approval', botId, at: 1, title: 't', ...extra });

describe('roster search', () => {
  const bots = [sb('a', { name: '晨报', title: '每天的一页纸' }), sb('b', { name: 'PR 巡检', title: 'CI watcher' }), sb('c', { name: 'Inbox' })];
  it('an empty query keeps every bot (the same array)', () => {
    expect(searchBots(bots, '')).toBe(bots);
    expect(searchBots(bots, '   ')).toBe(bots);
  });
  it('matches the name or the title, ignoring case and spaces around', () => {
    expect(searchBots(bots, ' pr ').map((b) => b.id)).toEqual(['b']);
    expect(searchBots(bots, 'ci WATCH').map((b) => b.id)).toEqual(['b']);
    expect(searchBots(bots, '一页纸').map((b) => b.id)).toEqual(['a']);
    expect(searchBots(bots, 'zzz')).toEqual([]);
  });
});

describe('rosterView', () => {
  it('hidden bots stay out of 需要你 even when something waits for them; the search applies to every group', () => {
    const bots = [sb('a', { pendingInbox: 1 }), sb('h', { hidden: true, pendingInbox: 2, state: 'attention' }), sb('m', { manager: true }), sb('r')];
    const v = rosterView(bots, [item('a'), item('h')], '');
    expect(v.attention.map((b) => b.id)).toEqual(['a']);
    expect(v.hidden.map((b) => b.id)).toEqual(['h']);
    expect(v.rest.map((b) => b.id)).toEqual(['r']);
    expect(v.manager?.id).toBe('m');
    const s = rosterView(bots, [], 'h');
    expect([s.attention.length, s.rest.length, s.hidden.map((b) => b.id), s.manager]).toEqual([0, 0, ['h'], undefined]);
  });
  it('counts what is shown, the hidden ones apart', () => {
    const v = rosterView([sb('a'), sb('b'), sb('h', { hidden: true })], [], '');
    expect([v.shown, v.hiddenCount]).toEqual([2, 1]);
  });
});

describe('rowTime', () => {
  const now = new Date(2026, 9, 31, 15, 0).getTime();
  it('today: the clock time; yesterday: 昨天; earlier: the date; none: nothing', () => {
    expect(rowTime(new Date(2026, 9, 31, 9, 41).getTime(), now)).toMatch(/9:41/);
    expect(rowTime(new Date(2026, 9, 30, 23, 0).getTime(), now)).toBe(tr('昨天'));
    expect(rowTime(new Date(2026, 9, 20, 8, 0).getTime(), now)).toMatch(/20/);
    expect(rowTime(undefined, now)).toBe('');
  });
});

describe('phone screens', () => {
  it('soleBot: one bot of your own (the manager aside), else none', () => {
    expect(soleBot([sb('manager', { manager: true }), sb('a')])).toBe('a');
    expect(soleBot([sb('manager', { manager: true })])).toBeUndefined();
    expect(soleBot([sb('a'), sb('b')])).toBeUndefined();
  });
  it('threadOnScreen: on a phone only the conversation screen counts', () => {
    const s = { open: true, selected: 'a', view: 'thread', phoneScreen: 'roster' };
    expect(threadOnScreen(s, 'a', false)).toBe(true);
    expect(threadOnScreen(s, 'a', true)).toBe(false);
    expect(threadOnScreen({ ...s, phoneScreen: 'profile' }, 'a', true)).toBe(false);
    expect(threadOnScreen({ ...s, phoneScreen: 'thread' }, 'a', true)).toBe(true);
    expect(threadOnScreen({ ...s, phoneScreen: 'thread', open: false }, 'a', true)).toBe(false);
  });
});
