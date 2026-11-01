import { useEffect, useMemo, useRef, useState } from 'react';
import type { LedgerEntry } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { hitRate, pickRows, profileName } from '@/features/panels/ledger-stats';
import { Icon } from '@/ui/icons';
import { clsx, fmtMs, fmtTok, fmtUsd, shortModel } from '@/util';
import { dateLocale, tr } from '@/i18n';

type RangeId = 'today' | '7d' | '30d' | 'all';
const RANGES: { id: RangeId; label: string; days: number }[] = [
  { id: 'today', label: tr('今天'), days: 1 },
  { id: '7d', label: tr('7 天'), days: 7 },
  { id: '30d', label: tr('30 天'), days: 30 },
  { id: 'all', label: tr('全部'), days: 36500 },
];
type Tab = 'requests' | 'sessions' | 'context';
const DAY = 86_400_000;

const tokensOf = (r: LedgerEntry) => r.input + r.output + r.cacheRead + r.cacheWrite;

/** A compact column chart: one column per hour (today) or day; hover names the bucket. */
function Columns({ data }: { data: { label: string; tokens: number; calls: number; cost: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.tokens));
  return (
    <div className="hub-bars" role="img" aria-label={tr('按时间的用量')}>
      {data.map((d, i) => (
        <span
          key={`${d.label}-${i}`}
          className="hub-bar-col"
          title={`${d.label} · ${tr('{tokens} tokens', { tokens: fmtTok(d.tokens) })} · ${tr('{n} 次调用', { n: d.calls })} · ${fmtUsd(d.cost)}`}
          style={{ height: `${Math.max(1, (d.tokens / max) * 100)}%` }}
        />
      ))}
      {!data.length && <span className="hub-muted hub-sml">{tr('还没有数据')}</span>}
    </div>
  );
}

/**
 * 用量 (spec §6.8): the token / cost total with its curve, a split by provider, and 请求 / 对话 / 上下文 tables.
 * Reads the ledger (one row per model call).
 */
