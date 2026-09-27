import { useState } from 'react';
import type { AssistantItem, UserItem } from '@/model/conversation';
import { turnItems } from '@/model/conversation';
import { buildHtml, downloadHtml } from '@/model/export';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';

function useSession(sessionId: string) {
  return useStore((s) => s.open[sessionId]);
}

/** The rendered transcript of THIS session — with split panes / background tabs the first `.chat-inner` is often another one. */
function chatRoot(sessionId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.chat-inner[data-session-id="${CSS.escape(sessionId)}"]`);
}

/** Export one turn: clone .chat-inner and keep only the rows of that turn. */
export function shareTurn(sessionId: string, userItemId: string) {
  const st = useStore.getState();
  const o = st.open[sessionId];
  const root = chatRoot(sessionId);
  if (!o || !root) return;
  const keep = new Set(turnItems(o.conv, userItemId).map((i) => i.id));
  const wrap = document.createElement('div');
  root.querySelectorAll<HTMLElement>('[data-item-id]').forEach((n) => { if (keep.has(n.dataset.itemId!)) wrap.appendChild(n.cloneNode(true)); });
  const title = st.sessions.find((x) => x.sessionId === sessionId)?.title ?? '对话';
  const first = o.conv.items.find((i) => i.id === userItemId);
  downloadHtml(`${title} - 一轮`, buildHtml({ title: `${title} · 一轮`, root: wrap, meta: first?.ts ? new Date(first.ts).toLocaleString() : '' }));
}

export function shareConversation(sessionId: string) {
  const st = useStore.getState();
  const root = chatRoot(sessionId);
  if (!root) { st.toast('切到这个会话的对话视图后再导出'); return; }
  const s = st.sessions.find((x) => x.sessionId === sessionId);
  const title = s?.title ?? '对话';
  downloadHtml(title, buildHtml({ title, root, meta: `${s?.cwd ?? ''}${s?.gitBranch ? ` · ${s.gitBranch}` : ''}` }));
}

export function UserActions({ it, sessionId, onEdit }: { it: UserItem; sessionId: string; onEdit: () => void }) {
  const st = useStore.getState;
  const o = useSession(sessionId);
  const busy = o && (o.state === 'running' || o.state === 'waiting' || o.state === 'starting');
  return (
    <div className="msg-actions">
      <button title="复制" aria-label="复制" onClick={() => navigator.clipboard.writeText(it.text)}><Icon name="copy" size={13} /></button>
      <button title="编辑并重新发送（从这里分叉）" disabled={!!busy} onClick={onEdit}><Icon name="edit" size={12} /> 编辑</button>
      <button title="用同样的消息重跑（从这里分叉）" disabled={!!busy} onClick={() => st().rerun(sessionId, it.id).catch((e) => st().toast(e.message))}><Icon name="refresh" size={12} /> 重跑</button>
      <button title="从这条消息之前分叉出新会话" onClick={() => st().forkAt(sessionId, it.id).catch((e) => st().toast(e.message))}><Icon name="branch" size={12} /> 分叉</button>
      <button title="导出这一轮为 HTML" onClick={() => shareTurn(sessionId, it.id)}><Icon name="external" size={12} /> 分享本轮</button>
    </div>
  );
}

export function AssistantActions({ it, sessionId }: { it: AssistantItem; sessionId: string }) {
  const fb = useStore((s) => s.open[sessionId]?.feedback[it.id]?.rating ?? null);
  const setFeedback = useStore((s) => s.setFeedback);
  const text = it.blocks.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n\n');
  const [copied, setCopied] = useState(false);
  const turn = () => {
    const o = useStore.getState().open[sessionId];
    if (!o) return;
    const idx = o.conv.items.findIndex((x) => x.id === it.id);
    for (let i = idx; i >= 0; i--) { const x = o.conv.items[i]; if (x.kind === 'user' && !x.meta) { shareTurn(sessionId, x.id); return; } }
  };
  return (
    <div className="msg-actions">
      <button title="复制回复（Markdown）" onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <><Icon name="check" size={12} /> 已复制</> : <><Icon name="copy" size={12} /> 复制</>}</button>
      <button className={clsx(fb === 'up' && 'on')} title="好评" aria-label="好评" onClick={() => setFeedback(sessionId, it.id, fb === 'up' ? null : 'up')}><Icon name="check" size={13} /></button>
      <button className={clsx(fb === 'down' && 'on')} title="差评" aria-label="差评" onClick={() => setFeedback(sessionId, it.id, fb === 'down' ? null : 'down')}><Icon name="close" size={13} /></button>
      <button title="导出这一轮为 HTML" onClick={turn}><Icon name="external" size={12} /> 分享本轮</button>
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
      <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(12, text.split('\n').length + 1)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } if (e.key === 'Escape') onDone(); }} />
      <div className="actions">
        <span className="tool-meta">会从这条消息之前分叉出新会话，原会话保持不变</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={onDone}>取消</button>
        <button className="btn sm primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? '发送中…' : '发送到新分支'}</button>
      </div>
    </div>
  );
}
