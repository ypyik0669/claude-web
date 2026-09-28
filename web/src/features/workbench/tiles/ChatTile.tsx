import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { basename, clsx } from '@/util';
import { walkTools } from '@/model/conversation';
import { sessionDiffStat } from '@/model/diffstat';
import type { Tile } from '@/model/layout';
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
import type { GitStatus, SessionSummary } from '@shared';
import { Icon } from '@/ui/icons';
import { SessionMenu, effectiveCaps } from '@/features/sidebar/session-actions';
import { sessionPeer } from '@/features/peers';
import { blockRemoteOpen } from '@/features/remote-guard';
import { coalesce, gitEventConcerns } from '../git-refresh';
import { SidebarReveal, usePaneEdge } from '../pane-edge';
import { useRepoContext } from '../repo-context';
import { viewsFor, WB_VIEWS } from '../wb-views';
import { runCommand } from '../commands';
import { modKey } from '../shortcuts';
import { TERMS } from '@/ui/terms';

/**
 * git status for a cwd (the files tab badges). Refreshed only by events about THIS repo (`gitEventConcerns`:
 * its resolved root or the cwd form, which differ behind a junction / symlink) and coalesced — 400 ms of
 * quiet, but at least every 2 s during a steady stream: a status is a git process on the server.
 */
function useGitStatus(cwd: string, enabled: boolean): GitStatus | null {
  const [st, setSt] = useState<GitStatus | null>(null);
  useEffect(() => {
    if (!enabled || !cwd) return;
    let alive = true;
    let root: string | null = null;
    const load = () => ws.request<GitStatus>({ kind: 'git.status', cwd }).then((s) => { if (alive) { root = s.root; setSt(s); } }).catch(() => alive && setSt(null));
    const soon = coalesce(load, 400, 2000);
    load();
    void ws.request({ kind: 'git.watch', cwd }).catch(() => {});
    const off = ws.on((e) => { if (gitEventConcerns(e, { cwd, root })) soon.trigger(); });
    return () => { alive = false; soon.cancel(); off(); };
  }, [cwd, enabled]);
  return st;
}

type ChatTileModel = Extract<Tile, { kind: 'chat' }>;

/**
 * The ··· menu's own part (what used to be header buttons and the 8 workbench tabs): export, the steps view, the
 * per-session views, pin, open the folder, stop / resume. The shared SessionMenu adds rename, fork, archive,
 * hand-over, native CLI, copy id and delete below it. A deleted conversation keeps what still works on what is on
 * screen (export, the views, the folder); pin / stop / resume go.
 * Subscribes only to what it shows — actions read the store when clicked.
 */
