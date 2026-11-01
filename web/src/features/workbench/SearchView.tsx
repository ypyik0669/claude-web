import { useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { basename, clsx } from '@/util';
import type { SearchOptions, SearchResult } from '@shared';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';
import { previewFile } from './right-panel';

/** Cross-file search & replace (ripgrep on the server). Results grouped per file; click → editor at that line. */
export function SearchView({ root }: { root: string }) {
  const toast = useStore((s) => s.toast);
  const [q, setQ] = useState('');
  const [rep, setRep] = useState('');
  const [showRep, setShowRep] = useState(false);
  const [opt, setOpt] = useState<SearchOptions>({ regex: false, caseSensitive: false, wholeWord: false, include: [], exclude: [] });
  const [inc, setInc] = useState('');
  const [exc, setExc] = useState('');
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set()); // "path:line" removed from replace scope
  const seq = useRef(0);

  const run = async () => {
    const my = ++seq.current;
    if (!q.trim()) { setRes(null); return; }
    setBusy(true); setErr('');
    try {
      const r = await ws.request<SearchResult>({ kind: 'search.run', root, query: q, options: { ...opt, include: inc.split(',').map((s) => s.trim()).filter(Boolean), exclude: exc.split(',').map((s) => s.trim()).filter(Boolean) } });
      if (my === seq.current) { setRes(r); setExcluded(new Set()); }
    } catch (e: any) { if (my === seq.current) setErr(e.message); }
    if (my === seq.current) setBusy(false);
  };
  useEffect(() => { const t = setTimeout(run, 250); return () => clearTimeout(t); }, [q, opt.regex, opt.caseSensitive, opt.wholeWord, inc, exc, root]);

  const replaceAll = async (only?: { path: string; lines?: number[] }[]) => {
    if (!res) return;
    const targets = only ?? res.files.map((f) => ({ path: f.path, lines: f.matches.map((m) => m.line).filter((l) => !excluded.has(`${f.path}:${l}`)) })).filter((t) => t.lines.length);
    const n = targets.reduce((a, t) => a + (t.lines?.length ?? 0), 0);
    if (!(await dlg.confirm(tr('替换 {n} 处（{targetsCount} 个文件）？', { n, targetsCount: targets.length }), { message: `「${q}」→「${rep}」`, okLabel: tr('替换') }))) return;
    try {
      const r = await ws.request<{ files: number; replacements: number }>({ kind: 'search.replace', root, query: q, replacement: rep, options: { ...opt, include: inc.split(',').map((s) => s.trim()).filter(Boolean), exclude: exc.split(',').map((s) => s.trim()).filter(Boolean) }, targets });
      toast(tr('已替换 {replacements} 处，{files} 个文件', { replacements: r.replacements, files: r.files }), true);
      void run();
    } catch (e: any) { toast(e.message); }
  };
  const total = res?.total ?? 0;
  const rel = (p: string) => p.slice(root.length).replace(/^[\\/]/, '');
  const preview = useMemo(() => (m: { text: string; ranges: { start: number; end: number }[] }) => {
    const out: React.ReactNode[] = [];
    let i = 0;
    const text = m.text;
    // bytes→chars mismatch for non-ASCII lines: treat ranges as best-effort
    for (const r of m.ranges) {
      if (r.start > i) out.push(text.slice(i, r.start));
      out.push(<mark key={r.start}>{text.slice(r.start, r.end)}</mark>);
      if (showRep) out.push(<ins key={`r${r.start}`}>{rep}</ins>);
      i = r.end;
    }
    out.push(text.slice(i));
    return out;
  }, [showRep, rep]);

  return (
    <div className="search-view">
      <div className="search-form">
        <div className="row">
          <button className={clsx('icon-btn', showRep && 'active')} title={tr('替换')} onClick={() => setShowRep(!showRep)} aria-label={tr('替换')}><Icon name={showRep ? 'chevronDown' : 'chevronRight'} size={13} /></button>
          <input className="field grow" placeholder={tr('搜索（Enter 立即搜索）')} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !imeComposing(e.nativeEvent) && run()} autoFocus />
          <button className={clsx('tog', opt.caseSensitive && 'on')} title={tr('区分大小写')} onClick={() => setOpt({ ...opt, caseSensitive: !opt.caseSensitive })}>Aa</button>
          <button className={clsx('tog', opt.wholeWord && 'on')} title={tr('全词匹配')} onClick={() => setOpt({ ...opt, wholeWord: !opt.wholeWord })}>ab</button>
          <button className={clsx('tog', opt.regex && 'on')} title={tr('正则表达式')} onClick={() => setOpt({ ...opt, regex: !opt.regex })}>.*</button>
        </div>
        {showRep && (
          <div className="row">
            <span style={{ width: 26 }} />
            <input className="field grow" placeholder={tr('替换为（正则可用 $1）')} value={rep} onChange={(e) => setRep(e.target.value)} />
            <button className="btn sm" disabled={!res?.total} onClick={() => replaceAll()} title={tr('替换所有未排除的匹配')}>{tr('全部替换')}</button>
          </div>
        )}
        <div className="row sub">
          <input className="field" placeholder={tr('包含：src/**, *.ts')} value={inc} onChange={(e) => setInc(e.target.value)} />
          <input className="field" placeholder={tr('排除：dist, *.min.js')} value={exc} onChange={(e) => setExc(e.target.value)} />
        </div>
        <div className="row sub muted">
          {busy ? tr('搜索中…') : res ? tr('{total}{v} 处 · {filesCount} 个文件', { total, v: res.truncated ? '+' : '', filesCount: res.files.length }) : q ? '' : tr('在工作目录里搜索文本')}
          {err && <span style={{ color: 'var(--red)' }}> {err}</span>}
        </div>
      </div>
      <div className="search-results">
        {res?.files.map((f) => (
          <div key={f.path} className="sr-file">
            <div className="sr-head" onClick={() => setCollapsed({ ...collapsed, [f.path]: !collapsed[f.path] })}>
              <span className="chev"><Icon name={collapsed[f.path] ? 'chevronRight' : 'chevronDown'} size={11} /></span>
              <b>{basename(f.path)}</b>
              <span className="muted">{rel(f.path).replace(/[\\/][^\\/]+$/, '')}</span>
              <span className="grow" />
              <span className="badge">{f.matches.length}</span>
              {showRep && <button className="x" title={tr('替换此文件')} aria-label={tr('替换此文件')} onClick={(e) => { e.stopPropagation(); void replaceAll([{ path: f.path, lines: f.matches.map((m) => m.line).filter((l) => !excluded.has(`${f.path}:${l}`)) }]); }}><Icon name="replace" size={12} /></button>}
            </div>
            {!collapsed[f.path] && f.matches.map((m) => {
              const key = `${f.path}:${m.line}`;
              return (
                <div key={key} className={clsx('sr-line', excluded.has(key) && 'excluded')} onClick={() => previewFile(f.path, m.line)} title={`${f.path}:${m.line}`}>
                  <span className="ln">{m.line}</span>
                  <span className="tx">{preview(m)}</span>
                  {showRep && <button className="x" title={excluded.has(key) ? tr('重新包含') : tr('从替换中排除')} onClick={(e) => { e.stopPropagation(); const n = new Set(excluded); n.has(key) ? n.delete(key) : n.add(key); setExcluded(n); }}><Icon name={excluded.has(key) ? 'plus' : 'close'} size={11} /></button>}
                </div>
              );
            })}
          </div>
        ))}
        {res && !res.files.length && q && !busy && <div className="empty">{tr('没有匹配')}</div>}
      </div>
    </div>
  );
}
