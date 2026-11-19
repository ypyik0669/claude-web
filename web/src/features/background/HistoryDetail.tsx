import { useEffect, useMemo, useState } from 'react';
import type { BgHistoryItem, BgTask } from '@shared';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { LazyNodeGraph } from '@/ui/node-graph';
import { clock, tokensText } from './model';
import { backgroundGraph } from './graph-data';
import { dayLabel, HISTORY_GRAPH_MAX, itemSpan, projectOf, replaySpan, rowTitle, taskAt } from './history-model';
import { replayInCafe, taskOfRow } from './history-state';
import { playPause, seekReplay, setReplaySpeed, startReplay, useReplay } from './replay';
import { openAgent, openChat, setBgView, useBackground, useTitleOf } from './state';
import { hhmm } from './EventFeed';
import { AgentDrawer } from './AgentDrawer';
import { HistoryTree } from './HistoryTree';
import { ReplayBar } from './ReplayBar';
import { tr } from '@/i18n';

/** 「9 个子代理」 / "9 subagents": the number first in both languages — set in bold. */
function numFirst(s: string): React.ReactNode {
  const m = /^(\d[\d.,]*)([\s\S]*)$/.exec(s);
  return m ? <><b>{m[1]}</b>{m[2]}</> : s;
}

/** The row's run as a task: a workflow's read from disk (background.run), a sub-agent's / a command's is the row. */
function useRowTask(item: BgHistoryItem): BgTask | null | undefined {
  const [task, setTask] = useState<BgTask | null | undefined>(undefined);
  // the same row again (the list was asked for anew) is not read again
  useEffect(() => {
    let live = true;
    setTask(undefined);
    void taskOfRow(item).then((t) => { if (live) setTask(t); });
    return () => { live = false; };
  }, [item.id, item.endedAt, item.status]); // eslint-disable-line react-hooks/exhaustive-deps
  return task;
}

/**
 * 跑过的 → one run: what it was (the conversation, when, how long, its agents, its tokens), its graph drawn still
 * (how it ended) — or played again by the times it recorded (10× / 60× / 120×, draggable) — and the agent's own
 * conversation beside it when a card is clicked (read from disk). On a phone the graph stands up (HistoryTree).
 */
