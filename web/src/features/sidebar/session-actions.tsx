import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentKind, SessionMeta, SessionSummary, SourceCaps } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { dlg } from '@/ui/dialog';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { isImportedSessionId, nativeSessionId } from '@/util';
import { agentOf, isArchived } from './filter';

/**
 * Everything the session context menu, the session header menu and the multi-select toolbar can do
 * to a session. What is offered follows the session's `caps` (its source's official APIs); Claude
 * and claude-web's own agent sessions archive in meta, since Claude Code has no archive flag.
 */

export interface EffectiveCaps extends SourceCaps {
  /** where archive goes: the source's own API, or claude-web's meta */
  archiveVia: 'library' | 'meta' | null;
}

export function effectiveCaps(s: SessionSummary): EffectiveCaps {
  const imported = isImportedSessionId(s.sessionId);
  // claude-web's own sessions (Claude, or an agent it drove itself) predate caps: everything works
  const c: SourceCaps = s.caps ?? { resume: true, rename: true, archive: false, delete: !imported, fork: !imported };
  const archiveVia = c.archive ? 'library' : !imported ? 'meta' : null;
  return { ...c, archive: !!archiveVia, archiveVia };
}

/** Caps every selected session supports (the multi-select toolbar only offers these). */
export function capsIntersection(list: SessionSummary[]): { archive: boolean; delete: boolean } {
  return { archive: list.length > 0 && list.every((s) => effectiveCaps(s).archive), delete: list.length > 0 && list.every((s) => effectiveCaps(s).delete) };
}

