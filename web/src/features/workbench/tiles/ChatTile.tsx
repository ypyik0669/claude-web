import { Backdrop } from '@/themes/Backdrop';
import { useActivePack } from '@/themes/apply';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { basename, clsx } from '@/util';
import { sessionDiffStat } from '@/model/diffstat';
import type { Tile } from '@/model/layout';
import { ChatView } from '@/features/chat/ChatView';
import { TrajectoryView } from '@/features/trajectory/TrajectoryView';
import { Composer } from '@/features/composer/Composer';
import { GoalBar } from '@/features/goals/GoalBar';
import { PrBar } from '@/features/vcs/PrBar';
import { ReviewView } from '../ReviewView';
import { SchedulesView } from '@/features/automation/SchedulesView';
import { shareConversation } from '@/features/chat/MessageActions';
import { Welcome } from '../Welcome';
import { FileTree } from '../FileTree';
import { GitView } from '../GitView';
import { SearchView } from '../SearchView';
import { RootGroups } from '../RootGroups';
import { projectRoots } from '@/features/paths';
import { BoardView } from '@/features/vcs/BoardView';
import type { SessionSummary } from '@shared';
import { Icon } from '@/ui/icons';
import { SessionMenu, effectiveCaps } from '@/features/sidebar/session-actions';
import { sessionPeer } from '@/features/peers';
import { useGitStatus } from '../git-status';
import { Artifacts } from '../Artifacts';
import { openReview, openSessionView } from '../right-panel';
import { SidebarReveal, usePaneEdge } from '../pane-edge';
import { useRepoContext } from '../repo-context';
import { viewsFor, WB_VIEWS } from '../wb-views';
import { runCommand } from '../commands';
import { modKey } from '../shortcuts';
import { TERMS } from '@/ui/terms';
import { imeComposing } from '@/ui/ime';
import { showUsageCard } from '@/features/composer/ContextMeter';
import { tr } from '@/i18n';
import { normViewMode, viewModeLabel } from '@/features/chat/view-mode';
import { InfoColumn } from '@/features/info/InfoColumn';
import { openSideChat } from '@/features/chat/side-chat';
import { openBackground, useBackground } from '@/features/background/state';
import { desktop } from '@/desktop';
import type { PanelId } from '@/model/layout';
import { ThinkingLanguageRow } from '@/features/settings/ThinkingLanguageRow';

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
  const mobile = useStore((st) => st.mobile);
  const viewMode = useStore((st) => normViewMode(st.settings['ui.viewMode']));
  const keepAwake = useStore((st) => !!st.sessionMeta[s.sessionId]?.keepAwake);
  const bgRunning = useBackground((b) => b.sessions[s.sessionId]?.tasks.filter((t) => t.status === 'running').length ?? 0);
  const caps = effectiveCaps(s);
  const act = (fn: () => unknown) => () => { onClose(); void fn(); };
  const st = () => useStore.getState();
  const patch = (p: Partial<ChatTileModel>) => st().dispatchLayout({ t: 'tile.patch', paneId, tileId: tile.id, patch: p });
  return (
    <>
      <button data-act="side" onClick={act(() => openSideChat(s.sessionId))} disabled={!live || remote}><Icon name="chat" size={14} /> <span style={{ flex: 1 }}>{tr('旁聊')}</span><span className="kbd">{modKey}+;</span></button>
      <button data-act="background" onClick={act(() => openBackground(s.sessionId))}><Icon name="tasks" size={14} /> <span style={{ flex: 1 }}>{tr('后台任务')}</span>{bgRunning > 0 && <span className="kbd">{bgRunning}</span>}</button>
      {desktop && !remote && (
        <button data-act="keep-awake" role="menuitemcheckbox" aria-checked={keepAwake} onClick={() => void st().setSessionMeta(s.sessionId, { keepAwake: !keepAwake })} title={tr('这个对话在跑的时候不让电脑睡眠（屏幕照常会关）')}>
          <Icon name="bolt" size={14} /> <span style={{ flex: 1 }}>{tr('保持电脑唤醒')}<span className="menu-sub">{tr('只对这个对话')}</span></span><span className={clsx('toggle sm', keepAwake && 'on')} aria-hidden />
        </button>
      )}
      {/* 思考用的语言, this conversation's own (Claude conversations on this machine: the instruction is Claude's system prompt) */}
      {!remote && !gone && (!s.agent || s.agent === 'claude') && <ThinkingLanguageRow sessionId={s.sessionId} />}
      <div className="menu-sep" />
      <button onClick={act(() => shareConversation(s.sessionId))}><Icon name="share" size={14} /> {tr('导出为 HTML')}</button>
      <button onClick={act(() => patch({ wb: 'live', view: tile.view === 'trajectory' && tile.wb === 'live' ? 'chat' : 'trajectory' }))} title={tr('对话 ⇄ {trajectory}（Alt+J）', { trajectory: TERMS.trajectory })}>
        <Icon name="workflow" size={14} /> <span style={{ flex: 1 }}>{TERMS.trajectory}</span>{tile.wb === 'live' && tile.view === 'trajectory' && <Icon name="check" size={13} />}
      </button>
      {/* the old stats bar: the composer's card (the ring in its corner shows up only from 60 %; final review I3) */}
      <button data-act="usage" onClick={act(() => { if (tile.wb !== 'live') patch({ wb: 'live' }); requestAnimationFrame(() => showUsageCard(tile.id)); })}><Icon name="usage" size={14} /> {tr('本对话用量')}</button>
      {/* 查看模式 is for every conversation (one setting); here because the header is where you look for it */}
      <button data-act="view-mode" onClick={act(() => runCommand('view.cycle'))} title={tr('普通 → 显示思考 → 详细')}><Icon name="eye" size={14} /> <span style={{ flex: 1 }}>{tr('查看模式：{label}', { label: viewModeLabel(viewMode) })}</span><span className="kbd">{modKey}+O</span></button>
      <div className="menu-label">{tr('查看这个对话的')}</div>
      <div className="menu-grid" role="group" aria-label={tr('查看这个对话的')}>
        {viewsFor(remote).map((v) => (
          // the right panel opens them (审阅 / 文件 / a temporary tab; a phone's bottom drawer); a remote conversation in place
          <button key={v.id} className={clsx(tile.wb === v.id && 'on')} onClick={act(() => (tile.wb === v.id ? patch({ wb: 'live' }) : openSessionView(v.id, { paneId, tileId: tile.id })))} data-view={v.id}>
            <Icon name={v.icon} size={13} /> {v.label}
          </button>
        ))}
        {/* phone: the header has no terminal button; the drawer's 终端 / 任务 from here too */}
        {mobile && !remote && <button onClick={act(() => st().dispatchLayout({ t: 'dock.show', panel: 'terminal' }))} data-view="terminal"><Icon name="terminal" size={13} /> {tr('终端')}</button>}
        {mobile && <button onClick={act(() => st().dispatchLayout({ t: 'dock.show', panel: 'tasks' }))} data-view="tasks"><Icon name="tasks" size={13} /> {tr('任务')}</button>}
      </div>
      <div className="menu-sep" />
      {!gone && <button onClick={act(() => st().setSessionMeta(s.sessionId, { pinned: !pinned }))}><Icon name="pin" size={14} /> {pinned ? tr('取消置顶') : tr('置顶')}</button>}
      {!remote && <button onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd }))}><Icon name="folder" size={14} /> {tr('在资源管理器打开')}</button>}
      {!remote && <button onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd, app: 'code' }))}><Icon name="keyboard" size={14} /> {tr('在 VS Code 打开')}</button>}
      {!gone && (live
        ? <button onClick={act(() => st().closeSession(s.sessionId))} title={tr('进程会退出，对话留着，发消息即可继续')}><Icon name="stop" size={14} /> {tr('结束进程')}</button>
        : caps.resume && <button onClick={act(() => st().openSession({ sessionId: s.sessionId, cwd: s.cwd }, 'none').catch((e) => st().toast(e.message)))}><Icon name="play" size={14} /> {tr('恢复运行')}</button>)}
      <div className="menu-sep" />
    </>
  );
}

