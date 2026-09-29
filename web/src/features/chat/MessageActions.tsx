import { useState } from 'react';
import type { AssistantItem, UserItem } from '@/model/conversation';
import { groupTurns } from '@/model/turn';
import { buildHtml, downloadHtml } from '@/model/export';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';

function useSession(sessionId: string) {
  return useStore((s) => s.open[sessionId]);
}

/** The rendered transcript of THIS session — with split panes / background tabs the first `.chat-inner` is often another one. */
function chatRoot(sessionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.chat-inner[data-session-id="${CSS.escape(sessionId)}"]`);
}

/**
 * Export one turn (`turnId` = a `Turn.id`: the user message's id, or `cont-…` / `pre-…` for a round without one of
 * its own — a goal's 继续, IM, a schedule: review M-4): the turn as drawn, else its rows.
 */
export function shareTurn(sessionId: string, turnId: string) {
  const st = useStore.getState();
  const o = st.open[sessionId];
  const root = chatRoot(sessionId);
  if (!o || !root) return;
  const turn = groupTurns(o.conv.items).find((t) => t.id === turnId);
  const wrap = document.createElement('div');
  // the turn as drawn (its folded steps, the answer, the change card); buildHtml un-hides the fold
  const drawn = root.querySelector<HTMLElement>(`.turn[data-turn="${CSS.escape(turnId)}"]`);
  if (drawn) wrap.appendChild(drawn.cloneNode(true));
  else if (turn) {
    const keep = new Set([...(turn.user ? [turn.user.id] : []), ...turn.body.map((i) => i.id)]);
    root.querySelectorAll<HTMLElement>('[data-item-id]').forEach((n) => { if (keep.has(n.dataset.itemId!)) wrap.appendChild(n.cloneNode(true)); });
  }
  const title = st.sessions.find((x) => x.sessionId === sessionId)?.title ?? '对话';
  const ts = (turn?.user ?? (turn?.body[0] as { ts?: string } | undefined))?.ts;
  downloadHtml(`${title} - 一轮`, buildHtml({ title: `${title} · 一轮`, root: wrap, meta: ts ? new Date(ts).toLocaleString() : '' }));
}

/** The turn a message's 分享本轮 button sits in (the `.turn` around it), else the turn that holds the message. */
function turnIdOf(el: Element, sessionId: string, itemId: string): string | undefined {
  const drawn = el.closest<HTMLElement>('.turn')?.dataset.turn;
  if (drawn) return drawn;
  const o = useStore.getState().open[sessionId];
  return o ? groupTurns(o.conv.items).find((t) => t.user?.id === itemId || t.body.some((i) => i.id === itemId))?.id : undefined;
}

export function shareConversation(sessionId: string) {
  const st = useStore.getState();
  const root = chatRoot(sessionId);
  if (!root) { st.toast('先切回这个对话（不是步骤视图）再导出'); return; }
  const s = st.sessions.find((x) => x.sessionId === sessionId);
  const title = s?.title ?? '对话';
  downloadHtml(title, buildHtml({ title, root, meta: `${s?.cwd ?? ''}${s?.gitBranch ? ` · ${s.gitBranch}` : ''}` }));
}

/**
 * The actions under / beside a message (spec §5.3): icons that show on hover, when the keyboard focus is inside the
 * message (:focus-within), and always on a touch screen / a phone — see `.msg-actions` in styles.css.
 */
export function UserActions({ it, sessionId, onEdit }: { it: UserItem; sessionId: string; onEdit: () => void }) {
  const st = useStore.getState;
  const o = useSession(sessionId);
  const busy = o && (o.state === 'running' || o.state === 'waiting' || o.state === 'starting');
  return (
    <div className="msg-actions" role="toolbar" aria-label="这条消息的操作">
      <button title="复制" aria-label="复制" onClick={() => navigator.clipboard.writeText(it.text)}><Icon name="copy" size={14} /></button>
      <button title="编辑并重新发送（从这里分叉）" aria-label="编辑" disabled={!!busy} onClick={onEdit}><Icon name="edit" size={14} /></button>
      <button title="用同样的消息重跑（从这里分叉）" aria-label="重跑" disabled={!!busy} onClick={() => st().rerun(sessionId, it.id).catch((e) => st().toast(e.message))}><Icon name="refresh" size={14} /></button>
      <button title="从这条消息之前分叉出新对话" aria-label="分叉" onClick={() => st().forkAt(sessionId, it.id).catch((e) => st().toast(e.message))}><Icon name="branch" size={14} /></button>
      <button title="导出这一轮为 HTML" aria-label="分享本轮" onClick={(e) => shareTurn(sessionId, turnIdOf(e.currentTarget, sessionId, it.id) ?? it.id)}><Icon name="share" size={14} /></button>
    </div>
  );
}

export function AssistantActions({ it, sessionId }: { it: AssistantItem; sessionId: string }) {
  const fb = useStore((s) => s.open[sessionId]?.feedback[it.id]?.rating ?? null);
  const setFeedback = useStore((s) => s.setFeedback);
  const text = it.blocks.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n\n');
  const [copied, setCopied] = useState(false);
  // the round this reply is in — its own `cont-…` turn when no user message of this window started it (review M-4)
  const turn = (e: React.MouseEvent<HTMLButtonElement>) => {
    const id = turnIdOf(e.currentTarget, sessionId, it.id);
    if (id) shareTurn(sessionId, id);
  };
  return (
    <div className="msg-actions" role="toolbar" aria-label="这条回复的操作">
      <button title={copied ? '已复制' : '复制回复（Markdown）'} aria-label="复制" onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
      <button className={clsx(fb === 'up' && 'on')} title="好评" aria-label="好评" aria-pressed={fb === 'up'} onClick={() => setFeedback(sessionId, it.id, fb === 'up' ? null : 'up')}><Icon name="thumbUp" size={14} /></button>
      <button className={clsx(fb === 'down' && 'on')} title="差评" aria-label="差评" aria-pressed={fb === 'down'} onClick={() => setFeedback(sessionId, it.id, fb === 'down' ? null : 'down')}><Icon name="thumbDown" size={14} /></button>
      <button title="导出这一轮为 HTML" aria-label="分享本轮" onClick={turn}><Icon name="share" size={14} /></button>
    </div>
  );
}

/** Inline editor shown in place of a user bubble. */
export function UserEditor({ it, sessionId, onDone }: { it: UserItem; sessionId: string; onDone: () => void }) {
  const [text, setText] = useState(it.text);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await useStore.getState().editAndResend(sessionId, it.id, text);
      onDone();
    } catch (e: any) {
      useStore.getState().toast(e.message);
    }
    setBusy(false);
  };
  return (
    <div className="user-editor">
      <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(12, text.split('\n').length + 1)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !imeComposing(e.nativeEvent)) { e.preventDefault(); void submit(); } if (e.key === 'Escape') onDone(); }} />
      <div className="actions">
        <span className="tool-meta">会从这条消息之前分叉出一个新对话，原对话保持不变</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={onDone}>取消</button>
        <button className="btn sm primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? '发送中…' : '发送到新分支'}</button>
      </div>
    </div>
  );
}
