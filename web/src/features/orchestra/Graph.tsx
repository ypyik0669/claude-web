import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeRun, OrchNode } from '@shared';
import { LazyNodeGraph } from '@/ui/node-graph';
import { useColumnFit } from '@/ui/node-graph/useColumnFit';
import { ORCH_CARD_W, ORCH_FIT, orchestraGraph } from './orch-graph';
import { tr } from '@/i18n';
export { kindIcon, STATE_L } from './orch-graph';

const LAYOUT = { cardW: ORCH_CARD_W, align: 'top' } as const;

/**
 * Execution graph (spec 2026-10-24 D3): the run view and the editor preview share the node graph; columns are the
 * same topological layers as before. `runs` gives cards their state (the running step glows, the edge into it is
 * strong, a failed one red); without it the graph is a plain preview. Review D5: fitted to the panel's width down to
 * 50 % (then it pans), as tall as that scale needs; the wheel zooms only once the graph was clicked.
 */
export function Graph({ nodes, runs, selected, onSelect }: { nodes: OrchNode[]; runs?: Record<string, NodeRun>; selected?: string | null; onSelect?: (id: string) => void }) {
  const live = !!runs && Object.values(runs).some((r) => r.state === 'running');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!live) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [live]);
  const graph = useMemo(() => orchestraGraph(nodes, runs, now), [nodes, runs, now]);
  const box = useRef<HTMLDivElement>(null);
  const { height, fit } = useColumnFit(box, graph.nodes, graph.edges, ORCH_FIT, LAYOUT);
  // the same div either way (React keeps the element): the width is measured from the first render on
  if (!nodes.length) return <div className="orch-graph empty" ref={box}>{tr('还没有节点')}</div>;
  return (
    <div className="orch-graph" ref={box}>
      <LazyNodeGraph graph={graph} ariaLabel={tr('执行图')} height={height} fit={fit} embedded cardW={ORCH_CARD_W} align="top" entrance selected={selected ?? null} onSelect={onSelect} />
    </div>
  );
}
