// Workbench layout model: groups → binary split tree of panes → tiles (tabs) inside a pane.
// Pure functions, no DOM / store imports, so it can be unit tested.

import type { IconName } from '@/ui/icons';

export type PanelId = 'tasks' | 'files' | 'usage' | 'config' | 'terminal' | 'inspector' | 'mission' | 'goals' | 'android' | 'memory' | 'orchestra';
/** A chat tile's view: the conversation (`live`) or one of the per-session workbench views. */
export const WORKBENCH_TABS = ['live', 'changes', 'git', 'files', 'search', 'schedules', 'artifacts', 'board'] as const;
export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];

/**
 * The one panel table. Dock tabs, the top bar, the command palette, the pane ＋ menu and
 * tile titles all read it — adding a panel means adding a row here and a case in `PanelBody`.
 * `rail` marks the panels the top bar surfaces directly; the rest live in menus.
 */
export const PANELS: { id: PanelId; title: string; icon: IconName; rail?: boolean }[] = [
  { id: 'mission', title: '总览', icon: 'mission', rail: true },
  { id: 'goals', title: '目标', icon: 'goals', rail: true },
  { id: 'orchestra', title: '编排', icon: 'orchestra', rail: true },
  { id: 'memory', title: '记忆', icon: 'memory', rail: true },
  { id: 'tasks', title: '任务', icon: 'tasks', rail: true },
  { id: 'files', title: '文件改动', icon: 'files', rail: true },
  { id: 'usage', title: '用量', icon: 'usage' },
  { id: 'config', title: '配置中心', icon: 'config' },
  { id: 'terminal', title: '终端', icon: 'terminal', rail: true },
  { id: 'inspector', title: '详情', icon: 'inspector' },
  { id: 'android', title: 'Android', icon: 'android' },
];
export const PANEL_IDS = PANELS.map((p) => p.id);
export const PANEL_TITLES = Object.fromEntries(PANELS.map((p) => [p.id, p.title])) as Record<PanelId, string>;
export const PANEL_ICONS = Object.fromEntries(PANELS.map((p) => [p.id, p.icon])) as Record<PanelId, IconName>;

/** Icon for a tile, by kind — the other half of the title/icon pair `tileTitle` builds. */
export const TILE_ICONS: Record<Tile['kind'], IconName> = { chat: 'chat', doc: 'read', diff: 'files', term: 'terminal', panel: 'inspector', browser: 'browser' };

export type Tile =
  | { id: string; kind: 'chat'; sessionId: string | null; view: 'chat' | 'trajectory'; wb: WorkbenchTab; title?: string }
  | { id: string; kind: 'doc'; path: string; line?: number; title?: string }
  | { id: string; kind: 'diff'; sessionId: string; path: string; staged?: boolean; rev?: string; cwd?: string; title?: string }
  | { id: string; kind: 'term'; cwd: string; title?: string; cmd?: string }
  | { id: string; kind: 'browser'; url: string; title?: string }
  | { id: string; kind: 'panel'; panel: PanelId; title?: string };

export interface Pane { id: string; tiles: Tile[]; activeTileId: string | null }
export type PaneNode = { type: 'leaf'; paneId: string } | { type: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode };
export interface Group { id: string; name: string; root: PaneNode; panes: Record<string, Pane>; focusedPaneId: string; zoomedPaneId: string | null }
export interface Dock { open: boolean; minimized: boolean; width: number; tabs: PanelId[]; active: PanelId | null }
export interface LayoutState {
  version: 2;
  groups: Group[];
  activeGroupId: string;
  sidebar: { width: number; sections: Record<string, boolean> };
  dock: Dock;
}

export type LayoutPreset = 'single' | 'cols2' | 'cols3' | 'grid2x2' | 'mainSide';