function HeaderMenu({ tile, paneId, s, live, remote, gone, onClose }: { tile: ChatTileModel; paneId: string; s: SessionSummary; live: boolean; remote: boolean; gone: boolean; onClose: () => void }) {
  const pinned = useStore((st) => !!st.sessionMeta[s.sessionId]?.pinned);
  const caps = effectiveCaps(s);
  const act = (fn: () => unknown) => () => { onClose(); void fn(); };
  const st = () => useStore.getState();
  const patch = (p: Partial<ChatTileModel>) => st().dispatchLayout({ t: 'tile.patch', paneId, tileId: tile.id, patch: p });
  return (
    <>
      <button onClick={act(() => shareConversation(s.sessionId))}><Icon name="share" size={14} /> 导出为 HTML</button>
      <button onClick={act(() => patch({ wb: 'live', view: tile.view === 'trajectory' && tile.wb === 'live' ? 'chat' : 'trajectory' }))} title={`对话 ⇄ ${TERMS.trajectory}（Alt+J）`}>
        <Icon name="workflow" size={14} /> <span style={{ flex: 1 }}>{TERMS.trajectory}</span>{tile.wb === 'live' && tile.view === 'trajectory' && <Icon name="check" size={13} />}
      </button>
      <div className="menu-label">查看这个对话的</div>
      <div className="menu-grid" role="group" aria-label="查看这个对话的">
        {viewsFor(remote).map((v) => (
          <button key={v.id} className={clsx(tile.wb === v.id && 'on')} onClick={act(() => patch({ wb: tile.wb === v.id ? 'live' : v.id }))} data-view={v.id}>
            <Icon name={v.icon} size={13} /> {v.label}
          </button>
        ))}
      </div>
      <div className="menu-sep" />
      {!gone && <button onClick={act(() => st().setSessionMeta(s.sessionId, { pinned: !pinned }))}><Icon name="pin" size={14} /> {pinned ? '取消置顶' : '置顶'}</button>}
      {!remote && <button onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd }))}><Icon name="folder" size={14} /> 在资源管理器打开</button>}
      {!remote && <button onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd, app: 'code' }))}><Icon name="keyboard" size={14} /> 在 VS Code 打开</button>}
      {!gone && (live
        ? <button onClick={act(() => st().closeSession(s.sessionId))} title="进程会退出，对话留着，发消息即可继续"><Icon name="stop" size={14} /> 结束进程</button>
        : caps.resume && <button onClick={act(() => st().openSession({ sessionId: s.sessionId, cwd: s.cwd }, 'none').catch((e) => st().toast(e.message)))}><Icon name="play" size={14} /> 恢复运行</button>)}
      <div className="menu-sep" />
    </>
  );
}

/**
 * The one row above a conversation (spec §5.2, ≤ 52px): title (double-click to rename) · project · branch ·
 * worktree, and on the right 「改动 +N −M」, terminal, the right-panel toggle and ···. Everything the old header
 * and its workbench-tab row did is in the ··· menu (see HeaderMenu) or the command palette.
 */
