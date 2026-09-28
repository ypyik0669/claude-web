import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store';
import { activeGroup, layoutRects, paneOrder, type PaneNode, type Rect } from '@/model/layout';
import { Pane } from './Pane';
import { Splitter } from './Splitter';
import { clsx } from '@/util';

const GAP = 6;

/** Parent rects for each split (so the splitter can convert pointer position → ratio). */
function splitParents(root: PaneNode, rect: Rect, out: Record<string, Rect> = {}): Record<string, Rect> {
  if (root.type === 'leaf') return out;
  out[root.id] = rect;
  const l = layoutRects(root, rect, GAP, null);
  const sub = (n: PaneNode): Rect => {
    const ids = paneOrder(n);
    const rs = ids.map((id) => l.panes[id]);
    const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
    const x2 = Math.max(...rs.map((r) => r.x + r.w)), y2 = Math.max(...rs.map((r) => r.y + r.h));
    return { x, y, w: x2 - x, h: y2 - y };
  };
  splitParents(root.a, sub(root.a), out);
  splitParents(root.b, sub(root.b), out);
  return out;
}

/**
 * Renders every pane of the active group absolutely positioned. Panes are never unmounted by split / move / zoom
 * (only by close), so xterm buffers, scroll positions and composer drafts survive layout changes.
 */
export function PaneLayer({ tabStrips, underGroupBar, workbench }: { tabStrips: Record<string, boolean>; underGroupBar: boolean; workbench: boolean }) {
  const layout = useStore((s) => s.layout);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // measured before paint so tiles never mount at 0×0 (the composer's autosize would read a bogus scrollHeight)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const g = activeGroup(layout);
  const rect: Rect = { x: 0, y: 0, w: size.w, h: size.h };
  const rects = useMemo(() => layoutRects(g.root, rect, GAP, g.zoomedPaneId), [g.root, g.zoomedPaneId, size.w, size.h]);
  const parents = useMemo(() => splitParents(g.root, rect), [g.root, size.w, size.h]);
  const order = paneOrder(g.root);
  // which window edges each pane touches: its first row doubles as the title bar there (drag region, caption-button
  // gap on the right, sidebar reveal / traffic-light gap on the left)
  const edges = (r: Rect) => ({ top: !underGroupBar && r.y <= 0, left: r.x <= 0, right: r.x + r.w >= size.w - 1 });
  return (
    <div className={clsx('pane-layer', order.length > 1 && !g.zoomedPaneId && 'multi')} ref={ref}>
      {size.w > 0 && order.map((id, i) => (
        <Pane key={id} pane={g.panes[id]} groupId={g.id} index={i} rect={rects.panes[id]} edges={edges(rects.panes[id])} strip={!!tabStrips[id]} workbench={workbench} paneCount={order.length} focused={g.focusedPaneId === id} zoomed={g.zoomedPaneId === id} single={order.length === 1} hidden={!!g.zoomedPaneId && g.zoomedPaneId !== id} />
      ))}
      {Object.entries(parents).map(([sid, r]) => <span key={sid} data-split-parent={sid} data-x={r.x} data-y={r.y} data-w={r.w} data-h={r.h} hidden />)}
      {rects.splitters.map((sp) => <Splitter key={sp.id} id={sp.id} dir={sp.dir} rect={sp.rect} container={() => ref.current?.getBoundingClientRect() ?? null} />)}
    </div>
  );
}
