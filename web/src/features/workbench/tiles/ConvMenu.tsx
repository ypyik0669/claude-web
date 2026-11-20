// The conversation header's ⋯ (redesign 2026-11 #pages 「侧栏和菜单」 对话头 ⋯; #phone 对话 ⋯ — problem 10).
//
// A desktop: one short menu — 重命名 · 分叉 · 导出… · 步骤视图 · 更多 › | 对话信息栏 (Ctrl I) · Issue 与 PR · Android 屏幕 |
// 交给其它 Agent… · 归档 · 删除. The panels are the header's five tools now; what the old menu also held and is used less
// (旁聊, 思考语言, 查看模式, 后台任务, 保持电脑唤醒, 置顶, 在资源管理器 / VS Code 打开, 结束进程, 引用, 原生 CLI, 复制 ID)
// is under 更多, which opens in place (one anchored menu at a time: a fly-out would close this one).
//
// A phone: a sheet — the title, a six-grid of what this conversation has to look at (改动 · 任务 · 终端 · 文件 · 浏览器 ·
// Artifacts: a tap pulls the bottom panel up on it), then five rows: 重命名 · 分叉 · 导出… · 查看模式 › · 更多 ›. A ›
// pushes its page into the same sheet, back at its top-left (the phone rules). 更多 also has the long-press actions of
// the last reply and of your last message (the same actions without the long press: plan.txt 「⋯ 里也能找到同样的操作」).
import { useMemo, useRef, useState } from 'react';
import type { SessionMeta, SessionSummary } from '@shared';
import { settledVersion, useSettledSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { basename, clsx } from '@/util';
import { cachedDiffStat } from '@/model/diffstat';
import { groupTurns, taskPlan } from '@/model/turn';
import type { Tile } from '@/model/layout';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { TERMS } from '@/ui/terms';
import { tr } from '@/i18n';
import { desktop } from '@/desktop';
import { MenuHost, closeDrawer, useAnchoredMenu } from '@/features/sidebar/menus';
import { deleteSessions, effectiveCaps, forkSession, handOver, handOverToLocal, nativeCliCommand, openNativeCli, referenceSession, renameSession, setArchived } from '@/features/sidebar/session-actions';
import { agentOf, isArchived } from '@/features/sidebar/filter';
import { canHandOffToPeer } from '@/features/cloud/logic';
import { openHandoffDialog } from '@/features/cloud/HandoffDialog';
import { shareConversation } from '@/features/chat/MessageActions';
import { openSideChat } from '@/features/chat/side-chat';
import { openBackground, useBackground } from '@/features/background/state';
import { ThinkingLanguageRow } from '@/features/settings/ThinkingLanguageRow';
import { VIEW_MODES, normViewMode, viewModeLabel } from '@/features/chat/view-mode';
import { useConversationArtifacts } from '@/features/panels/ArtifactsPanel';
import { openMessageSheet } from '@/features/chat/MessageSheet';
import { runCommand } from '../commands';
import { modKey } from '../shortcuts';

type ChatTileModel = Extract<Tile, { kind: 'chat' }>;

export interface ConvMenuProps {
  tile: ChatTileModel;
  paneId: string;
  s: SessionSummary;
  live: boolean;
  remote: boolean;
  gone: boolean;
  phone: boolean;
  onClose: () => void;
}

/** The six-grid's panels, in the mockup's order. */
const TILES = [
  { panel: 'files', icon: 'diff', label: () => tr('改动') },
  { panel: 'tasks', icon: 'tasks', label: () => tr('任务') },
  { panel: 'terminal', icon: 'terminal', label: () => tr('终端') },
  { panel: 'explorer', icon: 'folder', label: () => tr('文件') },
  { panel: 'browser', icon: 'web', label: () => tr('浏览器') },
  { panel: 'artifacts', icon: 'works', label: () => 'Artifacts' },
] as const;

export function ConvMenu(p: ConvMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<'main' | 'more' | 'view' | 'handoff'>('main');
  const [more, setMore] = useState(false);
  const [handoff, setHandoff] = useState(false);
  // fixed to the viewport next to its anchor (a desktop); a phone draws it in a sheet (MenuHost)
  useAnchoredMenu(ref, p.onClose, { deps: [page, more, handoff] });
  const { s, live, remote, gone, phone, tile, paneId } = p;
  const meta = useStore((st) => st.sessionMeta[s.sessionId]) as SessionMeta | undefined;
  const agents = useStore((st) => st.agents);
  const infoOn = useStore((st) => st.settings['ui.infoPanel'] !== false);
  const viewMode = useStore((st) => normViewMode(st.settings['ui.viewMode']));
  const bgRunning = useBackground((b) => b.sessions[s.sessionId]?.tasks.filter((t) => t.status === 'running').length ?? 0);
  const o = useSettledSession(s.sessionId);
  const stat = o ? cachedDiffStat(o.conv, settledVersion(o)) : null;
  const plan = useMemo(() => {
    if (!o) return null;
    const todos = (taskPlan(groupTurns(o.conv.items))?.input as { todos?: { status?: string }[] } | undefined)?.todos;
    return todos?.length ? { done: todos.filter((t) => t.status === 'completed').length, total: todos.length } : null;
  }, [o?.version]);
  const arts = useConversationArtifacts(phone ? s.sessionId : null);
  const caps = gone ? { ...effectiveCaps(s), fork: false, resume: false, rename: false, archive: false, delete: false } : effectiveCaps(s);
  const archived = isArchived(s, meta ? { [s.sessionId]: meta } : {});
  const cli = nativeCliCommand(s);
  const st = () => useStore.getState();
  const act = (fn: () => unknown) => () => { p.onClose(); closeDrawer(); void fn(); };
  const patch = (x: Partial<ChatTileModel>) => st().dispatchLayout({ t: 'tile.patch', paneId, tileId: tile.id, patch: x });
  const steps = tile.wb === 'live' && tile.view === 'trajectory';
  const cur = agentOf(s);
  const targets = remote && s.peer?.offline ? [] : agents.filter((a) => a.installed !== false && a.enabled !== false && (remote || a.kind !== cur));
  const agentRows = targets.map((a) => (
    <button key={a.kind} data-agent={a.kind} onClick={act(() => (remote ? handOverToLocal(s, a.kind) : handOver(s, a.kind)))}><Icon name={AGENT_ICONS[a.kind] ?? 'agent'} size={14} /> {a.name}</button>
  ));
  const handoffLabel = remote ? tr('交给本机的 Agent 继续…') : tr('交给其它 Agent…');

  // ---- rows both share
  const rename = caps.rename && <button data-act="rename" onClick={act(() => renameSession(s))}><Icon name="edit" size={14} /> {tr('重命名')}</button>;
  const fork = caps.fork && <button data-act="fork" onClick={act(() => forkSession(s))}><Icon name="branch" size={14} /> {tr('分叉')}</button>;
  const exp = <button data-act="export" onClick={act(() => shareConversation(s.sessionId))} title={tr('把这个对话导出成一个 HTML 文件')}><Icon name="share" size={14} /> {tr('导出…')}</button>;
  const archive = caps.archive && <button data-act="archive" onClick={act(() => setArchived([s], !archived))}><Icon name="archive" size={14} /> {archived ? tr('取消归档') : tr('归档')}</button>;
  const del = caps.delete && <button data-act="delete" className="danger" onClick={act(() => deleteSessions([s]))}><Icon name="trash" size={14} /> {tr('删除…')}</button>;
  const board = !remote && <button data-act="board" onClick={act(() => st().dispatchLayout({ t: 'dock.show', panel: 'board' }))}><Icon name="board" size={14} /> {tr('Issue 与 PR')}</button>;
  const android = !remote && !phone && <button data-act="android" onClick={act(() => st().dispatchLayout({ t: 'dock.show', panel: 'android' }))}><Icon name="android" size={14} /> {tr('Android 屏幕')}</button>;
  // the less used ones (更多): in place on a desktop, a page of the sheet on a phone
  const side = <button data-act="side" onClick={act(() => openSideChat(s.sessionId))} disabled={!live || remote}><Icon name="chat" size={14} /> <span className="grow">{tr('旁聊')}</span><span className="kbd">{modKey}+;</span></button>;
  const lang = !remote && !gone && (!s.agent || s.agent === 'claude') ? <ThinkingLanguageRow sessionId={s.sessionId} /> : null;
  const keepAwake = desktop && !remote && <KeepAwakeRow sessionId={s.sessionId} />;
  const background = <button data-act="background" onClick={act(() => openBackground(s.sessionId))}><Icon name="tasks" size={14} /> <span className="grow">{tr('后台任务')}</span>{bgRunning > 0 && <span className="menu-value">{bgRunning}</span>}</button>;
  const pin = !gone && <button data-act="pin" onClick={act(() => st().setSessionMeta(s.sessionId, { pinned: !meta?.pinned }))}><Icon name="pin" size={14} /> {meta?.pinned ? tr('取消置顶') : tr('置顶')}</button>;
  const explorer = !remote && !phone && <button data-act="explorer" onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd }))}><Icon name="folder" size={14} /> {tr('在资源管理器打开')}</button>;
  const vscode = !remote && !phone && <button data-act="vscode" onClick={act(() => ws.request({ kind: 'shell.open', path: s.cwd, app: 'code' }))}><Icon name="keyboard" size={14} /> {tr('在 VS Code 打开')}</button>;
  const proc = !gone && (live
    ? <button data-act="stop" onClick={act(() => st().closeSession(s.sessionId))} title={tr('进程会退出，对话留着，发消息即可继续')}><Icon name="stop" size={14} /> {tr('结束进程')}</button>
    : caps.resume ? <button data-act="resume" onClick={act(() => st().openSession({ sessionId: s.sessionId, cwd: s.cwd }, 'none').catch((e) => st().toast(e.message)))}><Icon name="play" size={14} /> {tr('恢复运行')}</button> : null);
  const reference = !gone && <button data-act="reference" onClick={act(() => referenceSession(s))}><Icon name="quote" size={14} /> {tr('引用到输入框')}</button>;
  const peerHandoff = !gone && canHandOffToPeer(s, meta) && <button data-act="handoff-peer" onClick={act(() => openHandoffDialog(s))}><Icon name="monitor" size={14} /> {tr('交给常开机器继续…')}</button>;
  const native = !gone && cli && !phone && <button data-act="native-cli" onClick={act(() => openNativeCli(s))} title={cli}><Icon name="terminal" size={14} /> {tr('在原生 CLI 打开')}</button>;
  const copyId = <button data-act="copy-id" onClick={act(() => { void navigator.clipboard.writeText(s.sessionId); st().toast(tr('已复制 session id'), true); })}><Icon name="copy" size={14} /> {tr('复制 ID')}</button>;

  if (phone) {
    const back = (title: string) => <button className="cm-back" data-act="back" onClick={() => setPage('main')}><Icon name="chevronLeft" size={16} /> {title}</button>;
    const count = (panel: (typeof TILES)[number]['panel']) => panel === 'files' && stat && stat.files > 0 ? <small><span className="add">+{stat.added}</span> <span className="del">−{stat.removed}</span></small>
      : panel === 'tasks' && plan ? <small>{plan.done} / {plan.total}</small> : panel === 'artifacts' && arts.length ? <small>{arts.length}</small> : null;
    return (
      <MenuHost onClose={p.onClose}>
        <div ref={ref} className="menu sess-menu conv-menu phone" role="menu" aria-label={tr('这个对话')} onClick={(e) => e.stopPropagation()}>
          {page === 'main' && (
            <>
              <div className="cm-title"><b>{s.title || tr('新对话')}</b>{(s.cwd || s.gitBranch) && <small>{[s.peer ? `${s.peer.name} · ${basename(s.cwd ?? '')}` : basename(s.cwd ?? ''), s.gitBranch].filter(Boolean).join(' · ')}</small>}</div>
              {/* the six things to look at: a tap pulls the bottom panel up on it */}
              <div className="cm-tiles" role="group" aria-label={tr('查看这个对话的')}>
                {TILES.filter((t) => !remote || t.panel === 'tasks').map((t) => (
                  <button key={t.panel} className="cm-tile" data-view={t.panel} onClick={act(() => st().dispatchLayout({ t: 'dock.show', panel: t.panel }))}>
                    <Icon name={t.icon} size={20} /><span>{t.label()}</span>{count(t.panel)}
                  </button>
                ))}
              </div>
              <div className="menu-sep" />
              {rename}{fork}{exp}
              <button data-act="view-mode" className="cm-push" onClick={() => setPage('view')}><Icon name="eye" size={14} /> <span className="grow">{tr('查看模式')}</span><span className="menu-value">{viewModeLabel(viewMode)}</span><Icon name="chevronRight" size={14} /></button>
              <button data-act="more" className="cm-push" onClick={() => setPage('more')}><Icon name="more" size={14} /> <span className="grow">{tr('更多')}</span><Icon name="chevronRight" size={14} /></button>
            </>
          )}
          {page === 'view' && (
            <>
              {back(tr('查看模式'))}
              {VIEW_MODES.map((m) => (
                <button key={m} role="menuitemradio" aria-checked={m === viewMode} data-mode={m} onClick={act(() => st().setSetting('ui.viewMode', m))}>
                  <span className="grow">{viewModeLabel(m)}</span>{m === viewMode && <Icon name="check" size={14} />}
                </button>
              ))}
            </>
          )}
          {page === 'more' && (
            <>
              {back(tr('更多'))}
              {lang}{side}{board}
              {/* the long-press actions, without the long press */}
              <button data-act="last-reply" onClick={act(() => openMessageSheet(s.sessionId, 'assistant'))}><Icon name="chat" size={14} /> {tr('最后一条回复…')}</button>
              <button data-act="last-message" onClick={act(() => openMessageSheet(s.sessionId, 'user'))}><Icon name="edit" size={14} /> {tr('我的上一条消息…')}</button>
              <div className="menu-sep" />
              <button data-act="handoff" className="cm-push" onClick={() => setPage('handoff')}><Icon name="agent" size={14} /> <span className="grow">{handoffLabel}</span><Icon name="chevronRight" size={14} /></button>
              {peerHandoff}{pin}{proc}{background}{reference}{copyId}
              <div className="menu-sep" />
              {archive}{del}
            </>
          )}
          {page === 'handoff' && (
            <>
              {back(handoffLabel)}
              {agentRows}
              {!targets.length && <div className="menu-note">{tr('没有其它可用的 agent')}</div>}
            </>
          )}
        </div>
      </MenuHost>
    );
  }

  return (
    <div ref={ref} className="menu sess-menu conv-menu" role="menu" aria-label={tr('这个对话')} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {rename}{fork}{exp}
      <button data-act="steps" role="menuitemcheckbox" aria-checked={steps} onClick={act(() => patch({ wb: 'live', view: steps ? 'chat' : 'trajectory' }))} title={tr('对话 ⇄ {trajectory}', { trajectory: TERMS.trajectory })}>
        <Icon name="workflow" size={14} /> <span className="grow">{TERMS.trajectory}</span><span className="kbd">Alt+J</span>{steps && <Icon name="check" size={13} />}
      </button>
      <button data-act="more" aria-expanded={more} onClick={() => setMore((v) => !v)}><Icon name="more" size={14} /> <span className="grow">{tr('更多')}</span><Icon name={more ? 'chevronDown' : 'chevronRight'} size={12} /></button>
      {more && (
        <div className="sub-menu cm-more">
          {side}{lang}
          <button data-act="view-mode" onClick={act(() => runCommand('view.cycle'))} title={tr('普通 → 显示思考 → 详细')}><Icon name="eye" size={14} /> <span className="grow">{tr('查看模式：{label}', { label: viewModeLabel(viewMode) })}</span><span className="kbd">{modKey}+O</span></button>
          {background}{keepAwake}{pin}{explorer}{vscode}{proc}{reference}{peerHandoff}{native}{copyId}
        </div>
      )}
      <div className="menu-sep" />
      <button data-act="info" role="menuitemcheckbox" aria-checked={infoOn} onClick={act(() => runCommand('info.toggle'))} title={tr('对话右边的一列：环境、上下文、连接器、改动、后台任务（窗口够宽、右侧面板关着时显示）')}>
        <span className="cm-ck">{infoOn && <Icon name="check" size={13} />}</span><span className="grow">{tr('对话信息栏')}</span><span className="kbd">{modKey} I</span>
      </button>
      {board}{android}
      <div className="menu-sep" />
      {!gone && (
        <>
          <button data-act="handoff" aria-expanded={handoff} onClick={() => setHandoff((v) => !v)}><Icon name="agent" size={14} /> <span className="grow">{handoffLabel}</span><Icon name={handoff ? 'chevronDown' : 'chevronRight'} size={12} /></button>
          {handoff && (
            <div className="sub-menu">
              {agentRows}
              {!targets.length && <div className="menu-note">{tr('没有其它可用的 agent')}</div>}
            </div>
          )}
        </>
      )}
      {archive}{del}
      {gone && copyId}
    </div>
  );
}

/** 保持电脑唤醒 while this conversation runs (the desktop app): a switch row. */
function KeepAwakeRow({ sessionId }: { sessionId: string }) {
  const on = useStore((st) => !!st.sessionMeta[sessionId]?.keepAwake);
  return (
    <button data-act="keep-awake" role="menuitemcheckbox" aria-checked={on} onClick={() => void useStore.getState().setSessionMeta(sessionId, { keepAwake: !on })} title={tr('这个对话在跑的时候不让电脑睡眠（屏幕照常会关）')}>
      <Icon name="bolt" size={14} /> <span className="grow">{tr('保持电脑唤醒')}<span className="menu-sub">{tr('只对这个对话')}</span></span><span className={clsx('toggle sm', on && 'on')} aria-hidden />
    </button>
  );
}

