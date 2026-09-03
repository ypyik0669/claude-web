import { beforeEach, describe, expect, it } from 'vitest';
import { activeGroup, activeTile, chatTile, deriveActive, initialLayout, layoutRects, layoutReducer, migrateLegacy, MAX_PANES, paneOrder, presetTree, resetIds, sanitizeLayout, type LayoutState } from './layout';

beforeEach(() => resetIds());

const focused = (s: LayoutState) => activeGroup(s).focusedPaneId;
const panes = (s: LayoutState) => paneOrder(activeGroup(s).root);

describe('panes', () => {
  it('split creates a 0.5 split with a new focused leaf', () => {
    const s0 = initialLayout();
    const p0 = focused(s0);
    const s1 = layoutReducer(s0, { t: 'pane.split', paneId: p0, dir: 'row' });
    const g = activeGroup(s1);
    expect(g.root.type).toBe('split');
    expect((g.root as any).ratio).toBe(0.5);
    expect(panes(s1)).toHaveLength(2);
    expect(panes(s1)[0]).toBe(p0);
    expect(focused(s1)).toBe(panes(s1)[1]);
  });

  it('refuses the 7th pane and returns the same reference', () => {
    let s = initialLayout();
    for (let i = 1; i < MAX_PANES; i++) s = layoutReducer(s, { t: 'pane.split', paneId: focused(s), dir: i % 2 ? 'row' : 'col' });
    expect(panes(s)).toHaveLength(MAX_PANES);
    const s2 = layoutReducer(s, { t: 'pane.split', paneId: focused(s), dir: 'row' });
    expect(s2).toBe(s);
  });

  it('close collapses the parent split and keeps a valid focus', () => {
    let s = initialLayout();
    const p0 = focused(s);
    s = layoutReducer(s, { t: 'pane.split', paneId: p0, dir: 'row' });
    const p1 = focused(s);
    s = layoutReducer(s, { t: 'pane.split', paneId: p1, dir: 'col' });
    const p2 = focused(s);
    expect(panes(s)).toEqual([p0, p1, p2]);
    s = layoutReducer(s, { t: 'pane.close', paneId: p1 });
    expect(panes(s)).toEqual([p0, p2]);
    expect(activeGroup(s).panes[p1]).toBeUndefined();
    expect(focused(s)).toBe(p2);
    s = layoutReducer(s, { t: 'pane.close', paneId: p2 });
    expect(activeGroup(s).root.type).toBe('leaf');
    expect(focused(s)).toBe(p0);
  });

  it('closing the last pane leaves one empty chat tile', () => {
    let s = initialLayout();
    const p0 = focused(s);
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('sess-1'), mode: 'replace' });
    s = layoutReducer(s, { t: 'pane.close', paneId: p0 });
    const p = activeGroup(s).panes[p0];
    expect(p.tiles).toHaveLength(1);
    expect(p.tiles[0]).toMatchObject({ kind: 'chat', sessionId: null });
    // already empty → no-op (same reference)
    expect(layoutReducer(s, { t: 'pane.close', paneId: p0 })).toBe(s);
  });

  it('even resets every ratio in the subtree', () => {
    let s = initialLayout();
    s = layoutReducer(s, { t: 'pane.split', paneId: focused(s), dir: 'row' });
    const sid = (activeGroup(s).root as any).id;
    s = layoutReducer(s, { t: 'pane.ratio', splitId: sid, ratio: 0.8 });
    expect((activeGroup(s).root as any).ratio).toBe(0.8);
    s = layoutReducer(s, { t: 'pane.ratio', splitId: sid, ratio: 0.01 });
    expect((activeGroup(s).root as any).ratio).toBe(0.1);
    s = layoutReducer(s, { t: 'pane.even' });
    expect((activeGroup(s).root as any).ratio).toBe(0.5);
  });

  it('jump / cycle / zoom follow DFS order', () => {
    let s = initialLayout();
    s = layoutReducer(s, { t: 'pane.split', paneId: focused(s), dir: 'row' });
    s = layoutReducer(s, { t: 'pane.split', paneId: focused(s), dir: 'row' });
    const order = panes(s);
    s = layoutReducer(s, { t: 'pane.jump', index: 0 });
    expect(focused(s)).toBe(order[0]);
    s = layoutReducer(s, { t: 'pane.cycle', dir: -1 });
    expect(focused(s)).toBe(order[2]);
    s = layoutReducer(s, { t: 'pane.zoom', paneId: order[1] });
    expect(activeGroup(s).zoomedPaneId).toBe(order[1]);
    expect(focused(s)).toBe(order[1]);
    s = layoutReducer(s, { t: 'pane.zoom', paneId: null });
    expect(activeGroup(s).zoomedPaneId).toBeNull();
  });
});

