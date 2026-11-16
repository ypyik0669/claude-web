import { useLayoutEffect, useRef, useState } from 'react';
import { useOpenSettled, useStore } from '@/store';
import { useDropdown } from '@/ui/menus';
import { placeFixed } from '@/features/sidebar/place';
import { imeComposing } from '@/ui/ime';
import { chatTile, MAX_PANES, PANELS, PANEL_ICONS, PANEL_TITLES, TILE_ICONS, type Pane as PaneModel, type Tile } from '@/model/layout';
import { clsx, basename } from '@/util';
import { Icon, type IconName } from '@/ui/icons';
import { MIME_TILE, hasType, tilePayload } from './dnd';
import { SidebarReveal } from './pane-edge';
import { tr } from '@/i18n';
import { captionBox } from '@/ui/caption';

export function tileTitle(t: Tile, sessions: { sessionId: string; title: string }[]): { icon: IconName; text: string } {
  const icon = iconFor(t);
  if (t.title) return { icon, text: t.title };
  switch (t.kind) {
    // a conversation not in the list yet has no transcript yet: it is a new one (issue #8 — its id was the tab's name)
    case 'chat': return { icon, text: (t.sessionId && sessions.find((s) => s.sessionId === t.sessionId)?.title) || tr('新对话') };
    case 'doc': return { icon, text: basename(t.path) };
    case 'diff': return { icon, text: basename(t.path) };
    case 'term': return { icon, text: tr('终端 · {basename}', { basename: basename(t.cwd) || t.cwd }) };
    case 'browser': return { icon, text: (() => { try { return new URL(t.url).host || t.url; } catch { return t.url; } })() };
    case 'panel': return { icon, text: PANEL_TITLES[t.panel] ?? t.panel };
  }
}
function iconFor(t: Tile): IconName {
  return t.kind === 'panel' ? PANEL_ICONS[t.panel] ?? 'inspector' : TILE_ICONS[t.kind];
}

/**
 * Tabs of one pane: click / middle-click close / double-click rename / drag reorder & move / ＋ menu / split & zoom buttons.
 * Rendered only when the pane needs it (`chromeVisibility`: several tabs, several panes, a lone non-chat tile, or
 * workbench mode). The pane number, split buttons and zoom only appear where they mean something.
 */
