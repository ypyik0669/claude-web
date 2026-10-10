import { useEffect } from 'react';
import { Icon } from '@/ui/icons';
import { canZoom, changeZoom, refreshZoom, useZoomState } from '@/ui/zoom';
import { zoomChoices, zoomPercent } from '@/ui/zoom-math';
import { modKey } from '@/features/workbench/shortcuts';

/**
 * 设置 → 外观 → 界面缩放: − · the factor · +. The desktop app's whole-window zoom (every window, remembered; the same
 * thing as its Ctrl + / Ctrl − / Ctrl 0). In a browser there is nothing to set — the row's sentence says to use the
 * browser's own zoom — so this draws nothing there.
 */
export function ZoomControl({ label }: { label: string }) {
  const st = useZoomState();
  // the limit is the screen's: ask again when the page is opened (the window can have moved to another screen)
  useEffect(() => { refreshZoom(); }, []);
  if (!canZoom) return null;
  const choices = zoomChoices(st.steps, st);
  return (
    <div className="zoomer" role="group" aria-label={label} data-zoom={st.zoom}>
      <button className="icon-btn" aria-label="缩小界面" title={`缩小（${modKey} −）`} disabled={st.zoom <= st.min} onClick={() => changeZoom('out')}><Icon name="minus" size={15} /></button>
      <select className="field" aria-label={`${label}比例`} title={`还原到 100%：${modKey} 0`} value={String(st.zoom)} onChange={(e) => changeZoom(Number(e.target.value))}>
        {choices.map((z) => <option key={z} value={String(z)}>{zoomPercent(z)}</option>)}
      </select>
      <button className="icon-btn" aria-label="放大界面" title={`放大（${modKey} +）`} disabled={st.zoom >= st.max} onClick={() => changeZoom('in')}><Icon name="plus" size={15} /></button>
    </div>
  );
}
