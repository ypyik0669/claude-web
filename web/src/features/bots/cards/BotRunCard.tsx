// 值班 Bot thread: a routine run — 「例行 · 早间简报 · 用时 46 s · 一句结论」 + 打开; while it runs 「在跑…」 and how long.
import { useEffect, useState } from 'react';
import type { BotRun, BotTimelineEntry } from '@shared';
import { tr } from '@/i18n';
import { useThreadNav } from './nav';

const firstLine = (s: string | undefined) => (s ?? '').trim().split('\n')[0]?.slice(0, 160) ?? '';

export function BotRunCard({ entry, run, routineName }: { entry: BotTimelineEntry; run?: BotRun; routineName?: string }) {
  const nav = useThreadNav();
  const name = routineName ?? entry.text ?? run?.routineId ?? '';
  const going = !!run && !run.endedAt && !run.skipped;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!going) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [going]);
  const secs = run ? Math.max(0, Math.round((run.durationMs ?? ((run.endedAt ?? now) - run.at)) / 1000)) : undefined;
  const parts = [tr('例行'), name];
  if (run?.skipped) parts.push(tr('没有变化，跳过'));
  else if (going) parts.push(tr('在跑… {s} s', { s: secs ?? 0 }));
  else if (secs !== undefined) parts.push(tr('用时 {s} s', { s: secs }));
  const said = going ? '' : run?.ok === false ? (run.error || tr('没成')) : firstLine(run?.said);
  return (
    <div className="bt-card bt-run" data-state={going ? 'running' : run?.ok === false ? 'failed' : 'done'}>
      <div className="bt-run-line">
        <span className="bt-run-h">{parts.join(' · ')}</span>
        {run?.sessionId && nav && <button className="btn sm" onClick={() => nav.openRun(run.sessionId!, name)}>{tr('打开')}</button>}
      </div>
      {said && <div className="bt-run-said">{said}</div>}
    </div>
  );
}
