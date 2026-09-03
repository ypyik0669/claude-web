import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/ui/icons';

const hasHighlight = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (window as any).Highlight === 'function';

function collectRanges(root: HTMLElement, query: string): Range[] {
  const out: Range[] = [];
  if (!query) return out;
  const q = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || p.closest('.find-bar, .msg-actions, textarea, script, style')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue && n.nodeValue.toLowerCase().includes(q) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  let node: Node | null;
  while ((node = walker.nextNode()) && out.length < 2000) {
    const text = node.nodeValue!.toLowerCase();
    let i = 0;
    while ((i = text.indexOf(q, i)) >= 0) {
      const r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      out.push(r);
      i += q.length;
    }
  }
  return out;
}

/** Ctrl+F search inside the transcript using the CSS Custom Highlight API (no DOM mutation). */
export function FindBar({ open, onClose, root }: { open: boolean; onClose: () => void; root: () => HTMLElement | null }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [count, setCount] = useState(0);
  const ranges = useRef<Range[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (open) setTimeout(() => input.current?.select(), 0); }, [open]);

  useEffect(() => {
    if (!open) { clear(); return; }
    const el = root();
    if (!el) return;
    ranges.current = collectRanges(el, q);
    setCount(ranges.current.length);
    setIdx((i) => Math.min(i, Math.max(0, ranges.current.length - 1)));
    paint(0);
  }, [q, open]);

  useEffect(() => { paint(idx); scrollTo(idx); }, [idx]);

  function paint(cur: number) {
    if (!hasHighlight) return;
    const H = (window as any).Highlight;
    (CSS as any).highlights.set('find', new H(...ranges.current));
    (CSS as any).highlights.set('find-active', new H(...(ranges.current[cur] ? [ranges.current[cur]] : [])));
  }
  function clear() {
    ranges.current = [];
    setCount(0);
    if (hasHighlight) { (CSS as any).highlights.delete('find'); (CSS as any).highlights.delete('find-active'); }
  }
  function scrollTo(i: number) {
    const r = ranges.current[i];
    const el = r?.startContainer.parentElement;
    el?.scrollIntoView({ block: 'center' });
  }
  const step = (d: number) => { if (!count) return; setIdx((i) => (i + d + count) % count); };
  if (!open) return null;
  return (
    <div className="find-bar" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Enter') step(e.shiftKey ? -1 : 1); }}>
      <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} placeholder="在对话中查找…" />
      <span className="cnt">{count ? `${idx + 1} / ${count}` : q ? '无结果' : ''}</span>
      <button className="icon-btn" title="上一个 (Shift+Enter)" onClick={() => step(-1)} aria-label="上一个"><Icon name="chevronRight" size={14} /></button>
      <button className="icon-btn" title="下一个 (Enter)" onClick={() => step(1)} aria-label="下一个"><Icon name="chevronDown" size={14} /></button>
      <button className="icon-btn" title="关闭 (Esc)" onClick={onClose} aria-label="关闭"><Icon name="close" size={14} /></button>
      {!hasHighlight && <span className="tool-meta">此浏览器不支持高亮 API，只能跳转</span>}
    </div>
  );
}
