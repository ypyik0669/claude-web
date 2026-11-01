import { useRef } from 'react';
import { toWslPath, type AgentKind, type SessionMeta, type SessionSummary } from '@shared';
import { wslCliCommand } from '@/features/composer/machine';
import { forkCarry, useStore } from '@/store';
import { ws } from '@/ws/client';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import { isImportedSessionId } from '@/util';
import { isArchived } from './filter';
import { deleteSummary, deleteTargets, effectiveCaps, nativeCliCommand } from './caps';
import { MenuHost, closeDrawer, useAnchoredMenu } from './menus';
import type { RowMenuId } from './entries';
import { tr } from '@/i18n';
import { SECTIONS_KEY, pruneSections, type CustomSection } from './view';
import { canHandOffToPeer } from '@/features/cloud/logic';
import { openHandoffDialog } from '@/features/cloud/HandoffDialog';

export { effectiveCaps, capsIntersection, nativeCliCommand, type EffectiveCaps } from './caps';

function sourceName(kind: AgentKind): string {
  const st = useStore.getState();
  return st.librarySources.find((x) => x.kind === kind)?.name ?? (kind === 'claude' ? 'Claude Code' : kind);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function renameSession(s: SessionSummary): Promise<void> {
  const st = useStore.getState();
  const t = (await dlg.prompt(tr('重命名对话'), s.title))?.trim();
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
      if (r?.failed?.length) st.toast(tr('{failedCount} 个对话{v}失败：{error}', { failedCount: r.failed.length, v: archived ? tr('归档') : tr('取消归档'), error: r.failed[0].error }));
    } catch (e) { st.toast(errText(e)); }
  }
}

/** Two confirmations; the second names the backup and the source it will be deleted from. */
export async function deleteSessions(list: SessionSummary[]): Promise<boolean> {
  const st = useStore.getState();
  if (!list.length) return false;
  const first = list.length === 1 ? tr('删除对话「{title}」？', { title: list[0].title }) : tr('删除选中的 {listCount} 个对话？', { listCount: list.length });
  if (!(await dlg.confirm(first, { message: tr('{deleteSummary}。对话记录会从它的来源里移除；只是不想看到的话，用「归档」。', { deleteSummary: deleteSummary(list, (k) => sourceName(k as AgentKind)) }), danger: true, okLabel: tr('继续') }))) return false;
  const where = deleteTargets(list, (k) => sourceName(k as AgentKind));
  if (!(await dlg.confirm(tr('再确认一次：删除后不能在这里恢复'), { message: tr('将先备份到 ~/.claude-web/library-trash，再{where}', { where }), danger: true, okLabel: tr('删除') }))) return false;
  try {
    const r = await st.libraryOp('delete', { sessionIds: list.map((s) => s.sessionId) });
    const failed: { id: string; error: string }[] = r?.failed ?? [];
    st.markDeleted(Array.isArray(r?.removed) ? r.removed : list.map((s) => s.sessionId).filter((id) => !failed.some((f) => f.id === id)));
    if (failed.length) st.toast(tr('{failedCount} 个对话没有删除：{error}', { failedCount: failed.length, error: failed[0].error }));
    else st.toast(list.length === 1 ? tr('已删除（备份在 library-trash）') : tr('已删除 {listCount} 个对话（备份在 library-trash）', { listCount: list.length }), true);
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
    } else await st.openSession({ sessionId: s.sessionId, cwd: s.cwd, fork: true, ...forkCarry(s.sessionId) });
  } catch (e) { st.toast(errText(e)); }
}

/**
 * 「在本机继续」: a session on another machine is read through that machine and goes on HERE as a new Claude
 * conversation with a briefing. Its paths are the other machine's, so the user picks the local directory (default:
 * the first workspace).
 */
export async function handOverToLocal(s: SessionSummary): Promise<void> {
  const st = useStore.getState();
  const def = st.workspaces[0]?.path ?? '';
  const cwd = (await dlg.prompt(tr('在本机继续：在哪个目录？'), def, {
    message: tr('这个对话在机器「{name}」上（目录 {cwd}），那里的路径在本机多半不存在。会新建一个本机对话，带上一份交接说明；原对话保持不变。', { name: s.peer?.name ?? '?', cwd: s.cwd }),
    okLabel: tr('继续'),
  }))?.trim();
  if (!cwd) return;
  try {
    const r = await ws.request<{ sessionId: string }>({ kind: 'peers.handover', sessionId: s.sessionId, cwd });
    st.toast(tr('已在本机新开对话'), true);
    await st.refreshSessions().catch(() => {});
    if (r?.sessionId) await st.loadHistory(r.sessionId, { mode: 'tab' });
  } catch (e) { st.toast(errText(e)); }
}

