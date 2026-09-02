import { useEffect, useState } from 'react';
import { useActive } from '@/store';
import { ws } from '@/ws/client';
import { fmtTok, fmtUsd, shortModel, basename } from '@/util';

interface Bucket { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number; costUsd: number }

function Row({ k, b, max }: { k: string; b: Bucket; max: number }) {
  return (
    <div style={{ padding: '3px 0' }}>
      <div style={{ display: 'flex', fontSize: 12 }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={k}>{k}</span>
        <span style={{ color: 'var(--fg-2)' }}>{fmtUsd(b.costUsd)} · {fmtTok(b.input + b.output + b.cacheRead + b.cacheWrite)}</span>
      </div>
      <div className="bar"><i style={{ width: `${max ? (b.costUsd / max) * 100 : 0}%` }} /></div>
    </div>
  );
}

function Totals({ b }: { b: Bucket }) {
  return (
    <div className="kv">
      <span className="k">估算成本</span><span>{fmtUsd(b.costUsd)}</span>
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
  const active = useActive();
  const [tab, setTab] = useState<'session' | 'global'>('session');
  const [days, setDays] = useState(30);
  const [sess, setSess] = useState<{ total: Bucket; byModel: Record<string, Bucket> } | null>(null);
  const [glob, setGlob] = useState<{ total: Bucket; byDay: Record<string, Bucket>; byModel: Record<string, Bucket>; byProject: Record<string, Bucket> } | null>(null);
  const [err, setErr] = useState('');
  const lastResultId = active?.conv.lastResult?.id;

  useEffect(() => {
    if (tab !== 'session' || !active) return;
    ws.request<any>({ kind: 'usage.session', sessionId: active.sessionId }).then(setSess).catch((e) => setErr(e.message));
  }, [tab, active?.sessionId, lastResultId]);
  useEffect(() => {
    if (tab !== 'global') return;
    setGlob(null);
    ws.request<any>({ kind: 'usage.global', days }).then(setGlob).catch((e) => setErr(e.message));
  }, [tab, days]);

  const sorted = (m: Record<string, Bucket>) => Object.entries(m).sort((a, b) => b[1].costUsd - a[1].costUsd);
  const maxOf = (m: Record<string, Bucket>) => Math.max(0, ...Object.values(m).map((b) => b.costUsd));

  return (
    <div>
      <div className="subtabs">
        <button className={tab === 'session' ? 'active' : ''} onClick={() => setTab('session')}>本会话</button>
        <button className={tab === 'global' ? 'active' : ''} onClick={() => setTab('global')}>全局</button>
        {tab === 'global' && (
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ marginLeft: 'auto', background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 4, fontSize: 12 }}>
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
          </div>
        </>
      ) : <div className="empty">{active ? '加载中…' : '没有活动会话'}</div>)}
      {tab === 'global' && (glob ? (
        <>
          <Totals b={glob.total} />
          <div className="section">
            <h5>按天</h5>
            {Object.entries(glob.byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 31).map(([k, b]) => <Row key={k} k={k} b={b} max={maxOf(glob.byDay)} />)}
            <h5>按模型</h5>
            {sorted(glob.byModel).map(([k, b]) => <Row key={k} k={shortModel(k)} b={b} max={maxOf(glob.byModel)} />)}
            <h5>按项目</h5>
            {sorted(glob.byProject).slice(0, 20).map(([k, b]) => <Row key={k} k={basename(k.replace(/^C--/, 'C:/').replace(/-/g, '/'))} b={b} max={maxOf(glob.byProject)} />)}
          </div>
          <div className="empty" style={{ fontSize: 11 }}>成本按公开定价估算，订阅用户仅供参考</div>
        </>
      ) : <div className="empty">扫描 ~/.claude/projects…</div>)}
    </div>
  );
}
