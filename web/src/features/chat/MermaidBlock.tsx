import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from '@/util';
import { NodeGraph } from '@/ui/node-graph/NodeGraph';
import { PanZoom } from '@/ui/node-graph/PanZoom';
import { FullscreenButton } from '@/ui/node-graph/ZoomBar';
import { flowchartToGraph, isFlowchart } from '@/ui/node-graph/mermaid-flow';
import { svgSize } from '@/ui/node-graph/svg-size';
import { chatFit, fullFit } from '@/ui/node-graph/viewport';
import { useColumnFit } from '@/ui/node-graph/useColumnFit';
import type { NgEdge, NgNode } from '@/ui/node-graph/schema';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { Viewer } from '@/ui/Viewer';
import { tr } from '@/i18n';
import { GraphFullscreen } from './GraphFullscreen';

const NONE: { nodes: NgNode[]; edges: NgEdge[] } = { nodes: [], edges: [] };
let seq = 0;
let inited: string | null = null;

async function getMermaid(theme: string) {
  const m = (await import('mermaid')).default;
  if (inited !== theme) {
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'light' || theme === 'paper' ? 'default' : 'dark', fontFamily: 'inherit' });
    inited = theme;
  }
  return m;
}
const themeNow = () => document.documentElement.dataset.theme ?? 'dark';

/** a picture whose size cannot be read (no viewBox, no px size): fitted as if it were this big */
const SOME_SIZE = { w: 800, h: 600 };

/**
 * issue #17: Mermaid's own picture (the 原图 view) as big as the window, on the node graph's canvas — drag, wheel, − +,
 * fit. Drawn again under a fresh id: a second copy of the reply's SVG would repeat its ids, and the markers / styles
 * inside it would be looked up in the first one.
 */
function MermaidFullscreen({ source, returnFocus, onClose }: { source: string; returnFocus: HTMLElement; onClose: () => void }) {
  const [pic, setPic] = useState<{ svg: string; w: number; h: number } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    getMermaid(themeNow())
      .then((m) => m.render(`mmd-${++seq}`, source))
      .then(({ svg }) => { if (alive) setPic({ svg, ...(svgSize(svg) ?? SOME_SIZE) }); })
      .catch((e) => { if (alive) setErr(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [source]);
  const content = useMemo(() => (pic ? { w: pic.w, h: pic.h } : SOME_SIZE), [pic]);
  const fit = useMemo(() => fullFit(false), []);
  const label = tr('Mermaid 图');
  return (
    <Viewer label={label} onClose={onClose} returnFocus={returnFocus}>
      <div className="viewer-stage ngv-stage" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }}>
        {pic
          ? <PanZoom content={content} label={label} fit={fit} autoFocus><div className="pz-pic" dangerouslySetInnerHTML={{ __html: pic.svg }} /></PanZoom>
          : err
            ? <pre className="code-body ngv-err">mermaid: {err}</pre>
            : <div className="ngv-wait" role="status"><span className="spinner" />{tr('加载中…')}</div>}
      </div>
    </Viewer>
  );
}

/**
 * Lazy mermaid renderer for ```mermaid fences. Only mounted once the block has finished streaming.
 * spec 2026-10-24 D4: a flowchart the node graph can read opens as 节点图, with 原图 one click away.
 * issue #17: both views open full-window — the 节点图 from its zoom buttons, the 原图 from a button in its corner.
 */
export default function MermaidBlock({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  // the 原图 is in place (its 全屏查看 shows from then on)
  const [drawn, setDrawn] = useState(false);
  const flow = useMemo(() => (isFlowchart(source) ? flowchartToGraph(source) : null), [source]);
  const [view, setView] = useState<'graph' | 'raw'>(() => (flow?.ok ? 'graph' : 'raw'));
  const graphOn = view === 'graph' && !!flow?.ok;
  // review D4: sized like a ```nodegraph block — the reply's width sets the scale, the height follows
  const wrap = useRef<HTMLDivElement>(null);
  const fg = flow?.ok ? flow.graph : NONE;
  const { height, fit } = useColumnFit(wrap, fg.nodes, fg.edges, chatFit(false));
  // issue #17: which view is open full-window, and the 全屏查看 button that opened it (the focus goes back there)
  const [full, setFull] = useState<{ view: 'graph' | 'raw'; from: HTMLElement } | null>(null);
  const openGraph = useCallback((from: HTMLElement) => setFull({ view: 'graph', from }), []);
  const openRaw = useCallback((from: HTMLElement) => setFull({ view: 'raw', from }), []);
  const closeFull = useCallback(() => setFull(null), []);
  useEffect(() => {
    if (graphOn) return;
    let alive = true;
    setDrawn(false);
    getMermaid(themeNow())
      .then(async (m) => {
        const id = `mmd-${++seq}`;
        const { svg } = await m.render(id, source);
        if (alive && ref.current) { ref.current.innerHTML = svg; setErr(''); setDrawn(true); }
      })
      .catch((e) => alive && setErr(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [source, graphOn]);
  // the reply's 节点图 keeps its own zoom / pan: the same element while the viewer opens and closes, React leaves it be
  const inlineGraph = useMemo(() => (graphOn && flow?.ok
    ? <NodeGraph graph={flow.graph} ariaLabel={tr('流程图')} height={height} fit={fit} embedded className="ng-mermaid" onFullscreen={openGraph} />
    : null), [graphOn, flow, height, fit, openGraph]);
  return (
    <div className="mermaid-wrap" ref={wrap}>
      {flow?.ok && (
        <div className="mmd-view" role="group" aria-label={tr('显示方式')}>
          <button type="button" className={clsx('btn sm', view === 'graph' && 'on')} aria-pressed={view === 'graph'} data-view="graph" onClick={() => setView('graph')}>{tr('节点图')}</button>
          <button type="button" className={clsx('btn sm', view === 'raw' && 'on')} aria-pressed={view === 'raw'} data-view="raw" onClick={() => setView('raw')}>{tr('原图')}</button>
        </div>
      )}
      {inlineGraph
        ? <ErrorBoundary area={tr('节点图')}>{inlineGraph}</ErrorBoundary>
        : (
          <div className="mmd-raw">
            <div ref={ref} className="mermaid-svg" />
            {drawn && !err && <div className="ng-zoom mmd-tools"><FullscreenButton onOpen={openRaw} /></div>}
          </div>
        )}
      {err && !graphOn && <pre className="code-body" style={{ color: 'var(--red)' }}>mermaid: {err}{'\n'}{source}</pre>}
      {full?.view === 'graph' && flow?.ok && <GraphFullscreen graph={flow.graph} label={tr('流程图')} returnFocus={full.from} onClose={closeFull} />}
      {full?.view === 'raw' && <MermaidFullscreen source={source} returnFocus={full.from} onClose={closeFull} />}
    </div>
  );
}
