import './node-graph.css';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Select } from '@/ui/Select';
import { Icon, ICON_NAMES, type IconName } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { wheelZoom } from '@/ui/wheel-zoom';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import type { NodeGraphProps } from './types';
import { dict, own, type NgNode } from './schema';
import { badgeView, edgeStyles, pickKey, pulses } from './marks';
import { edgeGeom, labelWidth, layoutNodes, moveBoxes, placeLabels, NG_BODY_PAD, NG_CARD_W, NG_HEAD_H, NG_LIST_HEAD, NG_LIST_ITEM, NG_ROW_H } from './layout';
import { entranceTimes, fitView, motionOn, NG_PAN_STEP, NG_ZOOM, PAN_KEYS, panToShow, zoomAt, zoomBy, type FitOpts, type View } from './viewport';
import { useReducedMotion } from './motion';
import { ZoomBar } from './ZoomBar';
// spec 2026-10-24 D1: the shared node graph — HTML cards (dropdowns, ellipsis, Tab focus) over one SVG layer of edges
// (glow, travelling dots, labels), in one transformed layer. Drag cards, drag the canvas, wheel / − + / fit zoom,
// double-click empty space to reset. Nothing here is saved (spec :409). Reads no store.

const EMPTY: Readonly<Record<string, string>> = {};
type Offsets = Record<string, { dx: number; dy: number }>;
interface Drag { kind: 'card' | 'pan'; id?: string; sx: number; sy: number; bx: number; by: number; moved: boolean; px: number; py: number }

function CardIcon({ n }: { n: NgNode }) {
  if (n.icon && (ICON_NAMES as string[]).includes(n.icon)) return <span className="ng-ic"><Icon name={n.icon as IconName} size={14} /></span>;
  if (n.icon && [...n.icon].length <= 2) return <span className="ng-ic">{n.icon}</span>;
  return <span className="ng-ic">{[...n.title][0]?.toUpperCase() ?? ''}</span>;
}