/** Writes the custom sections, dropping ids of conversations that are gone (C-U4; another machine's stay). */
export function saveSections(l: CustomSection[]): Promise<void> {
  const st = useStore.getState();
  return st.setSetting(SECTIONS_KEY, pruneSections(l, new Set(st.sessions.map((x) => x.sessionId))));
}

export function openNativeCli(s: SessionSummary): void {
  // a WSL conversation goes on with the distro's own claude, in its Linux folder (the shell starts in the home)
  const env = useStore.getState().sessionMeta[s.sessionId]?.env;
  if (env?.kind === 'wsl') {
    const cmd = wslCliCommand(env.distro, toWslPath(s.cwd, env.distro) ?? '~', s.sessionId);
    useStore.getState().openTile({ id: `t${Date.now()}`, kind: 'term', cwd: '', cmd, title: 'wsl' }, 'tab');
    return;
  }
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
  if (!detail.handled) useStore.getState().toast(detail.reason ?? tr('先打开一个对话（或新对话），再引用'));
}

/**
 * The session menu: the sidebar row's "…" / right-click, and the session header's "…".
 * `extra` lets the sidebar keep its own entries (open in tab / split, pin, explorer…).
 * `deleted`: the session is gone from its source — only `extra` (what works on the screen) and the id remain.
 */
export function SessionMenu({ s, onClose, style, extra, deleted }: { s: SessionSummary; onClose: () => void; style?: React.CSSProperties; extra?: React.ReactNode; deleted?: boolean }) {
  const meta = useStore((st) => st.sessionMeta[s.sessionId]) as SessionMeta | undefined;
  const ref = useRef<HTMLDivElement>(null);
  // fixed to the viewport next to its anchor: a scrolling sidebar list or a pane edge never clips it, and a long
  // menu near the bottom of the window opens upwards instead
  useAnchoredMenu(ref, onClose);
  const caps = effectiveCaps(s);
  const archived = isArchived(s, meta ? { [s.sessionId]: meta } : {});
  const cli = nativeCliCommand(s);
  // an action from the phone drawer (the sidebar's row menu) gets the drawer out of the way; elsewhere closeDrawer is a no-op
  const act = (fn: () => unknown) => () => { onClose(); closeDrawer(); void fn(); };
  // a session on another machine goes on here as a new conversation; an offline machine can't be read
  const canTakeOver = !!s.peer && !s.peer.offline;
  const id = (x: RowMenuId) => x;
  return (
    // (a phone: MenuHost draws this same element in an action sheet instead — UI refresh §8)
    <MenuHost onClose={onClose}>
    <div ref={ref} className="menu sess-menu" role="menu" title="" style={style ?? { right: 8, top: 28 }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {extra}
      {!deleted && <>
      <button data-id={id('reference')} onClick={act(() => referenceSession(s))}><Icon name="quote" size={14} /> {tr('引用到输入框')}</button>
      {caps.rename && <button data-id={id('rename')} onClick={act(() => renameSession(s))}><Icon name="edit" size={14} /> {tr('重命名')}</button>}
      {caps.fork && <button data-id={id('fork')} onClick={act(() => forkSession(s))}><Icon name="branch" size={14} /> {tr('分叉')}</button>}
      {caps.archive && <button data-id={id('archive')} onClick={act(() => setArchived([s], !archived))}><Icon name="archive" size={14} /> {archived ? tr('取消归档') : tr('归档')}</button>}
      {canTakeOver && <button data-id={id('handoff')} onClick={act(() => handOverToLocal(s))}><Icon name="monitor" size={14} /> {tr('在本机继续…')}</button>}
      {canHandOffToPeer(s, meta) && <button data-id={id('handoff-peer')} onClick={act(() => openHandoffDialog(s))}><Icon name="monitor" size={14} /> {tr('交给常开机器继续…')}</button>}
      {cli && <button data-id={id('native-cli')} onClick={act(() => openNativeCli(s))} title={cli}><Icon name="terminal" size={14} /> {tr('在原生 CLI 打开')}</button>}
      </>}
      <button data-id={id('copy-id')} onClick={act(() => { void navigator.clipboard.writeText(s.sessionId); useStore.getState().toast(tr('已复制 session id'), true); })}><Icon name="copy" size={14} /> {tr('复制 ID')}</button>
      {!deleted && caps.delete && <button data-id={id('delete')} className="danger" onClick={act(() => deleteSessions([s]))}><Icon name="trash" size={14} /> {tr('删除…')}</button>}
    </div>
    </MenuHost>
  );
}
