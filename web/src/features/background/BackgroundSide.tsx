import { useEffect, useMemo, useState } from 'react';
import type { BgRunSummary, BgSession } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { BG_TITLE, clock, hasLive, liveCounts, sortSessions } from './model';
import { selectBackground, useBackground } from './state';
import { tr } from '@/i18n';

/** The section's sidebar: the conversations with background work, and the selected one's finished runs. */
export function BackgroundSide() {
  const sessions = useBackground((s) => s.sessions);
  const selected = useBackground((s) => s.selected);
  // on 跑过的 no conversation is the page's (a row takes it back to 在跑 on that one)
  const runId = useBackground((s) => s.runId);
  const live = useBackground((s) => s.view === 'live');
  const titles = useStore((s) => s.sessions);
  const list = useMemo(() => sortSessions(Object.values(sessions)), [sessions]);
  const going = list.filter(hasLive);
  const ended = list.filter((s) => !hasLive(s));
  const [runs, setRuns] = useState<BgRunSummary[]>([]);
  const [runsOf, setRunsOf] = useState<string | undefined>();
  useEffect(() => {
    if (!selected) return;
    let ok = true;
    ws.request<BgRunSummary[]>({ kind: 'background.history', sessionId: selected }).then((r) => { if (ok) { setRuns(r ?? []); setRunsOf(selected); } }).catch(() => { if (ok) { setRuns([]); setRunsOf(selected); } });
    return () => { ok = false; };
    // a conversation that just finished a workflow has one more run on disk
  }, [selected, sessions[selected ?? '']?.tasks.filter((t) => t.status !== 'running').length]);
  const name = (id: string) => { const x = titles.find((v) => v.sessionId === id); return x?.customTitle || x?.title || tr('对话'); };
  const row = (s: BgSession) => {
    const c = liveCounts(s);
    return (
      <button key={s.sessionId} className={clsx('nav bg-srow', live && s.sessionId === selected && !runId && 'active')} data-sid={s.sessionId} onClick={() => selectBackground(s.sessionId)} title={name(s.sessionId)}>
        <Icon name={c.tasks ? 'office' : 'check'} size={15} />
        <span className="l">{name(s.sessionId)}</span>
        {c.tasks ? <span className="n live">{c.running || c.tasks}</span> : null}
      </button>
    );
  };
  return (
    <div className="sect-side bg-side">
      <div className="sect-top"><span className="sect-title">{BG_TITLE}</span></div>
      <div className="sect-list">
        {going.length > 0 && <div className="bg-sgroup"><div className="bg-sh">{tr('在跑')}</div>{going.map(row)}</div>}
        {ended.length > 0 && <div className="bg-sgroup"><div className="bg-sh">{tr('结束了')}</div>{ended.map(row)}</div>}
        {list.length === 0 && <div className="bg-side-empty">{tr('对话里派出子代理、跑工作流或后台命令时，它们会出现在这里。')}</div>}
        {selected && runsOf === selected && runs.length > 0 && (
          <div className="bg-sgroup">
            <div className="bg-sh">{tr('这个对话跑过的工作流')}</div>
            {runs.map((r) => (
              <button key={r.runId} className={clsx('nav bg-rrow', live && runId === r.runId && 'active')} data-run={r.runId} onClick={() => selectBackground(selected, { runId: r.runId })} title={tr('{agentCount} 个子代理{v}', { agentCount: r.agentCount, v: r.durationMs ? ` · ${clock(r.durationMs)}` : '' })}>
                <Icon name="workflow" size={15} /><span className="l">{r.name}</span><span className="n">{r.status === 'completed' ? '✓' : r.status === 'failed' ? '✗' : '·'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