export function NodeGraph({ graph, ariaLabel, height = 360, cardW = NG_CARD_W, align = 'center', compact, entrance, selected, onSelect, canSelect, picks, onPick, className, fit, embedded, onFullscreen }: NodeGraphProps) {
  const placed = useMemo(() => layoutNodes(graph.nodes, graph.edges, { cardW, align }), [graph, cardW, align]);
  const [offsets, setOffsets] = useState<Offsets>(dict);
  const boxes = useMemo(() => moveBoxes(placed.boxes, offsets), [placed, offsets]);
  const styles = useMemo(() => edgeStyles(graph, picks ?? EMPTY), [graph, picks]);
  const badge = useMemo(() => badgeView(graph.badge, styles), [graph.badge, styles]);
  const rowIdx = useMemo(() => new Map(graph.nodes.map((n) => [n.id, new Map(n.rows.map((r, i) => [r.id, i]))])), [graph]);
  const geoms = useMemo(() => graph.edges.flatMap((e) => {
    const a = own(boxes, e.from), b = own(boxes, e.to);
    if (!a || !b) return [];
    const ri = e.fromRow ? rowIdx.get(e.from)?.get(e.fromRow) : undefined;
    return [{ e, g: edgeGeom(e.id, a, b, ri ?? null) }];
  }), [graph.edges, boxes, rowIdx]);
  const labelAt = useMemo(() => placeLabels(geoms.flatMap(({ e, g }) => (e.label ? [{ id: e.id, p: g.p, w: labelWidth(e.label) }] : []))), [geoms]);
  const reduced = useReducedMotion();
  const motion = motionOn(graph.nodes.length, graph.edges.length, reduced);
  const nodeKey = useMemo(() => graph.nodes.map((n) => n.id).join('\n'), [graph]);
  // the title / badge sit over the canvas: the fit keeps their row free (review D4); the zoom buttons' corner too
  const hasHead = !compact && !!(graph.title || graph.subtitle || badge);
  const fitOpts: FitOpts = { ...(hasHead ? { top: 56 } : {}), ...fit };
  const fitRef = useRef(fitOpts);
  fitRef.current = fitOpts;
  const embeddedRef = useRef(embedded);
  embeddedRef.current = embedded;
  const [onScreen, setOnScreen] = useState(true);

  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [box, setBox] = useState({ w: 0, h: 0 });
  const boxRef = useRef(box);
  boxRef.current = box;
  const touched = useRef(false);
  const fittedKey = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  const [panning, setPanning] = useState(false);
  const [playing, setPlaying] = useState(() => !!entrance && motion);
  const times = useMemo(() => entranceTimes(graph.nodes.length, graph.edges.length), [graph.nodes.length, graph.edges.length]);
  const selectable = (id: string) => !!onSelect && (canSelect ? canSelect(id) : true);

  // size: a hidden panel measures 0 — do nothing until it has one
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); setBox((b) => (b.w === r.width && b.h === r.height ? b : { w: r.width, h: r.height })); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // off screen (scrolled away in a long chat): the animations pause (review D-minor)
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { const e = es[es.length - 1]; if (e) setOnScreen(e.isIntersecting); });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // fit: the first time there is a size, or when the cards or the size change and the user has not zoomed / panned
  // yet. D2 / D3 pass a new graph object every second — the key (card ids + size) keeps that from refitting.
  useEffect(() => {
    if (box.w <= 0 || box.h <= 0) return;
    const key = `${nodeKey}\n${box.w}x${box.h}`;
    if (fittedKey.current !== null && (fittedKey.current === key || touched.current)) return;
    fittedKey.current = key;
    setView(fitView({ w: placed.width, h: placed.height }, box, fitRef.current));
  }, [box, nodeKey, placed.width, placed.height]);

  // dragged offsets survive a new graph object, but only for cards that still exist
  useEffect(() => {
    const ids = new Set(nodeKey.split('\n'));
    setOffsets((o) => { const keys = Object.keys(o); if (keys.every((k) => ids.has(k))) return o; const next: Offsets = dict(); for (const k of keys) if (ids.has(k)) next[k] = o[k]; return next; });
  }, [nodeKey]);

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setPlaying(false), times.total + 50);
    return () => clearTimeout(t);
  }, [playing, times.total]);

  // the wheel: non-passive (React's onWheel is passive), the shared A3 rule — Shift / at the limit → the page scrolls
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      // embedded in a scrolling column: not until the graph was clicked / focused — the page scrolls past it (review D5)
      if (embeddedRef.current && !rootRef.current?.contains(document.activeElement)) return;
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

  const refit = () => {
    touched.current = false;
    fittedKey.current = `${nodeKey}\n${boxRef.current.w}x${boxRef.current.h}`;
    setOffsets(dict());
    if (boxRef.current.w > 0 && boxRef.current.h > 0) setView(fitView({ w: placed.width, h: placed.height }, boxRef.current, fitRef.current));
  };

  const apply = () => {
    frame.current = 0;
    const d = drag.current;
    if (!d) return;
    const dx = d.px - d.sx, dy = d.py - d.sy;
    if (!d.moved && Math.hypot(dx, dy) <= 4) return;
    if (!d.moved) { d.moved = true; touched.current = true; if (d.kind === 'pan') setPanning(true); }
    if (d.kind === 'card' && d.id) {
      const s = viewRef.current.scale, id = d.id;
      setOffsets((o) => Object.assign(dict<{ dx: number; dy: number }>(), o, { [id]: { dx: d.bx + dx / s, dy: d.by + dy / s } }));
    } else {
      setView((v) => ({ ...v, x: d.bx + dx, y: d.by + dy }));
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.select-trigger, button, a, input, select, textarea, .select-popover')) return;
    const card = t.closest<HTMLElement>('.ng-card');
    const id = card?.dataset.node;
    if (id) {
      const o = own(offsets, id) ?? { dx: 0, dy: 0 };
      drag.current = { kind: 'card', id, sx: e.clientX, sy: e.clientY, bx: o.dx, by: o.dy, moved: false, px: e.clientX, py: e.clientY };
    } else {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, bx: view.x, by: view.y, moved: false, px: e.clientX, py: e.clientY };
    }
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
    // pointerup, not onClick: the end of a drag never selects
    if (!d.moved && d.kind === 'card' && d.id && selectable(d.id)) onSelect!(d.id);
  };
  const onPointerCancel = () => { drag.current = null; setPanning(false); };

  // the canvas or a card has the focus (not a dropdown in a card): + − 0 zoom / refit, arrow keys pan (review D-minor)
  const onViewportKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (imeComposing(e.nativeEvent) || e.altKey || e.ctrlKey || e.metaKey || (t !== e.currentTarget && !t.classList.contains('ng-card'))) return;
    const pan = PAN_KEYS.get(e.key);
    if (e.key === '+' || e.key === '=') { e.preventDefault(); touched.current = true; setView((v) => zoomBy(v, 1, boxRef.current)); }
    else if (e.key === '-') { e.preventDefault(); touched.current = true; setView((v) => zoomBy(v, -1, boxRef.current)); }
    else if (e.key === '0') { e.preventDefault(); refit(); }
    else if (pan) { e.preventDefault(); touched.current = true; setView((v) => ({ ...v, x: v.x + pan[0] * NG_PAN_STEP, y: v.y + pan[1] * NG_PAN_STEP })); }
  };
  // review D6: Tab onto a card out of view pans to it (a click does not move the view)
  const onCardFocus = (id: string) => (e: ReactFocusEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !e.currentTarget.matches(':focus-visible')) return;
    const b = own(boxes, id);
    if (b) setView((v) => panToShow(v, b, boxRef.current, fitRef.current));
  };
  const onCardKey = (id: string) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (imeComposing(e.nativeEvent) || e.target !== e.currentTarget) return;
    if ((e.key === 'Enter' || e.key === ' ') && selectable(id)) { e.preventDefault(); onSelect!(id); }
  };
  const zoomButton = (dir: 1 | -1) => { touched.current = true; setView((v) => zoomBy(v, dir, boxRef.current)); };

  const rootStyle = {
    height,
    backgroundPosition: `${view.x}px ${view.y}px`,
    backgroundSize: `${18 * view.scale}px ${18 * view.scale}px`,
    '--ng-head-h': `${NG_HEAD_H}px`, '--ng-row-h': `${NG_ROW_H}px`, '--ng-body-pad': `${NG_BODY_PAD}px`, '--ng-list-head': `${NG_LIST_HEAD}px`, '--ng-list-item': `${NG_LIST_ITEM}px`,
  } as CSSProperties;

  return (
    <div ref={rootRef} className={clsx('ng', compact && 'compact', className)} data-motion={motion ? 'on' : 'off'} data-offscreen={onScreen ? undefined : ''} role="group" aria-label={ariaLabel} style={rootStyle}>
      {(graph.title || graph.subtitle) && (
        <div className="ng-head">
          {graph.title && <div className="ng-title">{graph.title}</div>}
          {graph.subtitle && <div className="ng-sub">{graph.subtitle}</div>}
        </div>
      )}
      {badge && <div className="ng-badge" data-tone={badge.tone} role="status" aria-live="polite">{badge.tone === 'ok' && <Icon name="check" size={12} />}{badge.text}</div>}
      <div ref={vpRef} className={clsx('ng-viewport', panning && 'panning')} tabIndex={0} aria-label={tr('节点图')} title={tr('拖动画布平移，滚轮缩放，双击空白恢复布局')}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onKeyDown={onViewportKey}
        onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('.ng-card')) refit(); }}>
        <div className="ng-layer" style={{ width: placed.width, height: placed.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="ng-edges" width={placed.width} height={placed.height} aria-hidden="true">
            {geoms.map(({ e, g }, i) => {
              const st = own(styles, e.id) ?? e.style;
              const glow = st === 'strong' || st === 'error';
              const lw = e.label ? labelWidth(e.label) : 0;
              const at = own(labelAt, e.id) ?? g.mid;
              return (
                <g key={e.id} className={clsx('ng-edge', playing && 'ng-in')} data-edge={e.id} data-style={st}
                  style={{ '--len': Math.ceil(g.len), animationDelay: playing ? `${times.edge(i)}ms` : undefined } as CSSProperties}>
                  {glow && <path className="ng-glow" d={g.d} />}
                  <path className="ng-line" d={g.d} />
                  {motion && onScreen && pulses(e, st) && (
                    <circle className="ng-pulse" r={3.5}>
                      <animateMotion dur={`${Math.max(1.2, g.len / 140).toFixed(2)}s`} repeatCount="indefinite" path={g.d} />
                    </circle>
                  )}
                  {e.label && (
                    <g className="ng-label">
                      <rect x={at.x - lw / 2} y={at.y - 9} width={lw} height={18} rx={9} />
                      <text x={at.x} y={at.y} textAnchor="middle" dy="0.35em">{e.label}</text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
          {graph.nodes.map((n, i) => {
            const b = own(boxes, n.id);
            if (!b) return null;
            const can = selectable(n.id);
            return (
              <div key={n.id} className={clsx('ng-card', playing && 'ng-in', selected === n.id && 'sel')} data-node={n.id} data-state={n.state}
                tabIndex={can ? 0 : -1} role={can ? 'button' : 'group'} aria-label={n.title} title={n.tip} onKeyDown={onCardKey(n.id)} onFocus={onCardFocus(n.id)}
                style={{ left: b.x, top: b.y, width: b.w, height: b.h, '--c': n.accent, animationDelay: playing ? `${times.card(i)}ms` : undefined } as CSSProperties}>
                <div className="ng-card-h">
                  <CardIcon n={n} />
                  <div className="ng-tx">
                    <div className="ng-t">{n.title}</div>
                    {n.subtitle && <div className="ng-s">{n.subtitle}</div>}
                  </div>
                </div>
                {n.rows.length > 0 && (
                  <div className="ng-rows">
                    {n.rows.map((r) => {
                      const key = pickKey(n.id, r.id);
                      return (
                        <div key={r.id} className="ng-row" data-row={r.id}>
                          <span className="k">{r.label}</span>
                          {onPick && r.options.length
                            ? <Select className="ng-sel" value={picks?.[key] ?? r.value} options={r.options.map((o) => ({ value: o.value, label: o.label }))} onValueChange={(v) => onPick(key, String(v))} label={r.label} />
                            : <span className="v">{r.value}</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
                {n.list && (
                  <div className="ng-list">
                    <div className="ng-list-h">{n.list.title}</div>
                    {n.list.items.map((it, k) => (
                      <div key={k} className="ng-li"><span>{it.text}</span>{it.tags.map((t, m) => <span key={m} className="ng-tag">{t}</span>)}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <ZoomBar scale={view.scale} onZoom={zoomButton} onFit={refit} onFullscreen={onFullscreen} />
    </div>
  );
}