/** Command that resumes this session in the agent's own CLI, or null when there is no such flag. */
export function nativeCliCommand(s: SessionSummary): string | null {
  const kind = agentOf(s);
  if (kind === 'claude' && !isImportedSessionId(s.sessionId)) return `claude --resume ${s.sessionId}`;
  if (!isImportedSessionId(s.sessionId)) return null; // an agent claude-web drove: its native id is not the session id
  if (kind === 'codex') return `codex resume ${nativeSessionId(s.sessionId)}`;
  if (kind === 'opencode') return `opencode --session ${nativeSessionId(s.sessionId)}`;
  return null;
}

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
  if (!(await dlg.confirm(first, { message: '会话记录会从它所属的 agent 里移除。只是不想看到的话，用「归档」。', danger: true, okLabel: '继续' }))) return false;
  const sources = [...new Set(list.map(agentOf))].map(sourceName).join('、');
  if (!(await dlg.confirm('再确认一次：删除后不能在这里恢复', { message: `将先备份到 ~/.claude-web/library-trash，再从 ${sources} 删除`, danger: true, okLabel: '删除' }))) return false;
  try {
    const r = await st.libraryOp('delete', { sessionIds: list.map((s) => s.sessionId) });
    const failed: { id: string; error: string }[] = r?.failed ?? [];
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

export async function handOver(s: SessionSummary, agent: AgentKind): Promise<void> {
  const st = useStore.getState();
  const name = st.agents.find((a) => a.kind === agent)?.name ?? agent;
  const ok = await dlg.confirm(`把这个会话交给 ${name}？`, {
    message: '会话 id、标题和历史都保留。新 agent 会收到一份结构化交接说明（已决定什么、改过哪些文件、试过什么失败了）。思考/推理内容带签名或加密，跨厂商无法携带，不会带过去。',
    okLabel: '交接',
  });
  if (!ok) return;
  try {
    await ws.request({ kind: 'session.switchAgent', sessionId: s.sessionId, agent });
    st.toast(`已交接给 ${name}`, true);
    await st.refreshSessions().catch(() => {});
    await st.loadHistory(s.sessionId);
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
  if (!detail.handled) useStore.getState().toast(detail.reason ?? '先在窗格里打开一个会话（或新会话），再引用');
}

/**
 * The session menu: the sidebar row's "…" / right-click, and the session header's "…".
 * `extra` lets the sidebar keep its own entries (open in tab / split, pin, explorer…).
 */
export function SessionMenu({ s, onClose, style, extra }: { s: SessionSummary; onClose: () => void; style?: React.CSSProperties; extra?: React.ReactNode }) {
  const meta = useStore((st) => st.sessionMeta[s.sessionId]) as SessionMeta | undefined;
  const agents = useStore((st) => st.agents);
  const [handoff, setHandoff] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // fixed to the viewport next to its anchor: a scrolling sidebar list or a pane edge never clips it, and a long
  // menu near the bottom of the window opens upwards instead
  useLayoutEffect(() => {
    const el = ref.current, anchor = el?.parentElement;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.scrollHeight, vh = window.innerHeight, vw = window.innerWidth;
    Object.assign(el.style, { position: 'fixed', right: 'auto', bottom: 'auto', maxHeight: '' });
    el.style.left = `${Math.max(8, Math.min(a.right - w - 6, vw - w - 8))}px`;
    if (h <= vh - a.bottom - 8) el.style.top = `${a.bottom + 2}px`;
    else if (h <= a.top - 8) el.style.top = `${a.top - h - 2}px`;
    else { el.style.top = '8px'; el.style.maxHeight = `${vh - 16}px`; }
  }, [handoff]);
  useEffect(() => {
    const onScroll = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [onClose]);
  useEffect(() => {
    const k = () => onClose();
    window.addEventListener('click', k);
    window.addEventListener('contextmenu', k, true);
    return () => { window.removeEventListener('click', k); window.removeEventListener('contextmenu', k, true); };
  }, [onClose]);
  const caps = effectiveCaps(s);
  const archived = isArchived(s, meta ? { [s.sessionId]: meta } : {});
  const cli = nativeCliCommand(s);
  const act = (fn: () => unknown) => () => { onClose(); void fn(); };
  const cur = agentOf(s);
  return (
    <div ref={ref} className="menu sess-menu" style={style ?? { right: 8, top: 28 }} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      {extra}
      <button onClick={act(() => referenceSession(s))}><Icon name="quote" size={14} /> 引用到输入框</button>
      {caps.rename && <button onClick={act(() => renameSession(s))}><Icon name="edit" size={14} /> 重命名</button>}
      {caps.fork && <button onClick={act(() => forkSession(s))}><Icon name="branch" size={14} /> 分叉</button>}
      {caps.archive && <button onClick={act(() => setArchived([s], !archived))}><Icon name="archive" size={14} /> {archived ? '取消归档' : '归档'}</button>}
      <button onClick={() => setHandoff(!handoff)} aria-expanded={handoff}><Icon name="agent" size={14} /> <span style={{ flex: 1 }}>交给其它 agent</span><Icon name={handoff ? 'chevronDown' : 'chevronRight'} size={12} /></button>
      {handoff && (
        <div className="sub-menu">
          {agents.filter((a) => a.installed !== false && a.enabled !== false && a.kind !== cur).map((a) => (
            <button key={a.kind} onClick={act(() => handOver(s, a.kind))}><Icon name={AGENT_ICONS[a.kind] ?? 'agent'} size={13} /> {a.name}</button>
          ))}
          {!agents.some((a) => a.installed !== false && a.enabled !== false && a.kind !== cur) && <div className="menu-note">没有其它可用的 agent</div>}
        </div>
      )}
      {cli && <button onClick={act(() => openNativeCli(s))} title={cli}><Icon name="terminal" size={14} /> 在原生 CLI 打开</button>}
      <button onClick={act(() => { void navigator.clipboard.writeText(s.sessionId); useStore.getState().toast('已复制 session id', true); })}><Icon name="copy" size={14} /> 复制 ID</button>
      {caps.delete && <button className="danger" onClick={act(() => deleteSessions([s]))}><Icon name="trash" size={14} /> 删除…</button>}
    </div>
  );
}