export function UsagePage() {
  const providers = useStore((s) => s.providers);
  const toast = useStore((s) => s.toast);
  const [range, setRange] = useState<RangeId>('today');
  const [tab, setTab] = useState<Tab>('requests');
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const def = RANGES.find((r) => r.id === range) ?? RANGES[0];

  const load = async (r: RangeId = range) => {
    const n = ++seq.current;
    const days = (RANGES.find((x) => x.id === r) ?? RANGES[0]).days;
    setBusy(true);
    try {
      const rows = await ws.request<LedgerEntry[]>({ kind: 'ledger.list', days });
      if (n === seq.current) setEntries(rows);
    } catch (e: any) { if (n === seq.current) toast(e.message); }
    finally { if (n === seq.current) setBusy(false); }
  };

  useEffect(() => { void load(range); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [range]);

  const picked = useMemo(() => pickRows(entries ?? [], 'all').rows, [entries]);
  const totals = useMemo(() => {
    const t = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0, costUnknown: 0, ms: 0, errors: 0 };
    for (const r of picked) {
      t.calls++;
      t.input += r.input;
      t.cacheRead += r.cacheRead;
      t.cacheWrite += r.cacheWrite;
      t.output += r.output;
      t.cost += r.costUsd;
      if (r.costUnknown && (r.input || r.output || r.cacheRead)) t.costUnknown++;
      t.ms += r.apiMs ?? r.durationMs;
      if (!r.ok) t.errors++;
    }
    return t;
  }, [picked]);
  const tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

  const buckets = useMemo(() => {
    const hourly = range === 'today';
    const days = hourly ? 1 : range === '7d' ? 7 : 30;
    const out: { label: string; tokens: number; calls: number; cost: number }[] = [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    if (hourly) {
      const nowHour = new Date().getHours();
      for (let h = 0; h <= nowHour; h++) out.push({ label: `${String(h).padStart(2, '0')}:00`, tokens: 0, calls: 0, cost: 0 });
      for (const r of picked) {
        const b = out[new Date(r.ts).getHours()];
        if (!b) continue;
        b.tokens += tokensOf(r); b.calls++; b.cost += r.costUsd;
      }
      return out;
    }
    const byKey = new Map<string, { tokens: number; calls: number; cost: number }>();
    for (const r of picked) {
      const d = new Date(r.ts);
      const key = `${d.getMonth() + 1}/${d.getDate()}`;
      const b = byKey.get(key) ?? byKey.set(key, { tokens: 0, calls: 0, cost: 0 }).get(key)!;
      b.tokens += tokensOf(r); b.calls++; b.cost += r.costUsd;
    }
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(start.getTime() - i * DAY);
      const key = `${d.getMonth() + 1}/${d.getDate()}`;
      const b = byKey.get(key) ?? { tokens: 0, calls: 0, cost: 0 };
      out.push({ label: key, ...b });
    }
    return out;
  }, [picked, range]);

  const bySource = useMemo(() => {
    const m = new Map<string, { tokens: number; calls: number; cost: number }>();
    for (const r of picked) {
      const name = profileName(providers, r.providerId);
      const b = m.get(name) ?? m.set(name, { tokens: 0, calls: 0, cost: 0 }).get(name)!;
      b.tokens += tokensOf(r); b.calls++; b.cost += r.costUsd;
    }
    return [...m.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 6);
  }, [picked, providers]);

  const sessions = useMemo(() => {
    const m = new Map<string, { calls: number; tokens: number; cost: number; last: number; models: Set<string> }>();
    for (const r of picked) {
      const key = r.sessionId || '';
      const b = m.get(key) ?? m.set(key, { calls: 0, tokens: 0, cost: 0, last: 0, models: new Set<string>() }).get(key)!;
      b.calls++; b.tokens += tokensOf(r); b.cost += r.costUsd; b.last = Math.max(b.last, r.ts);
      if (r.model) b.models.add(r.model);
    }
    return [...m.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, 40);
  }, [picked]);

  const composition = [
    { id: 'input', label: tr('新输入'), value: totals.input, tone: 'c1' },
    { id: 'cacheRead', label: tr('缓存读'), value: totals.cacheRead, tone: 'c2' },
    { id: 'cacheWrite', label: tr('缓存写'), value: totals.cacheWrite, tone: 'c3' },
    { id: 'output', label: tr('输出'), value: totals.output, tone: 'c4' },
  ];
  const compBase = composition.reduce((n, c) => n + c.value, 0);
  const cacheShare = compBase ? totals.cacheRead / compBase : 0;
  const outShare = compBase ? totals.output / compBase : 0;
  const tags = [
    cacheShare > 0.45 ? tr('缓存友好') : '',
    outShare > 0.35 ? tr('输出偏多') : '',
    compBase && totals.input / compBase > 0.6 ? tr('上下文偏重') : '',
  ].filter(Boolean);

  const exportCsv = async () => {
    try {
      const f = await ws.request<string>({ kind: 'ledger.export', days: def.days });
      toast(tr('已导出 {f}', { f }), true);
      void ws.request({ kind: 'shell.open', path: f.replace(/[\\/][^\\/]+$/, '') });
    } catch (e: any) { toast(e.message); }
  };

  return (
    <div className="hub-body">
      <div className="hub-toolbar">
        <div className="hub-seg" role="tablist" aria-label={tr('时间范围')}>
          {RANGES.map((r) => (
            <button key={r.id} role="tab" aria-selected={range === r.id} className={range === r.id ? 'on' : ''} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
        <span className="hub-grow" />
        <button className="btn sm ghost" disabled={busy} onClick={() => void load()}><Icon name="refresh" size={12} /> {busy ? tr('刷新中…') : tr('刷新')}</button>
        <button className="btn sm ghost" onClick={() => void exportCsv()}><Icon name="share" size={12} /> {tr('导出')}</button>
      </div>

      <div className="hub-grid-3 hub-usage-cards">
        <section className="hub-card hub-usage-total">
          <div className="hd"><h3>{tr('Token / 费用')}</h3></div>
          <div className="bd">
            <div className="hub-total-row">
              <span><span className="l">{tr('总 Token')}</span><b>{fmtTok(tokens)}</b></span>
              <span><span className="l">{tr('缓存命中')}</span><b>{(hitRate({ input: totals.input, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite }) * 100).toFixed(1)}%</b></span>
              <span><span className="l">{tr('费用')}</span><b>{totals.costUnknown && !totals.cost ? tr('未知') : fmtUsd(totals.cost)}</b></span>
            </div>
            {totals.costUnknown > 0 && <div className="hub-meta">{tr('{n} 次调用没有可靠价格，不计入费用', { n: totals.costUnknown })}</div>}
            <Columns data={buckets} />
          </div>
        </section>

        <section className="hub-card">
          <div className="hd"><h3>{tr('按供应商')}</h3></div>
          <div className="bd hub-split">
            {bySource.map(([name, b]) => (
              <div key={name}>
                <div className="l"><span title={name}>{name}</span><span>{tokens ? `${((b.tokens / tokens) * 100).toFixed(0)}%` : '0%'}</span></div>
                <div className="hub-bar"><i style={{ width: `${tokens ? Math.max(1, (b.tokens / tokens) * 100) : 0}%` }} /></div>
              </div>
            ))}
            {!bySource.length && <div className="hub-empty-inline">{tr('还没有用量')}</div>}
          </div>
        </section>

        <section className="hub-card">
          <div className="hd"><h3>{tr('概览')}</h3></div>
          <div className="bd hub-split">
            <div className="l"><span>{tr('调用')}</span><b>{totals.calls}</b></div>
            <div className="l"><span>{tr('失败')}</span><b className={totals.errors ? 'err' : ''}>{totals.errors}</b></div>
            <div className="l"><span>{tr('平均延迟')}</span><b>{totals.calls ? fmtMs(totals.ms / totals.calls) : '—'}</b></div>
            <div className="l"><span>{tr('费用')}</span><b>{totals.costUnknown && !totals.cost ? tr('未知') : fmtUsd(totals.cost)}</b></div>
          </div>
        </section>
      </div>

      <section className="hub-card hub-usage-table">
        <div className="hd">
          <div className="hub-seg" role="tablist" aria-label={tr('用量明细')}>
            {(['requests', 'sessions', 'context'] as const).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                {t === 'requests' ? tr('请求') : t === 'sessions' ? tr('对话') : tr('上下文')}
              </button>
            ))}
          </div>
          <span className="hub-grow" />
          {entries && <span className="hub-muted hub-sml">{tr('{n} 条记录', { n: entries.length })}</span>}
        </div>
        <div className="bd">
          {tab === 'requests' && (
            <table className="hub-table">
              <thead><tr><th>{tr('时间')}</th><th>{tr('供应商')}</th><th>{tr('模型')}</th><th className="num">{tr('Token')}</th><th className="num">{tr('费用')}</th><th className="num">{tr('延迟')}</th><th>{tr('状态')}</th></tr></thead>
              <tbody>
                {picked.slice().reverse().slice(0, 200).map((r, i) => (
                  <tr key={`${r.ts}-${i}`}>
                    <td className="hub-mono">{new Date(r.ts).toLocaleString(dateLocale(), { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{profileName(providers, r.providerId)}</td>
                    <td title={r.model}>{shortModel(r.model) || '-'}</td>
                    <td className="num hub-mono">{fmtTok(tokensOf(r))}</td>
                    <td className="num hub-mono" title={r.costUnknown ? tr('没有可靠价格') : undefined}>{r.costUnknown ? (tokensOf(r) ? tr('未知') : '-') : r.costUsd ? fmtUsd(r.costUsd) : '-'}</td>
                    <td className="num hub-mono">{fmtMs(r.apiMs ?? r.durationMs)}</td>
                    <td><span className={clsx('hub-chip', r.ok ? 'green' : 'danger')} title={r.error}>{r.ok ? tr('成功') : tr('失败')}</span></td>
                  </tr>
                ))}
                {!picked.length && <tr><td colSpan={7} className="hub-empty-cell">{entries ? tr('还没有用量记录') : tr('读取中…')}</td></tr>}
              </tbody>
            </table>
          )}
          {tab === 'sessions' && (
            <table className="hub-table">
              <thead><tr><th>{tr('对话')}</th><th className="num">{tr('调用')}</th><th className="num">{tr('Token')}</th><th className="num">{tr('费用')}</th><th>{tr('最近')}</th></tr></thead>
              <tbody>
                {sessions.map(([id, b]) => (
                  <tr key={id || '-'}>
                    <td title={id || tr('网关调用')}>{id ? id.slice(0, 18) : tr('网关调用')}</td>
                    <td className="num hub-mono">{b.calls}</td>
                    <td className="num hub-mono">{fmtTok(b.tokens)}</td>
                    <td className="num hub-mono">{fmtUsd(b.cost)}</td>
                    <td className="hub-mono">{new Date(b.last).toLocaleString(dateLocale(), { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  </tr>
                ))}
                {!sessions.length && <tr><td colSpan={5} className="hub-empty-cell">{entries ? tr('还没有用量记录') : tr('读取中…')}</td></tr>}
              </tbody>
            </table>
          )}
          {tab === 'context' && (
            <div className="hub-context">
              <div className="hub-context-head">
                <b>{tr('输入构成')}</b>
                {tags.map((t) => <span className="hub-chip" key={t}>{t}</span>)}
              </div>
              {composition.map((c) => (
                <div className="hub-context-row" key={c.id}>
                  <span className="l">{c.label}</span>
                  <span className="hub-bar"><i className={c.tone} style={{ width: `${compBase ? (c.value / compBase) * 100 : 0}%` }} /></span>
                  <span className="v hub-mono">{fmtTok(c.value)} · {compBase ? `${((c.value / compBase) * 100).toFixed(1)}%` : '0%'}</span>
                </div>
              ))}
              <div className="hub-meta">{tr('更细的构成（系统 / 工具 / 指令 / 文件 / 对话）要等网关记录请求明细；现在按输入、缓存和输出统计。')}</div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
