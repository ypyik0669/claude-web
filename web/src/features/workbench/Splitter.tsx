import { useRef } from 'react';
import { useStore } from '@/store';
import type { Rect } from '@/model/layout';

/** Absolutely positioned split bar: drag to change the ratio, double-click to even out the subtree. */
export function Splitter({ id, dir, rect, container }: { id: string; dir: 'row' | 'col'; rect: Rect; container: () => DOMRect | null }) {
  const dispatch = useStore((s) => s.dispatchLayout);
  const drag = useRef<{ start: number; startRatio: number; span: number; a0: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    const c = container();
    if (!c) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // recover the parent split geometry from the splitter rect and the container: we only need the parent span
    // (parent rect is unknown here, so drive the ratio by pixel delta over the container span — good enough,
    // the reducer clamps to [0.1, 0.9])
    drag.current = { start: dir === 'row' ? e.clientX : e.clientY, startRatio: NaN, span: dir === 'row' ? c.width : c.height, a0: dir === 'row' ? rect.x - c.left : rect.y - c.top };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const cur = dir === 'row' ? e.clientX : e.clientY;
    const el = (e.target as HTMLElement).parentElement;
    const parent = el?.querySelector<HTMLElement>(`[data-split-parent="${id}"]`);
    // the pane layer stores each split's parent rect on a hidden marker element (see PaneLayer)
    if (parent) {
      const px = Number(parent.dataset.x), py = Number(parent.dataset.y), pw = Number(parent.dataset.w), ph = Number(parent.dataset.h);
      const c = container();
      if (!c) return;
      const pos = dir === 'row' ? cur - c.left - px : cur - c.top - py;
      const span = dir === 'row' ? pw : ph;
      dispatch({ t: 'pane.ratio', splitId: id, ratio: pos / Math.max(1, span) });
    } else {
      dispatch({ t: 'pane.ratio', splitId: id, ratio: (d.a0 + (cur - d.start)) / Math.max(1, d.span) });
    }
  };
  const onUp = (e: React.PointerEvent) => {
    drag.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  return (
    <div
      className={`splitter ${dir}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={() => dispatch({ t: 'pane.even', splitId: id })}
      title="拖动调整 · 双击均分"
    />
  );
}
