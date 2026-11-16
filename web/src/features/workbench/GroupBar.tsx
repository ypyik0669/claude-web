import { useRef, useState } from 'react';
import { useOpenSettled, useStore } from '@/store';
import { useDropdown } from '@/ui/menus';
import { imeComposing } from '@/ui/ime';
import { paneOrder, type LayoutPreset } from '@/model/layout';
import { clsx } from '@/util';
import { desktop } from '@/desktop';
import { MIME_SESSION, MIME_TILE, hasType, tilePayload } from './dnd';
import { offerGroupToNewWindow } from './windows';
import { Icon, type IconName } from '@/ui/icons';
import { SidebarReveal } from './pane-edge';
import { tr } from '@/i18n';

const PRESETS: { id: LayoutPreset; l: string; ic: IconName }[] = [
  { id: 'single', l: tr('不分屏'), ic: 'circle' as const },
  { id: 'cols2', l: tr('左右两栏'), ic: 'splitRight' as const },
  { id: 'cols3', l: tr('三栏'), ic: 'board' as const },
  { id: 'grid2x2', l: tr('四宫格'), ic: 'zoom' as const },
  { id: 'mainSide', l: tr('主 + 侧'), ic: 'sidebar' as const },
];

/**
 * Group tabs (Mirasim's "分组"): each group is an independent pane tree; drag a tile or session onto a tab to move it
 * there. Shown only with more than one group or in workbench mode (`chromeVisibility`); it is then the window's top
 * row. (The row of panel icons it carried in workbench mode is gone — structure round 2: the panels are behind the
 * icon rail's ··· and the right panel's own 更多.)
 */
export function GroupBar() {
  const layout = useStore((s) => s.layout);
  const dispatch = useStore((s) => s.dispatchLayout);
  const open = useOpenSettled(); // not for each frame of a stream
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [presets, setPresets] = useState(false);
  const presetBox = useRef<HTMLSpanElement>(null);
  // one anchored menu app-wide (polish P2): also closes on a click outside, Esc, another menu opening
  useDropdown(presets, () => setPresets(false), presetBox);
  const [over, setOver] = useState<string | null>(null);
  const commit = () => { if (renaming && draft.trim()) dispatch({ t: 'group.rename', id: renaming, name: draft.trim() }); setRenaming(null); };
  const busy = (gid: string) => {
    const g = layout.groups.find((x) => x.id === gid);
    if (!g) return false;
    return Object.values(g.panes).some((p) => p.tiles.some((t) => t.kind === 'chat' && t.sessionId && (open[t.sessionId]?.state === 'running' || open[t.sessionId]?.state === 'waiting')));
  };
  const onDrop = (e: React.DragEvent, gid: string) => {
    setOver(null);
    const tp = tilePayload(e.dataTransfer);
    const sid = e.dataTransfer.getData(MIME_SESSION);
    const g = layout.groups.find((x) => x.id === gid)!;
    if (tp) {
      e.preventDefault();
      if (tp.groupId === gid) return;
      dispatch({ t: 'tile.move', from: { paneId: tp.paneId, tileId: tp.tileId }, to: { paneId: g.focusedPaneId } });
      dispatch({ t: 'group.activate', id: gid });
    } else if (sid) {
      e.preventDefault();
      dispatch({ t: 'group.activate', id: gid });
      useStore.getState().openInPane(sid, 'tab', g.focusedPaneId);
    }
  };
  return (
    <div className="groupbar">
      <SidebarReveal />
      <div className="gtabs">
      {layout.groups.map((g, i) => (
        <div
          key={g.id}
          className={clsx('gtab', g.id === layout.activeGroupId && 'active', over === g.id && 'over')}
          onClick={() => dispatch({ t: 'group.activate', id: g.id })}
          onDoubleClick={() => { setRenaming(g.id); setDraft(g.name); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); dispatch({ t: 'group.close', id: g.id }); } }}
          onDragOver={(e) => { if (hasType(e.dataTransfer, MIME_TILE) || hasType(e.dataTransfer, MIME_SESSION)) { e.preventDefault(); setOver(g.id); } }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => onDrop(e, g.id)}
          title={tr('{name} · {paneOrderCount} 个分屏 · 双击重命名 · 中键关闭 · {v}+{i}', { name: g.name, paneOrderCount: paneOrder(g.root).length, v: desktop ? 'Ctrl' : 'Ctrl+Alt', i: i + 1 })}
        >
          {busy(g.id) && <span className="dot running" />}
          {renaming === g.id ? (
            <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (imeComposing(e.nativeEvent)) return; if (e.key === 'Enter') commit(); if (e.key === 'Escape') setRenaming(null); }} onClick={(e) => e.stopPropagation()} />
          ) : (
            <span className="t">{g.name}</span>
          )}
          {layout.groups.length > 1 && <button className="x" title={tr('关闭分组')} onClick={(e) => { e.stopPropagation(); dispatch({ t: 'group.close', id: g.id }); }} aria-label={tr('关闭分组')}><Icon name="close" size={11} /></button>}
        </div>
      ))}
      <button className="icon-btn" title={tr('新分组')} aria-label={tr('新分组')} onClick={() => dispatch({ t: 'group.new' })}><Icon name="plus" size={15} /></button>
      </div>
      <span className="grow" />
      <span ref={presetBox} style={{ position: 'relative' }}>
        <button className="icon-btn" title={tr('布局预设')} aria-label={tr('布局预设')} aria-haspopup="menu" aria-expanded={presets} onClick={() => setPresets(!presets)}><Icon name="zoom" size={15} /></button>
        {presets && (
          <div className="menu" role="menu" aria-label={tr('布局预设')} style={{ right: 0, top: 26 }} onMouseLeave={() => setPresets(false)}>
            {PRESETS.map((p) => <button key={p.id} onClick={() => { setPresets(false); dispatch({ t: 'pane.preset', preset: p.id }); }}><Icon name={p.ic} size={13} /> {p.l}</button>)}
            <button onClick={() => { setPresets(false); dispatch({ t: 'pane.even' }); }}><Icon name="splitRight" size={13} /> {tr('均分所有分屏')}</button>
          </div>
        )}
      </span>
      {desktop && <button className="icon-btn" title={tr('在新窗口打开当前分组 (Ctrl+Shift+N)')} onClick={() => void offerGroupToNewWindow(layout.activeGroupId)} aria-label={tr('新窗口打开分组')}><Icon name="external" size={15} /></button>}
    </div>
  );
}
