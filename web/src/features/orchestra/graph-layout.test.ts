import { describe, expect, it } from 'vitest';
import { CARD_W, layers, layoutGraph, nextNodeId, promptVars } from './graph-layout';

const n = (id: string, dependsOn: string[] = []) => ({ id, dependsOn });

describe('orchestra graph layout', () => {
  it('puts nodes one column after their deepest dependency', () => {
    expect(layers([n('c', ['a', 'b']), n('a'), n('b', ['a'])]).map((l) => l.map((x) => x.id))).toEqual([['a'], ['b'], ['c']]);
  });
  it('parallel nodes share a column in different rows, edges connect card anchors', () => {
    const g = layoutGraph([n('a'), n('b', ['a']), n('c', ['a']), n('d', ['b', 'c'])]);
    expect(g.cols).toBe(3);
    expect(g.boxes.b.col).toBe(1);
    expect(g.boxes.c.col).toBe(1);
    expect(g.boxes.b.row).not.toBe(g.boxes.c.row);
    expect(g.edges).toHaveLength(4);
    expect(g.edges[0].d.startsWith(`M${g.boxes.a.x + CARD_W},`)).toBe(true);
    expect(g.width).toBeGreaterThan(3 * CARD_W);
  });
  it('survives cycles and dangling deps (unsaved drafts)', () => {
    const g = layoutGraph([n('a', ['b']), n('b', ['a']), n('c', ['zz'])]);
    expect(Object.keys(g.boxes).sort()).toEqual(['a', 'b', 'c']);
    expect(g.edges.length).toBe(2);
  });
  it('empty graph', () => {
    expect(layoutGraph([])).toMatchObject({ cols: 0, edges: [] });
  });
  it('next node id skips taken ones', () => {
    expect(nextNodeId([])).toBe('n1');
    expect(nextNodeId(['n1', 'n2'])).toBe('n3');
    expect(nextNodeId(['n2'])).toBe('n3');
    expect(nextNodeId(['x', 'n2'])).toBe('n3');
  });
  it('prompt variables list input + other nodes', () => {
    const v = promptVars([{ id: 'a', kind: 'task', title: 'A' }, { id: 'g', kind: 'approval', title: 'G' }, { id: 'me', kind: 'task', title: 'Me' }], 'me');
    expect(v.map((x) => x.token)).toEqual(['{{input}}', '{{nodes.a.output}}', '{{nodes.g.approval}}']);
  });
});
