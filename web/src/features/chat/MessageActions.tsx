import { useState } from 'react';
import type { AssistantItem, UserItem } from '@/model/conversation';
import { groupTurns } from '@/model/turn';
import { buildHtml, downloadHtml } from '@/model/export';
import { isLastPrompt, useStore } from '@/store';
import { ago, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { tr, dateLocale } from '@/i18n';

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
  const title = st.sessions.find((x) => x.sessionId === sessionId)?.title ?? tr('对话');
  const ts = (turn?.user ?? (turn?.body[0] as { ts?: string } | undefined))?.ts;
  downloadHtml(tr('{title} - 一轮', { title }), buildHtml({ title: tr('{title} · 一轮', { title }), root: wrap, meta: ts ? new Date(ts).toLocaleString(dateLocale()) : '' }));
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
  if (!root) { st.toast(tr('先切回这个对话（不是步骤视图）再导出')); return; }
  const s = st.sessions.find((x) => x.sessionId === sessionId);
  const title = s?.title ?? tr('对话');
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
  const last = !!o && isLastPrompt(o.conv.items, it.id);
  return (
    <div className="msg-actions" role="toolbar" aria-label={tr('这条消息的操作')}>
      <button title={tr('复制')} aria-label={tr('复制')} onClick={() => navigator.clipboard.writeText(it.text)}><Icon name="copy" size={14} /></button>
      {!it.shell && <button title={tr('编辑并重新发送（从这里分叉）')} aria-label={tr('编辑')} disabled={!!busy} onClick={onEdit}><Icon name="edit" size={14} /></button>}
      {!it.shell && <button title={last ? tr('用同样的消息再问一次') : tr('用同样的消息重跑（从这里分叉出新对话）')} aria-label={tr('重跑')} disabled={!!busy} onClick={() => st().rerun(sessionId, it.id).catch((e) => st().toast(e.message))}><Icon name="refresh" size={14} /></button>}
      <button title={tr('从这条消息之前分叉出新对话')} aria-label={tr('分叉')} onClick={() => st().forkAt(sessionId, it.id).catch((e) => st().toast(e.message))}><Icon name="branch" size={14} /></button>
      <button title={tr('导出这一轮为 HTML')} aria-label={tr('分享本轮')} onClick={(e) => shareTurn(sessionId, turnIdOf(e.currentTarget, sessionId, it.id) ?? it.id)}><Icon name="share" size={14} /></button>
    </div>
  );
}

