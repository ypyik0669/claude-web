import { useCallback, useContext, useMemo, useRef, useState } from 'react';
import { NodeGraph } from '@/ui/node-graph/NodeGraph';
import { parseNodeGraph, type NgEdge, type NgNode } from '@/ui/node-graph/schema';
import { changeSentence, initialPicks } from '@/ui/node-graph/marks';
import { chatFit } from '@/ui/node-graph/viewport';
import { useColumnFit } from '@/ui/node-graph/useColumnFit';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { insertInComposer } from '@/features/composer/quote';
import { useStore } from '@/store';
import { tr } from '@/i18n';
import { ArrivalCtx } from './turn-context';
import { useCopy } from './CodeBlock';
import { GraphFullscreen } from './GraphFullscreen';
// spec 2026-10-24 D4: a ```nodegraph block drawn as an interactive graph. Bad JSON → the code plus one line saying so.

const NONE: { nodes: NgNode[]; edges: NgEdge[] } = { nodes: [], edges: [] };

export default function NodegraphBlock({ source }: { source: string }) {
  const parsed = useMemo(() => parseNodeGraph(source), [source]);
  const arrival = useContext(ArrivalCtx);
  const [entrance] = useState(() => arrival.current);
  const init = useMemo(() => (parsed.ok ? initialPicks(parsed.graph) : {}), [parsed]);
  const [picks, setPicks] = useState<Record<string, string>>(init);
  const [showSrc, setShowSrc] = useState(false);
  const { ok: copied, copy } = useCopy();
  // review D4: the width of the reply sets the scale (60 %–100 %), the height follows it — no empty band under the cards
  const wrap = useRef<HTMLDivElement>(null);
  const g = parsed.ok ? parsed.graph : NONE;
  const hasHead = parsed.ok && !!(parsed.graph.title || parsed.graph.subtitle || parsed.graph.badge);
  const { height, fit } = useColumnFit(wrap, g.nodes, g.edges, chatFit(hasHead));
  const onPick = useCallback((k: string, v: string) => setPicks((p) => ({ ...p, [k]: v })), []);
  // issue #17: open full-window — the 全屏查看 button that did it (the focus goes back there), null when closed
  const [full, setFull] = useState<HTMLElement | null>(null);
  const closeFull = useCallback(() => setFull(null), []);
  // the reply's graph keeps its own zoom / pan: the same element while the viewer opens and closes, so React does not
  // even render it again (a new picks — a dropdown changed in the viewer — does)
  const inline = useMemo(() => (parsed.ok
    ? <NodeGraph graph={parsed.graph} ariaLabel={parsed.graph.title ?? tr('节点图')} height={height} fit={fit} embedded entrance={entrance} picks={picks} onPick={onPick} onFullscreen={setFull} />
    : null), [parsed, height, fit, entrance, picks, onPick]);
  if (!parsed.ok) {
    return (
      <>
        <pre className="code-body">{source}</pre>
        <div className="ng-bad" role="note">{tr('这张图格式有误')}<span className="sub">{parsed.error}</span></div>
      </>
    );
  }
  const changed = changeSentence(parsed.graph, init, picks);
  const send = () => {
    if (insertInComposer(changed)) return;
    void navigator.clipboard?.writeText(changed).catch(() => {});
    useStore.getState().toast(tr('没有可以填的输入框，这句话已复制'));
  };
  return (
    <div className="ng-chat" ref={wrap}>
      <ErrorBoundary area={tr('节点图')}>{inline}</ErrorBoundary>
      <div className="ng-foot">
        <button type="button" className="link ng-src" aria-expanded={showSrc} onClick={() => setShowSrc((v) => !v)}>{showSrc ? tr('收起源码') : tr('查看源码')}</button>
        <button type="button" className="link ng-copy" onClick={() => copy(source)}>{copied ? tr('已复制') : tr('复制')}</button>
        {changed && <button type="button" className="btn sm ng-send" onClick={send}>{tr('把改动发给 Claude')}</button>}
      </div>
      {showSrc && <pre className="code-body ng-source">{source}</pre>}
      {full && <GraphFullscreen graph={parsed.graph} label={parsed.graph.title ?? tr('节点图')} picks={picks} onPick={onPick} returnFocus={full} onClose={closeFull} />}
    </div>
  );
}
