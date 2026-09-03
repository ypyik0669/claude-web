import { useEffect, useState } from 'react';
import { autoContinueAt, disarmAutoContinue, useStore } from '@/store';
import { deriveStall } from '@/model/health';
import { ERROR_HINT, ERROR_LABEL } from '@/model/health';
import { clsx, fmtTok } from '@/util';
import { ws } from '@/ws/client';
import { Icon } from '@/ui/icons';

function useTick(active: boolean, ms = 1000) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

function countdown(at: number) {
  const s = Math.max(0, Math.round((at - Date.now()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function ContextRing({ pct }: { pct: number }) {
  const r = 6, c = 2 * Math.PI * r;
  const p = Math.min(100, Math.max(0, pct));
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="ctx-ring">
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--bg-3)" strokeWidth="2.5" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={`${(p / 100) * c} ${c}`} strokeLinecap="round" transform="rotate(-90 8 8)" />
    </svg>
  );
}

/** Chips between the transcript and the composer: stall / compaction / error taxonomy / rate limit / context / queue. */
export function StatusStrip({ sessionId, onRecall }: { sessionId: string; onRecall: (text: string) => void }) {
  const o = useStore((s) => s.open[sessionId]);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const st = useStore.getState;
  const running = !!o && (o.state === 'running' || o.state === 'waiting');
  const armed = autoContinueAt.get(sessionId);
  const rl = o?.conv.rateLimit;
  const rlActive = rl?.status === 'rejected' && (!rl.resetsAt || rl.resetsAt * (rl.resetsAt < 1e12 ? 1000 : 1) > Date.now());
  useTick(running || !!armed || rlActive);
  if (!o) return null;
  const stall = deriveStall({ state: o.state, now: Date.now(), lastEventAt: o.conv.lastEventAt, lastModelCallAt: o.conv.lastModelCallAt, runningTool: o.conv.runningTool, compacting: o.conv.compacting });
  const res = o.conv.lastResult;
  const showErr = !running && res?.isError && res.errorKind && o.conv.items[o.conv.items.length - 1]?.kind === 'result';
  const cu = o.contextUsage ?? o.conv.contextUsage;
  const cuWarn = cu && cu.percentage >= 80;
  // the ordinary running states (tool / quiet / compacting) are the run card's job now; what is left
  // here is only what the run card cannot say: it is stuck, it failed, it is throttled, it is queued
  const alarm = stall?.kind === 'no_model' ? stall : null;
  const nothing = !alarm && !showErr && !rlActive && !armed && !o.queue.length && !cuWarn;
  if (nothing) return null;
  const resetAt = rl?.resetsAt ? rl.resetsAt * (rl.resetsAt < 1e12 ? 1000 : 1) : undefined;
  return (
    <div className="status-strip">
      {alarm && (
        <span className="chip warn">
          {alarm.minutes} 分钟没有模型调用了，可能卡住
          <button className="link" onClick={() => st().interrupt(sessionId)}>中断</button>
        </span>
      )}
      {showErr && res && (
        <span className={clsx('chip', res.errorKind === 'aborted' ? 'muted' : 'err')} title={res.text}>
          {ERROR_LABEL[res.errorKind!]}{res.apiStatus ? ` HTTP ${res.apiStatus}` : ''} · {ERROR_HINT[res.errorKind!]}
          {res.errorKind !== 'aborted' && res.errorKind !== 'context' && o.lastSent && <button className="link" onClick={() => st().retryLast(sessionId)}>重试</button>}
          {res.errorKind === 'context' && <button className="link" onClick={() => st().send(sessionId, '/compact')}>/compact</button>}
        </span>
      )}
      {rlActive && (
        <span className="chip warn">
          额度用尽{resetAt ? ` · ${countdown(resetAt)} 后重置` : ''}
          <label className="inline">
            <input type="checkbox" checked={!!settings.autoContinueOnReset} onChange={(e) => { void setSetting('autoContinueOnReset', e.target.checked); if (!e.target.checked) disarmAutoContinue(sessionId); }} />
            额度恢复后自动继续
          </label>
        </span>
      )}
      {armed && <span className="chip"><span className="spinner" /> {countdown(armed)} 后自动继续 <button className="link" onClick={() => { disarmAutoContinue(sessionId); useStore.setState({}); }}>取消</button></span>}
      {cuWarn && cu && (
        <span className={clsx('chip', cu.percentage >= 95 ? 'err' : 'warn')} title={`${fmtTok(cu.totalTokens)} / ${fmtTok(cu.maxTokens)}`}>
          <ContextRing pct={cu.percentage} /> 上下文 {cu.percentage}%{cu.overLimit ? ' · 已超限' : ''}
          <button className="link" onClick={() => st().send(sessionId, '/compact')}>/compact</button>
        </span>
      )}
      {o.queue.length > 0 && (
        <div className="queue-list">
          {o.queue.map((q, i) => (
            <div key={q.id} className="queue-item">
              <span className="pos">#{i + 1}</span>
              <span className="tx" title={q.text}>{q.text.slice(0, 120)}{q.text.length > 120 ? '…' : ''}{q.attachments?.length ? ` · ${q.attachments.length} 个附件` : ''}{q.images?.length ? ` · ${q.images.length} 张图` : ''}</span>
              <button className="link" title="撤回到输入框" onClick={() => { const m = st().recall(sessionId, q.id); if (m) onRecall(m.text); }}>撤回</button>
              <button className="link" title="中断当前轮，立刻发送这条" onClick={() => st().stopAndRun(sessionId, q.id)}>停止并发送</button>
            </div>
          ))}
          <div className="tool-meta">排队消息在当前轮结束后按顺序发送 · 用「插话」可以不中断地传递指令</div>
        </div>
      )}
      {/* keep the strip subscribed to the ws so the compact request resolves */}
      <span hidden>{String(!!ws)}</span>
    </div>
  );
}