/**
 * The one row above a conversation (spec §5.2, ≤ 52px): title (double-click to rename) · project · branch ·
 * worktree, and on the right 「改动 +N −M」, terminal, the right-panel toggle and ···. Everything the old header
 * and its workbench-tab row did is in the ··· menu (see HeaderMenu) or the command palette.
 */
/** The header's tool row after 信息 and 终端 (phase 6 spec §2): each opens its right-panel tab; `local`: not for a
 *  conversation on another machine (its files are there). */
const TOOLS: { panel: PanelId; icon: 'diff' | 'browser' | 'files'; local: boolean; label: () => string; title: () => string }[] = [
  { panel: 'files', icon: 'diff', local: true, label: () => tr('审阅'), title: () => tr('审阅这个对话的改动') },
  { panel: 'browser', icon: 'browser', local: false, label: () => tr('浏览器'), title: () => tr('浏览器：预览网页或开发服务器') },
  { panel: 'explorer', icon: 'files', local: true, label: () => tr('文件'), title: () => tr('文件：项目的文件树') },
];

/** `infoShown`: the info column is on screen (on, and the pane wide enough) — else the header keeps the +N −M. */
function SessionHeader({ tile, paneId, infoShown }: { tile: ChatTileModel; paneId: string; infoShown: boolean }) {
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
  const title = meta?.title || tr('新对话');
  const sessions = useStore((s) => s.sessions);
  const peer = sessionPeer(sid, sessions);
  const cwd = active?.cwd || meta?.cwd || '';
  const live = !!active && active.state !== 'history' && active.state !== 'closed' && active.state !== 'error';
  const wsOf = workspaces.find((w) => cwd.toLowerCase().startsWith(w.path.toLowerCase()));
  const agentKind = meta?.agent;
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
  const toggleDock = () => (dockMin ? dispatch({ t: 'dock.set', patch: { minimized: false } }) : dockShown ? dispatch({ t: 'dock.set', patch: { open: false } }) : runCommand('dock.toggle'));
  const terminalOn = dockShown && dock.active === 'terminal' && !dock.minimized;
  const viewDef = tile.wb !== 'live' ? WB_VIEWS.find((v) => v.id === tile.wb) : undefined;
  const dirty = git?.files.length ?? 0;
  const infoOn = useStore((s) => s.settings['ui.infoPanel'] !== false);
  return (
    <div className="sess-head">
      {/* the window's top-left row; on a phone every conversation header, the drawer has no other handle */}
      {((edge.lead && !edge.strip) || mobile) && <SidebarReveal />}
      <div className="sh-main">
        {editing !== null ? (
          <input className="sh-rename" autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={rename} onKeyDown={(e) => (imeComposing(e.nativeEvent) ? null : e.key === 'Enter' ? rename() : e.key === 'Escape' ? setEditing(null) : null)} aria-label={tr('对话标题')} />
        ) : (
          <span className="sh-title" onDoubleClick={() => { if (caps.rename) setEditing(title); }} title={caps.rename ? tr("{title}\n双击重命名", { title }) : title}>{title}</span>
        )}
        <span className="sh-meta">
          {peer
            ? <span className="it" title={tr('{cwd}（在机器「{name}」上）', { cwd, name: peer.name })}><Icon name="machine" size={12} /><span className="nm">{peer.name} · {basename(cwd)}</span></span>
            : cwd && <span className="it" title={tr("{cwd}\n（在资源管理器打开：··· 菜单）", { cwd })}><Icon name="folder" size={12} /><span className="nm">{wsOf?.name ?? basename(cwd)}</span></span>}
          {/* grey words, not buttons (spec §5.2; final review I3): the folder opens from ···, the uncommitted changes
              from +N −M / the right panel's 审阅 / ··· 改动 */}
          {branch && !peer && (
            <span className={clsx('it branch', git && git.state !== 'clean' && 'dirty')} title={`${branch}${git?.upstream ? ` → ${git.upstream}` : git ? tr(' · 无上游') : ''}${git ? (dirty ? tr(' · {dirty} 处未提交的改动', { dirty }) : tr(' · 干净')) : ''}${git?.ahead ? tr(' · 领先 {ahead}', { ahead: git.ahead }) : ''}${git?.behind ? tr(' · 落后 {behind}', { behind: git.behind }) : ''}`}>
              <Icon name="branch" size={12} /><span className="nm bn">{branch}</span>
            </span>
          )}
          {worktree && <span className="tag" title={tr('这个对话在仓库的一个独立副本（git worktree）里运行，不是主检出')}>{tr('独立副本')}</span>}
          {agentKind === 'claudeai' && <span className="tag" title={tr('从 claude.ai 数据导出导入的对话')}>claude.ai</span>}
          {!live && !gone && !caps.resume && <span className="tag" title={tr('这个来源没有官方的续聊接口，只能查看')}>{tr('只读')}</span>}
        </span>
        {viewDef && (
          <button className="sh-view" onClick={() => patch({ wb: 'live' })} title={tr('回到对话')}><Icon name={viewDef.icon} size={13} /> {viewDef.label}<Icon name="close" size={11} /></button>
        )}
        {!viewDef && tile.view === 'trajectory' && (
          <button className="sh-view" onClick={() => patch({ view: 'chat' })} title={tr('回到对话（Alt+J）')}><Icon name="workflow" size={13} /> {TERMS.trajectory}<Icon name="close" size={11} /></button>
        )}
      </div>
      <span className="sh-actions">
        {/* phone (UI refresh §8): ☰ · title · +N −M (when there are changes) · ··· — 终端 / 任务 and the other views
            are in ··· and open the bottom drawer (whose own tabs switch between 审阅 · 文件 · 终端 · 任务) */}
        {stat && stat.files > 0 && (mobile || !infoShown) && (
          <button className="sh-diff" title={tr("这个对话改了 {files} 个文件：+{added} 行 −{removed} 行\n点击{v}审阅这些改动", { files: stat.files, added: stat.added, removed: stat.removed, v: mobile ? '' : tr('在右侧') })} onClick={() => openReview({ scope: 'session' })}>
            <span className="add">+{stat.added}</span><span className="del">−{stat.removed}</span>
          </button>
        )}
        {!mobile && <button className={clsx('icon-btn', infoShown && 'active')} title={infoOn && !infoShown ? tr('对话信息：这里太窄，先收起了（窗口拉宽或关掉右侧面板就回来）；点一下关掉') : tr('对话信息：环境、上下文、连接器、改动、后台任务')} aria-label={tr('对话信息')} aria-pressed={infoShown} onClick={() => void useStore.getState().setSetting('ui.infoPanel', !infoOn)}><Icon name={'info'} size={16} /></button>}
        {!peer && !mobile && <button className={clsx('icon-btn', terminalOn && 'active')} title={tr('终端 ({modKey}+`)', { modKey })} aria-label={tr('终端')} onClick={() => (terminalOn ? dispatch({ t: 'dock.set', patch: { open: false } }) : dispatch({ t: 'dock.show', panel: 'terminal' }))}><Icon name="terminal" size={16} /></button>}
        {!mobile && TOOLS.filter((t) => !peer || !t.local).map((t) => {
          const on = dockShown && !dock.minimized && dock.active === t.panel;
          return <button key={t.panel} className={clsx('icon-btn', on && 'active')} data-tool={t.panel} title={t.title()} aria-label={t.label()} aria-pressed={on} onClick={() => (on ? dispatch({ t: 'dock.set', patch: { open: false } }) : dispatch({ t: 'dock.show', panel: t.panel }))}><Icon name={t.icon} size={16} /></button>;
        })}
        {!mobile && <button className={clsx('icon-btn', dockShown && !dockMin && 'active')} title={dockMin ? tr('展开{dock} ({modKey}+J)', { dock: TERMS.dock, modKey }) : `${TERMS.dock} (${modKey}+J)`} aria-label={dockMin ? tr('展开{dock}', { dock: TERMS.dock }) : TERMS.dock} aria-pressed={dockShown && !dockMin} onClick={toggleDock}><Icon name="inspector" size={16} /></button>}
        <span className="sh-more">
          <button className={clsx('icon-btn', menu && 'active')} title={tr('这个对话的更多操作：导出、步骤视图、改动 / Git / 文件…、重命名、分叉、归档、删除')} aria-label={tr('更多操作')} aria-expanded={menu} aria-haspopup="menu" onClick={(e) => { e.stopPropagation(); setMenu(!menu); }}><Icon name="more" size={16} /></button>
          {menu && <SessionMenu s={summary} deleted={gone} onClose={() => setMenu(false)} style={{ right: 0, top: 34 }} extra={<HeaderMenu tile={tile} paneId={paneId} s={summary} live={live} remote={!!peer} gone={gone} onClose={() => setMenu(false)} />} />}
        </span>
      </span>
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
  // a project with extra folders: a group per folder in files / search / git (stage C2)
  const workspaces = useStore((s) => s.workspaces);
  const roots = useMemo(() => projectRoots(active?.cwd ?? '', workspaces), [active?.cwd, workspaces]);
  const deleted = useStore((s) => (sid ? !!s.deletedSessions[sid] : false));
  // 信息栏 (phase 6 spec §1): on unless switched off; it steps aside while the pane is too narrow for both columns
  const mobile = useStore((s) => s.mobile);
  const infoOn = useStore((s) => s.settings['ui.infoPanel'] !== false);
  const split = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(true);
  useEffect(() => {
    const el = split.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setRoomy(e.contentRect.width >= 560 + 288));
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!active, mobile, tile.wb]);
  const infoShown = infoOn && roomy && !deleted;
  // a character theme's backdrop, faint and slow behind the conversation (设置 → 对话里的淡背景)
  const chatBackdrop = useStore((s) => s.settings['ui.backdropInChat'] !== false) && !!useActivePack()?.backdrop;
  // restored from a persisted layout: lazily pull the transcript
  useEffect(() => {
    if (sid && !has && visible) void loadHistory(sid, { focus: false });
  }, [sid, has, visible]);
  // written from outside (a CLI in a terminal) while it was not on screen: catch up when it is shown
  const stale = useStore((s) => (sid ? !!s.open[sid]?.staleHistory : false));
  useEffect(() => {
    if (sid && stale && visible) void useStore.getState().refreshExternal(sid);
  }, [sid, stale, visible]);
  if (!sid) return <Welcome paneId={paneId} tileId={tile.id} />;
  if (!active) return <div className="empty">{tr('加载对话…')}</div>;
  const live = (
    <>
      <GoalBar sessionId={sid} />
      <PrBar sessionId={sid} visible={visible} />
      {tile.view === 'chat' ? <ChatView key={sid} /> : <TrajectoryView key={sid} />}
      <Composer key={`c-${sid}`} disabled={deleted} visible={visible} />
    </>
  );
  return (
    <div className="chat-tile">
      <SessionHeader tile={tile} paneId={paneId} infoShown={infoShown && !mobile && tile.wb === 'live'} />
      {deleted && <div className="deleted-banner" role="status"><Icon name="trash" size={13} /> {tr('这个对话已被删除（备份在 ~/.claude-web/library-trash），这里只剩最后看到的内容。')}</div>}
      {tile.wb === 'live' && (mobile ? live : (
        <div className="chat-split" ref={split}>
          <div className="chat-main">{chatBackdrop && <Backdrop scene="chat" />}{live}</div>
          {infoShown && <InfoColumn sessionId={sid} />}
        </div>
      ))}
      {remoteView && <div className="wb-body"><div className="remote-only"><Icon name="machine" size={22} /><div>{tr('这个对话在机器「{name}」上，它的文件 / Git / 搜索 / 定时任务都在那台机器上。', { name: peer!.name })}</div><div className="sub">{tr('请在该机器上查看；这里可以继续对话、审批、中断。')}</div></div></div>}
      {remoteView ? null : <>
      {tile.wb === 'changes' && <div className="wb-body"><ReviewView inPlace visible={visible} /></div>}
      {tile.wb === 'git' && <div className="wb-body"><RootGroups roots={roots}>{(r) => <GitView cwd={r} visible={visible} />}</RootGroups></div>}
      {tile.wb === 'files' && <div className="wb-body"><RootGroups roots={roots}>{(r) => <FileTree root={r} gitStatus={r === active.cwd ? gitStatus : undefined} />}</RootGroups></div>}
      {tile.wb === 'search' && <div className="wb-body"><RootGroups roots={roots}>{(r) => <SearchView root={r} />}</RootGroups></div>}
      {tile.wb === 'schedules' && <div className="wb-body"><SchedulesView /></div>}
      {tile.wb === 'artifacts' && <div className="wb-body"><Artifacts sessionId={sid} /></div>}
      {tile.wb === 'board' && <div className="wb-body"><BoardView cwd={active.cwd} sid={sid} /></div>}
      </>}
    </div>
  );
}