function SessionHeader({ tile, paneId }: { tile: ChatTileModel; paneId: string }) {
  const sid = tile.sessionId!;
  const active = useStore((s) => s.open[sid]);
  const meta = useStore((s) => s.sessions.find((x) => x.sessionId === sid));
  const workspaces = useStore((s) => s.workspaces);
  const dispatch = useStore((s) => s.dispatchLayout);
  const toast = useStore((s) => s.toast);
  const dock = useStore((s) => s.layout.dock);
  const inspect = useStore((s) => !!s.inspect);
  const edge = usePaneEdge();
  const mobile = useStore((s) => s.mobile);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const title = meta?.title ?? sid.slice(0, 8);
  const sessions = useStore((s) => s.sessions);
  const peer = sessionPeer(sid, sessions);
  const cwd = active?.cwd ?? meta?.cwd ?? '';
  const live = !!active && active.state !== 'history' && active.state !== 'closed' && active.state !== 'error';
  const wsOf = workspaces.find((w) => cwd.toLowerCase().startsWith(w.path.toLowerCase()));
  const agentKind = active?.info?.agent ?? meta?.agent;
  const agentDef = useStore((s) => s.agents.find((a) => a.kind === agentKind));
  const agentName = active?.info?.agentName ?? agentDef?.name ?? agentKind;
  const { git, worktree } = useRepoContext(cwd, sid);
  const branch = git?.branch ?? meta?.gitBranch;
  const stat = useMemo(() => (active ? sessionDiffStat(active.conv.items) : null), [active?.version]);
  const rename = async () => {
    if (editing !== null && editing.trim() && editing !== title) await useStore.getState().libraryOp('rename', { sessionId: sid, title: editing.trim() }).catch((e) => toast(e.message));
    setEditing(null);
  };
  // a brand-new session may not be in the list yet: the menu still works on what we know
  const summary: SessionSummary = meta ?? { sessionId: sid, title, cwd, lastModified: Date.now(), agent: agentKind };
  const gone = useStore((s) => !!s.deletedSessions[sid]);
  // a deleted session keeps only what is on screen: nothing to fork, resume or manage any more
  const caps = gone ? { ...effectiveCaps(summary), fork: false, resume: false, rename: false } : effectiveCaps(summary);
  const patch = (p: Partial<ChatTileModel>) => dispatch({ t: 'tile.patch', paneId, tileId: tile.id, patch: p });
  const dockShown = dock.open && (dock.tabs.length > 0 || inspect);
  // minimized to its icon rail, the panel is there but not open: the button brings it back instead of hiding it
  const dockMin = dockShown && dock.minimized;
  const toggleDock = () => (dockMin ? dispatch({ t: 'dock.set', patch: { minimized: false } }) : dockShown ? dispatch({ t: 'dock.set', patch: { open: false } }) : dock.tabs.length ? runCommand('dock.toggle') : dispatch({ t: 'dock.show', panel: 'tasks' }));
  const terminalOn = dockShown && dock.active === 'terminal' && !dock.minimized;
  const viewDef = tile.wb !== 'live' ? WB_VIEWS.find((v) => v.id === tile.wb) : undefined;
  const dirty = git?.files.length ?? 0;
  return (
    <div className="sess-head">
      {/* the window's top-left row; on a phone every conversation header, the drawer has no other handle */}
      {((edge.lead && !edge.strip) || mobile) && <SidebarReveal />}
      <div className="sh-main">
        {editing !== null ? (
          <input className="sh-rename" autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' ? setEditing(null) : null)} aria-label="对话标题" />
        ) : (
          <span className="sh-title" onDoubleClick={() => { if (caps.rename) setEditing(title); }} title={caps.rename ? `${title}\n双击重命名` : title}>{title}</span>
        )}
        <span className="sh-meta">
          {peer
            ? <span className="it" title={`${cwd}（在机器「${peer.name}」上）`}><Icon name="machine" size={12} /><span className="nm">{peer.name} · {basename(cwd)}</span></span>
            : cwd && <button className="it" title={`${cwd}\n点击在资源管理器打开`} onClick={() => ws.request({ kind: 'shell.open', path: cwd })}><Icon name="folder" size={12} /><span className="nm">{wsOf?.name ?? basename(cwd)}</span></button>}
          {branch && !peer && (
            <button className={clsx('it branch', git && git.state !== 'clean' && 'dirty')} title={`${branch}${git?.upstream ? ` → ${git.upstream}` : git ? ' · 无上游' : ''}${git ? (dirty ? ` · ${dirty} 处未提交的改动` : ' · 干净') : ''}${git?.ahead ? ` · 领先 ${git.ahead}` : ''}${git?.behind ? ` · 落后 ${git.behind}` : ''}\n点击查看文件改动`} onClick={() => dispatch({ t: 'dock.show', panel: 'files' })}>
              <Icon name="branch" size={12} /><span className="nm bn">{branch}</span>
            </button>
          )}
          {worktree && <span className="tag" title="这个对话在仓库的一个独立副本（git worktree）里运行，不是主检出">独立副本</span>}
          {agentKind && agentKind !== 'claude' && <span className="tag" title={`这个对话由 ${agentName} 运行`}>{agentName}</span>}
          {!live && !gone && !caps.resume && <span className="tag" title="这个来源没有官方的续聊接口，只能查看">只读</span>}
        </span>
        {viewDef && (
          <button className="sh-view" onClick={() => patch({ wb: 'live' })} title="回到对话"><Icon name={viewDef.icon} size={13} /> {viewDef.label}<Icon name="close" size={11} /></button>
        )}
        {!viewDef && tile.view === 'trajectory' && (
          <button className="sh-view" onClick={() => patch({ view: 'chat' })} title="回到对话（Alt+J）"><Icon name="workflow" size={13} /> {TERMS.trajectory}<Icon name="close" size={11} /></button>
        )}
      </div>
      <span className="sh-actions">
        {/* phone: no right panel to show them in (spec §5.11) — 改动 / Git / 文件 are views in ··· */}
        {!mobile && stat && stat.files > 0 && (
          <button className="sh-diff" title={`这个对话改了 ${stat.files} 个文件：+${stat.added} 行 −${stat.removed} 行\n点击查看改动`} onClick={() => dispatch({ t: 'dock.show', panel: 'files' })}>
            <span className="add">+{stat.added}</span><span className="del">−{stat.removed}</span>
          </button>
        )}
        {!peer && !mobile && <button className={clsx('icon-btn', terminalOn && 'active')} title={`终端 (${modKey}+\`)`} aria-label="终端" onClick={() => (terminalOn ? dispatch({ t: 'dock.set', patch: { open: false } }) : dispatch({ t: 'dock.show', panel: 'terminal' }))}><Icon name="terminal" size={16} /></button>}
        {!mobile && <button className={clsx('icon-btn', dockShown && !dockMin && 'active')} title={dockMin ? `展开${TERMS.dock} (${modKey}+J)` : `${TERMS.dock} (${modKey}+J)`} aria-label={dockMin ? `展开${TERMS.dock}` : TERMS.dock} aria-pressed={dockShown && !dockMin} onClick={toggleDock}><Icon name="inspector" size={16} /></button>}
        <span className="sh-more">
          <button className={clsx('icon-btn', menu && 'active')} title="这个对话的更多操作：导出、步骤视图、改动 / Git / 文件…、重命名、分叉、归档、交给其它 Agent、删除" aria-label="更多操作" aria-expanded={menu} aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}><Icon name="more" size={16} /></button>
          {menu && <SessionMenu s={summary} deleted={gone} handoffInline onClose={() => setMenu(false)} style={{ right: 0, top: 34 }} extra={<HeaderMenu tile={tile} paneId={paneId} s={summary} live={live} remote={!!peer} gone={gone} onClose={() => setMenu(false)} />} />}
        </span>
      </span>
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
  if (!items.length) return <div className="empty">还没有生成的文件。Claude 新建的文件（Write / Artifact）之后会出现在这里。</div>;
  return (
    <div className="list">
      {items.map((a) => (
        <div key={a.path} className="row clickable" onClick={() => { if (!blockRemoteOpen(sessionId, a.path)) openTile({ id: `d${Date.now()}`, kind: 'doc', path: a.path }, 'tab'); }} title={a.path}>
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
  const remoteView = !!peer && !viewsFor(true).some((v) => v.id === tile.wb) && tile.wb !== 'live';
  const gitStatus = useGitStatus(active?.cwd ?? '', tile.wb === 'files' && !peer);
  const deleted = useStore((s) => (sid ? !!s.deletedSessions[sid] : false));
  // restored from a persisted layout: lazily pull the transcript
  useEffect(() => {
    if (sid && !has && visible) void loadHistory(sid, { focus: false });
  }, [sid, has, visible]);
  if (!sid) return <Welcome paneId={paneId} tileId={tile.id} />;
  if (!active) return <div className="empty">加载对话…</div>;
  return (
    <div className="chat-tile">
      <SessionHeader tile={tile} paneId={paneId} />
      {deleted && <div className="deleted-banner" role="status"><Icon name="trash" size={13} /> 这个对话已被删除（备份在 ~/.claude-web/library-trash），这里只剩最后看到的内容。</div>}
      {tile.wb === 'live' && (
        <>
          {tile.view === 'chat' ? <ChatView key={sid} /> : <TrajectoryView key={sid} />}
          <Composer key={`c-${sid}`} disabled={deleted} />
        </>
      )}
      {remoteView && <div className="wb-body"><div className="remote-only"><Icon name="machine" size={22} /><div>这个对话在机器「{peer!.name}」上，它的文件 / Git / 搜索 / 定时任务都在那台机器上。</div><div className="sub">请在该机器上查看；这里可以继续对话、审批、中断。</div></div></div>}
      {remoteView ? null : <>
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