describe('tiles', () => {
  it('open replaces an empty chat tile, tabs otherwise, and dedupes the same session', () => {
    let s = initialLayout();
    const p0 = focused(s);
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('a'), mode: 'tab' });
    expect(activeGroup(s).panes[p0].tiles).toHaveLength(1); // empty tile replaced even in tab mode
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('b'), mode: 'tab' });
    expect(activeGroup(s).panes[p0].tiles.map((t: any) => t.sessionId)).toEqual(['a', 'b']);
    const before = s;
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('a'), mode: 'tab' });
    expect(activeGroup(s).panes[p0].tiles).toHaveLength(2);
    expect((activeGroup(s).panes[p0].tiles.find((t) => t.id === activeGroup(s).panes[p0].activeTileId) as any).sessionId).toBe('a');
    expect(s).not.toBe(before);
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('c'), mode: 'replace' });
    expect(activeGroup(s).panes[p0].tiles.map((t: any) => t.sessionId)).toEqual(['c', 'b']);
  });

  it('close removes the tile and picks a neighbour; last tile closes the pane', () => {
    let s = initialLayout();
    const p0 = focused(s);
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('a'), mode: 'replace' });
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('b'), mode: 'tab' });
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('c'), mode: 'tab' });
    const tiles = activeGroup(s).panes[p0].tiles;
    s = layoutReducer(s, { t: 'tile.close', paneId: p0, tileId: tiles[2].id });
    expect(activeGroup(s).panes[p0].activeTileId).toBe(tiles[1].id);
    s = layoutReducer(s, { t: 'pane.split', paneId: p0, dir: 'row' });
    const p1 = focused(s);
    const only = activeGroup(s).panes[p1].tiles[0];
    s = layoutReducer(s, { t: 'tile.close', paneId: p1, tileId: only.id });
    expect(panes(s)).toEqual([p0]);
  });

  it('move takes a tile to another pane and removes an emptied source pane', () => {
    let s = initialLayout();
    const p0 = focused(s);
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('a'), mode: 'replace' });
    s = layoutReducer(s, { t: 'pane.split', paneId: p0, dir: 'row', tile: chatTile('b') });
    const p1 = focused(s);
    const b = activeGroup(s).panes[p1].tiles[0];
    s = layoutReducer(s, { t: 'tile.move', from: { paneId: p1, tileId: b.id }, to: { paneId: p0, index: 0 } });
    expect(panes(s)).toEqual([p0]);
    expect(activeGroup(s).panes[p0].tiles.map((t: any) => t.sessionId)).toEqual(['b', 'a']);
    expect(activeGroup(s).panes[p0].activeTileId).toBe(b.id);
    expect(focused(s)).toBe(p0);
    // reorder within the pane
    s = layoutReducer(s, { t: 'tile.move', from: { paneId: p0, tileId: b.id }, to: { paneId: p0, index: 1 } });
    expect(activeGroup(s).panes[p0].tiles.map((t: any) => t.sessionId)).toEqual(['a', 'b']);
  });

  it('session.assign fills an empty chat tile; deriveActive follows focus', () => {
    let s = initialLayout();
    const p0 = focused(s);
    const t0 = activeGroup(s).panes[p0].tiles[0];
    expect(deriveActive(s)).toBeNull();
    s = layoutReducer(s, { t: 'session.assign', paneId: p0, tileId: t0.id, sessionId: 'x' });
    expect(deriveActive(s)).toBe('x');
    s = layoutReducer(s, { t: 'pane.split', paneId: p0, dir: 'row', tile: chatTile('y') });
    expect(deriveActive(s)).toBe('y');
    s = layoutReducer(s, { t: 'pane.focus', paneId: p0 });
    expect(deriveActive(s)).toBe('x');
  });

  it('deriveActive looks past a browser / doc tab in front', () => {
    let s = initialLayout();
    const p0 = focused(s);
    const t0 = activeGroup(s).panes[p0].tiles[0];
    s = layoutReducer(s, { t: 'session.assign', paneId: p0, tileId: t0.id, sessionId: 'x' });
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, mode: 'tab', tile: { kind: 'browser', url: 'http://localhost:3000' } as any });
    expect(activeTile(activeGroup(s).panes[p0])!.kind).toBe('browser');
    expect(deriveActive(s)).toBe('x'); // the dock panels stay pointed at the session
    // …and past a pane that holds no session at all
    s = layoutReducer(s, { t: 'pane.split', paneId: p0, dir: 'row', tile: { kind: 'term' } as any });
    expect(deriveActive(s)).toBe('x');
  });
});

