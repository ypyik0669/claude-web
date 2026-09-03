import { memo, useMemo, useState } from 'react';
import { diffLines, diffWordsWithSpace, parsePatch } from 'diff';
import { clsx } from '@/util';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';

export interface Hunk { oldStart: number; oldLines?: number; newStart: number; newLines?: number; lines: string[] }

type Seg = { t: ' ' | '+' | '-'; s: string };
type LineRow = { type: 'ctx' | 'add' | 'del'; oldNo?: number; newNo?: number; text: string; segs?: Seg[] };
type Row =
  | LineRow
  | { type: 'hunk'; text: string }
  | { type: 'skip'; count: number; key: string; lines: Row[] };

const CONTEXT = 3;
const INTRA_MAX = 600;

/** Normalise every input form to hunks with +/-/space prefixed lines. */
function toHunks(p: { patch?: Hunk[]; oldText?: string; newText?: string; unified?: string }): Hunk[] {
  if (p.patch?.length) return p.patch;
  if (p.unified) {
    try {
      return parsePatch(p.unified).flatMap((f) => f.hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines })));
    } catch {
      return [{ oldStart: 1, newStart: 1, lines: p.unified.split('\n') }];
    }
  }
  const parts = diffLines(p.oldText ?? '', p.newText ?? '');
  const lines: string[] = [];
  for (const part of parts) {
    const ls = part.value.split('\n');
    if (ls[ls.length - 1] === '') ls.pop();
    const prefix = part.added ? '+' : part.removed ? '-' : ' ';
    for (const l of ls) lines.push(prefix + l);
  }
  return [{ oldStart: 1, newStart: 1, lines }];
}

function intraline(a: string, b: string): [Seg[], Seg[]] {
  const parts = diffWordsWithSpace(a, b);
  const del: Seg[] = [], add: Seg[] = [];
  for (const p of parts) {
    if (p.added) add.push({ t: '+', s: p.value });
    else if (p.removed) del.push({ t: '-', s: p.value });
    else { del.push({ t: ' ', s: p.value }); add.push({ t: ' ', s: p.value }); }
  }
  return [del, add];
}

function buildRows(hunks: Hunk[], collapse: boolean): Row[] {
  const rows: Row[] = [];
  hunks.forEach((h, hi) => {
    if (hunks.length > 1 || (h.oldStart > 1 && hi === 0)) rows.push({ type: 'hunk', text: `@@ -${h.oldStart}${h.oldLines !== undefined ? `,${h.oldLines}` : ''} +${h.newStart}${h.newLines !== undefined ? `,${h.newLines}` : ''} @@` });
    let o = h.oldStart, n = h.newStart;
    const body: Row[] = [];
    for (const raw of h.lines) {
      const c = raw[0];
      const text = raw.slice(1);
      if (c === '+') body.push({ type: 'add', newNo: n++, text });
      else if (c === '-') body.push({ type: 'del', oldNo: o++, text });
      else if (c === '\\') continue; // "\ No newline at end of file"
      else body.push({ type: 'ctx', oldNo: o++, newNo: n++, text });
    }
    // pair equal-length del/add runs for intra-line highlights
    for (let i = 0; i < body.length; i++) {
      if (body[i].type !== 'del') continue;
      let j = i;
      while (j < body.length && body[j].type === 'del') j++;
      let k = j;
      while (k < body.length && body[k].type === 'add') k++;
      const dels = j - i, adds = k - j;
      if (dels === adds && dels > 0) {
        for (let x = 0; x < dels; x++) {
          const d = body[i + x] as LineRow, a = body[j + x] as LineRow;
          if (d.text.length < INTRA_MAX && a.text.length < INTRA_MAX && d.text !== a.text) {
            const [ds, as] = intraline(d.text, a.text);
            d.segs = ds; a.segs = as;
          }
        }
      }
      i = k - 1;
    }
    // collapse long context runs
    if (collapse) {
      let run: Row[] = [];
      const flush = (edge: 'start' | 'mid' | 'end') => {
        if (!run.length) return;
        const keepHead = edge === 'start' ? 0 : CONTEXT;
        const keepTail = edge === 'end' ? 0 : CONTEXT;
        if (run.length > keepHead + keepTail + 2) {
          rows.push(...run.slice(0, keepHead));
          const hidden = run.slice(keepHead, run.length - keepTail);
          rows.push({ type: 'skip', count: hidden.length, key: `${hi}-${rows.length}`, lines: hidden });
          rows.push(...run.slice(run.length - keepTail));
        } else rows.push(...run);
        run = [];
      };
      let seenChange = false;
      for (const r of body) {
        if (r.type === 'ctx') run.push(r);
        else { flush(seenChange ? 'mid' : 'start'); seenChange = true; rows.push(r); }
      }
      flush('end');
    } else rows.push(...body);
  });
  return rows;
}

function Segs({ segs, text, side }: { segs?: Seg[]; text: string; side: 'del' | 'add' }) {
  if (!segs) return <>{text || ' '}</>;
  return <>{segs.map((s, i) => (s.t === ' ' ? <span key={i}>{s.s}</span> : <mark key={i} className={side}>{s.s}</mark>))}</>;
}

