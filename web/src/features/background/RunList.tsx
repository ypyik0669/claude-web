// 自动化 › 运行中 · 列表 (redesign 2026-11, the plan's 自动化 page and its phone screen): every conversation's
// background work, one group per thing a conversation runs — a workflow and its sub-agents, a single sub-agent, a
// background command — a conversation's groups together (run-list.ts). Each group opens its conversation or stops;
// an agent's row opens its own conversation beside the list (AgentDrawer). A workflow's graph and its 动态 fold out
// under it on a desktop. The 3D cafe is the page's other view of the same snapshot.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BgAgent, BgSession, BgTask } from '@shared';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { EmptyState } from '@/ui/EmptyState';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { EMPTY } from '@/ui/terms';
import { agentColor, KIND_LABEL, taskStateText, taskTitle } from './model';
import { agentLine, agentTokens, agentWho, groupMeta, phaseChip, runGroups, shownAgents, type RunGroup } from './run-list';
import { agentTip } from './Character';
import { CommandGraph } from './CommandGraph';
import { EventFeed } from './EventFeed';
import { RecentRuns } from './RecentRuns';
import { openAgent, openChat, stopTask, useBackground } from './state';
import { tr } from '@/i18n';

const KIND_ICON = { workflow: 'workflow', agent: 'agent', shell: 'terminal', other: 'tasks' } as const;
const STOP_TITLE: Record<BgTask['kind'], () => string> = {
  workflow: () => tr('停止整个工作流'),
  agent: () => tr('停止这个子代理'),
  shell: () => tr('停止这条命令'),
  other: () => tr('停止这个任务'),
};
/** A focused group (the page opened on its conversation) is marked this long. */
const FLASH_MS = 1600;

