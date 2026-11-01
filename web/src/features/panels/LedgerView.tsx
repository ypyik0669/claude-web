import { Icon } from '@/ui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx, fmtMs, fmtTok, shortModel } from '@/util';
import type { LedgerEntry } from '@shared';
import { hitRate, hitRates, profileName } from './ledger-stats';
import { tr, dateLocale } from '@/i18n';
import { Select } from '@/ui/Select';
import { SwitchChip } from '@/ui/Switch';

/** Traffic ledger: per-call latency / cache / cost table with a bar chart per hour or day, CSV export. */
export function LedgerView({ sessionId }: { sessionId?: string }) {
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<LedgerEntry[] | null>(null);
  const [metric, setMetric] = useState<'calls' | 'cost' | 'latency' | 'tokens'>('calls');
  const [onlyErr, setOnlyErr] = useState(false);
  const toast = useStore((s) => s.toast);
  const providers = useStore((s) => s.providers);
  const seq = useRef(0); // switching 90 → 1 day: the slow 90-day answer must not overwrite the 1-day one
  const load = () => { const n = ++seq.current; return ws.request<LedgerEntry[]>({ kind: 'ledger.list', days, sessionId }).then((r) => { if (n === seq.current) setRows(r); }).catch((e) => toast(e.message)); };
  useEffect(() => { void load(); }, [days, sessionId]);
  const picked = useMemo(() => rows ?? [], [rows]);
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
    const t = { calls: 0, err: 0, cost: 0, costUnknown: 0, lat: 0, cacheRead: 0, input: 0 };
    for (const r of picked) { t.calls++; if (!r.ok) t.err++; t.cost += r.costUsd; if (r.costUnknown && (r.input || r.output || r.cacheRead)) t.costUnknown++; t.lat += r.apiMs ?? r.durationMs; t.cacheRead += r.cacheRead; t.input += r.input + r.cacheRead + r.cacheWrite; }
    return t;
  }, [picked]);
  const byProvider = useMemo(() => hitRates(picked, (id) => profileName(providers, id)), [picked, providers]);
  const fmtVal = (v: number) => metric === 'cost' ? `$${v.toFixed(3)}` : metric === 'latency' ? fmtMs(v) : metric === 'tokens' ? fmtTok(v) : String(v);
  return (
    <div className="ledger">
      <div className="ledger-bar">
        <Select className="field" value={String(days)} onValueChange={(value) => setDays(Number(value))} aria-label={tr('统计天数')} options={[1, 2, 7, 30, 90].map((d) => ({ value: String(d), label: tr('{d} 天', { d }) }))} />
        <span className="seg mini">{(['calls', 'cost', 'latency', 'tokens'] as const).map((m) => <button key={m} className={metric === m ? 'active' : ''} onClick={() => setMetric(m)}>{{ calls: tr('调用'), cost: tr('费用'), latency: tr('延迟'), tokens: 'token' }[m]}</button>)}</span>
        <SwitchChip on={onlyErr} onChange={setOnlyErr}>{tr('只看失败')}</SwitchChip>
        <span className="grow" />
        <button className="btn sm ghost" onClick={load}>{tr('刷新')}</button>
        <button className="btn sm ghost" onClick={async () => { try { const f = await ws.request<string>({ kind: 'ledger.export', days: Math.max(days, 30) }); toast(tr('已导出 {f}', { f }), true); void ws.request({ kind: 'shell.open', path: f.replace(/[\\/][^\\/]+$/, '') }); } catch (e: any) { toast(e.message); } }}>{tr('导出 CSV')}</button>
      </div>
      <div className="ledger-totals">
        <span><b>{totals.calls}</b> {tr('次调用')}</span>
        <span className={clsx(!!totals.err && 'err')}><b>{totals.err}</b> {tr('失败')}</span>
        <span title={totals.costUnknown ? tr('{costUnknown} 次调用没有可靠价格（非 Claude 模型），不计入', { costUnknown: totals.costUnknown }) : undefined}><b>{totals.costUnknown && !totals.cost ? tr('费用未知') : `$${totals.cost.toFixed(3)}`}</b>{totals.costUnknown && totals.cost ? <span className="muted">{tr('（{costUnknown} 次未知）', { costUnknown: totals.costUnknown })}</span> : null}</span>
        <span>{tr('平均')} <b>{fmtMs(totals.calls ? totals.lat / totals.calls : 0)}</b></span>
        <span>{tr('缓存命中')} <b>{totals.input ? Math.round((totals.cacheRead / totals.input) * 100) : 0}%</b></span>
      </div>
      {byProvider.length > 0 && (
        <details style={{ fontSize: 13, margin: '2px 0 6px' }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>{tr('缓存命中 · 按供应商 × 模型')}</summary>
          {byProvider.map((h) => (
            <div key={`${h.provider}|${h.model}`} style={{ display: 'flex', gap: 8, padding: '1px 0' }} title={tr('输入 {fmtTok} · 缓存读 {fmtTok2} · 缓存写 {fmtTok3}', { fmtTok: fmtTok(h.input), fmtTok2: fmtTok(h.cacheRead), fmtTok3: fmtTok(h.cacheWrite) })}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.provider} · {shortModel(h.model) || h.model}</span>
              <span className="muted">{tr('{calls} 次', { calls: h.calls })}</span>
              <b style={{ minWidth: 40, textAlign: 'right' }}>{Math.round(hitRate(h) * 100)}%</b>
            </div>
          ))}
        </details>
      )}
      <div className="ledger-chart" title={tr('按天 / 小时聚合')}>
        {buckets.map(([k, b]) => (
          <div key={k} className="bar" title={`${k}: ${fmtVal(val(b))}${b.err ? tr(' · {err} 失败', { err: b.err }) : ''}`}>
            <div className={clsx('fill', !!b.err && 'has-err')} style={{ height: `${Math.max(2, (val(b) / max) * 100)}%` }} />
            <span className="lbl">{k.replace(/^\d+\//, '')}</span>
          </div>
        ))}
        {!buckets.length && <div className="empty">{tr('还没有记录（新的调用会自动进账本）')}</div>}
      </div>
      <div className="ledger-table">
        <div className="lh"><span>{tr('时间')}</span><span>{tr('模型')}</span><span>{tr('延迟')}</span><span>{tr('输入')}</span><span>{tr('缓存读')}</span><span>{tr('输出')}</span><span>{tr('费用')}</span><span>{tr('状态')}</span></div>
        {shown.slice(0, 300).map((r, i) => (
          <div key={i} className={clsx('lr', !r.ok && 'err')} title={r.error ?? ''}>
            <span>{new Date(r.ts).toLocaleString(dateLocale(), { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            <span>{shortModel(r.model) || (r.providerId ?? '-')}</span>
            <span>{fmtMs(r.apiMs ?? r.durationMs)}</span>
            <span>{fmtTok(r.input)}</span>
            <span>{fmtTok(r.cacheRead)}</span>
            <span>{fmtTok(r.output)}</span>
            <span title={r.costUnknown ? tr('没有可靠价格（非 Claude 模型 / 外部 agent / 网关行）') : undefined}>{r.costUnknown ? (r.input || r.output || r.cacheRead ? tr('未知') : '-') : r.costUsd ? `$${r.costUsd.toFixed(4)}` : '-'}</span>
            <span className={r.ok ? 'ok' : 'err'} title={r.ok ? tr('成功') : r.error ?? tr('失败')}>{r.ok ? <Icon name="check" size={12} /> : <><Icon name="close" size={12} /> {(r.error ?? '').slice(0, 22)}</>}</span>
          </div>
        ))}
        {rows && !shown.length && <div className="empty">{tr('没有记录')}</div>}
      </div>
    </div>
  );
}
