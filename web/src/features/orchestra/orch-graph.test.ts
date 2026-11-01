import { describe, expect, it, vi } from 'vitest';
vi.mock('./labels', () => ({ agentLabel: (k: string) => k }));   // labels reads the store (agent names); not needed here
import type { NodeRun, OrchNode } from '@shared';
import { layoutNodes } from '@/ui/node-graph/layout';
import { orchestraGraph } from './orch-graph';

const task = (id: string, dependsOn: string[] = []) => ({ id, kind: 'task', title: id.toUpperCase(), agent: 'claude', prompt: 'p', dependsOn, workspace: 'shared' }) as unknown as OrchNode;
const nodes = [task('a'), task('b', ['a', 'a', 'ghost']), task('c', ['b'])];
const run = (state: NodeRun['state'], extra: Partial<NodeRun> = {}) => ({ state, sessionIds: [], ...extra }) as NodeRun;

describe('orchestra graph', () => {
  it('the editor preview: one card per node, plain edges, same columns as before', () => {
    const g = orchestraGraph(nodes, undefined, 0);
    expect(g.nodes.map((n) => [n.id, n.title, n.state])).toEqual([['a', 'A', undefined], ['b', 'B', undefined], ['c', 'C', undefined]]);
    expect(g.edges.map((e) => [e.id, e.style])).toEqual([['a>b', 'normal'], ['b>c', 'normal']]);
    expect(layoutNodes(g.nodes, g.edges).cols).toEqual([['a'], ['b'], ['c']]);
  });
  it('a run: the running step glows and its incoming edge is strong', () => {
    const g = orchestraGraph(nodes, { a: run('done', { startedAt: 0, finishedAt: 4000 }), b: run('running', { startedAt: 5000 }), c: run('pending') }, 10_000);
    expect(g.nodes.map((n) => n.state)).toEqual(['done', 'running', 'idle']);
    expect(g.nodes[0].icon).toBe('check');
    expect(g.edges.map((e) => e.style)).toEqual(['strong', 'normal']);
    expect(g.nodes[1].subtitle).toMatch(/·/);
  });
  it('a failed step: red edge, no dot', () => {
    const g = orchestraGraph(nodes, { a: run('done'), b: run('failed'), c: run('cancelled') }, 0);
    expect([g.edges[0].style, g.edges[0].pulse]).toEqual(['error', false]);
    expect(g.nodes[2].state).toBe('stopped');
    expect(g.nodes[1].icon).toBe('close');
  });
  it('a stored compare node (kind removed 2026-11-01) still gets a card with a neutral icon', () => {
    const old = { id: 'cmp', kind: 'compare', title: 'C', agents: ['claude'], prompt: 'p', dependsOn: [] } as unknown as OrchNode;
    const g = orchestraGraph([old], undefined, 0);
    expect(g.nodes[0].icon).toBe('agent');
    expect(g.nodes[0].subtitle).toBeTruthy();
  });
  it('a card says its whole title on hover; an id like constructor is a node like any other (review D5 / D1)', () => {
    const g = orchestraGraph([task('constructor'), task('b', ['constructor'])], { b: run('running') }, 0);
    expect(g.nodes.map((n) => [n.tip, n.state])).toEqual([['CONSTRUCTOR', undefined], ['B', 'running']]);
    expect(g.edges.map((e) => e.id)).toEqual(['constructor>b']);
  });
});
