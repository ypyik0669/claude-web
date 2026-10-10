import { useEffect, useState } from 'react';
import { autoContinueAt, disarmAutoContinue, useStore } from '@/store';
import { deriveStall } from '@/model/health';
import { ERROR_HINT, ERROR_LABEL } from '@/model/health';
import { clsx, fmtTok } from '@/util';
import { ws } from '@/ws/client';
import { Icon } from '@/ui/icons';
import { connectModel, loginInTerminal } from '@/features/providers/ConnectModel';
import type { Provider } from '@shared';
import { accountFailed } from './account-fail';

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

/**
 * Chips between the transcript and the composer: stall / error taxonomy / rate limit / auto-continue / context.
 * The queued messages are not here any more: they are cards of their own under this strip (QueueCards.tsx).
 */
export function StatusStrip({ sessionId }: { sessionId: string }) {
  const o = useStore((s) => s.open[sessionId]);
  const meta = useStore((s) => s.sessionMeta[sessionId]);
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const st = useStore.getState;
  const running = !!o && (o.state === 'running' || o.state === 'waiting');
  const armed = autoContinueAt.get(sessionId);
  const rl = o?.conv.rateLimit;
  const rlActive = rl?.status === 'rejected' && (!rl.resetsAt || rl.resetsAt * (rl.resetsAt < 1e12 ? 1000 : 1) > Date.now());
  useTick(running || !!armed || rlActive);
  if (!o) return null;
  const stall = deriveStall({ state: o.state, now: Date.now(), lastEventAt: o.conv.lastEventAt, lastModelCallAt: o.conv.lastModelCallAt, turnStartedAt: o.conv.turnStartedAt, runningTool: o.conv.runningTool, compacting: o.conv.compacting });
  const res = o.conv.lastResult;
  const showErr = !running && res?.isError && res.errorKind && o.conv.items[o.conv.items.length - 1]?.kind === 'result';
  const cu = o.contextUsage ?? o.conv.contextUsage;
  // the percentage itself is the composer ring's job; here only the action, and only when it is nearly full
  const cuWarn = cu && cu.percentage >= 95;
  // the ordinary running states (tool / quiet / compacting) are the run card's job now; what is left
  // here is only what the run card cannot say: it is stuck, it failed, it is throttled
  const alarm = stall?.kind === 'no_model' || stall?.kind === 'no_reply' ? stall : null;
  const upstream = o.info?.providerName ? `「${o.info.providerName}」` : '';
  // the Claude account was never logged in (「Not logged in · Please run /login」 — there is no /login here): a retry
  // fails the same way; switch this conversation to a model instead, or log in
  const noLogin = !!showErr && res?.errorKind === 'credential' && /not logged in|run \/login/i.test(res.text ?? '');
  const switchTo = async (p: Provider) => {
    try {
      await ws.request({ kind: 'session.setProvider', sessionId, providerId: p.id });
      if (st().open[sessionId]?.lastSent) await st().retryLast(sessionId);
      else st().toast(`这个对话已改用「${p.name}」，再发一次消息就行`);
    } catch (e: any) { st().toast(e?.message ?? String(e)); }
  };
  const useModel = async () => {
    const p = await connectModel({ reason: 'session' });
    if (p) await switchTo(p);
  };
  // on the Claude account, not on the providers the user added: say so, one click over (account-fail.ts)
  const accountFail = !!showErr && !noLogin && accountFailed({ sessionId, errorKind: res?.errorKind, agent: o.info?.agent, hasInfo: !!o.info, live: o.info?.providerId, recorded: meta?.providerId, providers: providers.length });
  const nothing = !alarm && !showErr && !rlActive && !armed && !cuWarn;
  if (nothing) return null;
  const resetAt = rl?.resetsAt ? rl.resetsAt * (rl.resetsAt < 1e12 ? 1000 : 1) : undefined;
  return (
    <div className="status-strip">
      {alarm && (
        <span className="chip warn">
          {alarm.kind === 'no_reply'
            ? `${alarm.minutes} 分钟还没收到模型的任何回复，供应商${upstream}可能没有响应`
            : `${alarm.minutes} 分钟没有模型调用了，可能卡住`}
          <button className="link" onClick={() => void st().interrupt(sessionId)}>中断</button>
        </span>
      )}
      {showErr && res && noLogin && (
        <span className="chip err" title={res.text} data-err="no-login">
          Claude 账号还没登录 · 接一个模型（API Key）继续这个对话，或者登录 Claude 账号
          <button className="link" data-act="connect" onClick={() => void useModel()}>接一个模型</button>
          <button className="link" data-act="login" onClick={loginInTerminal}>用 Claude 账号登录</button>
        </span>
      )}
      {showErr && res && accountFail && (
        <span className="chip err" title={res.text} data-err="account-not-provider">
          {ERROR_LABEL[res.errorKind!]} · 这个对话用的是「Claude 账号」，没有经过你添加的{providers.length === 1 ? `「${providers[0].name}」` : '供应商'}
          {providers.length === 1
            ? <button className="link" data-act="use-provider" onClick={() => void switchTo(providers[0])}>改用「{providers[0].name}」重试</button>
            : <button className="link" data-act="use-provider" onClick={() => void useModel()}>改用供应商重试</button>}
          {o.lastSent && <button className="link" onClick={() => st().retryLast(sessionId)}>重试</button>}
        </span>
      )}
      {showErr && res && !noLogin && !accountFail && (
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
      {/* ≥ 95 % only, and only the action: the ring in the composer already says how full it is */}
      {cuWarn && cu && (
        <span className="chip err ctx-full" title={`上下文 ${cu.percentage}% · ${fmtTok(cu.totalTokens)} / ${fmtTok(cu.maxTokens)}`}>
          {cu.overLimit ? '上下文已超限' : '上下文快满了'}
          <button className="link" onClick={() => st().send(sessionId, '/compact')}>/compact 压缩</button>
        </span>
      )}
      {/* keep the strip subscribed to the ws so the compact request resolves */}
      <span hidden>{String(!!ws)}</span>
    </div>
  );
}
