import { describe, expect, it } from 'vitest';
import type { BgHistoryItem, BgTask } from '@shared';
import { backgroundGraph } from './graph-data';
import { agoText, dayLabel, groupByDay, mergeFirstPage, projectOf, replaySpan, rowMeta, sessionAt, spanText, statusChip, taskAt, taskOfItem } from './history-model';

// 跑过的 (2026-11-19): the list's words and groups, a row as a task, and the task at a moment of its replay.

const now = new Date(2026, 10, 19, 15, 0, 0).getTime();
const h = 3600_000;
const item = (o: Partial<BgHistoryItem>): BgHistoryItem => ({ id: `s|${o.kind ?? 'agent'}|${o.title ?? 'x'}`, sessionId: 's', kind: 'agent', title: 'x', status: 'completed', startedAt: now - h, ...o });

describe('跑过的: the list', () => {
  it('groups by day, newest first: 今天, 昨天, then the date (the year only when it is another one)', () => {
    const items = [item({ title: 'a', startedAt: now - h }), item({ title: 'b', startedAt: now - 2 * h }), item({ title: 'c', startedAt: now - 20 * h }), item({ title: 'd', startedAt: new Date(2026, 10, 2, 9).getTime() }), item({ title: 'e', startedAt: new Date(2025, 11, 30, 9).getTime() })];
    expect(groupByDay(items, now).map((g) => [g.label, g.items.map((i) => i.title).join('')])).toEqual([['今天', 'ab'], ['昨天', 'c'], ['11月2日', 'd'], ['2025年12月30日', 'e']]);
    expect(dayLabel(now - 30 * h, now)).toBe('昨天');
    expect(dayLabel(now - 50 * h, now)).toBe('11月17日');
  });

  it('something ended while the list is open: the newest page goes on top, a row in both is the new one, the pages below stay', () => {
    const a = item({ title: 'a', startedAt: now - 5 * h }), b = item({ title: 'b', startedAt: now - 3 * h }), c = item({ title: 'c', startedAt: now - 2 * h, status: 'running' });
    const c2 = { ...c, status: 'completed' as const, endedAt: now - h }, d = item({ title: 'd', startedAt: now - 30 * 60_000 });
    const merged = mergeFirstPage([c, b, a], [d, c2]);
    expect(merged.map((i) => i.title)).toEqual(['d', 'c', 'b', 'a']);
    expect(merged[1]).toBe(c2);
    // the same start: by id, as the server orders them
    const x = item({ id: 's|agent|x1', startedAt: now }), y = item({ id: 's|agent|x2', startedAt: now });
    expect(mergeFirstPage([x], [y]).map((i) => i.id)).toEqual(['s|agent|x2', 's|agent|x1']);
    expect(mergeFirstPage([], [d])).toEqual([d]);
  });

  it('how long ago, in words (the cafe\'s 刚跑完的)', () => {
    expect(agoText(now - 20_000, now)).toBe('刚刚');
    expect(agoText(now - 12 * 60_000, now)).toBe('12 分钟前');
    expect(agoText(now - 3 * h, now)).toBe('3 小时前');
    expect(agoText(now - 20 * h, now)).toBe('昨天');
    expect(agoText(now - 50 * h, now)).toBe('11月17日');
  });

  it('how long it ran, in words', () => {
    expect(spanText(800)).toBe('1 秒');
    expect(spanText(40_000)).toBe('40 秒');
    expect(spanText(12 * 60_000 + 20_000)).toBe('12 分钟');
    expect(spanText(2 * h)).toBe('2 小时');
    expect(spanText(h + 5 * 60_000)).toBe('1 小时 5 分钟');
  });

  it('how it ended: 完成, how many failed, 失败, 已停止', () => {
    expect(statusChip(item({}))).toEqual({ text: '完成', tone: 'ok' });
    expect(statusChip(item({ kind: 'workflow', failed: 1 }))).toEqual({ text: '1 个失败', tone: 'bad' });
    expect(statusChip(item({ status: 'failed' }))).toEqual({ text: '失败', tone: 'bad' });
    expect(statusChip(item({ status: 'stopped' }))).toEqual({ text: '已停止', tone: 'muted' });
  });

  it('a row\'s line: the folder, the kind (a sub-agent\'s type), how long', () => {
    expect(projectOf('C:\\work\\acme-shop')).toBe('acme-shop');
    expect(projectOf('/home/me/notes-app/')).toBe('notes-app');
    expect(rowMeta(item({ kind: 'workflow', cwd: 'C:\\work\\acme-shop', endedAt: now - h + 12 * 60_000 }))).toBe('acme-shop · 工作流 · 12 分钟');
    expect(rowMeta(item({ agentType: 'Explore', cwd: 'C:\\work\\acme-shop', endedAt: now - h + 3 * 60_000 }))).toBe('acme-shop · 子代理 Explore · 3 分钟');
    expect(rowMeta(item({ kind: 'shell' }))).toBe('后台命令');
  });
});

