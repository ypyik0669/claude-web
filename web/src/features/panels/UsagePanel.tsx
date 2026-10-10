import { useEffect, useState } from 'react';
import { useScopedSession } from '@/store';
import { ws } from '@/ws/client';
import { LedgerView } from './LedgerView';
import { fmtTok, shortModel, basename } from '@/util';
import { byTokens, fmtCost, tokensOf } from '@/model/cost';
import { hitRate } from './ledger-stats';

/** `costUnknown`: how many calls had no real price (non-Claude models) — shown as 「费用未知」, not $0 */
interface Bucket { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number; costUsd: number; costUnknown?: number }

function Row({ k, b, max }: { k: string; b: Bucket; max: number }) {
  return (
    <div style={{ padding: '3px 0' }}>
      <div style={{ display: 'flex', fontSize: 13 }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={k}>{k}</span>
        <span style={{ color: 'var(--fg-2)' }}>{fmtCost(b.costUsd, b.costUnknown)} · {fmtTok(tokensOf(b))} · 命中 {Math.round(hitRate(b) * 100)}%</span>
      </div>
      <div className="bar"><i style={{ width: `${max ? (tokensOf(b) / max) * 100 : 0}%` }} /></div>
    </div>
  );
}

function Totals({ b }: { b: Bucket }) {
  return (
    <div className="kv">
      <span className="k">估算成本</span><span title={b.costUnknown ? `${b.costUnknown} 次调用没有可靠价格（非 Claude 模型）` : undefined}>{fmtCost(b.costUsd, b.costUnknown)}</span>
      <span className="k">API 调用</span><span>{b.turns}</span>
      <span className="k">输入</span><span>{fmtTok(b.input)}</span>
      <span className="k">输出</span><span>{fmtTok(b.output)}</span>
      <span className="k">缓存读</span><span>{fmtTok(b.cacheRead)}</span>
      <span className="k">缓存写</span><span>{fmtTok(b.cacheWrite)}</span>
      <span className="k">缓存命中</span><span>{b.input + b.cacheRead ? `${Math.round((b.cacheRead / (b.input + b.cacheRead + b.cacheWrite)) * 100)}%` : '-'}</span>
    </div>
  );
}

export function UsagePanel() {
  const active = useScopedSession();
  const [tab, setTab] = useState<'session' | 'global' | 'ledger'>('session');
  const [days, setDays] = useState(30);
  const [sess, setSess] = useState<{ total: Bucket; byModel: Record<string, Bucket>; byProvider?: Record<string, Bucket> } | null>(null);
  const [glob, setGlob] = useState<{ total: Bucket; byDay: Record<string, Bucket>; byModel: Record<string, Bucket>; byProject: Record<string, Bucket>; byProvider?: Record<string, Bucket> } | null>(null);
  const [err, setErr] = useState('');
  const lastResultId = active?.conv.lastResult?.id;

  const sid = active?.sessionId;
  // don't show the previous session's numbers while this one loads
  useEffect(() => { setSess(null); }, [sid]);
  useEffect(() => {
    if (tab !== 'session' || !sid) return;
    let live = true;
    setErr('');
    ws.request<any>({ kind: 'usage.session', sessionId: sid }).then((r) => live && setSess(r)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [tab, sid, lastResultId]);
  useEffect(() => {
    if (tab !== 'global') return;
    let live = true;
    setGlob(null);
    setErr('');
    ws.request<any>({ kind: 'usage.global', days }).then((r) => live && setGlob(r)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [tab, days]);

  // by tokens, not cost: sorting by cost sinks every model whose price is unknown
  const sorted = (m: Record<string, Bucket>) => Object.entries(m).sort(byTokens);
  const maxOf = (m: Record<string, Bucket>) => Math.max(0, ...Object.values(m).map(tokensOf));

  return (
    <div>
      <div className="subtabs">
        <button className={tab === 'session' ? 'active' : ''} onClick={() => setTab('session')}>本对话</button>
        <button className={tab === 'global' ? 'active' : ''} onClick={() => setTab('global')}>全局</button>
        <button className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}>账本</button>
        {tab === 'global' && (
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ marginLeft: 'auto', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 4, fontSize: 13 }}>
            {[7, 30, 90, 365].map((d) => <option key={d} value={d}>{d} 天</option>)}
          </select>
        )}
      </div>
      {err && <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>}
      {tab === 'session' && (sess ? (
        <>
          <Totals b={sess.total} />
          <div className="section">
            <h5>按模型</h5>
            {sorted(sess.byModel).map(([k, b]) => <Row key={k} k={shortModel(k)} b={b} max={maxOf(sess.byModel)} />)}
            {sess.byProvider && <><h5>按供应商 × 模型</h5>{sorted(sess.byProvider).map(([k, b]) => <Row key={k} k={k} b={b} max={maxOf(sess.byProvider!)} />)}</>}
          </div>
        </>
      ) : <div className="empty">{active ? '加载中…' : '没有打开的对话'}</div>)}
      {tab === 'ledger' && <LedgerView />}
      {tab === 'global' && (glob ? (
        <>
          <Totals b={glob.total} />
          <div className="section">
            <h5>按天</h5>
            {Object.entries(glob.byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 31).map(([k, b]) => <Row key={k} k={k} b={b} max={maxOf(glob.byDay)} />)}
            <h5>按模型</h5>
            {sorted(glob.byModel).map(([k, b]) => <Row key={k} k={shortModel(k)} b={b} max={maxOf(glob.byModel)} />)}
            {glob.byProvider && <><h5>按供应商 × 模型</h5>{sorted(glob.byProvider).map(([k, b]) => <Row key={k} k={k} b={b} max={maxOf(glob.byProvider!)} />)}</>}
            <h5>按项目</h5>
            {sorted(glob.byProject).slice(0, 20).map(([k, b]) => <Row key={k} k={basename(k.replace(/^C--/, 'C:/').replace(/-/g, '/'))} b={b} max={maxOf(glob.byProject)} />)}
          </div>
          <div className="empty" style={{ fontSize: 12 }}>成本按 Claude 公开定价估算，其它厂商的模型显示「费用未知」；各组按用量（token）排序。订阅用户仅供参考</div>
        </>
      ) : <div className="empty">扫描 ~/.claude/projects…</div>)}
    </div>
  );
}