export function TabStrip({ pane, groupId, index, zoomed, single, lead, workbench, paneCount }: { pane: PaneModel; groupId: string; index: number; zoomed: boolean; single: boolean; lead: boolean; workbench: boolean; paneCount: number }) {
  const dispatch = useStore((s) => s.dispatchLayout);
  const closeTile = useStore((s) => s.closeTile);
  const dirty = useStore((s) => s.dirtyDocs);
  const sessions = useStore((s) => s.sessions);
  const open = useOpenSettled(); // not for each frame of a stream
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(false);
  const addBox = useRef<HTMLSpanElement>(null);
  // one anchored menu app-wide (polish P2): also closes on a click outside, Esc, another menu opening
  useDropdown(menu, () => setMenu(false), addBox);
  // fixed next to the ＋: the tab row scrolls sideways (overflow-x: auto clips the other axis too), a menu placed
  // inside it was cut to the row's height — the ＋ looked dead (Enroll, 2026-10-14)
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = menuRef.current, anchor = addBox.current;
    if (!menu || !el || !anchor) return;
    const place = () => {
      el.style.maxHeight = '';
      const spot = placeFixed(anchor.getBoundingClientRect(), { w: el.offsetWidth, h: el.scrollHeight }, { vw: window.innerWidth, vh: window.innerHeight }, { align: 'left', caption: captionBox() });
      el.style.left = `${spot.left}px`;
      el.style.top = `${spot.top}px`;
      el.style.maxHeight = spot.maxHeight ? `${spot.maxHeight}px` : '';
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [menu]);
  const [over, setOver] = useState<number | null>(null);
  // split buttons are workbench tools; Ctrl+D / Ctrl+Shift+D work regardless
  const canSplit = workbench && paneCount < MAX_PANES;

  const startRename = (t: Tile) => { setRenaming(t.id); setDraft(tileTitle(t, sessions).text); };
  const commitRename = () => { if (renaming) dispatch({ t: 'tile.rename', paneId: pane.id, tileId: renaming, title: draft.trim() }); setRenaming(null); };

  const onDragStart = (e: React.DragEvent, t: Tile) => {
    e.dataTransfer.setData(MIME_TILE, JSON.stringify({ groupId, paneId: pane.id, tileId: t.id }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragOver = (e: React.DragEvent, i: number) => {
    if (!hasType(e.dataTransfer, MIME_TILE)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOver(e.clientX < r.left + r.width / 2 ? i : i + 1);
  };
  const onDrop = (e: React.DragEvent) => {
    const p = tilePayload(e.dataTransfer);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    dispatch({ t: 'tile.move', from: { paneId: p.paneId, tileId: p.tileId }, to: { paneId: pane.id, index: over ?? pane.tiles.length } });
    setOver(null);
  };

  return (
    <div className="tabstrip" onDragOver={(e) => { if (hasType(e.dataTransfer, MIME_TILE)) { e.preventDefault(); e.stopPropagation(); } }} onDrop={onDrop} onDragLeave={() => setOver(null)}>
      {lead && <SidebarReveal />}
      {paneCount > 1 && <span className="pane-idx" title={tr('分屏 {index}（Alt+{index2}）', { index: index + 1, index2: index + 1 })}>{index + 1}</span>}
      <div className="tabs">
        {pane.tiles.map((t, i) => {
          const { icon, text } = tileTitle(t, sessions);
          const live = t.kind === 'chat' && t.sessionId ? open[t.sessionId]?.state : undefined;
          const active = t.id === pane.activeTileId;
          return (
            <div
              key={t.id}
              className={clsx('tab', active && 'active', over === i && 'ins-before', over === i + 1 && i === pane.tiles.length - 1 && 'ins-after')}
              draggable
              onDragStart={(e) => onDragStart(e, t)}
              onDragOver={(e) => onDragOver(e, i)}
              onClick={() => dispatch({ t: 'tile.activate', paneId: pane.id, tileId: t.id })}
              onDoubleClick={() => startRename(t)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTile(pane.id, t.id); } }}
              title={tr("{text}\n双击重命名 · 中键关闭 · 可拖到别的分屏", { text })}
            >
              {live && live !== 'history' && live !== 'closed' && <span className={clsx('dot', live)} />}
              {!live && <span className="ic"><Icon name={icon} size={14} /></span>}
              {renaming === t.id ? (
                <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (imeComposing(e.nativeEvent)) return; if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }} onClick={(e) => e.stopPropagation()} />
              ) : (
                <span className="t">{text}{dirty[t.id] ? ' •' : ''}</span>
              )}
              <button className="x" title={tr('关闭')} aria-label={tr('关闭标签')} onClick={(e) => { e.stopPropagation(); closeTile(pane.id, t.id); }}><Icon name="close" size={11} /></button>
            </div>
          );
        })}
        <span ref={addBox} style={{ position: 'relative' }}>
          <button className="tab-add" title={tr('新标签页')} aria-label={tr('新标签页')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="plus" size={14} /></button>
          {menu && (
            <div ref={menuRef} className="menu tab-add-menu" role="menu" aria-label={tr('新标签页')} onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); dispatch({ t: 'tile.open', paneId: pane.id, tile: chatTile(null), mode: 'tab' }); }}><Icon name="chat" size={14} /> {tr('新对话')}</button>
              <button onClick={() => { setMenu(false); const cwd = currentCwd(pane, open); dispatch({ t: 'tile.open', paneId: pane.id, tile: { id: `t${Date.now()}`, kind: 'term', cwd }, mode: 'tab' }); }}><Icon name="terminal" size={14} /> {tr('终端')}</button>
              <button onClick={() => { setMenu(false); dispatch({ t: 'tile.open', paneId: pane.id, tile: { id: `t${Date.now()}`, kind: 'browser', url: 'http://localhost:3000' }, mode: 'tab' }); }}><Icon name="browser" size={14} /> {tr('浏览器')}</button>
              {PANELS.map((p) => (
                <button key={p.id} onClick={() => { setMenu(false); dispatch({ t: 'tile.open', paneId: pane.id, tile: { id: `t${Date.now()}`, kind: 'panel', panel: p.id }, mode: 'tab' }); }}><Icon name={p.icon} size={14} /> {p.title}</button>
              ))}
            </div>
          )}
        </span>
      </div>
      <span className="grow" />
      {canSplit && <button className="icon-btn xs" title={tr('向右分屏 (Ctrl+D)')} onClick={() => dispatch({ t: 'pane.split', paneId: pane.id, dir: 'row' })}><Icon name="splitRight" size={14} /></button>}
      {canSplit && <button className="icon-btn xs" title={tr('向下分屏 (Ctrl+Shift+D)')} onClick={() => dispatch({ t: 'pane.split', paneId: pane.id, dir: 'col' })}><Icon name="splitDown" size={14} /></button>}
      {!single && <button className={clsx('icon-btn xs', zoomed && 'active')} title={zoomed ? tr('还原 (Ctrl+Shift+Enter)') : tr('放大这个分屏 (Ctrl+Shift+Enter)')} onClick={() => dispatch({ t: 'pane.zoom', paneId: zoomed ? null : pane.id })}><Icon name="zoom" size={14} /></button>}
      {!single && <button className="icon-btn xs" title={tr('关闭这个分屏')} aria-label={tr('关闭这个分屏')} onClick={() => dispatch({ t: 'pane.close', paneId: pane.id })}><Icon name="close" size={14} /></button>}
    </div>
  );
}

/** Phone only: the one row above a non-conversation tile (the tab strip never shows on a phone). */
export function MobileTileBar({ paneId, tile }: { paneId: string; tile: Tile }) {
  const sessions = useStore((s) => s.sessions);
  const dirty = useStore((s) => !!s.dirtyDocs[tile.id]);
  const closeTile = useStore((s) => s.closeTile);
  const { icon, text } = tileTitle(tile, sessions);
  return (
    <div className="mobile-tilebar">
      <SidebarReveal />
      <span className="ic"><Icon name={icon} size={14} /></span>
      <span className="t" title={text}>{text}{dirty ? ' •' : ''}</span>
      <button className="icon-btn" title={tr('关闭')} aria-label={tr('关闭')} onClick={() => closeTile(paneId, tile.id)}><Icon name="close" size={16} /></button>
    </div>
  );
}

function currentCwd(pane: PaneModel, open: Record<string, { cwd: string }>): string {
  const t = pane.tiles.find((x) => x.id === pane.activeTileId) ?? pane.tiles[0];
  if (t?.kind === 'chat' && t.sessionId) return open[t.sessionId]?.cwd ?? '';
  if (t?.kind === 'term') return t.cwd;
  return localStorage.getItem('cw.lastCwd') ?? '';
}
