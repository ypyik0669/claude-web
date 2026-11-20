import { describe, expect, it } from 'vitest';
import type { BgAgent, BgSession, BgTask } from '@shared';
import { agentLine, agentTokens, agentWho, groupMeta, liveSummary, phaseChip, runGroups, runViewOf, shownAgents, taskKind } from './run-list';

const agent = (o: Partial<BgAgent> = {}): BgAgent => ({ key: 'w1', color: 1, label: 'api', state: 'running', beats: [], ...o });
const task = (o: Partial<BgTask> = {}): BgTask => ({ id: 't', kind: 'workflow', description: 'd', status: 'running', startedAt: 1_000, agents: [], ...o });
const session = (sessionId: string, tasks: BgTask[], updatedAt = 1): BgSession => ({ sessionId, updatedAt, tasks, events: [] });

describe('运行中 as a list', () => {
  it('groups every conversation\'s tasks, a conversation\'s together: running conversations first, newest change first', () => {
    const groups = runGroups({
      ended: session('ended', [task({ id: 'e1', status: 'completed' })], 50),
      a: session('a', [task({ id: 'a-old', status: 'completed', startedAt: 9 }), task({ id: 'a-wf', startedAt: 2 }), task({ id: 'a-sh', kind: 'shell', startedAt: 5 })], 10),
      b: session('b', [task({ id: 'b-ag', kind: 'agent' })], 20),
    });
    expect(groups.map((g) => `${g.sessionId}:${g.task.id}`)).toEqual(['b:b-ag', 'a:a-sh', 'a:a-wf', 'a:a-old', 'ended:e1']);
    expect(runGroups({})).toEqual([]);
  });

  it('says what each group is, where and how long: acme-shop · 工作流 · 8 分钟', () => {
    const now = 1_000 + 8 * 60_000;
    expect(groupMeta(task(), 'C:\\work\\acme-shop', now)).toBe('acme-shop · 工作流 · 8 分钟');
    expect(groupMeta(task({ kind: 'agent', agents: [agent({ agentType: 'Explore' })] }), '/home/me/acme-shop/', now)).toBe('acme-shop · 子代理 Explore · 8 分钟');
    // an ended one: how long it ran, not how long ago it started
    expect(groupMeta(task({ kind: 'shell', status: 'completed', endedAt: 1_000 + 40_000 }), undefined, now)).toBe('后台命令 · 40 秒');
    expect(taskKind(task({ kind: 'agent', agents: [agent()] }))).toBe('子代理');
    // a phone: where the workflow is instead of how long
    expect(groupMeta(task(), 'C:\\work\\acme-shop', now, { phase: '改代码 2/4' })).toBe('acme-shop · 工作流 · 改代码 2/4');
    expect(groupMeta(task(), 'C:\\work\\acme-shop', now, { phase: null })).toBe('acme-shop · 工作流 · 8 分钟');
  });

  it('shows where a running workflow is: the phase of its first agent at work, out of all phases', () => {
    const phases = [{ index: 1, title: '读代码' }, { index: 2, title: '改代码' }, { index: 3, title: '补测试' }, { index: 4, title: '收尾' }];
    expect(phaseChip(task({ phases, agents: [agent({ phase: 1, state: 'done' }), agent({ phase: 2, phaseTitle: '改代码' }), agent({ phase: 3, state: 'queued' })] }))).toBe('改代码 2/4');
    // nothing at work yet: the first one queued
    expect(phaseChip(task({ phases, agents: [agent({ phase: 1, state: 'queued' })] }))).toBe('读代码 1/4');
    // no phases list: the highest phase an agent has
    expect(phaseChip(task({ agents: [agent({ phase: 1 }), agent({ phase: 3, state: 'queued' })] }))).toBe('1/3');
    expect(phaseChip(task({ status: 'completed', phases, agents: [agent({ phase: 2 })] }))).toBeNull();
    expect(phaseChip(task({ kind: 'agent', agents: [agent()] }))).toBeNull();
  });

  it('words an agent row: its name, what it does, how it ended, its tokens', () => {
    const wf = task();
    const sub = task({ kind: 'agent' });
    expect(agentWho(wf, agent({ label: 'tests' }))).toBe('tests');
    expect(agentWho(sub, agent({ agentType: 'Explore' }))).toBe('Explore');
    expect(agentWho(sub, agent())).toBe('子代理');
    expect(agentLine(agent({ lastSummary: '改了 cart.ts' }))).toBe('改了 cart.ts');
    expect(agentLine(agent())).toBe('在跑');
    expect(agentLine(agent({ state: 'done', lastSummary: '补了 14 个测试' }))).toBe('补了 14 个测试 · 完成');
    expect(agentLine(agent({ state: 'done', cached: true }))).toBe('用了上次的结果');
    expect(agentLine(agent({ state: 'queued' }))).toBe('排队中');
    expect(agentLine(agent({ state: 'failed', error: 'boom\n  at x.ts:1' }))).toBe('boom');
    expect(agentLine(agent({ state: 'stopped' }))).toBe('已停止');
    expect(agentTokens(agent({ tokens: 41_000 }))).toBe('41.0k tok');
    expect(agentTokens(agent())).toBe('');
  });

  it('folds a long workflow: the ones at work first, the rest behind 「还有 N 个」', () => {
    const many = Array.from({ length: 11 }, (_, i) => agent({ key: `w${i}`, state: i === 9 ? 'running' : 'done' }));
    const folded = shownAgents(many, false, 8);
    expect(folded.shown).toHaveLength(8);
    expect(folded.shown[0].key).toBe('w9');
    expect(folded.more).toBe(3);
    expect(shownAgents(many, true, 8)).toEqual({ shown: many, more: 0 });
    expect(shownAgents(many.slice(0, 4), false, 8).more).toBe(0);
  });

  it('sums up what runs for the line under the tabs', () => {
    expect(liveSummary({})).toBeUndefined();
    expect(liveSummary({ x: session('x', [task({ status: 'completed' })]) })).toBeUndefined();
    const two = {
      a: session('a', [task({ agents: [agent({ tokens: 40_000 }), agent({ key: 'w2', state: 'queued' })] }), task({ id: 's', kind: 'shell' })]),
      b: session('b', [task({ id: 'g', kind: 'agent', agents: [agent({ tokens: 2_000 })] })]),
    };
    expect(liveSummary(two)).toBe('3 个在跑 · 2 个对话 · 2 个子代理在干活 · 42.0k tok');
  });

  it('reads the remembered view: anything but 网吧 is the list', () => {
    expect(runViewOf('cafe')).toBe('cafe');
    expect(runViewOf('list')).toBe('list');
    expect(runViewOf(undefined)).toBe('list');
    expect(runViewOf(42)).toBe('list');
  });
});
