import { useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { basename, clsx } from '@/util';
import type { SearchOptions, SearchResult } from '@shared';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';

/** Cross-file search & replace (ripgrep on the server). Results grouped per file; click → editor at that line. */
export function SearchView({ root }: { root: string }) {
  const openTile = useStore((s) => s.openTile);
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
    if (!(await dlg.confirm(`替换 ${n} 处（${targets.length} 个文件）？`, { message: `「${q}」→「${rep}」`, okLabel: '替换' }))) return;
    try {
      const r = await ws.request<{ files: number; replacements: number }>({ kind: 'search.replace', root, query: q, replacement: rep, options: { ...opt, include: inc.split(',').map((s) => s.trim()).filter(Boolean), exclude: exc.split(',').map((s) => s.trim()).filter(Boolean) }, targets });
      toast(`已替换 ${r.replacements} 处，${r.files} 个文件`, true);
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
          <button className={clsx('icon-btn', showRep && 'active')} title="替换" onClick={() => setShowRep(!showRep)} aria-label="替换"><Icon name={showRep ? 'chevronDown' : 'chevronRight'} size={13} /></button>
          <input className="field grow" placeholder="搜索（Enter 立即搜索）" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} autoFocus />
          <button className={clsx('tog', opt.caseSensitive && 'on')} title="区分大小写" onClick={() => setOpt({ ...opt, caseSensitive: !opt.caseSensitive })}>Aa</button>
          <button className={clsx('tog', opt.wholeWord && 'on')} title="全词匹配" onClick={() => setOpt({ ...opt, wholeWord: !opt.wholeWord })}>ab</button>
          <button className={clsx('tog', opt.regex && 'on')} title="正则表达式" onClick={() => setOpt({ ...opt, regex: !opt.regex })}>.*</button>
        </div>
        {showRep && (
          <div className="row">
            <span style={{ width: 26 }} />
            <input className="field grow" placeholder="替换为（正则可用 $1）" value={rep} onChange={(e) => setRep(e.target.value)} />
            <button className="btn sm" disabled={!res?.total} onClick={() => replaceAll()} title="替换所有未排除的匹配">全部替换</button>
          </div>
        )}
        <div className="row sub">
          <input className="field" placeholder="包含：src/**, *.ts" value={inc} onChange={(e) => setInc(e.target.value)} />
          <input className="field" placeholder="排除：dist, *.min.js" value={exc} onChange={(e) => setExc(e.target.value)} />
        </div>
        <div className="row sub muted">
          {busy ? '搜索中…' : res ? `${total}${res.truncated ? '+' : ''} 处 · ${res.files.length} 个文件` : q ? '' : '在工作目录里搜索文本'}
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
              {showRep && <button className="x" title="替换此文件" aria-label="替换此文件" onClick={(e) => { e.stopPropagation(); void replaceAll([{ path: f.path, lines: f.matches.map((m) => m.line).filter((l) => !excluded.has(`${f.path}:${l}`)) }]); }}><Icon name="replace" size={12} /></button>}
            </div>
            {!collapsed[f.path] && f.matches.map((m) => {
              const key = `${f.path}:${m.line}`;
              return (
                <div key={key} className={clsx('sr-line', excluded.has(key) && 'excluded')} onClick={() => openTile({ id: `d${Date.now().toString(36)}`, kind: 'doc', path: f.path, line: m.line }, 'tab')} title={`${f.path}:${m.line}`}>
                  <span className="ln">{m.line}</span>
                  <span className="tx">{preview(m)}</span>
                  {showRep && <button className="x" title={excluded.has(key) ? '重新包含' : '从替换中排除'} onClick={(e) => { e.stopPropagation(); const n = new Set(excluded); n.has(key) ? n.delete(key) : n.add(key); setExcluded(n); }}><Icon name={excluded.has(key) ? 'plus' : 'close'} size={11} /></button>}
                </div>
              );
            })}
          </div>
        ))}
        {res && !res.files.length && q && !busy && <div className="empty">没有匹配</div>}
      </div>
    </div>
  );
}