/** A clock for the groups' running times, ticking only while something runs on screen. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

const groupKey = (g: RunGroup) => `${g.sessionId}|${g.task.id}`;

function AgentRow({ task, agent: a, phone, onPick }: { task: BgTask; agent: BgAgent; phone: boolean; onPick: () => void }) {
  return (
    <button type="button" className={clsx('bg-run-a', `is-${a.state}`)} style={{ '--c': agentColor(a.color) } as CSSProperties} title={agentTip(task, a)} data-agent={a.key} onClick={onPick}>
      <span className="dot" aria-hidden />
      <span className="who">{agentWho(task, a)}</span>
      <span className="say">{agentLine(a)}</span>
      {!phone && <small>{agentTokens(a)}</small>}
    </button>
  );
}

function RunCard({ g, session, title, cwd, now, phone, graph, onGraph, flash }: {
  g: RunGroup; session: BgSession; title: string; cwd?: string; now: number; phone: boolean; graph: boolean; onGraph(): void; flash: boolean;
}) {
  const t = g.task;
  const running = t.status === 'running';
  const [all, setAll] = useState(false);
  const { shown, more } = shownAgents(t.kind === 'shell' ? [] : t.agents, all);
  const phase = phaseChip(t);
  const name = taskTitle(t);
  const open = tr('打开对话「{title}」', { title });
  const pick = (a: BgAgent) => openAgent({ sessionId: g.sessionId, taskId: t.id, agentKey: a.key });
  const events = graph ? session.events.filter((e) => e.taskId === t.id) : [];
  return (
    <section className={clsx('bg-run', `k-${t.kind}`, !running && 'ended', flash && 'flash')} data-sid={g.sessionId} data-task={t.id} data-kind={t.kind} role="listitem" aria-label={`${KIND_LABEL[t.kind]} · ${name}`}>
      <div className="bg-run-h">
        <Icon name={KIND_ICON[t.kind]} size={phone ? 17 : 15} />
        <span className="tx">
          <b title={name}>{name}</b>
          <small title={title}>{groupMeta(t, cwd, now, { phase: phone ? phase : null })}</small>
        </span>
        <span className="r">
          {phase && <span className="bg-run-phase">{phase}</span>}
          {!running && <span className={clsx('bg-run-st', t.status)}>{taskStateText(t)}</span>}
          {running && (
            <button type="button" className="btn sm bg-run-stop" data-act="stop" title={STOP_TITLE[t.kind]()} onClick={() => stopTask(g.sessionId, t.id)}>
              {!phone && <Icon name="stop" size={12} />}<span className="l">{tr('停止')}</span>
            </button>
          )}
          <button type="button" className="btn sm bg-run-open" data-act="open" title={open} aria-label={open} onClick={() => openChat(g.sessionId)}>
            {phone ? <Icon name="chevronRight" size={18} /> : <><Icon name="chat" size={13} /><span className="l">{tr('打开对话')}</span></>}
          </button>
        </span>
      </div>
      {shown.length > 0 && (
        <div className="bg-run-as">
          {shown.map((a) => <AgentRow key={a.key} task={t} agent={a} phone={phone} onPick={() => pick(a)} />)}
          {more > 0 && <button type="button" className="bg-run-more" onClick={() => setAll(true)}>{tr('还有 {more} 个', { more })}</button>}
          {all && t.agents.length > 8 && <button type="button" className="bg-run-more" onClick={() => setAll(false)}>{tr('收起')}</button>}
        </div>
      )}
      {/* a workflow's graph (main → workflow → phases → agents) and its 动态: a desktop's, folded until asked for */}
      {t.kind === 'workflow' && !phone && (
        <div className="bg-run-x">
          <button type="button" className="bg-run-xt" data-act="graph" aria-expanded={graph} onClick={onGraph}>
            <Icon name={graph ? 'chevronDown' : 'chevronRight'} size={12} />{tr('关系图和动态')}
          </button>
          {graph && (
            <div className="bg-run-xb">
              <div className="bg-graph-wrap"><ErrorBoundary area={tr('后台 · 关系图')}><CommandGraph session={session} taskId={t.id} onPick={(agentKey, taskId) => openAgent({ sessionId: g.sessionId, taskId, agentKey })} /></ErrorBoundary></div>
              {events.length > 0 && <div className="bg-feed-wrap"><EventFeed events={events} limit={12} onPick={(agentKey, taskId) => openAgent({ sessionId: g.sessionId, taskId, agentKey })} /></div>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The list. `shown`: on screen (the clock ticks, a focus asked for scrolls). Nothing running: the empty sentence and
 * the three runs that ended last (刚跑完的: each can be replayed in the cafe).
 */
export function RunList({ shown }: { shown: boolean }) {
  const sessions = useBackground((s) => s.sessions);
  const focusAt = useBackground((s) => s.focusAt);
  const summaries = useStore((s) => s.sessions);
  const phone = useStore((s) => s.mobile);
  const groups = useMemo(() => runGroups(sessions), [sessions]);
  const meta = useMemo(() => new Map(summaries.map((x) => [x.sessionId, x])), [summaries]);
  const now = useNow(shown && groups.some((g) => g.task.status === 'running'));
  const [graphs, setGraphs] = useState<Set<string>>(() => new Set());
  const [flash, setFlash] = useState<string | undefined>();
  const root = useRef<HTMLDivElement>(null);

  // opened on a conversation (the composer's pill, a workflow card's 在「后台」里看): its group comes into view and is
  // marked for a moment; a workflow asked for by its card shows its graph. (Pending until its group is there: the
  // snapshot may come a moment after the page opened.)
  const handled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!shown || !focusAt || focusAt === handled.current) return;
    const { selected, taskId } = useBackground.getState();
    const g = groups.find((x) => x.sessionId === selected && (!taskId || x.task.id === taskId)) ?? groups.find((x) => x.sessionId === selected);
    if (!g) return;
    handled.current = focusAt;
    const key = groupKey(g);
    if (taskId && g.task.kind === 'workflow' && !phone) setGraphs((s) => new Set(s).add(key));
    setFlash(key);
    requestAnimationFrame(() => root.current?.querySelector(`[data-sid="${CSS.escape(g.sessionId)}"][data-task="${CSS.escape(g.task.id)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [focusAt, shown, groups, phone]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(undefined), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  if (!groups.length) {
    return (
      <div className="bg-runs empty" ref={root}>
        <EmptyState e={EMPTY.background} />
        <RecentRuns />
      </div>
    );
  }
  const toggle = (key: string) => setGraphs((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return (
    <div className="bg-runs" role="list" aria-label={tr('在跑')} ref={root}>
      {groups.map((g) => {
        const key = groupKey(g);
        const x = meta.get(g.sessionId);
        return (
          <RunCard
            key={key}
            g={g}
            session={sessions[g.sessionId]}
            title={x?.customTitle || x?.title || tr('对话')}
            cwd={x?.cwd}
            now={now}
            phone={phone}
            graph={graphs.has(key)}
            onGraph={() => toggle(key)}
            flash={flash === key}
          />
        );
      })}
    </div>
  );
}