describe('groups', () => {
  it('new / rename / next / close', () => {
    let s = initialLayout();
    const g0 = s.activeGroupId;
    s = layoutReducer(s, { t: 'group.new', name: 'B' });
    expect(s.groups).toHaveLength(2);
    expect(s.activeGroupId).not.toBe(g0);
    s = layoutReducer(s, { t: 'group.rename', id: s.activeGroupId, name: 'Beta' });
    expect(activeGroup(s).name).toBe('Beta');
    s = layoutReducer(s, { t: 'group.next', dir: 1 });
    expect(s.activeGroupId).toBe(g0);
    s = layoutReducer(s, { t: 'group.close', id: g0 });
    expect(s.groups).toHaveLength(1);
    expect(activeGroup(s).name).toBe('Beta');
    s = layoutReducer(s, { t: 'group.close', id: s.activeGroupId });
    expect(s.groups).toHaveLength(1);
    expect(activeGroup(s).panes[focused(s)].tiles[0]).toMatchObject({ kind: 'chat', sessionId: null });
  });
});

describe('geometry & presets', () => {
  it('layoutRects tiles the container exactly and zoom yields one full rect', () => {
    let s = initialLayout();
    s = layoutReducer(s, { t: 'pane.split', paneId: focused(s), dir: 'row' });
    s = layoutReducer(s, { t: 'pane.split', paneId: focused(s), dir: 'col' });
    const g = activeGroup(s);
    const r = layoutRects(g.root, { x: 0, y: 0, w: 1000, h: 600 }, 4, null);
    const order = paneOrder(g.root);
    const [a, b, c] = order.map((id) => r.panes[id]);
    expect(a.w + 4 + b.w).toBe(1000);
    expect(b.h + 4 + c.h).toBe(600);
    expect(r.splitters).toHaveLength(2);
    const z = layoutRects(g.root, { x: 0, y: 0, w: 1000, h: 600 }, 4, order[1]);
    expect(z.panes[order[1]]).toEqual({ x: 0, y: 0, w: 1000, h: 600 });
    expect(z.panes[order[0]].w).toBe(0);
    expect(z.splitters).toHaveLength(0);
  });

  it('presets produce the expected leaf count and reuse pane ids in order', () => {
    let s = initialLayout();
    const p0 = focused(s);
    s = layoutReducer(s, { t: 'pane.split', paneId: p0, dir: 'row', tile: chatTile('b') });
    const p1 = focused(s);
    s = layoutReducer(s, { t: 'pane.preset', preset: 'grid2x2' });
    expect(panes(s)).toHaveLength(4);
    expect(panes(s).slice(0, 2)).toEqual([p0, p1]);
    s = layoutReducer(s, { t: 'pane.preset', preset: 'single' });
    expect(panes(s)).toEqual([p0]);
    // tiles from the dropped panes were merged into the kept pane
    expect(activeGroup(s).panes[p0].tiles.length).toBeGreaterThanOrEqual(2);
    const { root } = presetTree('cols3', []);
    expect(paneOrder(root)).toHaveLength(3);
  });
});

describe('persistence', () => {
  it('migrateLegacy maps cw.panels / cw.rp / cw.collapsed', () => {
    const store: Record<string, string> = { 'cw.panels': '["files","inspector","usage"]', 'cw.rp': '520', 'cw.collapsed': '{"pinned":true}' };
    const s = migrateLegacy({ getItem: (k) => store[k] ?? null });
    expect(s.dock).toEqual({ open: true, minimized: false, width: 520, tabs: ['files', 'usage'], active: 'files' });
    expect(s.sidebar.sections).toEqual({ pinned: true });
    expect(s.groups).toHaveLength(1);
  });

  it('sanitizeLayout rejects garbage and repairs empty panes', () => {
    expect(sanitizeLayout(null)).toBeNull();
    expect(sanitizeLayout({ version: 1 })).toBeNull();
    const s = initialLayout();
    const p0 = focused(s);
    (s as any).groups[0].panes[p0].tiles = [];
    (s as any).groups[0].focusedPaneId = 'nope';
    const ok = sanitizeLayout(JSON.parse(JSON.stringify(s)))!;
    expect(ok.groups[0].panes[p0].tiles).toHaveLength(1);
    expect(ok.groups[0].focusedPaneId).toBe(p0);
  });
});
