import { useState } from 'react';
import { useStore } from '@/store';
import { chatTile, paneOrder, activeGroup, MAX_PANES, type Pane as PaneModel, type Tile } from '@/model/layout';
import { clsx, basename } from '@/util';
import { MIME_TILE, hasType, tilePayload } from './dnd';

const PANEL_TITLES: Record<string, string> = { tasks: '任务', files: '文件改动', usage: '用量', config: '配置中心', terminal: '终端', inspector: '详情', mission: '总览' };

export function tileTitle(t: Tile, sessions: { sessionId: string; title: string }[]): { icon: string; text: string } {
  if (t.title) return { icon: iconFor(t), text: t.title };
  switch (t.kind) {
    case 'chat': return { icon: '◌', text: t.sessionId ? sessions.find((s) => s.sessionId === t.sessionId)?.title ?? t.sessionId.slice(0, 8) : '新会话' };
    case 'doc': return { icon: '📄', text: basename(t.path) };
    case 'diff': return { icon: '±', text: basename(t.path) };
    case 'term': return { icon: '▣', text: `终端 · ${basename(t.cwd) || t.cwd}` };
    case 'panel': return { icon: '▤', text: PANEL_TITLES[t.panel] ?? t.panel };
  }
}
function iconFor(t: Tile) {
  return t.kind === 'chat' ? '◌' : t.kind === 'doc' ? '📄' : t.kind === 'diff' ? '±' : t.kind === 'term' ? '▣' : '▤';
}

/** Tabs of one pane: click / middle-click close / double-click rename / drag reorder & move / ＋ menu / split & zoom buttons. */
export function TabStrip({ pane, groupId, index, zoomed, single }: { pane: PaneModel; groupId: string; index: number; zoomed: boolean; single: boolean }) {
  const dispatch = useStore((s) => s.dispatchLayout);
  const closeTile = useStore((s) => s.closeTile);
  const dirty = useStore((s) => s.dirtyDocs);
  const sessions = useStore((s) => s.sessions);
  const open = useStore((s) => s.open);
  const singleWindow = useStore((s) => !!s.settings['ui.singleWindow']);
  const layout = useStore((s) => s.layout);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState(false);
  const [over, setOver] = useState<number | null>(null);
  const paneCount = paneOrder(activeGroup(layout).root).length;
  const canSplit = !singleWindow && paneCount < MAX_PANES;

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
      <span className="pane-idx" title={`窗格 ${index + 1}（Alt+${index + 1}）`}>{index + 1}</span>
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
              title={`${text}\n双击重命名 · 中键关闭 · 可拖到别的窗格`}
            >
              {live && live !== 'history' && live !== 'closed' && <span className={clsx('dot', live)} />}
              {!live && <span className="ic">{icon}</span>}
              {renaming === t.id ? (
                <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commitRename} onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }} onClick={(e) => e.stopPropagation()} />
              ) : (
                <span className="t">{text}{dirty[t.id] ? ' •' : ''}</span>
              )}
              <button className="x" title="关闭" onClick={(e) => { e.stopPropagation(); closeTile(pane.id, t.id); }}>✕</button>
            </div>
          );
        })}
        <span style={{ position: 'relative' }}>
          <button className="tab-add" title="新标签" onClick={() => setMenu(!menu)}>＋</button>
          {menu && (
            <div className="menu" style={{ top: 26, left: 0 }} onMouseLeave={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); dispatch({ t: 'tile.open', paneId: pane.id, tile: chatTile(null), mode: 'tab' }); }}>◌ 新会话</button>
              <button onClick={() => { setMenu(false); const cwd = currentCwd(pane, open); dispatch({ t: 'tile.open', paneId: pane.id, tile: { id: `t${Date.now()}`, kind: 'term', cwd }, mode: 'tab' }); }}>▣ 终端</button>
              {(['mission', 'goals', 'tasks', 'files', 'usage', 'config', 'inspector', 'android'] as const).map((p) => (
                <button key={p} onClick={() => { setMenu(false); dispatch({ t: 'tile.open', paneId: pane.id, tile: { id: `t${Date.now()}`, kind: 'panel', panel: p }, mode: 'tab' }); }}>▤ {PANEL_TITLES[p]}</button>
              ))}
            </div>
          )}
        </span>
      </div>
      <span className="grow" />
      {canSplit && <button className="icon-btn" title="向右分屏 (Ctrl+D)" onClick={() => dispatch({ t: 'pane.split', paneId: pane.id, dir: 'row' })}>◫</button>}
      {canSplit && <button className="icon-btn" title="向下分屏 (Ctrl+Shift+D)" onClick={() => dispatch({ t: 'pane.split', paneId: pane.id, dir: 'col' })}>⬓</button>}
      {!single && <button className={clsx('icon-btn', zoomed && 'active')} title={zoomed ? '还原 (Ctrl+Shift+Enter)' : '缩放此窗格 (Ctrl+Shift+Enter)'} onClick={() => dispatch({ t: 'pane.zoom', paneId: zoomed ? null : pane.id })}>{zoomed ? '⤡' : '⤢'}</button>}
      {!single && <button className="icon-btn" title="关闭窗格" onClick={() => dispatch({ t: 'pane.close', paneId: pane.id })}>✕</button>}
    </div>
  );
}

function currentCwd(pane: PaneModel, open: Record<string, { cwd: string }>): string {
  const t = pane.tiles.find((x) => x.id === pane.activeTileId) ?? pane.tiles[0];
  if (t?.kind === 'chat' && t.sessionId) return open[t.sessionId]?.cwd ?? '';
  if (t?.kind === 'term') return t.cwd;
  return localStorage.getItem('cw.lastCwd') ?? '';
}