/** 朗读 (the official row's speaker): the reply's words, without the Markdown marks, in the voice of its language. */
let speaking: string | null = null;
function speak(id: string, text: string, onEnd: () => void): boolean {
  const synth = window.speechSynthesis;
  if (!synth) return false;
  synth.cancel();
  if (speaking === id) { speaking = null; return false; }
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`~|-]+/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  const u = new SpeechSynthesisUtterance(plain.slice(0, 8000));
  u.lang = /[\u3400-\u9fff]/.test(plain) ? 'zh-CN' : 'en-US';
  u.onend = u.onerror = () => { if (speaking === id) speaking = null; onEnd(); };
  speaking = id;
  synth.speak(u);
  return true;
}

/** 钉住: a pinned reply is listed in the info column's 钉住 card (SessionMeta.pinnedMsgs), to come back to. */
export function togglePin(sessionId: string, id: string, text: string) {
  const st = useStore.getState();
  const cur = st.sessionMeta[sessionId]?.pinnedMsgs ?? [];
  const next = cur.some((p) => p.id === id) ? cur.filter((p) => p.id !== id) : [...cur, { id, text: text.replace(/\s+/g, ' ').trim().slice(0, 120) }];
  void st.setSessionMeta(sessionId, { pinnedMsgs: next });
}

/** A reply as Markdown: its text blocks (what 复制回复 copies). */
export function replyMarkdown(it: AssistantItem): string {
  return it.blocks.filter((b) => b.type === 'text').map((b: any) => b.text).join('\n\n');
}

/** 分叉 of a message: before a user message (its id), after a reply (its uuid — none: it cannot be forked from). */
export function forkFrom(sessionId: string, it: UserItem | AssistantItem): void {
  const at = it.kind === 'user' ? it.id : it.uuid;
  if (!at) return;
  const st = useStore.getState();
  st.forkAt(sessionId, at).catch((e) => st.toast(e.message));
}

export function AssistantActions({ it, sessionId }: { it: AssistantItem; sessionId: string }) {
  const st = useStore.getState;
  const pinned = useStore((s) => !!s.sessionMeta[sessionId]?.pinnedMsgs?.some((p) => p.id === it.id));
  const [talking, setTalking] = useState(false);
  const fb = useStore((s) => s.open[sessionId]?.feedback[it.id]?.rating ?? null);
  const setFeedback = useStore((s) => s.setFeedback);
  const text = replyMarkdown(it);
  const [copied, setCopied] = useState(false);
  // the round this reply is in — its own `cont-…` turn when no user message of this window started it (review M-4)
  const turn = (e: React.MouseEvent<HTMLButtonElement>) => {
    const id = turnIdOf(e.currentTarget, sessionId, it.id);
    if (id) shareTurn(sessionId, id);
  };
  return (
    <div className="msg-actions" role="toolbar" aria-label={tr('这条回复的操作')}>
      <button title={copied ? tr('已复制') : tr('复制回复（Markdown）')} aria-label={tr('复制')} onClick={() => { void navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); }}><Icon name={copied ? 'check' : 'copy'} size={14} /></button>
      <button className={clsx(fb === 'up' && 'on')} title={tr('好评')} aria-label={tr('好评')} aria-pressed={fb === 'up'} onClick={() => setFeedback(sessionId, it.id, fb === 'up' ? null : 'up')}><Icon name="thumbUp" size={14} /></button>
      <button className={clsx(fb === 'down' && 'on')} title={tr('差评')} aria-label={tr('差评')} aria-pressed={fb === 'down'} onClick={() => setFeedback(sessionId, it.id, fb === 'down' ? null : 'down')}><Icon name="thumbDown" size={14} /></button>
      <button title={tr('导出这一轮为 HTML')} aria-label={tr('分享本轮')} onClick={turn}><Icon name="share" size={14} /></button>
      {/* the official app's row also has 分叉 and when it was said (phase 6 §6) */}
      <button data-act="pin" className={clsx(pinned && 'on')} title={pinned ? tr('取消钉住') : tr('钉住这条回复（在右边信息栏的「钉住的回复」里能找回）')} aria-label={pinned ? tr('取消钉住') : tr('钉住')} aria-pressed={pinned} onClick={() => togglePin(sessionId, it.id, text)}><Icon name={pinned ? 'pinFill' : 'pin'} size={14} /></button>
      {'speechSynthesis' in window && text && <button data-act="speak" className={clsx(talking && 'on')} title={talking ? tr('停止朗读') : tr('朗读这条回复')} aria-label={talking ? tr('停止朗读') : tr('朗读')} aria-pressed={talking} onClick={() => setTalking(speak(it.id, text, () => setTalking(false)))}><Icon name={talking ? 'volumeOff' : 'volume'} size={14} /></button>}
      {it.uuid && <button data-act="fork" title={tr('从这条回复之后分叉出新对话（原对话不变）')} aria-label={tr('分叉')} onClick={() => st().forkAt(sessionId, it.uuid!).catch((e) => st().toast(e.message))}><Icon name="branch" size={14} /></button>}
      {it.ts && <span className="msg-time" title={new Date(it.ts).toLocaleString(dateLocale())}>{agoText(it.ts)}</span>}
    </div>
  );
}

/** 「2 分钟前」: `ago` says how long; under a reply it reads as when. */
function agoText(ts: string): string {
  const a = ago(ts);
  const old = Date.now() - Date.parse(ts) >= 7 * 86400_000; // a date by then
  return old || a === tr('刚刚') ? a : tr('{a}前', { a });
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
        <span className="tool-meta">{tr('会从这条消息之前分叉出一个新对话，原对话保持不变')}</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={onDone}>{tr('取消')}</button>
        <button className="btn sm primary" disabled={busy || !text.trim()} onClick={submit}>{busy ? tr('发送中…') : tr('发送到新分支')}</button>
      </div>
    </div>
  );
}
