import { beforeEach, describe, expect, it } from 'vitest';
import { activeGroup, activeTile, chatTile, chromeVisibility, currentChatTile, deriveActive, hasLegacyLayout, initialLayout, layoutRects, layoutReducer, migrateLegacy, migrateWorkbench, needsSimplifiedNotice, SIMPLIFIED_NOTICE_KEY, MAX_PANES, paneOrder, panelToggleEffect, presetTree, resetIds, sanitizeLayout, workbenchOn, type LayoutState, type Tile } from './layout';

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

  it('replace mode never duplicates a tab already in the pane, and keeps the tile id of the current one', () => {
    let s = initialLayout();
    const p0 = focused(s);
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('a'), mode: 'replace' });
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('b'), mode: 'tab' });
    const [ta, tb] = activeGroup(s).panes[p0].tiles;
    // b is active; "open a" (sidebar click) must switch to the existing a tab, not turn b into a second a
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('a'), mode: 'replace' });
    let p = activeGroup(s).panes[p0];
    expect(p.tiles.map((t: any) => t.sessionId)).toEqual(['a', 'b']);
    expect(p.activeTileId).toBe(ta.id);
    // re-opening the active session is a no-op: same tile id → the tile is not remounted
    const before = s;
    s = layoutReducer(s, { t: 'tile.open', paneId: p0, tile: chatTile('a'), mode: 'replace' });
    expect(s).toBe(before);
    p = activeGroup(s).panes[p0];
    expect(p.tiles.map((t) => t.id)).toEqual([ta.id, tb.id]);
  });

  // 「新对话」 / a sidebar click without the workbench setting (spec decision I3): only a conversation is swapped out;
  // a terminal, document, diff or browser in front gets a new tab next to it — never replaced, so a running
  // terminal keeps its process and a document with unsaved changes never skips its prompt
  describe('replace mode only ever replaces a conversation', () => {
    const withFront = (tile: Tile) => {
      let s = initialLayout();
      const p = focused(s);
      s = layoutReducer(s, { t: 'tile.open', paneId: p, tile: chatTile('a'), mode: 'replace' });
      s = layoutReducer(s, { t: 'tile.open', paneId: p, tile, mode: 'tab' });
      return { s, p };
    };
    const kinds = (s: LayoutState, p: string) => activeGroup(s).panes[p].tiles.map((t) => (t.kind === 'chat' ? `chat:${t.sessionId}` : `${t.kind}:${t.id}`));
    const front = (s: LayoutState, p: string) => activeTile(activeGroup(s).panes[p]);

    it('a conversation in front is replaced in place (it stays in the sidebar; its process is not touched)', () => {
      const { s: s0, p } = withFront(chatTile('b'));
      const s = layoutReducer(s0, { t: 'tile.open', paneId: p, tile: chatTile(null), mode: 'replace' });
      expect(kinds(s, p)).toEqual(['chat:a', 'chat:null']);
    });

    it('a terminal in front: the new conversation opens as a new tab, the terminal tile is kept as it was', () => {
      const term: Tile = { id: 'term1', kind: 'term', cwd: '/w' };
      const { s: s0, p } = withFront(term);
      const s = layoutReducer(s0, { t: 'tile.open', paneId: p, tile: chatTile(null), mode: 'replace' });
      expect(kinds(s, p)).toEqual(['chat:a', 'term:term1', 'chat:null']);
      expect(activeGroup(s).panes[p].tiles[1]).toBe(activeGroup(s0).panes[p].tiles[1]);
      expect(front(s, p)).toMatchObject({ kind: 'chat', sessionId: null });
    });

    it('a document (possibly with unsaved changes) in front is never replaced — by a new chat or a sidebar click', () => {
      const doc: Tile = { id: 'doc1', kind: 'doc', path: '/w/a.ts' };
      const { s: s0, p } = withFront(doc);
      let s = layoutReducer(s0, { t: 'tile.open', paneId: p, tile: chatTile(null), mode: 'replace' });
      expect(kinds(s, p)).toEqual(['chat:a', 'doc:doc1', 'chat:null']);
      // sidebar click on another session (setActive / openInPane → replace) with the document in front
      s = layoutReducer(layoutReducer(s0, { t: 'tile.activate', paneId: p, tileId: 'doc1' }), { t: 'tile.open', paneId: p, tile: chatTile('c'), mode: 'replace' });
      expect(kinds(s, p)).toEqual(['chat:a', 'doc:doc1', 'chat:c']);
      // a session that is already a tab is just brought to the front
      s = layoutReducer(layoutReducer(s0, { t: 'tile.activate', paneId: p, tileId: 'doc1' }), { t: 'tile.open', paneId: p, tile: chatTile('a'), mode: 'replace' });
      expect(kinds(s, p)).toEqual(['chat:a', 'doc:doc1']);
      expect(front(s, p)).toMatchObject({ kind: 'chat', sessionId: 'a' });
    });

    it('diff and browser tabs are not replaced either', () => {
      for (const t of [{ id: 'df1', kind: 'diff', sessionId: 'a', path: '/w/a.ts' }, { id: 'b1', kind: 'browser', url: 'http://localhost:3000' }] as Tile[]) {
        const { s: s0, p } = withFront(t);
        const s = layoutReducer(s0, { t: 'tile.open', paneId: p, tile: chatTile('z'), mode: 'replace' });
        expect(kinds(s, p)).toEqual(['chat:a', `${t.kind}:${t.id}`, 'chat:z']);
      }
    });
  });

  it('currentChatTile: the conversation the 「当前对话」 commands act on, looking past a document / terminal in front', () => {
    let s = initialLayout();
    const p = focused(s);
    expect(currentChatTile(s)).toBeNull(); // only the empty page
    s = layoutReducer(s, { t: 'tile.open', paneId: p, tile: chatTile('a'), mode: 'replace' });
    const chat = activeTile(activeGroup(s).panes[p])!;
    expect(currentChatTile(s)).toEqual({ paneId: p, tileId: chat.id });
    s = layoutReducer(s, { t: 'tile.open', paneId: p, tile: { id: 'doc1', kind: 'doc', path: '/w/a.ts' }, mode: 'tab' });
    expect(currentChatTile(s)).toEqual({ paneId: p, tileId: chat.id });
    // focus moved to a new split whose only tile is a terminal: the conversation next door is still "current"
    s = layoutReducer(s, { t: 'pane.split', paneId: p, dir: 'row', tile: { id: 't1', kind: 'term', cwd: '/w' } });
    expect(focused(s)).not.toBe(p);
    expect(currentChatTile(s)).toEqual({ paneId: p, tileId: chat.id });
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

describe('right panel (dock) toggles', () => {
  it('toggling the shown terminal only hides the panel: the tab — and the terminal process — stay (I6)', () => {
    let s = layoutReducer(initialLayout(), { t: 'dock.show', panel: 'terminal' });
    expect(panelToggleEffect(s.dock, 'terminal')).toBe('hide');
    s = layoutReducer(s, { t: 'dock.toggle', panel: 'terminal' });
    expect(s.dock.open).toBe(false);
    expect(s.dock.tabs).toContain('terminal');
    expect(s.dock.active).toBe('terminal');
    expect(panelToggleEffect(s.dock, 'terminal')).toBe('show');
    s = layoutReducer(s, { t: 'dock.toggle', panel: 'terminal' });
    expect(s.dock).toMatchObject({ open: true, minimized: false, active: 'terminal' });
  });

  it('other panels hold nothing alive: toggling the shown one closes its tab, as before', () => {
    let s = layoutReducer(initialLayout(), { t: 'dock.show', panel: 'files' });
    expect(panelToggleEffect(s.dock, 'files')).toBe('remove');
    s = layoutReducer(s, { t: 'dock.toggle', panel: 'files' });
    expect(s.dock.tabs).not.toContain('files');
  });

  it('a panel that is a tab but not in view (behind another tab, minimized, hidden) is shown', () => {
    let s = layoutReducer(initialLayout(), { t: 'dock.show', panel: 'terminal' });
    s = layoutReducer(s, { t: 'dock.show', panel: 'files' });
    expect(panelToggleEffect(s.dock, 'terminal')).toBe('show');
    s = layoutReducer(s, { t: 'dock.set', patch: { active: 'terminal', minimized: true } });
    expect(panelToggleEffect(s.dock, 'terminal')).toBe('show');
    s = layoutReducer(s, { t: 'dock.toggle', panel: 'terminal' });
    expect(s.dock).toMatchObject({ open: true, minimized: false, active: 'terminal' });
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

describe('chrome visibility (spec §5.10)', () => {
  const off = { workbench: false }, on = { workbench: true };
  const vis = (s: LayoutState, o = off) => chromeVisibility(s, o);

  it('one session in one pane: no group bar, no tab strip, no dock rail', () => {
    const s = initialLayout();
    expect(vis(s)).toEqual({ groupBar: false, tabStrip: { [focused(s)]: false } });
  });

  it('workbench mode shows all of it', () => {
    const s = initialLayout();
    expect(vis(s, on)).toEqual({ groupBar: true, tabStrip: { [focused(s)]: true } });
  });

  it('Ctrl+D (split) brings the tab strips; closing the split takes them away again', () => {
    const s0 = initialLayout();
    const p0 = focused(s0);
    const s1 = layoutReducer(s0, { t: 'pane.split', paneId: p0, dir: 'row' });
    const v1 = vis(s1);
    expect(Object.values(v1.tabStrip)).toEqual([true, true]);
    expect(v1.groupBar).toBe(false);
    const s2 = layoutReducer(s1, { t: 'pane.close', paneId: focused(s1) });
    expect(vis(s2).tabStrip).toEqual({ [p0]: false });
  });

  it('a second tab brings the strip; closing it hides the strip', () => {
    let s = layoutReducer(initialLayout(), { t: 'tile.open', paneId: '', tile: chatTile('a'), mode: 'replace' });
    const p = focused(s);
    s = layoutReducer(s, { t: 'tile.open', paneId: p, tile: chatTile('a'), mode: 'replace' });
    expect(vis(s).tabStrip[p]).toBe(false);
    s = layoutReducer(s, { t: 'tile.open', paneId: p, tile: chatTile('b'), mode: 'tab' });
    expect(vis(s).tabStrip[p]).toBe(true);
    const second = activeGroup(s).panes[p].tiles[1].id;
    s = layoutReducer(s, { t: 'tile.close', paneId: p, tileId: second });
    expect(vis(s).tabStrip[p]).toBe(false);
  });

  it('a lone document / terminal keeps its strip (it has no session header to name or close it)', () => {
    let s = initialLayout();
    const p = focused(s);
    s = layoutReducer(s, { t: 'tile.open', paneId: p, tile: { id: 'd1', kind: 'doc', path: '/x/a.ts' }, mode: 'replace' });
    expect(activeGroup(s).panes[p].tiles).toHaveLength(1);
    expect(vis(s).tabStrip[p]).toBe(true);
  });

  it('a second group brings the group bar', () => {
    const s = layoutReducer(initialLayout(), { t: 'group.new' });
    expect(vis(s).groupBar).toBe(true);
    expect(vis(layoutReducer(s, { t: 'group.close', id: s.activeGroupId })).groupBar).toBe(false);
  });

  it('a phone never shows the group bar, tab strips or the rail — workbench setting, splits and groups or not (spec §5.11)', () => {
    let s = layoutReducer(initialLayout(), { t: 'pane.split', paneId: focused(initialLayout()), dir: 'row' });
    s = layoutReducer(s, { t: 'tile.open', paneId: focused(s), tile: chatTile('b'), mode: 'tab' });
    s = layoutReducer(s, { t: 'tile.open', paneId: focused(s), tile: { id: 'd1', kind: 'doc', path: '/x/a.ts' }, mode: 'tab' });
    s = layoutReducer(s, { t: 'group.new' });
    for (const workbench of [false, true]) {
      for (const g of [s, layoutReducer(s, { t: 'group.next', dir: 1 })]) {
        const v = chromeVisibility(g, { workbench, mobile: true });
        expect(v.groupBar).toBe(false);
        expect(Object.values(v.tabStrip).every((x) => x === false)).toBe(true);
      }
    }
    expect(chromeVisibility(s, { workbench: false, mobile: false }).groupBar).toBe(true);
  });

  it('workbenchOn only accepts true', () => {
    expect(workbenchOn({})).toBe(false);
    expect(workbenchOn({ 'ui.workbench': 'yes' })).toBe(false);
    expect(workbenchOn({ 'ui.workbench': true })).toBe(true);
  });
});

describe('ui.singleWindow → ui.workbench migration', () => {
  const split = () => layoutReducer(initialLayout(), { t: 'pane.split', paneId: focused(initialLayout()), dir: 'row' });

  it('leaves an existing setting alone', () => {
    expect(migrateWorkbench({ 'ui.workbench': false }, split())).toBeUndefined();
    expect(migrateWorkbench({ 'ui.workbench': true }, null)).toBeUndefined();
  });

  it('a fresh install (no saved layout) gets the quiet default', () => {
    expect(migrateWorkbench({}, null)).toBe(false);
  });

  it('single-window users keep a single window', () => {
    expect(migrateWorkbench({ 'ui.singleWindow': true }, split())).toBe(false);
  });

  it('someone really using splits or groups keeps the workbench', () => {
    let s = initialLayout();
    s = layoutReducer(s, { t: 'pane.split', paneId: focused(s), dir: 'row' });
    expect(migrateWorkbench({}, s)).toBe(true);
    expect(migrateWorkbench({}, layoutReducer(initialLayout(), { t: 'group.new' }))).toBe(true);
  });

  it('an open dock alone does not count (it was open by default; Ctrl+J still opens it)', () => {
    const docked = layoutReducer(initialLayout(), { t: 'dock.show', panel: 'files' });
    expect(migrateWorkbench({}, docked)).toBe(false);
    expect(migrateWorkbench({ 'ui.singleWindow': false }, docked)).toBe(false);
    // the exact shape every pre-redesign layout was saved with: dock open on the tasks tab
    const oldDefault: LayoutState = { ...initialLayout(), dock: { open: true, minimized: false, width: 440, tabs: ['tasks'], active: 'tasks' } };
    expect(migrateWorkbench({}, oldDefault)).toBe(false);
    expect(migrateWorkbench({ 'ui.singleWindow': false }, oldDefault)).toBe(false);
  });

  it('the one-time 「界面已简化」 notice: old users landing on the quiet UI, once, never fresh installs', () => {
    const docked = layoutReducer(initialLayout(), { t: 'dock.show', panel: 'files' });
    expect(needsSimplifiedNotice({}, docked, false)).toBe(true);
    expect(needsSimplifiedNotice({ onboarded: true }, null, false)).toBe(true); // desktop: the layout is per-origin, gone every launch
    expect(needsSimplifiedNotice({ 'ui.singleWindow': true }, null, false)).toBe(true);
    expect(needsSimplifiedNotice({}, null, false)).toBe(false); // fresh install: nothing changed for them
    expect(needsSimplifiedNotice({}, docked, true)).toBe(false); // kept the workbench: nothing changed either
    expect(needsSimplifiedNotice({ [SIMPLIFIED_NOTICE_KEY]: true, onboarded: true }, docked, false)).toBe(false); // only once
  });

  it('a saved single pane with the dock closed is not a workbench user', () => {
    expect(migrateWorkbench({}, initialLayout())).toBe(false);
  });

  it('a fresh layout starts with the dock closed', () => {
    expect(initialLayout().dock.open).toBe(false);
    expect(migrateLegacy({ getItem: () => null }).dock.open).toBe(false);
    expect(hasLegacyLayout({ getItem: () => null })).toBe(false);
    expect(hasLegacyLayout({ getItem: (k) => (k === 'cw.rp' ? '400' : null) })).toBe(true);
  });

  it('a cw.layout.v2 save from before the redesign still loads (wb tabs, trajectory view, dock tabs)', () => {
    // shape written by the pre-redesign app: two panes, a chat tile on the 文件 tab in trajectory view, the dock open
    const saved = {
      version: 2,
      groups: [{
        id: 'g1', name: '主工作区', focusedPaneId: 'p2', zoomedPaneId: null,
        root: { type: 'split', id: 's1', dir: 'row', ratio: 0.5, a: { type: 'leaf', paneId: 'p1' }, b: { type: 'leaf', paneId: 'p2' } },
        panes: {
          p1: { id: 'p1', activeTileId: 't1', tiles: [{ id: 't1', kind: 'chat', sessionId: 'a', view: 'trajectory', wb: 'files' }] },
          p2: { id: 'p2', activeTileId: 't2', tiles: [{ id: 't2', kind: 'chat', sessionId: 'b', view: 'chat', wb: 'live' }, { id: 't3', kind: 'term', cwd: '/w' }] },
        },
      }],
      activeGroupId: 'g1',
      sidebar: { width: 300, sections: { __pinned: true } },
      dock: { open: true, minimized: false, width: 480, tabs: ['tasks', 'files'], active: 'files' },
    };
    const s = sanitizeLayout(JSON.parse(JSON.stringify(saved)))!;
    expect(s).not.toBeNull();
    expect(panes(s)).toEqual(['p1', 'p2']);
    const t1 = activeGroup(s).panes.p1.tiles[0];
    expect(t1.kind === 'chat' && t1.wb === 'files' && t1.view === 'trajectory').toBe(true);
    expect(deriveActive(s)).toBe('b');
    expect(chromeVisibility(s, { workbench: false }).tabStrip).toEqual({ p1: true, p2: true });
    expect(migrateWorkbench({}, s)).toBe(true);
  });
});
