// Execution-graph layout for the orchestration panel: columns = topological layers, SVG edges between
// card anchors. Pure, so it's unit tested and shared by the editor preview and the run view.

export interface GraphNodeIn { id: string; dependsOn: string[] }
export interface GraphBox { id: string; col: number; row: number; x: number; y: number }
export interface GraphEdge { from: string; to: string; d: string }
export interface GraphLayout { boxes: Record<string, GraphBox>; edges: GraphEdge[]; width: number; height: number; cols: number }

export const CARD_W = 150;
export const CARD_H = 56;
const GAP_X = 36;
const GAP_Y = 14;
const PAD = 8;

/** Layer = one more than the deepest dependency; nodes on a cycle (unsaved drafts) go to a trailing column. */
export function layers<T extends GraphNodeIn>(nodes: T[]): T[][] {
  const by = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const onPath = new Set<string>();
  const cyclic = new Set<string>();
  const d = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (onPath.has(id)) { cyclic.add(id); return 0; }
    onPath.add(id);
    let v = 0;
    for (const p of by.get(id)?.dependsOn ?? []) if (by.has(p)) v = Math.max(v, d(p) + 1);
    onPath.delete(id);
    depth.set(id, v);
    return v;
  };
  for (const n of nodes) d(n.id);
  const out: T[][] = [];
  const tail: T[] = [];
  for (const n of nodes) { if (cyclic.has(n.id)) tail.push(n); else (out[depth.get(n.id)!] ??= []).push(n); }
  const res = out.filter(Boolean);
  if (tail.length) res.push(tail);
  return res;
}

export function layoutGraph(nodes: GraphNodeIn[]): GraphLayout {
  const cols = layers(nodes);
  const boxes: Record<string, GraphBox> = {};
  cols.forEach((col, c) => col.forEach((n, r) => { boxes[n.id] = { id: n.id, col: c, row: r, x: PAD + c * (CARD_W + GAP_X), y: PAD + r * (CARD_H + GAP_Y) }; }));
  const edges: GraphEdge[] = [];
  for (const n of nodes) {
    const b = boxes[n.id];
    for (const dep of n.dependsOn) {
      const a = boxes[dep];
      if (!a || !b) continue;
      const x1 = a.x + CARD_W, y1 = a.y + CARD_H / 2, x2 = b.x, y2 = b.y + CARD_H / 2;
      // backwards edges (a cycle in a draft) bow out below instead of cutting through the cards
      const dx = x2 > x1 ? Math.max(20, (x2 - x1) / 2) : 60;
      edges.push({ from: dep, to: n.id, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` });
    }
  }
  const rows = Math.max(0, ...cols.map((c) => c.length));
  return { boxes, edges, cols: cols.length, width: PAD * 2 + cols.length * CARD_W + Math.max(0, cols.length - 1) * GAP_X, height: PAD * 2 + rows * CARD_H + Math.max(0, rows - 1) * GAP_Y };
}

/** Zoom that fits a graph of `width` into `available` px: ≤ 1, and not below `floor` (then it scrolls). */
export function fitScale(width: number, available: number, floor = 0.5): number {
  if (width <= 0 || available <= 0 || width <= available) return 1;
  return Math.max(floor, available / width);
}

/** Next free `n<k>` id for a new node. */
export function nextNodeId(ids: string[]): string {
  let k = ids.length + 1;
  while (ids.includes(`n${k}`)) k++;
  return `n${k}`;
}

/** Template variables a node's prompt can use: input + every other node's output / approval. */
export function promptVars(nodes: { id: string; kind: string; title: string }[], self: string): { token: string; label: string }[] {
  const out = [{ token: '{{input}}', label: '启动输入' }];
  for (const n of nodes) {
    if (n.id === self) continue;
    if (n.kind === 'approval') out.push({ token: `{{nodes.${n.id}.approval}}`, label: `${n.title || n.id} 的审批意见` });
    else out.push({ token: `{{nodes.${n.id}.output}}`, label: `${n.title || n.id} 的输出` });
  }
  return out;
}
