import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { basename, clsx } from '@/util';
import { walkTools } from '@/model/conversation';
import type { Tile, WorkbenchTab } from '@/model/layout';
import { ChatView } from '@/features/chat/ChatView';
import { TrajectoryView } from '@/features/trajectory/TrajectoryView';
import { Composer } from '@/features/composer/Composer';
import { FilesPanel } from '@/features/panels/FilesPanel';
import { SchedulesView } from '@/features/automation/SchedulesView';
import { shareConversation } from '@/features/chat/MessageActions';
import { Welcome } from '../Welcome';
import { FileTree } from '../FileTree';
import { GitView } from '../GitView';
import { SearchView } from '../SearchView';
import { BoardView } from '@/features/vcs/BoardView';
import type { GitStatus } from '@shared';
import { Icon } from '@/ui/icons';

/** git status for a cwd, refreshed on git.changed broadcasts (shared by the files tab badges). */
function useGitStatus(cwd: string, enabled: boolean): GitStatus | null {
  const [st, setSt] = useState<GitStatus | null>(null);
  useEffect(() => {
    if (!enabled || !cwd) return;
    let alive = true;
    const load = () => ws.request<GitStatus>({ kind: 'git.status', cwd }).then((s) => alive && setSt(s)).catch(() => alive && setSt(null));
    load();
    void ws.request({ kind: 'git.watch', cwd }).catch(() => {});
    const off = ws.on((e) => { if (e.kind === 'git.changed' || e.kind === 'fs.changed') load(); });
    return () => { alive = false; off(); };
  }, [cwd, enabled]);
  return st;
}

type ChatTileModel = Extract<Tile, { kind: 'chat' }>;

const WB_TABS: { id: WorkbenchTab; l: string }[] = [
  { id: 'live', l: '对话' },
  { id: 'changes', l: '改动' },
  { id: 'git', l: 'Git' },
  { id: 'files', l: '文件' },
  { id: 'search', l: '搜索' },
  { id: 'schedules', l: '定时' },
  { id: 'artifacts', l: '产物' },
  { id: 'board', l: '看板' },
];

