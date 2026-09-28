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
import { EngineSwitcher } from '../EngineSwitcher';
import { SessionMenu, effectiveCaps, forkSession } from '@/features/sidebar/session-actions';
import { sessionPeer } from '@/features/peers';

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
/** A session on another machine: its files, git, search, schedules live there — only these tabs make sense here. */
const REMOTE_TABS = new Set<WorkbenchTab>(['live', 'artifacts']);

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
  const [menu, setMenu] = useState(false);
  const title = meta?.title ?? sid.slice(0, 8);
  const sessions = useStore((s) => s.sessions);
  const peer = sessionPeer(sid, sessions);
  const cwd = active?.cwd ?? meta?.cwd ?? '';
  const live = active && active.state !== 'history' && active.state !== 'closed' && active.state !== 'error';
  const wsOf = workspaces.find((w) => cwd.toLowerCase().startsWith(w.path.toLowerCase()));
  const agentKind = active?.info?.agent ?? useStore.getState().sessions.find((s) => s.sessionId === sid)?.agent;
  const agentDef = useStore((s) => s.agents.find((a) => a.kind === agentKind));
  const agentName = active?.info?.agentName ?? agentDef?.name ?? agentKind;
  const rename = async () => {
    if (editing !== null && editing.trim() && editing !== title) await useStore.getState().libraryOp('rename', { sessionId: sid, title: editing.trim() }).catch((e) => toast(e.message));
    setEditing(null);
  };
  // a brand-new session may not be in the list yet: the menu still works on what we know
  const summary = meta ?? { sessionId: sid, title, cwd, lastModified: Date.now(), agent: agentKind };
  const gone = useStore((s) => !!s.deletedSessions[sid]);
  // a deleted session keeps only what is on screen: nothing to fork, resume or manage any more
  const caps = gone ? { ...effectiveCaps(summary), fork: false, resume: false, rename: false } : effectiveCaps(summary);
  const canRename = caps.rename;
  const patch = (p: Partial<ChatTileModel>) => dispatch({ t: 'tile.patch', paneId, tileId: tile.id, patch: p });
  return (
    <div className="sess-head">
      <div className="crumb">
        {peer
          ? <button title={`${cwd}（在机器「${peer.name}」上）`} disabled><Icon name="machine" size={12} /> {peer.name} · {basename(cwd)}</button>
          : <button title={cwd} onClick={() => ws.request({ kind: 'shell.open', path: cwd })}><Icon name="folder" size={12} /> {wsOf?.name ?? basename(cwd)}</button>}
        <span className="sep">/</span>
        {live && <span className={clsx('dot', active.state)} />}
        {editing !== null ? (
          <input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setEditing(null) : null)} />
        ) : (
          <span className="cur" onDoubleClick={() => { if (canRename) setEditing(title); }} title={canRename ? '双击重命名' : title}>{title}</span>
        )}
        {meta?.gitBranch && <span className="sep branch" style={{ fontSize: 12 }} title={meta.gitBranch}>· {meta.gitBranch}</span>}
        {active?.info && live && <EngineSwitcher sessionId={sid} info={active.info} />}
        {(!active?.info || !live) && agentKind && agentKind !== 'claude' && <span className="badge agent" title={`这个会话由 ${agentName} 驱动`}>{agentName}</span>}
      </div>
      <span className="grow" />
      {caps.fork && <button className="icon-btn" title="从当前会话分叉（新标签）" onClick={() => forkSession(summary)} aria-label="分叉"><Icon name="branch" size={14} /></button>}
      <button className="icon-btn" title="导出对话为 HTML（可分享）" onClick={() => shareConversation(sid)}>↗</button>
      {!gone && <span style={{ position: 'relative' }}>
        <button className={clsx('icon-btn', menu && 'active')} title="会话菜单：引用、重命名、归档、删除、交接、原生 CLI…" aria-label="会话菜单" aria-expanded={menu} onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}><Icon name="more" size={14} /></button>
        {menu && <SessionMenu s={summary} onClose={() => setMenu(false)} style={{ right: 0, top: 30 }} />}
      </span>}
      {live ? (
        <button className="icon-btn" title="结束进程（可随时恢复）" onClick={() => closeSession(sid)} aria-label="结束进程"><Icon name="stop" size={13} /></button>
      ) : gone ? null : caps.resume ? (
        <button className="btn sm ghost" onClick={() => openSession({ sessionId: sid, cwd }, 'none').catch((e) => toast(e.message))}><Icon name="play" size={12} /> 恢复</button>
      ) : (
        <span className="badge" title="这个来源没有官方的续聊接口，只能查看">只读</span>
      )}
      <div className="sess-tabs">
        <div className="wb-tabs">
          {(peer ? WB_TABS.filter((t) => REMOTE_TABS.has(t.id)) : WB_TABS).map((t) => <button key={t.id} className={clsx(tile.wb === t.id && 'active')} onClick={() => patch({ wb: t.id })}>{t.l}</button>)}
          {peer && <span className="peer-note" title={`文件 / Git / 搜索在机器「${peer.name}」上，请在那台机器上查看`}><Icon name="machine" size={11} /> 文件 / Git / 搜索：在该机器上查看</span>}
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
  const sessions = useStore((s) => s.sessions);
  // by id, not by the list: a fork or a restored layout may render before the list has the row
  const peer = sessionPeer(sid, sessions);
  const gitStatus = useGitStatus(active?.cwd ?? '', tile.wb === 'files' && !peer);
  const deleted = useStore((s) => (sid ? !!s.deletedSessions[sid] : false));
  // restored from a persisted layout: lazily pull the transcript
  useEffect(() => {
    if (sid && !has && visible) void loadHistory(sid, { focus: false });
  }, [sid, has, visible]);
  if (!sid) return <Welcome paneId={paneId} tileId={tile.id} />;
  if (!active) return <div className="empty">加载会话…</div>;
  return (
    <div className="chat-tile">
      <SessionHeader tile={tile} paneId={paneId} />
      {deleted && <div className="deleted-banner" role="status"><Icon name="trash" size={13} /> 这个会话已被删除（备份在 ~/.claude-web/library-trash），这里只剩最后看到的内容。</div>}
      {tile.wb === 'live' && (
        <>
          {tile.view === 'chat' ? <ChatView key={sid} /> : <TrajectoryView key={sid} />}
          <Composer key={`c-${sid}`} disabled={deleted} />
        </>
      )}
      {peer && !REMOTE_TABS.has(tile.wb) && <div className="wb-body"><div className="remote-only"><Icon name="machine" size={22} /><div>这个会话在机器「{peer.name}」上，它的文件 / Git / 搜索 / 定时任务都在那台机器上。</div><div className="sub">请在该机器上查看；这里可以继续对话、审批、中断。</div></div></div>}
      {peer && !REMOTE_TABS.has(tile.wb) ? null : <>
      {tile.wb === 'changes' && <div className="wb-body"><FilesPanel /></div>}
      {tile.wb === 'git' && <div className="wb-body"><GitView cwd={active.cwd} /></div>}
      {tile.wb === 'files' && <div className="wb-body"><FileTree root={active.cwd} gitStatus={gitStatus} /></div>}
      {tile.wb === 'search' && <div className="wb-body"><SearchView root={active.cwd} /></div>}
      {tile.wb === 'schedules' && <div className="wb-body"><SchedulesView /></div>}
      {tile.wb === 'artifacts' && <div className="wb-body"><Artifacts sessionId={sid} /></div>}
      {tile.wb === 'board' && <div className="wb-body"><BoardView cwd={active.cwd} sid={sid} /></div>}
      </>}
    </div>
  );
}