const T = 1_000_000;
const wf = (): BgTask => ({
  id: 'wt', kind: 'workflow', type: 'local_workflow', description: 'Refactor', name: '结账模块重构', status: 'completed', startedAt: T, endedAt: T + 720_000, tokens: 214000, runId: 'wf_1',
  phases: [{ index: 1, title: '分析' }, { index: 2, title: '改代码' }],
  agents: [
    { key: 'w1', color: 1, label: 'explore', phase: 1, state: 'done', queuedAt: T, startedAt: T + 1000, endedAt: T + 127_000, tokens: 900, beats: [1, 2] },
    { key: 'w2', color: 2, label: 'db', phase: 2, state: 'failed', queuedAt: T + 130_000, startedAt: T + 160_000, endedAt: T + 300_000, error: 'boom', beats: [] },
    { key: 'w3', color: 3, label: 'docs', phase: 2, state: 'done', queuedAt: T + 130_000, beats: [] },
  ],
});

describe('跑过的: a run replayed', () => {
  it('the span: from the start to the last end', () => {
    expect(replaySpan(wf())).toEqual({ start: T, end: T + 720_000 });
    const t = wf();
    t.endedAt = undefined;
    expect(replaySpan(t).end).toBe(T + 300_000);
  });

  it('at a moment: who waits, who works, who is done; the end is how it ended', () => {
    const states = (at: number) => taskAt(wf(), at).agents.map((a) => `${a.label}:${a.state}`).join(' ');
    expect(states(T)).toBe('explore:queued db:queued docs:queued');
    expect(states(T + 60_000)).toBe('explore:running db:queued docs:queued');
    expect(states(T + 200_000)).toBe('explore:done db:running docs:queued');
    expect(states(T + 400_000)).toBe('explore:done db:failed docs:queued');
    expect(states(T + 720_000)).toBe('explore:done db:failed docs:done');
    const mid = taskAt(wf(), T + 60_000);
    expect(mid).toMatchObject({ status: 'running', endedAt: undefined });
    expect(mid.agents[0]).toMatchObject({ endedAt: undefined, tokens: undefined, beats: [] });
    expect(taskAt(wf(), T + 720_000)).toMatchObject({ status: 'completed', endedAt: T + 720_000, tokens: 214000 });
  });

  it('in the cafe a customer comes in when it was queued (not before)', () => {
    const at = (t: number) => sessionAt('sid', wf(), t).tasks[0].agents.map((a) => a.label).join(',');
    expect(at(T + 60_000)).toBe('explore');
    expect(at(T + 200_000)).toBe('explore,db,docs');
    const s = sessionAt('sid', wf(), T + 200_000);
    expect(s.sessionId).toBe('sid');
    expect(s.events.map((e) => `${e.who}|${e.tone}`)).toEqual(['explore|start', 'explore|done', 'db|start']);
  });

  it('a sub-agent row and a command row as tasks of their own', () => {
    const a = taskOfItem(item({ id: 's|agent|a1', title: '查一下', agentId: 'a1', agentType: 'Explore', model: 'opus', startedAt: T, endedAt: T + 180_000, tokens: 5000, toolUses: 12 }));
    expect(a).toMatchObject({ id: 'a1', kind: 'agent', description: '查一下', status: 'completed', startedAt: T, endedAt: T + 180_000 });
    expect(a.agents).toEqual([{ key: 'a1', color: 1, label: '查一下', agentId: 'a1', agentType: 'Explore', model: 'opus', state: 'done', startedAt: T, endedAt: T + 180_000, tokens: 5000, toolCalls: 12, beats: [] }]);
    expect(taskAt(a, T + 60_000).agents[0].state).toBe('running');
    const sh = taskOfItem(item({ id: 's|shell|b1', kind: 'shell', title: 'Watch', command: 'npm run test:watch', status: 'stopped', startedAt: T, endedAt: T + 60_000 }));
    expect(sh).toMatchObject({ id: 'b1', kind: 'shell', description: 'npm run test:watch', status: 'stopped', agents: [] });
    expect(taskAt(sh, T + 1000).status).toBe('running');
  });

  it('a run\'s graph is terse: one line per agent — how it is / ended and how long it took (so far)', () => {
    const g = backgroundGraph({ sessionId: 's', updatedAt: 0, tasks: [taskAt(wf(), T + 60_000)], events: [] }, { now: T + 60_000, terse: true });
    const card = (id: string) => g.graph.nodes.find((n) => n.id === id)!;
    expect(card('wt|w1')).toMatchObject({ subtitle: '在跑 0:59', rows: [] });
    expect(card('wt|w2')).toMatchObject({ subtitle: '排队', rows: [] });
    const end = backgroundGraph({ sessionId: 's', updatedAt: 0, tasks: [wf()], events: [] }, { now: T + 720_000, terse: true });
    expect(end.graph.nodes.find((n) => n.id === 'wt|w2')!.subtitle).toBe('失败 2:20');
  });

  it('the graph of a run draws at most 150 cards; what is left out is counted', () => {
    const big = wf();
    big.agents = Array.from({ length: 228 }, (_, i) => ({ key: `w${i}`, color: 1, label: `a${i}`, phase: 1 + (i % 2), state: 'done' as const, beats: [] }));
    const g = backgroundGraph({ sessionId: 's', updatedAt: 0, tasks: [big], events: [] }, { now: T, maxCards: 150 });
    expect(g.graph.nodes.length).toBe(150);
    expect(g.more).toBe(228 - (150 - 4));
  });
});