export type LayoutAction =
  | { t: 'group.new'; name?: string; tile?: Tile }
  | { t: 'group.close'; id: string }
  | { t: 'group.rename'; id: string; name: string }
  | { t: 'group.activate'; id: string }
  | { t: 'group.next'; dir: 1 | -1 }
  | { t: 'group.add'; group: Group }
  | { t: 'group.remove'; id: string }
  | { t: 'pane.split'; paneId: string; dir: 'row' | 'col'; tile?: Tile; before?: boolean }
  | { t: 'pane.close'; paneId: string }
  | { t: 'pane.focus'; paneId: string }
  | { t: 'pane.zoom'; paneId: string | null }
  | { t: 'pane.jump'; index: number }
  | { t: 'pane.cycle'; dir: 1 | -1 }
  | { t: 'pane.ratio'; splitId: string; ratio: number }
  | { t: 'pane.even'; splitId?: string }
  | { t: 'pane.preset'; preset: LayoutPreset }
  | { t: 'tile.open'; paneId: string; tile: Tile; mode: 'replace' | 'tab' }
  | { t: 'tile.close'; paneId: string; tileId: string }
  | { t: 'tile.activate'; paneId: string; tileId: string }
  | { t: 'tile.rename'; paneId: string; tileId: string; title: string }
  | { t: 'tile.move'; from: { paneId: string; tileId: string }; to: { paneId: string; index?: number } }
  | { t: 'tile.patch'; paneId: string; tileId: string; patch: Partial<Tile> }
  | { t: 'tile.next'; paneId: string; dir: 1 | -1 }
  | { t: 'session.assign'; paneId: string; tileId: string; sessionId: string }
  | { t: 'dock.set'; patch: Partial<Dock> }
  | { t: 'dock.toggle'; panel: PanelId }
  | { t: 'dock.show'; panel: PanelId }
  | { t: 'sidebar.set'; patch: Partial<LayoutState['sidebar']> };

export const MAX_PANES = 6;
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;

let seq = 0;
export const uid = (p = 'x') => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
/** Test hook: deterministic ids. */
export function resetIds() { seq = 0; }

export function chatTile(sessionId: string | null = null, extra: Partial<Extract<Tile, { kind: 'chat' }>> = {}): Tile {
  return { id: uid('t'), kind: 'chat', sessionId, view: 'chat', wb: 'live', ...extra };
}

export function newPane(tile?: Tile): Pane {
  const t = tile ?? chatTile();
  return { id: uid('p'), tiles: [t], activeTileId: t.id };
}

export function newGroup(name = '工作区', tile?: Tile): Group {
  const p = newPane(tile);
  return { id: uid('g'), name, root: { type: 'leaf', paneId: p.id }, panes: { [p.id]: p }, focusedPaneId: p.id, zoomedPaneId: null };
}

export function initialLayout(): LayoutState {
  const g = newGroup('主工作区');
  return { version: 2, groups: [g], activeGroupId: g.id, sidebar: { width: 264, sections: {} }, dock: { open: true, minimized: false, width: 440, tabs: ['tasks'], active: 'tasks' } };
}

/** Leaf pane ids in DFS order (a before b) — this is the Alt+1..6 / cycle order. */
export function paneOrder(root: PaneNode): string[] {
  const out: string[] = [];
  const rec = (n: PaneNode) => { if (n.type === 'leaf') out.push(n.paneId); else { rec(n.a); rec(n.b); } };
  rec(root);
  return out;
}

export function activeGroup(s: LayoutState): Group {
  return s.groups.find((g) => g.id === s.activeGroupId) ?? s.groups[0];
}

export function findPaneGroup(s: LayoutState, paneId: string): Group | undefined {
  return s.groups.find((g) => !!g.panes[paneId]);
}

const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
/** Two tiles show the same thing (used to de-duplicate tabs). An empty chat tile never equals anything. */
export function sameTile(a: Tile, b: Tile): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'chat') return b.kind === 'chat' && a.sessionId !== null && a.sessionId === b.sessionId;
  if (a.kind === 'doc') return b.kind === 'doc' && normPath(a.path) === normPath(b.path);
  if (a.kind === 'diff') return b.kind === 'diff' && normPath(a.path) === normPath(b.path) && !!a.staged === !!b.staged && a.rev === b.rev;
  if (a.kind === 'panel') return b.kind === 'panel' && a.panel === b.panel;
  return false;
}

export function activeTile(p: Pane | undefined): Tile | undefined {
  return p ? p.tiles.find((t) => t.id === p.activeTileId) ?? p.tiles[0] : undefined;
}

/**
 * Session shown in the focused pane (for `activeId` derivation).
 *
 * Falls back past non-session tiles: bringing a doc / terminal / browser tab to the front must not
 * strand the dock panels (files, git, memory, tasks…) with no session — they read `activeId`, and a
 * browser tab next to the chat is the normal way to work.
 */
