import { useEffect, useMemo, useState } from 'react';
import type { BgRunSummary, BgSession, BgTask } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { OverPage, type OverTab } from '@/features/sections/OverPage';
import { AgentCards } from './AgentCards';
import { AgentDrawer } from './AgentDrawer';
import { CommandGraph } from './CommandGraph';
import { EventFeed } from './EventFeed';
import { lazy, Suspense } from 'react';
import { BG_TITLE, clock, hasLive, KIND_LABEL, liveCounts, orderedTasks, sortSessions, taskStateText, taskTitle, tokensText } from './model';
import { closeAgent, closeBackground, openAgent, selectBackground, stopTask, useBackground } from './state';
import { tr } from '@/i18n';

// the cafe is a three.js scene: loaded when the page first shows it (the first screen's entry stays small)
const Office = lazy(() => import('@/features/office/Office').then((m) => ({ default: m.Office })));

const EMPTY_SESSION = (sessionId: string): BgSession => ({ sessionId, updatedAt: 0, tasks: [], events: [] });

/** A conversation's name as the sidebar shows it. */
export function useTitleOf(sessionId: string | undefined): string {
  return useStore((s) => {
    if (!sessionId) return '';
    const x = s.sessions.find((v) => v.sessionId === sessionId);
    return x?.customTitle || x?.title || tr('对话');
  });
}

/** A ticking clock while something runs (the header's 运行中 3:12). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    // the page stays mounted while closed: on reopening, the time it was last closed would show for a second
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** One finished run read from disk, shown as if it were the conversation's only task. */
function useRun(sessionId: string | undefined, runId: string | undefined): BgTask | null | undefined {
  const [run, setRun] = useState<BgTask | null | undefined>(undefined);
  useEffect(() => {
    setRun(undefined);
    if (!sessionId || !runId) return;
    let live = true;
    ws.request<BgTask | null>({ kind: 'background.run', sessionId, runId }).then((t) => { if (live) setRun(t); }).catch(() => { if (live) setRun(null); });
    return () => { live = false; };
  }, [sessionId, runId]);
  return run;
}

function TaskChips({ session, taskId }: { session: BgSession; taskId?: string }) {
  const tasks = orderedTasks(session);
  if (tasks.length < 2) return null;
  return (
    <div className="bg-chips" role="tablist" aria-label={tr('后台任务')}>
      <button role="tab" aria-selected={!taskId} className={clsx('bg-chip', !taskId && 'on')} onClick={() => selectBackground(session.sessionId)}>{tr('全部 · {tasksCount}', { tasksCount: tasks.length })}</button>
      {tasks.map((t) => (
        <span key={t.id} className={clsx('bg-chip', taskId === t.id && 'on', t.status === 'running' && 'live')} data-task={t.id}>
          <button role="tab" aria-selected={taskId === t.id} className="bg-chip-b" title={`${KIND_LABEL[t.kind]} · ${taskStateText(t)}`} onClick={() => selectBackground(session.sessionId, { taskId: t.id })}>
            <Icon name={t.kind === 'workflow' ? 'workflow' : t.kind === 'shell' ? 'terminal' : 'agent'} size={13} />
            <span className="k">{KIND_LABEL[t.kind]}</span>{taskTitle(t)}
          </button>
          {t.status === 'running' && <button className="bg-chip-x" title={tr('停止{v}', { v: KIND_LABEL[t.kind] })} aria-label={tr('停止{taskTitle}', { taskTitle: taskTitle(t) })} onClick={() => stopTask(session.sessionId, t.id)}><Icon name="stop" size={11} /></button>}
        </span>
      ))}
    </div>
  );
}

/** Back to a conversation (a floor's lead is its main conversation). */
const toChat = (sid: string) => () => {
  closeBackground();
  const st = useStore.getState();
  if (st.open[sid]) st.openInPane(sid, 'replace');
  else void st.loadHistory(sid);
};

