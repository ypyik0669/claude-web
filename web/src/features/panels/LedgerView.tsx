import { useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx, fmtMs, fmtTok, shortModel } from '@/util';
import type { LedgerEntry } from '@shared';
import { hitRate, hitRates } from './ledger-stats';

/** Traffic ledger: per-call latency / cache / cost table with a bar chart per hour or day, CSV export. */
export function LedgerView({ sessionId }: { sessionId?: string }) {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<LedgerEntry[] | null>(null);
  const [metric, setMetric] = useState<'calls' | 'cost' | 'latency' | 'tokens'>('calls');
  const [onlyErr, setOnlyErr] = useState(false);
  const [source, setSource] = useState<'all' | 'session' | 'gateway'>('session'); // gateway rows = one per request through the model gateway; a session through the gateway has both kinds, so totals default to sessions
  const toast = useStore((s) => s.toast);
  const providers = useStore((s) => s.providers);
  const seq = useRef(0); // switching 90 → 1 day: the slow 90-day answer must not overwrite the 1-day one
  const load = () => { const n = ++seq.current; return ws.request<LedgerEntry[]>({ kind: 'ledger.list', days, sessionId }).then((r) => { if (n === seq.current) setRows(r); }).catch((e) => toast(e.message)); };
  useEffect(() => { void load(); }, [days, sessionId]);
  const picked = useMemo(() => (rows ?? []).filter((r) => source === 'all' || (source === 'gateway' ? r.kind === 'gateway' : r.kind !== 'gateway')), [rows, source]);
  const shown = useMemo(() => picked.filter((r) => !onlyErr || !r.ok).slice().reverse(), [picked, onlyErr]);
  const buckets = useMemo(() => {
    const byHour = days <= 2;
    const m = new Map<string, { calls: number; cost: number; latency: number; tokens: number; err: number }>();
    for (const r of picked) {
      const d = new Date(r.ts);
      const k = byHour ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}h` : `${d.getMonth() + 1}/${d.getDate()}`;
      const b = m.get(k) ?? m.set(k, { calls: 0, cost: 0, latency: 0, tokens: 0, err: 0 }).get(k)!;
      b.calls++; b.cost += r.costUsd; b.latency += r.apiMs ?? r.durationMs; b.tokens += r.input + r.output + r.cacheRead + r.cacheWrite; if (!r.ok) b.err++;
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [picked, days]);
  const val = (b: { calls: number; cost: number; latency: number; tokens: number }) => metric === 'calls' ? b.calls : metric === 'cost' ? b.cost : metric === 'latency' ? (b.calls ? b.latency / b.calls : 0) : b.tokens;
  const max = Math.max(1, ...buckets.map(([, b]) => val(b)));
  const totals = useMemo(() => {
    const t = { calls: 0, err: 0, cost: 0, lat: 0, cacheRead: 0, input: 0 };
    for (const r of picked) { t.calls++; if (!r.ok) t.err++; t.cost += r.costUsd; t.lat += r.apiMs ?? r.durationMs; t.cacheRead += r.cacheRead; t.input += r.input + r.cacheRead + r.cacheWrite; }
    return t;
  }, [picked]);
  const byProvider = useMemo(() => hitRates(picked, (id) => (id ? providers.find((p) => p.id === id)?.name ?? id : 'Claude 账号')), [picked, providers]);
  const fmtVal = (v: number) => metric === 'cost' ? `$${v.toFixed(3)}` : metric === 'latency' ? fmtMs(v) : metric === 'tokens' ? fmtTok(v) : String(v);
  return (
    <div className="ledger">
      <div className="ledger-bar">
        <select className="field" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 2, 7, 30, 90].map((d) => <option key={d} value={d}>{d} 天</option>)}</select>
        <span className="seg mini">{(['calls', 'cost', 'latency', 'tokens'] as const).map((m) => <button key={m} className={metric === m ? 'active' : ''} onClick={() => setMetric(m)}>{{ calls: '调用', cost: '费用', latency: '延迟', tokens: 'token' }[m]}</button>)}</span>
        <span className="seg mini" title="来源">{(['all', 'session', 'gateway'] as const).map((k) => <button key={k} className={source === k ? 'active' : ''} title={k === 'all' ? '经网关的会话会同时有会话行和网关行，调用数与 token 在这里会算两遍' : undefined} onClick={() => setSource(k)}>{{ all: '全部', session: '会话', gateway: '网关' }[k]}</button>)}</span>
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
      {byProvider.length > 0 && (
        <details style={{ fontSize: 12, margin: '2px 0 6px' }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>缓存命中 · 按供应商 × 模型</summary>
          {byProvider.map((h) => (
            <div key={`${h.provider}|${h.model}`} style={{ display: 'flex', gap: 8, padding: '1px 0' }} title={`输入 ${fmtTok(h.input)} · 缓存读 ${fmtTok(h.cacheRead)} · 缓存写 ${fmtTok(h.cacheWrite)}`}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.provider} · {shortModel(h.model) || h.model}</span>
              <span className="muted">{h.calls} 次</span>
              <b style={{ minWidth: 40, textAlign: 'right' }}>{Math.round(hitRate(h) * 100)}%</b>
            </div>
          ))}
        </details>
      )}
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
          <div key={i} className={clsx('lr', !r.ok && 'err')} title={[r.gateway ? `网关 · ${r.gateway.group} · ${r.gateway.inbound} → ${r.gateway.member ?? '?'}${r.gateway.switches ? ` · 切换 ${r.gateway.switches} 次` : ''}` : '', r.error ?? ''].filter(Boolean).join(' · ')}>
            <span>{new Date(r.ts).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <span>{r.gateway ? <>{shortModel(r.model) || '-'} <span className="muted">· {r.gateway.member}</span></> : shortModel(r.model) || (r.providerId ?? '-')}</span>
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
