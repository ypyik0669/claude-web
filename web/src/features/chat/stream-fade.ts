// Text that just arrived in a streaming answer fades in (UI refresh §6: opacity + 3px blur, 240 ms — only the newly
// added part of the block that is streaming, the wrappers gone when the stream ends).
//
// How, with react-markdown re-parsing the whole text on every delta: `arrive()` notes where each delta started and
// when; `fadeNewText()` — a rehype step, so it sees source offsets — cuts the text nodes of the LAST top-level block
// at those places and wraps every piece in a <span>. A piece younger than FRESH_MS has class `w` (the animation),
// an older one has none. What keeps text that is already on screen from flickering or fading twice:
//  - the class only ever depends on a piece's age, and a piece's age only on a mark made when it arrived;
//  - a piece keeps its <span> for as long as its block is the last one, so the n-th span of a parent is the same
//    DOM node from one delta to the next (react-markdown keys siblings by tag and order) and a new piece is a new
//    node whose animation starts from 0;
//  - a block that is no longer the last one, and everything once the stream ends, is plain text again (same text in
//    the same place: one DOM swap, nothing to see).
// Code blocks are never touched (CodeBlock reads its text as one string and checks its own DOM, see code-blank.ts).
// Pure — Markdown.tsx holds the state and adds the step while `streaming`.

/** How long the fade is (chat.css `.md .w`). */
export const FADE_MS = 240;
/** How long a piece counts as new: its fade and a margin, so the class is never taken off mid-animation. */
export const FRESH_MS = 320;

/** Text from source offset `off` on arrived at `at` (ms, any monotonic clock). */
export interface Arrival { off: number; at: number }

export interface FadeState {
  text: string;
  /** ascending by `off` */
  marks: Arrival[];
  /** where the last top-level block starts in `text` (set by the rehype step; older marks are dropped by it) */
  from?: number;
}

/**
 * The state after `text` is seen at `now`. What is there when a stream is first seen is not new (switching back to a
 * conversation that is streaming replays nothing); text that grew at its end adds one mark; text that changed any
 * other way starts over, with nothing new.
 */
export function arrive(prev: FadeState | null, text: string, now: number): FadeState {
  if (!prev) return { text, marks: [] };
  if (text === prev.text) return prev;
  if (!text.startsWith(prev.text)) return { text, marks: [] };
  let marks = prev.marks;
  if (prev.from !== undefined) {
    // keep the last mark at or before the block's start (its delta may reach into the block), and all after it
    let k = 0;
    while (k + 1 < marks.length && marks[k + 1].off <= prev.from) k++;
    if (k) marks = marks.slice(k);
  }
  return { text, marks: [...marks, { off: prev.text.length, at: now }], from: prev.from };
}

interface Pos { start: { offset?: number }; end: { offset?: number } }
export interface HNode { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HNode[]; position?: Pos }

/** Never cut or wrapped inside these. */
const SKIP = new Set(['pre', 'svg', 'math', 'script', 'style']);

/** Whether `value` may be cut before index `i` without tearing a character apart (a surrogate pair, a joined emoji, a combining mark). */
function cuttable(value: string, i: number): boolean {
  const c = value.charCodeAt(i), p = value.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff) return false; // the second half of a pair
  if (c === 0x200d || p === 0x200d) return false; // zero-width joiner on either side
  if ((c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x0300 && c <= 0x036f) || (c >= 0x20d0 && c <= 0x20ff) || c === 0x3099 || c === 0x309a) return false; // a variation selector / combining mark
  if (c === 0xd83c) { const d = value.charCodeAt(i + 1); if (d >= 0xdffb && d <= 0xdfff) return false; } // a skin-tone modifier
  return true;
}

/** Index of the last mark at or before `off`, or -1. */
function markAt(marks: readonly Arrival[], off: number): number {
  let lo = 0, hi = marks.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].off <= off) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

const span = (value: string, fresh: boolean): HNode => ({ type: 'element', tagName: 'span', properties: fresh ? { className: ['w'] } : {}, children: [{ type: 'text', value }] });

/** One text node → itself (untouched), or the spans it is cut into. */
function pieces(node: HNode, source: string, marks: readonly Arrival[], now: number): HNode[] {
  const value = node.value ?? '';
  const s = node.position?.start.offset, e = node.position?.end.offset;
  if (!value || s === undefined || e === undefined || e <= s) return [node];
  const exact = e - s === value.length; // no escapes, entities or stripped indentation in between: offsets map 1:1
  // cut places inside the node, as indices into `value`
  const cuts: { i: number; m: number }[] = [];
  for (let m = markAt(marks, s) + 1; m < marks.length && marks[m].off < e; m++) {
    const off = marks[m].off;
    const i = value.length - (e - off);
    if (i <= 0 || i >= value.length || (cuts.length && i <= cuts[cuts.length - 1].i)) continue;
    // where the source and the text differ, a place is only used when everything after it is the same in both
    if (!exact && source.slice(off, e) !== value.slice(i)) continue;
    if (!cuttable(value, i)) continue;
    cuts.push({ i, m });
  }
  const first = markAt(marks, s);
  if (!cuts.length && first < 0) return [node]; // all of it was there before the stream was first seen
  const fresh = (m: number) => m >= 0 && now - marks[m].at < FRESH_MS;
  const out: HNode[] = [];
  let at = 0, m = first;
  for (const c of cuts) {
    out.push(span(value.slice(at, c.i), fresh(m)));
    at = c.i;
    m = c.m;
  }
  out.push(span(value.slice(at), fresh(m)));
  return out;
}

function walk(el: HNode, source: string, marks: readonly Arrival[], now: number): void {
  if (!el.children) return;
  const next: HNode[] = [];
  for (const c of el.children) {
    if (c.type === 'text') next.push(...pieces(c, source, marks, now));
    else {
      if (c.type === 'element' && !SKIP.has(c.tagName ?? '')) walk(c, source, marks, now);
      next.push(c);
    }
  }
  el.children = next;
}

/**
 * Wraps the arrivals of the last top-level block of `tree` (hast, as react-markdown hands it to rehype plugins; changed
 * in place). Returns where that block starts in `source`, for `arrive()` to drop the marks before it.
 */
export function fadeNewText(tree: HNode, source: string, marks: readonly Arrival[], now: number): number | undefined {
  const kids = tree.children ?? [];
  let last: HNode | undefined;
  for (let i = kids.length - 1; i >= 0; i--) {
    const c = kids[i];
    if (c.type === 'text' && !(c.value ?? '').trim()) continue;
    if (c.type === 'element') last = c;
    break;
  }
  if (!last) return undefined;
  const from = last.position?.start.offset;
  if (marks.length && !SKIP.has(last.tagName ?? '')) walk(last, source, marks, now);
  return from;
}

/** The rehype step for react-markdown: `[rehypeStreamFade, ref]`, `ref.current` kept up to date with `arrive()`. */
export function rehypeStreamFade(ref: { current: FadeState | null }, clock: () => number = () => performance.now()) {
  return (tree: HNode): void => {
    const st = ref.current;
    if (!st) return;
    st.from = fadeNewText(tree, st.text, st.marks, clock());
  };
}