export interface DiffViewProps {
  patch?: Hunk[]; // structuredPatch from the SDK (has line numbers)
  oldText?: string;
  newText?: string;
  unified?: string;
  mode?: 'unified' | 'split';
  /** collapse unchanged context (default true for large inputs) */
  collapse?: boolean;
  title?: string;
}

/** Unified / side-by-side diff with line numbers, intra-line word highlights and collapsible context. */
export const DiffView = memo(function DiffView(p: DiffViewProps) {
  const pref = useStore((s) => (s.settings['ui.diffMode'] as 'unified' | 'split' | undefined));
  const setSetting = useStore((s) => s.setSetting);
  const mode = p.mode ?? pref ?? 'unified';
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const hunks = useMemo(() => toHunks(p), [p.patch, p.oldText, p.newText, p.unified]);
  const rows = useMemo(() => buildRows(hunks, p.collapse ?? true), [hunks, p.collapse]);
  const stats = useMemo(() => {
    let a = 0, d = 0;
    const walk = (rs: Row[]) => { for (const r of rs) { if (r.type === 'add') a++; else if (r.type === 'del') d++; else if (r.type === 'skip') walk(r.lines); } };
    walk(rows);
    return { a, d };
  }, [rows]);
  const flat = useMemo(() => {
    const out: Row[] = [];
    for (const r of rows) {
      if (r.type === 'skip' && opened[r.key]) out.push(...r.lines);
      else out.push(r);
    }
    return out;
  }, [rows, opened]);

  const head = (
    <div className="diff-head">
      {p.title && <span className="diff-title" title={p.title}>{p.title}</span>}
      <span className="diff-stats"><span className="add">+{stats.a}</span> <span className="del">−{stats.d}</span></span>
      <span className="grow" />
      <span className="seg mini">
        <button className={clsx(mode === 'unified' && 'active')} onClick={() => setSetting('ui.diffMode', 'unified')}>内联</button>
        <button className={clsx(mode === 'split' && 'active')} onClick={() => setSetting('ui.diffMode', 'split')}>并排</button>
      </span>
    </div>
  );

  if (mode === 'split') {
    // pair rows into left/right
    const pairs: { l?: Row; r?: Row; key: number }[] = [];
    for (let i = 0; i < flat.length; i++) {
      const r = flat[i];
      if (r.type === 'del') {
        let j = i;
        while (j < flat.length && flat[j].type === 'del') j++;
        let k = j;
        while (k < flat.length && flat[k].type === 'add') k++;
        const n = Math.max(j - i, k - j);
        for (let x = 0; x < n; x++) pairs.push({ l: flat[i + x]?.type === 'del' ? flat[i + x] : undefined, r: j + x < k ? flat[j + x] : undefined, key: pairs.length });
        i = k - 1;
      } else if (r.type === 'add') pairs.push({ r, key: pairs.length });
      else pairs.push({ l: r, r, key: pairs.length });
    }
    return (
      <div className="diff split">
        {head}
        <div className="diff-grid">
          {pairs.map(({ l, r, key }) => {
            if (l?.type === 'hunk' || l?.type === 'skip') return <SpecialRow key={key} r={l} span onOpen={() => setOpened((o) => ({ ...o, [(l as any).key]: true }))} />;
            return (
              <div key={key} className="diff-pair">
                <Cell r={l} side="del" />
                <Cell r={r} side="add" />
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div className="diff unified">
      {head}
      <div className="diff-lines">
        {flat.map((r, i) => {
          if (r.type === 'hunk' || r.type === 'skip') return <SpecialRow key={i} r={r} onOpen={() => setOpened((o) => ({ ...o, [(r as any).key]: true }))} />;
          return (
            <div key={i} className={clsx('dl', r.type)}>
              <span className="ln">{r.oldNo ?? ''}</span>
              <span className="ln">{r.newNo ?? ''}</span>
              <span className="mk">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
              <span className="tx"><Segs segs={r.segs} text={r.text} side={r.type === 'add' ? 'add' : 'del'} /></span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

function SpecialRow({ r, span, onOpen }: { r: Row; span?: boolean; onOpen: () => void }) {
  if (r.type === 'hunk') return <div className={clsx('dl hunk', span && 'span')}>{r.text}</div>;
  if (r.type === 'skip') return <div className={clsx('dl skip', span && 'span')} onClick={onOpen}><Icon name="chevronDown" size={12} /> 展开 {r.count} 行未改动内容</div>;
  return null;
}

function Cell({ r, side }: { r?: Row; side: 'del' | 'add' }) {
  if (!r || r.type === 'hunk' || r.type === 'skip') return <div className="dc empty" />;
  const no = side === 'del' ? r.oldNo : r.newNo;
  const changed = r.type === side;
  return (
    <div className={clsx('dc', changed && r.type)}>
      <span className="ln">{no ?? ''}</span>
      <span className="tx"><Segs segs={changed ? r.segs : undefined} text={r.text} side={side} /></span>
    </div>
  );
}
