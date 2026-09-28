import { useRef, useState } from 'react';
import type { AgentKind, SessionMeta, SessionSummary } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { dlg } from '@/ui/dialog';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { isImportedSessionId } from '@/util';
import { handOverConfirmText, turnRunning } from './handover-text';
import { agentOf, isArchived } from './filter';
import { deleteSummary, deleteTargets, effectiveCaps, nativeCliCommand } from './caps';
import { closeDrawer, useAnchoredMenu } from './menus';
import type { RowMenuId } from './entries';
import { TERMS } from '@/ui/terms';

export { effectiveCaps, capsIntersection, nativeCliCommand, type EffectiveCaps } from './caps';

function sourceName(kind: AgentKind): string {
  const st = useStore.getState();
  return st.librarySources.find((x) => x.kind === kind)?.name ?? st.agents.find((a) => a.kind === kind)?.name ?? (kind === 'claude' ? 'Claude Code' : kind);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function renameSession(s: SessionSummary): Promise<void> {
  const st = useStore.getState();
  const t = (await dlg.prompt('重命名会话', s.title))?.trim();
  if (!t || t === s.title) return;
  await st.libraryOp('rename', { sessionId: s.sessionId, title: t }).catch((e) => st.toast(errText(e)));
}

export async function setArchived(list: SessionSummary[], archived: boolean): Promise<void> {
  const st = useStore.getState();
  const viaLib = list.filter((s) => effectiveCaps(s).archiveVia === 'library');
  const viaMeta = list.filter((s) => effectiveCaps(s).archiveVia === 'meta');
  await Promise.all(viaMeta.map((s) => st.setSessionMeta(s.sessionId, { archived })));
  if (viaLib.length) {
    try {
      const r = await st.libraryOp('archive', { sessionIds: viaLib.map((s) => s.sessionId), archived });
      if (r?.failed?.length) st.toast(`${r.failed.length} 个会话${archived ? '归档' : '取消归档'}失败：${r.failed[0].error}`);
    } catch (e) { st.toast(errText(e)); }
  }
}

/** Two confirmations; the second names the backup and the source it will be deleted from. */
export async function deleteSessions(list: SessionSummary[]): Promise<boolean> {
  const st = useStore.getState();
  if (!list.length) return false;
  const first = list.length === 1 ? `删除会话「${list[0].title}」？` : `删除选中的 ${list.length} 个会话？`;
  if (!(await dlg.confirm(first, { message: `${deleteSummary(list, (k) => sourceName(k as AgentKind))}。会话记录会从它所属的 agent 里移除；只是不想看到的话，用「归档」。`, danger: true, okLabel: '继续' }))) return false;
  const where = deleteTargets(list, (k) => sourceName(k as AgentKind));
  if (!(await dlg.confirm('再确认一次：删除后不能在这里恢复', { message: `将先备份到 ~/.claude-web/library-trash，再${where}`, danger: true, okLabel: '删除' }))) return false;
  try {
    const r = await st.libraryOp('delete', { sessionIds: list.map((s) => s.sessionId) });
    const failed: { id: string; error: string }[] = r?.failed ?? [];
    st.markDeleted(Array.isArray(r?.removed) ? r.removed : list.map((s) => s.sessionId).filter((id) => !failed.some((f) => f.id === id)));
    if (failed.length) st.toast(`${failed.length} 个会话没有删除：${failed[0].error}`);
    else st.toast(list.length === 1 ? '已删除（备份在 library-trash）' : `已删除 ${list.length} 个会话（备份在 library-trash）`, true);
    await st.refreshSessions().catch(() => {});
    return !failed.length;
  } catch (e) {
    st.toast(errText(e));
    return false;
  }
}

export async function forkSession(s: SessionSummary): Promise<void> {
  const st = useStore.getState();
  try {
    if (isImportedSessionId(s.sessionId)) {
      const r = await st.libraryOp('fork', { sessionId: s.sessionId });
      await st.refreshSessions().catch(() => {});
      if (r?.sessionId) await st.loadHistory(r.sessionId, { mode: 'tab' });
    } else await st.openSession({ sessionId: s.sessionId, cwd: s.cwd, fork: true });
  } catch (e) { st.toast(errText(e)); }
}

/**
 * Hand a session to another agent (··· and the model menu, which passes the model picked in that agent's section
 * and its name as the menu shows it). false = cancelled or failed.
 */
export async function handOver(s: SessionSummary, agent: AgentKind, model?: string, modelLabel?: string): Promise<boolean> {
  const st = useStore.getState();
  const name = agent === 'claude' ? 'Claude Code' : st.agents.find((a) => a.kind === agent)?.name ?? agent;
  const running = turnRunning(st.open[s.sessionId]?.state, s.live);
  const text = handOverConfirmText({ sessionId: s.sessionId, agentName: name, modelLabel: model ? modelLabel || model : undefined, running });
  const ok = await dlg.confirm(text.title, { message: text.message, okLabel: '交接' });
  if (!ok) return false;
  try {
    const r = await ws.request<{ sessionId: string }>({ kind: 'session.switchAgent', sessionId: s.sessionId, agent, model });
    st.toast(`已交接给 ${name}`, true);
    await st.refreshSessions().catch(() => {});
    // an imported session is never swapped in place: the hand-over is a new session — open that one
    if (r?.sessionId && r.sessionId !== s.sessionId) await st.loadHistory(r.sessionId, { mode: 'tab' });
    else await st.loadHistory(s.sessionId);
    return true;
  } catch (e) { st.toast(errText(e)); return false; }
}

/**
 * 「交给本机 agent 继续」: a session on another machine is read through that machine and handed to an agent
 * HERE as a new session with a briefing. Its paths are the other machine's, so the user picks the local
 * directory (default: the first workspace).
 */
export async function handOverToLocal(s: SessionSummary, agent: AgentKind): Promise<void> {
  const st = useStore.getState();
  const name = st.agents.find((a) => a.kind === agent)?.name ?? agent;
  const def = st.workspaces[0]?.path ?? '';
  const cwd = (await dlg.prompt(`交给本机的 ${name}：在哪个目录继续？`, def, {
    message: `这个会话在机器「${s.peer?.name ?? '?'}」上（目录 ${s.cwd}），那里的路径在本机多半不存在。会新建一个本机会话，带上一份交接说明；原会话保持不变。`,
    okLabel: '交接',
  }))?.trim();
  if (!cwd) return;
  try {
    const r = await ws.request<{ sessionId: string }>({ kind: 'peers.handover', sessionId: s.sessionId, agent, cwd });
    st.toast(`已交给本机的 ${name}`, true);
    await st.refreshSessions().catch(() => {});
    if (r?.sessionId) await st.loadHistory(r.sessionId, { mode: 'tab' });
  } catch (e) { st.toast(errText(e)); }
}

export function openNativeCli(s: SessionSummary): void {
  const cmd = nativeCliCommand(s);
  if (!cmd) return;
  useStore.getState().openTile({ id: `t${Date.now()}`, kind: 'term', cwd: s.cwd, cmd, title: cmd.split(' ')[0] }, 'tab');
}

/** Payload of the `cw:reference` window event; the composer of the front chat tile claims it. */
export interface ReferenceDetail { id: string; title: string; handled: boolean; reason?: string }
export const REFERENCE_EVENT = 'cw:reference';

export function referenceSession(s: SessionSummary): void {
  const detail: ReferenceDetail = { id: s.sessionId, title: s.title, handled: false };
  window.dispatchEvent(new CustomEvent(REFERENCE_EVENT, { detail }));
  if (!detail.handled) useStore.getState().toast(detail.reason ?? '先打开一个对话（或新对话），再引用');
}

/**
 * The session menu: the sidebar row's "…" / right-click, and the session header's "…".
 * `extra` lets the sidebar keep its own entries (open in tab / split, pin, explorer…).
 * `handoffInline` lists the agents right in the menu instead of behind a sub-menu (the header's ···).
 * `deleted`: the session is gone from its source — only `extra` (what works on the screen) and the id remain.
 */
export function SessionMenu({ s, onClose, style, extra, handoffInline, deleted }: { s: SessionSummary; onClose: () => void; style?: React.CSSProperties; extra?: React.ReactNode; handoffInline?: boolean; deleted?: boolean }) {
  const meta = useStore((st) => st.sessionMeta[s.sessionId]) as SessionMeta | undefined;
  const agents = useStore((st) => st.agents);
  const [handoff, setHandoff] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // fixed to the viewport next to its anchor: a scrolling sidebar list or a pane edge never clips it, and a long
  // menu near the bottom of the window opens upwards instead
  useAnchoredMenu(ref, onClose, { deps: [handoff] });
  const caps = effectiveCaps(s);
  const archived = isArchived(s, meta ? { [s.sessionId]: meta } : {});
  const cli = nativeCliCommand(s);
  // an action from the phone drawer (the sidebar's row menu) gets the drawer out of the way; elsewhere closeDrawer is a no-op
  const act = (fn: () => unknown) => () => { onClose(); closeDrawer(); void fn(); };
  const cur = agentOf(s);
  // a session on another machine can go to ANY local agent (the same kind included: it moves machines);
  // an offline machine can't be read, so there is nothing to hand over
  const remote = !!s.peer;
  const targets = remote && s.peer?.offline ? [] : agents.filter((a) => a.installed !== false && a.enabled !== false && (remote || a.kind !== cur));
  const handoffLabel = remote ? '交给本机的 Agent 继续' : TERMS.handoff;
  const agentButtons = targets.map((a) => (
    <button key={a.kind} data-agent={a.kind} onClick={act(() => (remote ? handOverToLocal(s, a.kind) : handOver(s, a.kind)))}><Icon name={AGENT_ICONS[a.kind] ?? 'agent'} size={13} /> {a.name}</button>
  ));
  const id = (x: RowMenuId) => x;
  return (
    <div ref={ref} className="menu sess-menu" role="menu" title="" style={style ?? { right: 8, top: 28 }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {extra}
      {!deleted && <>
      <button data-id={id('reference')} onClick={act(() => referenceSession(s))}><Icon name="quote" size={14} /> 引用到输入框</button>
      {caps.rename && <button data-id={id('rename')} onClick={act(() => renameSession(s))}><Icon name="edit" size={14} /> 重命名</button>}
      {caps.fork && <button data-id={id('fork')} onClick={act(() => forkSession(s))}><Icon name="branch" size={14} /> 分叉</button>}
      {caps.archive && <button data-id={id('archive')} onClick={act(() => setArchived([s], !archived))}><Icon name="archive" size={14} /> {archived ? '取消归档' : '归档'}</button>}
      {handoffInline ? (
        <>
          <div className="menu-label" data-id={id('handoff')}>{handoffLabel}</div>
          {agentButtons}
          {!targets.length && <div className="menu-note">没有其它可用的 agent</div>}
        </>
      ) : (
        <>
          <button data-id={id('handoff')} onClick={() => setHandoff(!handoff)} aria-expanded={handoff}><Icon name="agent" size={14} /> <span style={{ flex: 1 }}>{handoffLabel}</span><Icon name={handoff ? 'chevronDown' : 'chevronRight'} size={12} /></button>
          {handoff && (
            <div className="sub-menu">
              {agentButtons}
              {!targets.length && <div className="menu-note">没有其它可用的 agent</div>}
            </div>
          )}
        </>
      )}
      {cli && <button data-id={id('native-cli')} onClick={act(() => openNativeCli(s))} title={cli}><Icon name="terminal" size={14} /> 在原生 CLI 打开</button>}
      </>}
      <button data-id={id('copy-id')} onClick={act(() => { void navigator.clipboard.writeText(s.sessionId); useStore.getState().toast('已复制 session id', true); })}><Icon name="copy" size={14} /> 复制 ID</button>
      {!deleted && caps.delete && <button data-id={id('delete')} className="danger" onClick={act(() => deleteSessions([s]))}><Icon name="trash" size={14} /> 删除…</button>}
    </div>
  );
}