export function HistoryDetail({ item, onBack }: { item: BgHistoryItem; onBack?: () => void }) {
  const mobile = useStore((s) => s.mobile);
  const conv = useTitleOf(item.sessionId);
  const task = useRowTask(item);
  const mine = (s: ReturnType<typeof useReplay.getState>) => s.show?.id === item.id && s.show.where === 'graph';
  const showing = useReplay(mine);
  const t = useReplay((s) => (mine(s) ? s.t : 0));
  const playing = useReplay((s) => mine(s) && s.playing);
  const speed = useReplay((s) => s.speed);
  const span = useMemo(() => (task ? replaySpan(task) : undefined), [task]);
  const dur = span ? span.end - span.start : 0;
  // still: how it ended; replaying: the moment it is at
  const at = span ? (showing ? span.start + t : span.end) : 0;
  const view = task ? taskAt(task, at) : undefined;
  // the graph changes when a state does (and once a second of real time, for the cards' running times)
  const sig = view ? `${view.status}|${view.agents.map((a) => a.state[0]).join('')}` : '';
  const tick = showing ? Math.floor(t / (speed * 1000)) : -1;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const graph = useMemo(() => (view ? backgroundGraph({ sessionId: item.sessionId, updatedAt: 0, tasks: [view], events: [] }, { now: at, maxCards: HISTORY_GRAPH_MAX, terse: true }) : undefined), [task, sig, tick]);
  const drawer = useBackground((s) => (s.drawer?.from === 'history' && s.drawer.sessionId === item.sessionId ? s.drawer : undefined));
  const dAgent = drawer && task && drawer.taskId === task.id ? task.agents.find((a) => a.key === drawer.agentKey) : undefined;
  const pick = (agentKey: string) => { if (task) openAgent({ sessionId: item.sessionId, taskId: task.id, agentKey, task, from: 'history' }); };
  const show = () => ({ id: item.id, sessionId: item.sessionId, title: rowTitle(item), task: task!, where: 'graph' as const });
  const play = () => { if (!task) return; if (showing) playPause(); else startReplay(show()); };
  const seek = (x: number) => { if (!task) return; if (showing) seekReplay(x); else startReplay(show(), { play: false, t: x }); };
  const span0 = itemSpan(item);
  const stats: { k: string; el: React.ReactNode; bad?: boolean }[] = [];
  if (span0 !== undefined) stats.push({ k: 'time', el: <>{tr('用时')} <b>{clock(span0)}</b></> });
  if (item.kind === 'workflow') stats.push({ k: 'agents', el: numFirst(tr('{n} 个子代理', { n: item.agentCount ?? task?.agents.length ?? 0 })) });
  if (item.failed) stats.push({ k: 'failed', el: numFirst(tr('{n} 个失败', { n: item.failed })), bad: true });
  if (item.tokens) stats.push({ k: 'tokens', el: <><b>{tokensText(item.tokens)}</b> tokens</> });
  if (item.toolUses) stats.push({ k: 'tools', el: numFirst(tr('{toolCalls} 次工具调用', { toolCalls: item.toolUses })) });
  const where = [projectOf(item.cwd), conv, `${dayLabel(item.startedAt)} ${hhmm(item.startedAt)}`].filter(Boolean).join(' · ');
  return (
    <div className="hx-detail" data-hid={item.id}>
      <div className="hx-main">
        <div className="hx-dh">
          {onBack && <button type="button" className="icon-btn hx-back" aria-label={tr('回到列表')} title={tr('回到列表')} onClick={onBack}><Icon name="chevronLeft" size={16} /></button>}
          <div className="tx"><b>{rowTitle(item)}</b><small>{where}</small></div>
          {!mobile && task && (
            <button type="button" className="btn sm" title={tr('把这一次放进网吧里重演')} onClick={() => { void replayInCafe(item).then((ok) => { if (ok) setBgView('live'); }); }}>
              <Icon name="cafe" size={13} /><span className="l">{tr('在网吧里回放')}</span>
            </button>
          )}
          <button type="button" className="btn sm" title={tr('打开对话')} onClick={() => openChat(item.sessionId)}><Icon name="chat" size={13} /><span className="l">{tr('打开对话')}</span></button>
        </div>
        {stats.length > 0 && <div className="hx-stats">{stats.map((s) => <span key={s.k} className={s.bad ? 'bad' : undefined}>{s.el}</span>)}</div>}
        <div className="hx-graph">
          {task === undefined ? <div className="bg-idle">{tr('读取中…')}</div>
            : task === null || !view || !graph ? <div className="bg-idle">{tr('读不到这次运行')}</div>
              : mobile ? <HistoryTree task={view} at={at} onPick={pick} />
                : (
                  <ErrorBoundary area={tr('后台 · 跑过的关系图')}>
                    <div className="bg-graph">
                      <LazyNodeGraph graph={graph.graph} ariaLabel={tr('跑过的关系图')} height="100%" cardW={190}
                        canSelect={(id) => !!graph.picks[id]} onSelect={(id) => { const p = graph.picks[id]; if (p) pick(p.agentKey); }} />
                      {graph.more > 0 && <div className="bg-graph-more">{tr('还有 {more} 个', { more: graph.more })}</div>}
                    </div>
                  </ErrorBoundary>
                )}
        </div>
        {task && <ReplayBar t={showing ? t : dur} dur={dur} playing={playing} speed={speed} compact={mobile} onPlay={play} onSeek={seek} onSpeed={setReplaySpeed} />}
        {item.kind === 'shell' && item.command
          ? <pre className="hx-cmd">{item.command}</pre>
          : task && task.agents.length > 0 && <div className="hx-foot">{mobile ? tr('点子代理看它当时的对话（读的是磁盘上的记录）') : tr('点一个子代理，右边看它当时的对话（读的是磁盘上的记录）')}</div>}
      </div>
      {dAgent && task && <ErrorBoundary area={tr('后台 · 子代理对话')}><AgentDrawer sessionId={item.sessionId} task={task} agent={dAgent} /></ErrorBoundary>}
    </div>
  );
}
