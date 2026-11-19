import { useMemo } from 'react';
import { NodeGraph } from '@/ui/node-graph/NodeGraph';
import { fullFit } from '@/ui/node-graph/viewport';
import type { NodeGraphData } from '@/ui/node-graph/schema';
import type { Picks } from '@/ui/node-graph/marks';
import { Viewer } from '@/ui/Viewer';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { tr } from '@/i18n';
// issue #17: a node graph from the conversation (a ```nodegraph block, a Mermaid flowchart's 节点图 view) as big as the
// window. A second NodeGraph of the same graph in ui/Viewer, fitted to the window when it opens; the reply's own graph
// stays where it is, untouched, with its own zoom. The dropdowns share the block's picks: a choice made here is there
// when the viewer closes (and 把改动发给 Claude picks it up).

/** the graph's canvas takes the focus when the viewer opens: + − 0 and the arrow keys work at once */
const canvasOf = (layer: HTMLElement) => layer.querySelector<HTMLElement>('.ng-viewport');

export function GraphFullscreen({ graph, label, picks, onPick, returnFocus, onClose }: {
  graph: NodeGraphData;
  label: string;
  picks?: Picks;
  onPick?: (key: string, value: string) => void;
  /** the 全屏查看 button: the focus goes back to it */
  returnFocus: HTMLElement;
  onClose: () => void;
}) {
  const fit = useMemo(() => fullFit(!!(graph.title || graph.subtitle || graph.badge)), [graph]);
  return (
    <Viewer label={label} onClose={onClose} returnFocus={returnFocus} initialFocus={canvasOf}>
      {/* a press on the dark margin around the canvas closes it, as around a picture in the image viewer — without its
          default action, which would otherwise move the focus to <body> right after the 全屏查看 button got it back */}
      <div className="viewer-stage ngv-stage" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }}>
        <ErrorBoundary area={tr('节点图')}>
          <NodeGraph graph={graph} ariaLabel={label} height="100%" fit={fit} picks={picks} onPick={onPick} />
        </ErrorBoundary>
      </div>
    </Viewer>
  );
}
