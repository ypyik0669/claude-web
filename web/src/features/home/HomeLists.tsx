import { useMemo, useState } from 'react';
import type { SessionSummary } from '@shared';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { EmptyState } from '@/ui/EmptyState';
import { EMPTY } from '@/ui/terms';
import { sessionDiffStat } from '@/model/diffstat';
import { openAutomation } from '@/features/automation/state';
import { homeRows, homeStatus, homeTabs, type HomeRow, type HomeStatus, type HomeTab } from './model';

function StatusEnd({ st }: { st: HomeStatus | null }) {
  if (!st) return null;
  switch (st.kind) {
    case 'running': return <span className="hs run" title={st.title}><span className="spin" />{st.label}</span>;
    case 'confirm': case 'ask': return <span className="hs need" title={st.title}><span className="pip" />{st.label}</span>;
    case 'error': return <span className="hs err" title={st.title}>{st.label}</span>;
    case 'diff': return <span className="hs stat" title={st.title}><span className="a">+{st.added}</span> <span className="d">−{st.removed}</span></span>;
    default: return <span className={clsx('hs', st.kind)} title={st.title}>{st.label}</span>;
  }
}

/** A conversation row: its status from this window's runner when it is open (requests, errors, its own edits). */
function SessionLine({ row, s, onOpen }: { row: HomeRow; s: SessionSummary; onOpen: (id: string) => void }) {
  const o = useStore((st) => st.open[s.sessionId]);
  const busy = !!o && (o.state === 'running' || o.state === 'starting' || o.pending.length > 0);
  const diff = useMemo(() => (o && !busy ? sessionDiffStat(o.conv.items) : null), [o?.version, busy]);
  const st = o ? homeStatus(s, { state: o.state, pending: o.pending, error: o.error, diff }) : row.status;
  return <Line row={row} st={st} onClick={() => onOpen(s.sessionId)} />;
}

function Line({ row, st, onClick }: { row: HomeRow; st: HomeStatus | null; onClick: () => void }) {
  return (
    <button className="home-row" onClick={onClick} data-row={row.id}>
      <span className="grow">
        <span className="tt">{row.title}</span>
        <span className="ss">{[row.where, row.agent, row.when].filter(Boolean).map((x, i, all) => <span key={i} title={i === all.length - 1 ? row.whenTitle : undefined}>{i > 0 && <span className="sep">·</span>}{x}</span>)}</span>
      </span>
      <StatusEnd st={st} />
    </button>
  );
}

/**
 * 最近任务 · 定时任务 · 已归档 under the start page's composer (spec §5.8): each row a title, project · time, and one
 * status on the right (running, waiting for you, +N −M…). A conversation opens in this tile; a schedule opens the
 * automation page. 查看全部 goes where the whole list is.
 */
export function HomeLists({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const sessions = useStore((s) => s.sessions);
  const meta = useStore((s) => s.sessionMeta);
  const workspaces = useStore((s) => s.workspaces);
  const agents = useStore((s) => s.agents);
  const schedules = useStore((s) => s.schedules);
  const [tab, setTab] = useState<HomeTab>('recent');
  const { rows, more } = useMemo(() => homeRows(tab, { sessions, meta, workspaces, agents, schedules }), [tab, sessions, meta, workspaces, agents, schedules]);
  const byId = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  const all = () => {
    if (tab === 'schedules') openAutomation('schedules');
    else if (tab === 'archived') useStore.setState({ showArchived: true, sidebarOpen: true });
    else useStore.setState({ paletteOpen: true });
  };
  const showAll = tab === 'schedules' || more > 0;
  return (
    <section className="home-lists" aria-label="最近">
      <div className="home-tabs" role="tablist">
        {homeTabs({ schedules: schedules.length }).map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={clsx('ht', tab === t.id && 'on')} data-tab={t.id} onClick={() => setTab(t.id)}>
            {t.label}{t.n ? <span className="n">{t.n}</span> : null}
          </button>
        ))}
        <span className="grow" />
        {showAll && <button className="ht all" onClick={all} title={tab === 'schedules' ? '在「自动化」里管理定时任务' : tab === 'archived' ? '在侧栏里显示已归档的对话' : '搜索全部对话'}>{tab === 'schedules' ? '管理' : `查看全部${more ? ` ${more + rows.length}` : ''}`}</button>}
      </div>
      <div className="home-list" role="tabpanel">
        {rows.map((r) => {
          const s = byId.get(r.id);
          return s && tab !== 'schedules' ? <SessionLine key={r.id} row={r} s={s} onOpen={onOpen} /> : <Line key={r.id} row={r} st={r.status} onClick={() => openAutomation('schedules')} />;
        })}
        {!rows.length && (
          tab === 'schedules'
            ? <EmptyState e={EMPTY.schedules} action={<button className="btn sm" onClick={() => openAutomation('schedules')}><Icon name="tasks" size={13} /> 去「自动化」设一个</button>} />
            : <EmptyState e={tab === 'recent' ? EMPTY.recent : EMPTY.archived} />
        )}
      </div>
    </section>
  );
}
