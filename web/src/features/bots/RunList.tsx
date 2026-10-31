import { useEffect, useState } from 'react';
import type { AuditBasis, AuditRow, BotRun, BotStatus, RunTrigger } from '@shared';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { clsx, fmtMs } from '@/util';
import { dateLocale, tr } from '@/i18n';
import { classLabel, levelLabel, runCost } from './model';
import { closeBots, loadAudit, loadRuns, useBots } from './state';

const NO_RUNS: BotRun[] = [];
const SAID_MAX = 200;

function triggerLabel(t: RunTrigger): string {
  switch (t) {
    case 'cron': return tr('定时');
    case 'manual': return tr('手动');
    case 'dispatch': return tr('派活');
    case 'resume': return tr('接着跑');
  }
}

function basisLabel(b: AuditBasis): string {
  switch (b) {
    case 'rule': return tr('规则');
    case 'trust': return tr('信任');
    case 'user': return tr('你批的');
    case 'autopilot': return tr('全自动');
    case 'unleashed': return tr('放开全部');
  }
}

function resultLabel(r: AuditRow['result']): string {
  switch (r) {
    case 'allowed': return tr('放行');
    case 'denied': return tr('拦下');
    case 'queued': return tr('等你批');
  }
}

const clock = (t: number) => new Date(t).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const stamp = (t: number) => new Date(t).toLocaleString(dateLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Back to the conversation a run had (read from disk when it isn't open). */
export function openRunChat(sessionId: string): void {
  closeBots();
  const st = useStore.getState();
  if (st.open[sessionId]) st.openInPane(sessionId, 'replace');
  else void st.loadHistory(sessionId);
}

/** Every tool call the gate saw in one run — what the bot did, from the audit, not from what it said. */
function Audit({ botId, runId }: { botId: string; runId: string }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    loadAudit(botId, runId).then((r) => { if (live) setRows(r); }).catch((e: any) => { if (live) setErr(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [botId, runId]);
  if (err) return <div className="bd-note">{tr('读不到审计：{err}', { err })}</div>;
  if (!rows) return <div className="bd-note">{tr('读取中…')}</div>;
  if (!rows.length) return <div className="bd-note">{tr('这次运行没有调用工具')}</div>;
  return (
    <table className="bd-table bd-audit">
      <thead><tr><th>{tr('时间')}</th><th>{tr('类别')}</th><th>{tr('档位')}</th><th>{tr('依据')}</th><th>{tr('摘要')}</th><th>{tr('结果')}</th></tr></thead>
      <tbody>
        {rows.map((a, i) => (
          <tr key={i} data-result={a.result}>
            <td className="bd-when">{clock(a.at)}</td>
            <td>{classLabel(a.cls)}</td>
            <td>{levelLabel(a.level)}</td>
            <td>{basisLabel(a.basis)}{a.scope && a.scope !== '*' ? ` · ${a.scope}` : ''}</td>
            <td className="bd-sum" title={a.toolName}>{a.summary}{a.undo && <div className="bd-undo">{tr('怎么撤：{undo}', { undo: a.undo })}</div>}</td>
            <td className={clsx('bd-result', a.result)}>{resultLabel(a.result)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunRow({ bot, run }: { bot: BotStatus; run: BotRun }) {
  const [audit, setAudit] = useState(false);
  const routine = bot.routines.find((r) => r.id === run.routineId);
  const said = run.said ? (run.said.length > SAID_MAX ? `${run.said.slice(0, SAID_MAX)}…` : run.said) : '';
  const going = !run.endedAt && !run.skipped;
  const facts = [
    triggerLabel(run.trigger),
    run.skipped ? tr('跳过') : going ? tr('在跑') : tr('跑了'),
    !run.skipped && (run.usedScript ? tr('脚本') : tr('模型')),
    !run.skipped && runCost(run),
    run.durationMs ? fmtMs(run.durationMs) : '',
  ].filter(Boolean);
  return (
    <li className={clsx('bd-run', run.skipped && 'skipped', run.ok === false && 'failed')} data-id={run.id}>
      <div className="bd-run-head">
        <span className="bd-when">{stamp(run.at)}</span>
        <span className="bd-run-name">{routine?.name ?? run.routineId}</span>
        <span className="bd-run-facts">{facts.join(' · ')}</span>
        <span className="grow" />
        {run.verified && <span className={clsx('bd-verdict', run.verified.ok ? 'ok' : 'bad')} title={tr('验收')}>{run.verified.ok ? '✓' : '✗'} {tr('验收')}</span>}
        {!run.skipped && <button className="btn sm ghost" aria-expanded={audit} onClick={() => setAudit(!audit)}>{tr('审计')}</button>}
        {run.sessionId && <button className="btn sm ghost" title={tr('打开这次运行的对话')} onClick={() => openRunChat(run.sessionId!)}><Icon name="chat" size={12} />{tr('打开对话')}</button>}
      </div>
      {run.error && <div className="bd-err">{run.error}</div>}
      {!run.skipped && (said || run.verified) && (
        <div className="bd-said">
          <div><div className="bd-said-h">{tr('Bot 说的')}</div><div className="bd-said-t">{said || '—'}</div></div>
          <div><div className="bd-said-h">{tr('核实到的')}</div><div className="bd-said-t">{run.verified?.note || (run.verified ? (run.verified.ok ? tr('验收通过') : tr('验收没过')) : tr('没有验收'))}</div></div>
        </div>
      )}
      {audit && <Audit botId={bot.id} runId={run.id} />}
    </li>
  );
}

/** The bot's runs, newest first: trigger, skipped or ran, script or model, cost, acceptance, said vs verified. */
export function RunList({ bot }: { bot: BotStatus }) {
  const runs = useBots((s) => s.runs[bot.id]) ?? NO_RUNS;
  useEffect(() => { void loadRuns(bot.id); }, [bot.id]);
  if (!runs.length) return <div className="bd-note">{tr('还没有运行记录。例行跑过一次之后会出现在这里。')}</div>;
  return <ul className="bd-runs">{runs.map((r) => <RunRow key={r.id} bot={bot} run={r} />)}</ul>;
}