export function deriveActive(s: LayoutState): string | null {
  const g = activeGroup(s);
  const held = (t: Tile | undefined) => (t?.kind === 'chat' || t?.kind === 'diff' ? t.sessionId : null);
  const inPane = (p: Pane | undefined) => (p ? held(activeTile(p)) ?? held(p.tiles.find((t) => held(t))) : null);
  return inPane(g.panes[g.focusedPaneId]) ?? paneOrder(g.root).map((id) => inPane(g.panes[id])).find(Boolean) ?? null;
}

export interface Rect { x: number; y: number; w: number; h: number }
export interface Layout { panes: Record<string, Rect>; splitters: { id: string; dir: 'row' | 'col'; rect: Rect }[] }

/** Absolute rectangles for panes and splitters. Zoomed pane takes the whole area; the others get zero-size rects. */
export function layoutRects(root: PaneNode, rect: Rect, gap: number, zoomedPaneId: string | null): Layout {
  const out: Layout = { panes: {}, splitters: [] };
  if (zoomedPaneId) {
    for (const id of paneOrder(root)) out.panes[id] = id === zoomedPaneId ? rect : { x: 0, y: 0, w: 0, h: 0 };
    return out;
  }
  const rec = (n: PaneNode, r: Rect) => {
    if (n.type === 'leaf') { out.panes[n.paneId] = r; return; }
    if (n.dir === 'row') {
      const wa = Math.round((r.w - gap) * n.ratio);
      rec(n.a, { x: r.x, y: r.y, w: wa, h: r.h });
      out.splitters.push({ id: n.id, dir: 'row', rect: { x: r.x + wa, y: r.y, w: gap, h: r.h } });
      rec(n.b, { x: r.x + wa + gap, y: r.y, w: r.w - wa - gap, h: r.h });
    } else {
      const ha = Math.round((r.h - gap) * n.ratio);
      rec(n.a, { x: r.x, y: r.y, w: r.w, h: ha });
      out.splitters.push({ id: n.id, dir: 'col', rect: { x: r.x, y: r.y + ha, w: r.w, h: gap } });
      rec(n.b, { x: r.x, y: r.y + ha + gap, w: r.w, h: r.h - ha - gap });
    }
  };
  rec(root, rect);
  return out;
}

function mapNode(n: PaneNode, fn: (n: PaneNode) => PaneNode | null): PaneNode | null {
  const r = fn(n);
  if (r !== n) return r;
  if (n.type === 'leaf') return n;
  const a = mapNode(n.a, fn), b = mapNode(n.b, fn);
  if (a === n.a && b === n.b) return n;
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}

/** Build a preset tree, reusing existing pane ids in order and creating new panes as needed. */
export function presetTree(preset: LayoutPreset, existing: Pane[]): { root: PaneNode; panes: Record<string, Pane> } {
  const need = preset === 'single' ? 1 : preset === 'cols2' || preset === 'mainSide' ? 2 : preset === 'cols3' ? 3 : 4;
  const panes: Record<string, Pane> = {};
  const ids: string[] = [];
  for (let i = 0; i < need; i++) {
    const p = existing[i] ?? newPane();
    panes[p.id] = p;
    ids.push(p.id);
  }
  // leftover panes: merge their tiles into the last kept pane so nothing is lost (same session / file only once)
  for (const p of existing.slice(need)) {
    const lastId = ids[ids.length - 1];
    const last = panes[lastId];
    const extra = p.tiles.filter((t) => !last.tiles.some((x) => sameTile(x, t)));
    if (extra.length) panes[lastId] = { ...last, tiles: [...last.tiles, ...extra] };
  }
  const leaf = (id: string): PaneNode => ({ type: 'leaf', paneId: id });
  const split = (dir: 'row' | 'col', ratio: number, a: PaneNode, b: PaneNode): PaneNode => ({ type: 'split', id: uid('s'), dir, ratio, a, b });
  let root: PaneNode;
  switch (preset) {
    case 'single': root = leaf(ids[0]); break;
    case 'cols2': root = split('row', 0.5, leaf(ids[0]), leaf(ids[1])); break;
    case 'mainSide': root = split('row', 0.66, leaf(ids[0]), leaf(ids[1])); break;
    case 'cols3': root = split('row', 1 / 3, leaf(ids[0]), split('row', 0.5, leaf(ids[1]), leaf(ids[2]))); break;
    case 'grid2x2': root = split('col', 0.5, split('row', 0.5, leaf(ids[0]), leaf(ids[1])), split('row', 0.5, leaf(ids[2]), leaf(ids[3]))); break;
  }
  return { root, panes };
}

