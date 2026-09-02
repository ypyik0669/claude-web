import { useRef, useState } from 'react';
import { useStore } from '@/store';
import { PaneContext } from '@/store/paneContext';
import { chatTile, type Pane as PaneModel, type Rect } from '@/model/layout';
import { clsx } from '@/util';
import { TabStrip } from './TabStrip';
import { Tile } from './Tile';
import { MIME_PANEL, MIME_SESSION, MIME_TILE, hasType, tilePayload, zoneAt, type DropZone } from './dnd';

export function Pane({ pane, groupId, index, rect, focused, zoomed, single, hidden }: { pane: PaneModel; groupId: string; index: number; rect: Rect; focused: boolean; zoomed: boolean; single: boolean; hidden: boolean }) {
  const dispatch = useStore((s) => s.dispatchLayout);
  const singleWindow = useStore((s) => !!s.settings['ui.singleWindow']);
  const [zone, setZone] = useState<DropZone | null>(null);
  const enter = useRef(0);
  const active = pane.tiles.find((t) => t.id === pane.activeTileId) ?? pane.tiles[0];
  const sessionId = active?.kind === 'chat' ? active.sessionId : active?.kind === 'diff' ? active.sessionId : null;

  const accepts = (dt: DataTransfer | null) => hasType(dt, MIME_SESSION) || hasType(dt, MIME_TILE) || hasType(dt, MIME_PANEL);
  const onDragOver = (e: React.DragEvent) => {
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    const z = singleWindow ? 'center' : zoneAt((e.currentTarget as HTMLElement).getBoundingClientRect(), e.clientX, e.clientY);
    if (z !== zone) setZone(z);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!accepts(e.dataTransfer)) return;
    e.preventDefault();
    enter.current = 0;
    const z = zone ?? 'center';
    setZone(null);
    const dir = z === 'left' || z === 'right' ? 'row' : 'col';
    const before = z === 'left' || z === 'top';
    const sid = e.dataTransfer.getData(MIME_SESSION);
    const tp = tilePayload(e.dataTransfer);
    const panel = e.dataTransfer.getData(MIME_PANEL);
    if (sid) {
      const tile = chatTile(sid);
      if (z === 'center') dispatch({ t: 'tile.open', paneId: pane.id, tile, mode: e.ctrlKey ? 'tab' : 'replace' });
      else dispatch({ t: 'pane.split', paneId: pane.id, dir, tile, before });
    } else if (tp) {
      if (tp.paneId === pane.id && z === 'center') return;
      if (z === 'center') dispatch({ t: 'tile.move', from: { paneId: tp.paneId, tileId: tp.tileId }, to: { paneId: pane.id } });
      else {
        // split first, then move the tile into the new pane
        const st = useStore.getState();
        st.dispatchLayout({ t: 'pane.split', paneId: pane.id, dir, before });
        const g = st.layout.groups.find((x) => x.id === groupId) ?? st.layout.groups[0];
        const newPane = useStore.getState().layout.groups.find((x) => x.id === g.id)!.focusedPaneId;
        useStore.getState().dispatchLayout({ t: 'tile.move', from: { paneId: tp.paneId, tileId: tp.tileId }, to: { paneId: newPane } });
      }
    } else if (panel) {
      const tile = { id: `t${Date.now()}`, kind: 'panel' as const, panel: panel as any };
      if (z === 'center') dispatch({ t: 'tile.open', paneId: pane.id, tile, mode: 'tab' });
      else dispatch({ t: 'pane.split', paneId: pane.id, dir, tile, before });
    }
  };
  const style: React.CSSProperties = { left: rect.x, top: rect.y, width: rect.w, height: rect.h, visibility: hidden ? 'hidden' : undefined };
  return (
    <PaneContext.Provider value={{ paneId: pane.id, tileId: active?.id ?? '', sessionId }}>
      <div
        className={clsx('pane', focused && 'focused', zoomed && 'zoomed')}
        style={style}
        onMouseDownCapture={() => !focused && dispatch({ t: 'pane.focus', paneId: pane.id })}
        onFocusCapture={() => !focused && dispatch({ t: 'pane.focus', paneId: pane.id })}
        onDragEnter={(e) => { if (accepts(e.dataTransfer)) { enter.current++; } }}
        onDragLeave={() => { enter.current = Math.max(0, enter.current - 1); if (!enter.current) setZone(null); }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        data-pane-id={pane.id}
      >
        <TabStrip pane={pane} groupId={groupId} index={index} zoomed={zoomed} single={single} />
        <div className="pane-content">
          {pane.tiles.map((t) => (
            <div key={t.id} className="tile-slot" style={{ display: t.id === active?.id ? undefined : 'none' }}>
              <PaneContext.Provider value={{ paneId: pane.id, tileId: t.id, sessionId: t.kind === 'chat' ? t.sessionId : t.kind === 'diff' ? t.sessionId : null }}>
                <Tile tile={t} paneId={pane.id} visible={t.id === active?.id && !hidden} />
              </PaneContext.Provider>
            </div>
          ))}
        </div>
        {zone && <div className={clsx('drop-hint', zone)} />}
      </div>
    </PaneContext.Provider>
  );
}