/** Per-session header: breadcrumb · status · rename · chat/trajectory · fork · export · stop/resume. Moved out of TopBar. */
function SessionHeader({ tile, paneId }: { tile: ChatTileModel; paneId: string }) {
  const sid = tile.sessionId!;
  const active = useStore((s) => s.open[sid]);
  const meta = useStore((s) => s.sessions.find((x) => x.sessionId === sid));
  const workspaces = useStore((s) => s.workspaces);
  const dispatch = useStore((s) => s.dispatchLayout);
  const openSession = useStore((s) => s.openSession);
  const closeSession = useStore((s) => s.closeSession);
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState<string | null>(null);
  const title = meta?.title ?? sid.slice(0, 8);
  const cwd = active?.cwd ?? meta?.cwd ?? '';
  const live = active && active.state !== 'history' && active.state !== 'closed' && active.state !== 'error';
  const wsOf = workspaces.find((w) => cwd.toLowerCase().startsWith(w.path.toLowerCase()));
  const agentKind = active?.info?.agent ?? useStore.getState().sessions.find((s) => s.sessionId === sid)?.agent;
  const agentDef = useStore((s) => s.agents.find((a) => a.kind === agentKind));
  const agentName = active?.info?.agentName ?? agentDef?.name ?? agentKind;
  const agentIcon = agentDef?.icon ?? '◆';
  const rename = async () => {
    if (editing !== null && editing.trim() && editing !== title) await ws.request({ kind: 'session.rename', sessionId: sid, title: editing.trim() }).catch((e) => toast(e.message));
    setEditing(null);
  };
  const patch = (p: Partial<ChatTileModel>) => dispatch({ t: 'tile.patch', paneId, tileId: tile.id, patch: p });
  return (
    <div className="sess-head">
      <div className="crumb">
        <button title={cwd} onClick={() => ws.request({ kind: 'shell.open', path: cwd })}><Icon name="folder" size={12} /> {wsOf?.name ?? basename(cwd)}</button>
        <span className="sep">/</span>
        {live && <span className={clsx('dot', active.state)} />}
        {editing !== null ? (
          <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setEditing(null) : null)} />
        ) : (
          <span className="cur" onDoubleClick={() => setEditing(title)} title="双击重命名">{title}</span>
        )}
        {meta?.gitBranch && <span className="sep" style={{ fontSize: 12 }}>· {meta.gitBranch}</span>}
        {active?.info?.providerId && active.info.providerId !== 'claude' && <span className="badge" title="这个会话走第三方供应商" style={{ color: 'var(--blue)' }}>{active.info.providerName ?? '第三方'}</span>}
        {agentKind && agentKind !== 'claude' && <span className="badge agent" title={`这个会话由 ${agentName} 驱动`}>{agentIcon} {agentName}</span>}
      </div>
      <span className="grow" />
      <button className="icon-btn" title="从当前会话分叉（新标签）" onClick={() => openSession({ sessionId: sid, cwd, fork: true }).catch((e) => toast(e.message))} aria-label="分叉"><Icon name="branch" size={14} /></button>
      <button className="icon-btn" title="导出对话为 HTML（可分享）" onClick={() => shareConversation(sid)}>↗</button>
      {live ? (
        <button className="icon-btn" title="结束进程（可随时恢复）" onClick={() => closeSession(sid)} aria-label="结束进程"><Icon name="stop" size={13} /></button>
      ) : (
        <button className="btn sm ghost" onClick={() => openSession({ sessionId: sid, cwd }, 'none').catch((e) => toast(e.message))}><Icon name="play" size={12} /> 恢复</button>
      )}
      <div className="sess-tabs">
        <div className="wb-tabs">
          {WB_TABS.map((t) => <button key={t.id} className={clsx(tile.wb === t.id && 'active')} onClick={() => patch({ wb: t.id })}>{t.l}</button>)}
        </div>
        <span className="grow" />
        {tile.wb === 'live' && (
          <div className="seg mini">
            <button className={clsx(tile.view === 'chat' && 'active')} onClick={() => patch({ view: 'chat' })}>对话</button>
            <button className={clsx(tile.view === 'trajectory' && 'active')} onClick={() => patch({ view: 'trajectory' })}>轨迹</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Files this session produced: Artifact tool outputs and Write-created files, newest first. */
function Artifacts({ sessionId }: { sessionId: string }) {
  const active = useStore((s) => s.open[sessionId]);
  const openTile = useStore((s) => s.openTile);
  const items = useMemo(() => {
    if (!active) return [];
    const seen = new Map<string, { path: string; via: string }>();
    for (const { tool } of walkTools(active.conv.items)) {
      const inp = tool.input as any;
      const p: string | undefined = tool.name === 'Write' ? inp.file_path : tool.name === 'Artifact' ? inp.path ?? inp.file_path ?? (tool.result?.structured as any)?.path : undefined;
      if (p && tool.status === 'done') seen.set(p, { path: p, via: tool.name });
    }
    return [...seen.values()].reverse();
  }, [active?.version]);
  if (!items.length) return <div className="empty">这个会话还没有产物（Artifact 工具或 Write 新建的文件会出现在这里）。</div>;
  return (
    <div className="list">
      {items.map((a) => (
        <div key={a.path} className="row clickable" onClick={() => openTile({ id: `d${Date.now()}`, kind: 'doc', path: a.path }, 'tab')} title={a.path}>
          <span><Icon name="read" size={13} /></span>
          <div className="grow"><div>{basename(a.path)}</div><div className="sub">{a.path}</div></div>
          <span className="badge">{a.via}</span>
        </div>
      ))}
    </div>
  );
}

export function ChatTile({ tile, paneId, visible }: { tile: ChatTileModel; paneId: string; visible: boolean }) {
  const sid = tile.sessionId;
  const has = useStore((s) => (sid ? !!s.open[sid] : true));
  const loadHistory = useStore((s) => s.loadHistory);
  const active = useStore((s) => (sid ? s.open[sid] : undefined));
  const gitStatus = useGitStatus(active?.cwd ?? '', tile.wb === 'files');
  // restored from a persisted layout: lazily pull the transcript
  useEffect(() => {
    if (sid && !has && visible) void loadHistory(sid, { focus: false });
  }, [sid, has, visible]);
  if (!sid) return <Welcome paneId={paneId} tileId={tile.id} />;
  if (!active) return <div className="empty">加载会话…</div>;
  return (
    <div className="chat-tile">
      <SessionHeader tile={tile} paneId={paneId} />
      {tile.wb === 'live' && (
        <>
          {tile.view === 'chat' ? <ChatView key={sid} /> : <TrajectoryView key={sid} />}
          <Composer key={`c-${sid}`} />
        </>
      )}
      {tile.wb === 'changes' && <div className="wb-body"><FilesPanel /></div>}
      {tile.wb === 'git' && <div className="wb-body"><GitView cwd={active.cwd} /></div>}
      {tile.wb === 'files' && <div className="wb-body"><FileTree root={active.cwd} gitStatus={gitStatus} /></div>}
      {tile.wb === 'search' && <div className="wb-body"><SearchView root={active.cwd} /></div>}
      {tile.wb === 'schedules' && <div className="wb-body"><SchedulesView /></div>}
      {tile.wb === 'artifacts' && <div className="wb-body"><Artifacts sessionId={sid} /></div>}
      {tile.wb === 'board' && <div className="wb-body"><BoardView cwd={active.cwd} sid={sid} /></div>}
    </div>
  );
}