/** The page's body for one conversation (live) or one finished run (from disk). */
/** The building of every conversation's background, on top of the page. */
function OfficeBlock({ follow }: { follow?: string }) {
  return (
    <div className="bg-office-wrap">
      <ErrorBoundary area={tr('后台 · 网吧')}>
        <Suspense fallback={null}>
          <Office
            follow={follow}
            onFloor={(sid) => selectBackground(sid)}
            onOpenAgent={(sid, taskId, agentKey) => { selectBackground(sid); openAgent({ sessionId: sid, taskId, agentKey }); }}
            onOpenChat={(sid) => toChat(sid)()}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

function Board({ session, live, taskId }: { session: BgSession; live: boolean; taskId?: string }) {
  const drawer = useBackground((s) => s.drawer);
  const pick = (agentKey: string, tId: string) => openAgent({ sessionId: session.sessionId, taskId: tId, agentKey });
  const dTask = drawer && drawer.sessionId === session.sessionId ? session.tasks.find((t) => t.id === drawer.taskId) : undefined;
  const dAgent = dTask?.agents.find((a) => a.key === drawer!.agentKey);
  return (
    <div className={clsx('bg-board', dAgent && 'with-drawer')}>
      <div className="bg-main">
        {live && <TaskChips session={session} taskId={taskId} />}
        <ErrorBoundary area={tr('后台 · 卡片')}><AgentCards session={session} taskId={taskId} onPick={pick} /></ErrorBoundary>
        <div className="bg-graph-wrap"><ErrorBoundary area={tr('后台 · 关系图')}><CommandGraph session={session} taskId={taskId} onPick={pick} /></ErrorBoundary></div>
        <div className="bg-stage bg-stage-low">
          <div className="bg-side-col">
            {session.events.length > 0 && <div className="bg-feed-wrap"><div className="bg-h">{tr('动态')}</div><EventFeed events={taskId ? session.events.filter((e) => e.taskId === taskId) : session.events} onPick={pick} /></div>}
          </div>
        </div>
      </div>
      {dTask && dAgent && <ErrorBoundary area={tr('后台 · 子代理对话')}><AgentDrawer sessionId={session.sessionId} task={dTask} agent={dAgent} /></ErrorBoundary>}
    </div>
  );
}

/**
 * 后台 (spec 2026-10-12-background-office-design.md §3): what a conversation has going besides its turn — the agents
 * of its workflows, its sub-agents, its background commands — as cards, an office, a graph and a feed. The page lies
 * over the main area like 自动化; the section's sidebar (BackgroundSide) picks the conversation, where it is not on
 * screen the page has the conversations as tabs.
 */
export function BackgroundPage() {
  const open = useBackground((s) => s.open);
  const sessions = useBackground((s) => s.sessions);
  const selected = useBackground((s) => s.selected);
  const taskId = useBackground((s) => s.taskId);
  const runId = useBackground((s) => s.runId);
  const drawer = useBackground((s) => !!s.drawer);
  const sideNav = useStore((s) => !s.mobile && s.sidebarOpen);
  const titles = useStore((s) => s.sessions);
  const title = useTitleOf(selected);
  const session = selected ? sessions[selected] ?? EMPTY_SESSION(selected) : undefined;
  const run = useRun(selected, runId);
  const counts = liveCounts(session);
  const now = useNow(open && counts.tasks > 0);
  const list = useMemo(() => sortSessions(Object.values(sessions)), [sessions]);
  const tabs: OverTab[] = useMemo(() => list.slice(0, 8).map((s) => {
    const x = titles.find((v) => v.sessionId === s.sessionId);
    return { id: s.sessionId, label: x?.customTitle || x?.title || tr('对话'), icon: hasLive(s) ? 'office' : 'check', title: hasLive(s) ? tr('在跑') : tr('结束了') };
  }), [list, titles]);

  const shown: BgSession | undefined = runId ? (run ? { ...EMPTY_SESSION(selected!), tasks: [run] } : undefined) : session;
  const started = session?.tasks.filter((t) => t.status === 'running').reduce((m, t) => Math.min(m, t.startedAt), Infinity) ?? Infinity;
  const agentCount = shown ? shown.tasks.reduce((n, t) => n + t.agents.length, 0) : 0;
  const tokens = shown ? shown.tasks.reduce((n, t) => n + (t.tokens ?? t.agents.reduce((m, a) => m + (a.tokens ?? 0), 0)), 0) : 0;
  const desc = runId
    ? (run ? tr('跑过的工作流 · {taskStateText} · {agentsCount} 个子代理 · {tokensText} tok', { taskStateText: taskStateText(run), agentsCount: run.agents.length, tokensText: tokensText(run.tokens) }) : run === null ? tr('读不到这次运行') : tr('读取中…'))
    : !session ? undefined
      : counts.tasks ? tr('运行中 {clock} · {agentCount} 个子代理 · {tokensText} tok', { clock: Number.isFinite(started) ? clock(now - started) : '', agentCount, tokensText: tokensText(tokens) })
        : session.tasks.length ? tr('都结束了 · {agentCount} 个子代理 · {tokensText} tok', { agentCount, tokensText: tokensText(tokens) }) : undefined;
  const running = session?.tasks.filter((t) => t.status === 'running') ?? [];
  const toChat = () => {
    if (!selected) return;
    closeBackground();
    const st = useStore.getState();
    if (st.open[selected]) st.openInPane(selected, 'replace');
    else void st.loadHistory(selected);
  };
  return (
    <OverPage
      name="bg"
      label={BG_TITLE}
      open={open}
      onClose={() => { if (drawer) closeAgent(); else closeBackground(); }}
      title={selected ? title : BG_TITLE}
      desc={desc}
      tab={selected ?? ''}
      tabs={tabs}
      showTabs={!sideNav && tabs.length > 1}
      onTab={(id) => selectBackground(id)}
      actions={selected ? (
        <>
          {!runId && running.length > 1 && <button className="btn sm" title={tr('全部停止')} onClick={() => { for (const t of running) stopTask(selected, t.id); }}><Icon name="stop" size={12} /><span className="l">{tr('全部停止')}</span></button>}
          {!runId && running.length === 1 && <button className="btn sm" title={tr('停止{v}', { v: KIND_LABEL[running[0].kind] })} onClick={() => stopTask(selected, running[0].id)}><Icon name="stop" size={12} /><span className="l">{tr('停止{v}', { v: KIND_LABEL[running[0].kind] })}</span></button>}
          {runId && <button className="btn sm" title={tr('回到现在')} onClick={() => selectBackground(selected)}><Icon name="office" size={13} /><span className="l">{tr('回到现在')}</span></button>}
          <button className="btn sm" title={tr('回到对话')} onClick={toChat}><Icon name="chat" size={13} /><span className="l">{tr('回到对话')}</span></button>
        </>
      ) : undefined}
    >
      <div className="over-body bg-body">
        <OfficeBlock follow={selected} />
        {!shown
          ? null
          : <Board session={shown} live={!runId} taskId={runId ? undefined : taskId} />}
      </div>
    </OverPage>
  );
}
