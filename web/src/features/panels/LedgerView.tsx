import { useEffect, useMemo, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx, fmtMs, fmtTok, shortModel } from '@/util';
import type { LedgerEntry } from '@shared';

/** Traffic ledger: per-call latency / cache / cost table with a bar chart per hour or day, CSV export. */
export function LedgerView({ sessionId }: { sessionId?: string }) {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<LedgerEntry[] | null>(null);
  const [metric, setMetric] = useState<'calls' | 'cost' | 'latency' | 'tokens'>('calls');
  const [onlyErr, setOnlyErr] = useState(false);
  const toast = useStore((s) => s.toast);
  const load = () => ws.request<LedgerEntry[]>({ kind: 'ledger.list', days, sessionId }).then(setRows).catch((e) => toast(e.message));
  useEffect(() => { void load(); }, [days, sessionId]);
  const shown = useMemo(() => (rows ?? []).filter((r) => !onlyErr || !r.ok).slice().reverse(), [rows, onlyErr]);
  const buckets = useMemo(() => {
    const byHour = days <= 2;
    const m = new Map<string, { calls: number; cost: number; latency: number; tokens: number; err: number }>();
    for (const r of rows ?? []) {
      const d = new Date(r.ts);
      const k = byHour ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}h` : `${d.getMonth() + 1}/${d.getDate()}`;
      const b = m.get(k) ?? m.set(k, { calls: 0, cost: 0, latency: 0, tokens: 0, err: 0 }).get(k)!;
      b.calls++; b.cost += r.costUsd; b.latency += r.apiMs ?? r.durationMs; b.tokens += r.input + r.output + r.cacheRead + r.cacheWrite; if (!r.ok) b.err++;
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, days]);
  const val = (b: { calls: number; cost: number; latency: number; tokens: number }) => metric === 'calls' ? b.calls : metric === 'cost' ? b.cost : metric === 'latency' ? (b.calls ? b.latency / b.calls : 0) : b.tokens;
  const max = Math.max(1, ...buckets.map(([, b]) => val(b)));
  const totals = useMemo(() => {
    const t = { calls: 0, err: 0, cost: 0, lat: 0, cacheRead: 0, input: 0 };
    for (const r of rows ?? []) { t.calls++; if (!r.ok) t.err++; t.cost += r.costUsd; t.lat += r.apiMs ?? r.durationMs; t.cacheRead += r.cacheRead; t.input += r.input + r.cacheRead + r.cacheWrite; }
    return t;
  }, [rows]);
  const fmtVal = (v: number) => metric === 'cost' ? `$${v.toFixed(3)}` : metric === 'latency' ? fmtMs(v) : metric === 'tokens' ? fmtTok(v) : String(v);
  return (
    <div className="ledger">
      <div className="ledger-bar">
        <select className="field" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 2, 7, 30, 90].map((d) => <option key={d} value={d}>{d} 天</option>)}</select>
        <span className="seg mini">{(['calls', 'cost', 'latency', 'tokens'] as const).map((m) => <button key={m} className={metric === m ? 'active' : ''} onClick={() => setMetric(m)}>{{ calls: '调用', cost: '费用', latency: '延迟', tokens: 'token' }[m]}</button>)}</span>
        <label className="muted" style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={onlyErr} onChange={(e) => setOnlyErr(e.target.checked)} /> 只看失败</label>
        <span className="grow" />
        <button className="btn sm ghost" onClick={load}>刷新</button>
        <button className="btn sm ghost" onClick={async () => { try { const f = await ws.request<string>({ kind: 'ledger.export', days: Math.max(days, 30) }); toast(`已导出 ${f}`, true); void ws.request({ kind: 'shell.open', path: f.replace(/[\\/][^\\/]+$/, '') }); } catch (e: any) { toast(e.message); } }}>导出 CSV</button>
      </div>
      <div className="ledger-totals">
        <span><b>{totals.calls}</b> 次调用</span>
        <span className={clsx(!!totals.err && 'err')}><b>{totals.err}</b> 失败</span>
        <span><b>${totals.cost.toFixed(3)}</b></span>
        <span>平均 <b>{fmtMs(totals.calls ? totals.lat / totals.calls : 0)}</b></span>
        <span>缓存命中 <b>{totals.input ? Math.round((totals.cacheRead / totals.input) * 100) : 0}%</b></span>
      </div>
      <div className="ledger-chart" title="按天 / 小时聚合">
        {buckets.map(([k, b]) => (
          <div key={k} className="bar" title={`${k}: ${fmtVal(val(b))}${b.err ? ` · ${b.err} 失败` : ''}`}>
            <div className={clsx('fill', !!b.err && 'has-err')} style={{ height: `${Math.max(2, (val(b) / max) * 100)}%` }} />
            <span className="lbl">{k.replace(/^\d+\//, '')}</span>
          </div>
        ))}
        {!buckets.length && <div className="empty">还没有记录（新的调用会自动进账本）</div>}
      </div>
      <div className="ledger-table">
        <div className="lh"><span>时间</span><span>模型</span><span>延迟</span><span>输入</span><span>缓存读</span><span>输出</span><span>费用</span><span>状态</span></div>
        {shown.slice(0, 300).map((r, i) => (
          <div key={i} className={clsx('lr', !r.ok && 'err')} title={r.error ?? ''}>
            <span>{new Date(r.ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <span>{shortModel(r.model) || (r.providerId ?? '-')}</span>
            <span>{fmtMs(r.apiMs ?? r.durationMs)}</span>
            <span>{fmtTok(r.input)}</span>
            <span>{fmtTok(r.cacheRead)}</span>
            <span>{fmtTok(r.output)}</span>
            <span>{r.costUsd ? `$${r.costUsd.toFixed(4)}` : '-'}</span>
            <span>{r.ok ? '✓' : `✗ ${r.error ?? ''}`.slice(0, 24)}</span>
          </div>
        ))}
        {rows && !shown.length && <div className="empty">没有记录</div>}
      </div>
    </div>
  );
}
