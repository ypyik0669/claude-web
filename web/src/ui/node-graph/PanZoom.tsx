import './node-graph.css';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { imeComposing } from '@/ui/ime';
import { wheelZoom } from '@/ui/wheel-zoom';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import { fitView, NG_PAN_STEP, NG_ZOOM, PAN_KEYS, zoomAt, zoomBy, type FitOpts, type Size, type View } from './viewport';
import { ZoomBar } from './ZoomBar';
// issue #17: the node graph's canvas for a picture that is not a node graph — the raw Mermaid view in the fullscreen
// viewer. The same gestures and buttons (viewport.ts, ZoomBar): drag to pan, wheel / − + to zoom, 适应窗口, + − 0 and the
// arrow keys on the focused canvas, a double-click fits it again. Fitted when it gets a size, and again when the size
// changes until the user zoomed or panned.

interface Drag { sx: number; sy: number; bx: number; by: number; px: number; py: number; moved: boolean }

export function PanZoom({ content, label, fit, autoFocus, className, children }: {
  /** the picture's own size (svg-size.ts) */
  content: Size;
  label: string;
  fit?: FitOpts;
  /** take the focus when it appears, unless something in the viewer has it already */
  autoFocus?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [box, setBox] = useState<Size>({ w: 0, h: 0 });
  const boxRef = useRef(box);
  boxRef.current = box;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const touched = useRef(false);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setBox((b) => (b.w === r.width && b.h === r.height ? b : { w: r.width, h: r.height })); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (box.w <= 0 || box.h <= 0 || touched.current) return;
    setView(fitView(content, box, fitRef.current));
  }, [box, content]);

  // the wheel: non-passive (React's onWheel is passive), the shared A3 rule (Shift / at the limit → not taken)
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      const v = viewRef.current;
      const next = wheelZoom(v.scale, e, NG_ZOOM);
      if (next === null) return;
      e.preventDefault();
      touched.current = true;
      const r = el.getBoundingClientRect();
      setView(zoomAt(v, next, { x: e.clientX - r.left, y: e.clientY - r.top }));
    };
    el.addEventListener('wheel', h, { passive: false });
    return () => el.removeEventListener('wheel', h);
  }, []);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  useEffect(() => {
    if (!autoFocus) return;
    const a = document.activeElement;
    if (!a || a === document.body || a === rootRef.current?.closest('[role="dialog"]')) vpRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const refit = () => {
    touched.current = false;
    const b = boxRef.current;
    if (b.w > 0 && b.h > 0) setView(fitView(content, b, fitRef.current));
  };
  const apply = () => {
    frame.current = 0;
    const d = drag.current;
    if (!d) return;
    const dx = d.px - d.sx, dy = d.py - d.sy;
    if (!d.moved && Math.hypot(dx, dy) <= 4) return;
    if (!d.moved) { d.moved = true; touched.current = true; setPanning(true); }
    setView((v) => ({ ...v, x: d.bx + dx, y: d.by + dy }));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    drag.current = { sx: e.clientX, sy: e.clientY, bx: viewRef.current.x, by: viewRef.current.y, px: e.clientX, py: e.clientY, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.px = e.clientX; d.py = e.clientY;
    if (!frame.current) frame.current = requestAnimationFrame(apply);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
    d.px = e.clientX; d.py = e.clientY;
    apply();
    drag.current = null;
    setPanning(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  const onPointerCancel = () => { drag.current = null; setPanning(false); };
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (imeComposing(e.nativeEvent) || e.altKey || e.ctrlKey || e.metaKey || e.target !== e.currentTarget) return;
    const pan = PAN_KEYS.get(e.key);
    if (e.key === '+' || e.key === '=') { e.preventDefault(); touched.current = true; setView((v) => zoomBy(v, 1, boxRef.current)); }
    else if (e.key === '-') { e.preventDefault(); touched.current = true; setView((v) => zoomBy(v, -1, boxRef.current)); }
    else if (e.key === '0') { e.preventDefault(); refit(); }
    else if (pan) { e.preventDefault(); touched.current = true; setView((v) => ({ ...v, x: v.x + pan[0] * NG_PAN_STEP, y: v.y + pan[1] * NG_PAN_STEP })); }
  };
  const zoomButton = (dir: 1 | -1) => { touched.current = true; setView((v) => zoomBy(v, dir, boxRef.current)); };

  const rootStyle = { height: '100%', backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${18 * view.scale}px ${18 * view.scale}px` } as CSSProperties;
  return (
    <div ref={rootRef} className={clsx('ng', 'pz', className)} role="group" aria-label={label} style={rootStyle}>
      <div ref={vpRef} className={clsx('ng-viewport', panning && 'panning')} tabIndex={0} aria-label={label} title={tr('拖动平移，滚轮缩放，双击适应窗口')}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onKeyDown={onKey} onDoubleClick={refit}>
        <div className="ng-layer" style={{ width: content.w, height: content.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>{children}</div>
      </div>
      <ZoomBar scale={view.scale} onZoom={zoomButton} onFit={refit} />
    </div>
  );
}