function clampRatio(r: number) {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

function withGroup(s: LayoutState, gid: string, fn: (g: Group) => Group): LayoutState {
  const i = s.groups.findIndex((g) => g.id === gid);
  if (i < 0) return s;
  const g2 = fn(s.groups[i]);
  if (g2 === s.groups[i]) return s;
  const groups = s.groups.slice();
  groups[i] = g2;
  return { ...s, groups };
}

function fixFocus(g: Group): Group {
  const order = paneOrder(g.root);
  const focused = g.panes[g.focusedPaneId] ? g.focusedPaneId : order[0];
  const zoomed = g.zoomedPaneId && g.panes[g.zoomedPaneId] ? g.zoomedPaneId : null;
  return focused === g.focusedPaneId && zoomed === g.zoomedPaneId ? g : { ...g, focusedPaneId: focused, zoomedPaneId: zoomed };
}

function updatePane(g: Group, paneId: string, fn: (p: Pane) => Pane): Group {
  const p = g.panes[paneId];
  if (!p) return g;
  const p2 = fn(p);
  if (p2 === p) return g;
  return { ...g, panes: { ...g.panes, [paneId]: p2 } };
}

/** Remove a pane from the tree; the parent split is replaced by the sibling. Never removes the last pane. */
function removePane(g: Group, paneId: string): Group {
  const order = paneOrder(g.root);
  if (order.length <= 1) return g;
  const root = mapNode(g.root, (n) => (n.type === 'leaf' && n.paneId === paneId ? null : n));
  if (!root) return g;
  const panes = { ...g.panes };
  delete panes[paneId];
  const idx = order.indexOf(paneId);
  const nextOrder = paneOrder(root);
  const focus = g.focusedPaneId === paneId ? nextOrder[Math.min(idx, nextOrder.length - 1)] : g.focusedPaneId;
  return fixFocus({ ...g, root, panes, focusedPaneId: focus, zoomedPaneId: g.zoomedPaneId === paneId ? null : g.zoomedPaneId });
}

export function layoutReducer(s: LayoutState, a: LayoutAction): LayoutState {
  switch (a.t) {
    case 'group.new': {
      const g = newGroup(a.name ?? `组 ${s.groups.length + 1}`, a.tile);
      return { ...s, groups: [...s.groups, g], activeGroupId: g.id };
    }
    case 'group.add':
      if (s.groups.some((g) => g.id === a.group.id)) return s;
      return { ...s, groups: [...s.groups, a.group], activeGroupId: a.group.id };
    case 'group.close':
    case 'group.remove': {
      if (s.groups.length <= 1 && a.t === 'group.close') {
        // closing the only group resets it to one empty pane
        const g = newGroup(s.groups[0]?.name ?? '主工作区');
        return { ...s, groups: [g], activeGroupId: g.id };
      }
      const i = s.groups.findIndex((g) => g.id === a.id);
      if (i < 0) return s;
      const groups = s.groups.filter((g) => g.id !== a.id);
      if (!groups.length) { const g = newGroup('主工作区'); return { ...s, groups: [g], activeGroupId: g.id }; }
      const active = s.activeGroupId === a.id ? groups[Math.min(i, groups.length - 1)].id : s.activeGroupId;
      return { ...s, groups, activeGroupId: active };
    }
    case 'group.rename':
      return withGroup(s, a.id, (g) => (g.name === a.name ? g : { ...g, name: a.name }));
    case 'group.activate':
      return s.groups.some((g) => g.id === a.id) && s.activeGroupId !== a.id ? { ...s, activeGroupId: a.id } : s;
    case 'group.next': {
      const i = s.groups.findIndex((g) => g.id === s.activeGroupId);
      const j = (i + a.dir + s.groups.length) % s.groups.length;
      return j === i ? s : { ...s, activeGroupId: s.groups[j].id };
    }

    case 'pane.split': {
      const g = findPaneGroup(s, a.paneId);
      if (!g) return s;
      if (paneOrder(g.root).length >= MAX_PANES) return s;
      const p = newPane(a.tile);
      const leaf: PaneNode = { type: 'leaf', paneId: p.id };
      const root = mapNode(g.root, (n) => (n.type === 'leaf' && n.paneId === a.paneId ? { type: 'split', id: uid('s'), dir: a.dir, ratio: 0.5, a: a.before ? leaf : n, b: a.before ? n : leaf } : n))!;
      return withGroup(s, g.id, () => ({ ...g, root, panes: { ...g.panes, [p.id]: p }, focusedPaneId: p.id, zoomedPaneId: null }));
    }
    case 'pane.close': {
      const g = findPaneGroup(s, a.paneId);
      if (!g) return s;
      if (paneOrder(g.root).length <= 1) {
        // last pane: leave one empty chat tile
        const p = g.panes[a.paneId];
        if (p.tiles.length === 1 && p.tiles[0].kind === 'chat' && p.tiles[0].sessionId === null) return s;
        const t = chatTile();
        return withGroup(s, g.id, () => ({ ...g, panes: { [a.paneId]: { ...p, tiles: [t], activeTileId: t.id } }, zoomedPaneId: null }));
      }
      return withGroup(s, g.id, () => removePane(g, a.paneId));
    }
    case 'pane.focus': {
      const g = findPaneGroup(s, a.paneId);
      if (!g) return s;
      const s2 = s.activeGroupId === g.id ? s : { ...s, activeGroupId: g.id };
      return withGroup(s2, g.id, (gg) => (gg.focusedPaneId === a.paneId ? gg : { ...gg, focusedPaneId: a.paneId }));
    }
    case 'pane.zoom': {
      const g = activeGroup(s);
      const id = a.paneId && g.panes[a.paneId] ? a.paneId : null;
      return withGroup(s, g.id, (gg) => (gg.zoomedPaneId === id ? gg : { ...gg, zoomedPaneId: id, focusedPaneId: id ?? gg.focusedPaneId }));
    }
    case 'pane.jump': {
      const g = activeGroup(s);
      const id = paneOrder(g.root)[a.index];
      return id ? layoutReducer(s, { t: 'pane.focus', paneId: id }) : s;
    }
    case 'pane.cycle': {
      const g = activeGroup(s);
      const order = paneOrder(g.root);
      const i = order.indexOf(g.focusedPaneId);
      return layoutReducer(s, { t: 'pane.focus', paneId: order[(i + a.dir + order.length) % order.length] });
    }
    case 'pane.ratio': {
      const g = activeGroup(s);
      const root = mapNode(g.root, (n) => (n.type === 'split' && n.id === a.splitId ? { ...n, ratio: clampRatio(a.ratio) } : n))!;
      return root === g.root ? s : withGroup(s, g.id, (gg) => ({ ...gg, root }));
    }
    case 'pane.even': {
      const g = activeGroup(s);
      const even = (n: PaneNode): PaneNode => (n.type === 'leaf' ? n : { ...n, ratio: 0.5, a: even(n.a), b: even(n.b) });
      const root = a.splitId ? mapNode(g.root, (n) => (n.type === 'split' && n.id === a.splitId ? even(n) : n))! : even(g.root);
      return withGroup(s, g.id, (gg) => ({ ...gg, root }));
    }
    case 'pane.preset': {
      const g = activeGroup(s);
      const order = paneOrder(g.root);
      const { root, panes } = presetTree(a.preset, order.map((id) => g.panes[id]));
      return withGroup(s, g.id, () => fixFocus({ ...g, root, panes, zoomedPaneId: null }));
    }

    case 'tile.open': {
      const g = findPaneGroup(s, a.paneId);
      if (!g) return s;
      return withGroup(s, g.id, (gg) => updatePane(gg, a.paneId, (p) => {
        const cur = p.tiles.find((t) => t.id === p.activeTileId) ?? p.tiles[0];
        // an empty chat tile is always replaced; otherwise honour mode
        const replace = a.mode === 'replace' || (cur?.kind === 'chat' && cur.sessionId === null);
        // same session / document / diff already open as a tab → just activate it (docs also take the new line).
        // Checked before replacing too: replacing would put a second tab of the same thing in the pane, or (when it
        // is the current tab) swap in a new tile id, which remounts the tile and throws away scroll / composer state.
        const nt = a.tile;
        const dup = p.tiles.find((t) => sameTile(t, nt));
        if (dup) {
          const tiles = nt.kind === 'doc' && nt.line ? p.tiles.map((t) => (t.id === dup.id ? { ...t, line: nt.line } : t)) : p.tiles;
          return p.activeTileId === dup.id && tiles === p.tiles ? p : { ...p, tiles, activeTileId: dup.id };
        }
        if (replace && cur) {
          const tiles = p.tiles.map((t) => (t.id === cur.id ? { ...a.tile, id: a.tile.id || cur.id } : t));
          return { ...p, tiles, activeTileId: tiles.find((t) => t === tiles[p.tiles.indexOf(cur)])!.id };
        }
        return { ...p, tiles: [...p.tiles, a.tile], activeTileId: a.tile.id };
      }));
    }
    case 'tile.close': {
      const g = findPaneGroup(s, a.paneId);
      if (!g) return s;
      const p = g.panes[a.paneId];
      if (!p || !p.tiles.some((t) => t.id === a.tileId)) return s;
      if (p.tiles.length === 1) return layoutReducer(s, { t: 'pane.close', paneId: a.paneId });
      const idx = p.tiles.findIndex((t) => t.id === a.tileId);
      const tiles = p.tiles.filter((t) => t.id !== a.tileId);
      const active = p.activeTileId === a.tileId ? tiles[Math.min(idx, tiles.length - 1)].id : p.activeTileId;
      return withGroup(s, g.id, (gg) => updatePane(gg, a.paneId, () => ({ ...p, tiles, activeTileId: active })));
    }
    case 'tile.activate': {
      const g = findPaneGroup(s, a.paneId);
      if (!g) return s;
      const s2 = layoutReducer(s, { t: 'pane.focus', paneId: a.paneId });
      return withGroup(s2, g.id, (gg) => updatePane(gg, a.paneId, (p) => (p.activeTileId === a.tileId || !p.tiles.some((t) => t.id === a.tileId) ? p : { ...p, activeTileId: a.tileId })));
    }
    case 'tile.next': {
      const g = findPaneGroup(s, a.paneId);
      if (!g) return s;
      const p = g.panes[a.paneId];
      const i = p.tiles.findIndex((t) => t.id === p.activeTileId);
      const next = p.tiles[(i + a.dir + p.tiles.length) % p.tiles.length];
      return next ? layoutReducer(s, { t: 'tile.activate', paneId: a.paneId, tileId: next.id }) : s;
    }
    case 'tile.rename':
    case 'tile.patch': {
      const g = findPaneGroup(s, a.paneId);
      if (!g) return s;
      const patch = a.t === 'tile.rename' ? { title: a.title } : a.patch;
      return withGroup(s, g.id, (gg) => updatePane(gg, a.paneId, (p) => ({ ...p, tiles: p.tiles.map((t) => (t.id === a.tileId ? ({ ...t, ...patch } as Tile) : t)) })));
    }
    case 'tile.move': {
      const gFrom = findPaneGroup(s, a.from.paneId);
      const gTo = findPaneGroup(s, a.to.paneId);
      if (!gFrom || !gTo) return s;
      const tile = gFrom.panes[a.from.paneId].tiles.find((t) => t.id === a.from.tileId);
      if (!tile) return s;
      if (a.from.paneId === a.to.paneId) {
        // reorder within the pane
        return withGroup(s, gFrom.id, (gg) => updatePane(gg, a.from.paneId, (p) => {
          const rest = p.tiles.filter((t) => t.id !== tile.id);
          const idx = a.to.index ?? rest.length;
          rest.splice(Math.min(idx, rest.length), 0, tile);
          return { ...p, tiles: rest };
        }));
      }
      // remove from source (closing the pane if it was its last tile), then insert
      let s2 = s;
      const src = gFrom.panes[a.from.paneId];
      if (src.tiles.length === 1) {
        s2 = paneOrder(gFrom.root).length > 1 ? withGroup(s2, gFrom.id, (gg) => removePane(gg, a.from.paneId)) : withGroup(s2, gFrom.id, (gg) => updatePane(gg, a.from.paneId, (p) => { const t = chatTile(); return { ...p, tiles: [t], activeTileId: t.id }; }));
      } else {
        s2 = withGroup(s2, gFrom.id, (gg) => updatePane(gg, a.from.paneId, (p) => {
          const idx = p.tiles.findIndex((t) => t.id === tile.id);
          const tiles = p.tiles.filter((t) => t.id !== tile.id);
          return { ...p, tiles, activeTileId: p.activeTileId === tile.id ? tiles[Math.min(idx, tiles.length - 1)].id : p.activeTileId };
        }));
      }
      s2 = withGroup(s2, gTo.id, (gg) => updatePane(gg, a.to.paneId, (p) => {
        const tiles = p.tiles.slice();
        // dropping onto an empty chat tile replaces it
        const emptyIdx = tiles.findIndex((t) => t.kind === 'chat' && t.sessionId === null);
        if (emptyIdx >= 0 && tiles.length === 1) return { ...p, tiles: [tile], activeTileId: tile.id };
        tiles.splice(Math.min(a.to.index ?? tiles.length, tiles.length), 0, tile);
        return { ...p, tiles, activeTileId: tile.id };
      }));
      return layoutReducer(s2, { t: 'pane.focus', paneId: a.to.paneId });
    }
    case 'session.assign': {
      const g = findPaneGroup(s, a.paneId);
      if (!g) return s;
      return withGroup(s, g.id, (gg) => updatePane(gg, a.paneId, (p) => ({ ...p, tiles: p.tiles.map((t) => (t.id === a.tileId && t.kind === 'chat' ? { ...t, sessionId: a.sessionId } : t)) })));
    }

    case 'dock.set':
      return { ...s, dock: { ...s.dock, ...a.patch } };
    case 'dock.toggle': {
      const has = s.dock.tabs.includes(a.panel);
      if (has && s.dock.active === a.panel && s.dock.open && !s.dock.minimized) {
        const tabs = s.dock.tabs.filter((t) => t !== a.panel);
        return { ...s, dock: { ...s.dock, tabs, active: tabs[0] ?? null, open: tabs.length > 0 } };
      }
      const tabs = has ? s.dock.tabs : [...s.dock.tabs, a.panel];
      return { ...s, dock: { ...s.dock, tabs, active: a.panel, open: true, minimized: false } };
    }
    case 'dock.show': {
      const tabs = s.dock.tabs.includes(a.panel) ? s.dock.tabs : [...s.dock.tabs, a.panel];
      return { ...s, dock: { ...s.dock, tabs, active: a.panel, open: true, minimized: false } };
    }
    case 'sidebar.set':
      return { ...s, sidebar: { ...s.sidebar, ...a.patch } };
    default:
      return s;
  }
}

/** Build a v2 layout from the pre-workbench localStorage keys (cw.panels / cw.rp / cw.collapsed). */
export function migrateLegacy(ls: Pick<Storage, 'getItem'>): LayoutState {
  const base = initialLayout();
  let tabs: PanelId[] = ['tasks'];
  try {
    const p = JSON.parse(ls.getItem('cw.panels') ?? '["tasks"]');
    if (Array.isArray(p)) tabs = p.filter((x: string) => x !== 'inspector');
  } catch { /* keep */ }
  let sections: Record<string, boolean> = {};
  try { sections = JSON.parse(ls.getItem('cw.collapsed') ?? '{}') ?? {}; } catch { /* keep */ }
  const width = Number(ls.getItem('cw.rp') ?? 440) || 440;
  return { ...base, sidebar: { width: 264, sections }, dock: { open: tabs.length > 0, minimized: false, width, tabs, active: tabs[0] ?? null } };
}

/** Validate a persisted layout (shape + invariants); returns null when unusable. */
export function sanitizeLayout(x: unknown): LayoutState | null {
  const s = x as LayoutState;
  if (!s || s.version !== 2 || !Array.isArray(s.groups) || !s.groups.length) return null;
  for (const g of s.groups) {
    if (!g.root || !g.panes) return null;
    const order = paneOrder(g.root);
    if (!order.length || order.some((id) => !g.panes[id])) return null;
    for (const id of order) if (!g.panes[id].tiles.length) { const t = chatTile(); g.panes[id] = { ...g.panes[id], tiles: [t], activeTileId: t.id }; }
    // drop panes that are not in the tree
    for (const id of Object.keys(g.panes)) if (!order.includes(id)) delete g.panes[id];
    Object.assign(g, fixFocus(g));
  }
  if (!s.groups.some((g) => g.id === s.activeGroupId)) s.activeGroupId = s.groups[0].id;
  const dock: Partial<Dock> = s.dock ?? {};
  s.dock = { open: dock.open ?? true, minimized: dock.minimized ?? false, width: dock.width ?? 440, tabs: dock.tabs ?? [], active: dock.active ?? null };
  const sb: Partial<LayoutState['sidebar']> = s.sidebar ?? {};
  s.sidebar = { width: sb.width ?? 264, sections: sb.sections ?? {} };
  return s;
}
