import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { pct } from './viewport';
// The node graph's zoom buttons (−  N%  +  适应窗口) — also under the picture canvas of the fullscreen viewer (PanZoom) —
// and issue #17's 全屏查看 after them when the owner offers it: the chat's ```nodegraph / Mermaid blocks do, the 后台
// 指挥台 and 编排 graphs do not (no `onFullscreen`, no button: their bar is what it was).

/** 全屏查看. Hands the button over, so the focus can go back to it when the viewer closes. */
export function FullscreenButton({ onOpen }: { onOpen: (from: HTMLElement) => void }) {
  return (
    <button type="button" className="ng-full" aria-label={tr('全屏查看')} title={tr('全屏查看')} aria-haspopup="dialog" onClick={(e) => onOpen(e.currentTarget)}>
      <Icon name="zoom" size={14} />
    </button>
  );
}

export function ZoomBar({ scale, onZoom, onFit, onFullscreen }: { scale: number; onZoom: (dir: 1 | -1) => void; onFit: () => void; onFullscreen?: (from: HTMLElement) => void }) {
  return (
    <div className="ng-zoom">
      <button type="button" className="ng-zoom-out" aria-label={tr('缩小')} title={tr('缩小')} onClick={() => onZoom(-1)}><Icon name="minus" size={14} /></button>
      <span className="ng-zoom-pct">{pct(scale)}</span>
      <button type="button" className="ng-zoom-in" aria-label={tr('放大')} title={tr('放大')} onClick={() => onZoom(1)}><Icon name="plus" size={14} /></button>
      <button type="button" className="ng-fit" aria-label={tr('适应窗口')} title={tr('适应窗口')} onClick={onFit}><Icon name="frame" size={14} /></button>
      {onFullscreen && <FullscreenButton onOpen={onFullscreen} />}
    </div>
  );
}
