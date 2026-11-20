// A phone's message actions (redesign 2026-11 #phone 对话; problem 7): no row of icons under every message — a long
// press on one opens this sheet: 复制 · 编辑 · 重跑 · 分叉 · 朗读 (编辑 for your own messages). The first time a phone
// shows a conversation with messages, a one-time hint says so (meta.json `ui.hint.longPress`). The same actions are
// reachable without a long press: the header ⋯ › 更多 › 「最后一条回复…」 / 「我的上一条消息…」 open this sheet on
// them, the browser's own context menu gesture does too, and the row's buttons stay in the page for a screen reader
// (visually hidden on a phone, redesign-chat.css).
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { AssistantItem, UserItem } from '@/model/conversation';
import { groupTurns } from '@/model/turn';
import { isLastPrompt, useStore } from '@/store';
import { ActionSheet } from '@/ui/ActionSheet';
import { Icon } from '@/ui/icons';
import { haptic } from '@/ui/haptics';
import { tr } from '@/i18n';
import { replyMarkdown, speak } from './MessageActions';

interface SheetState { at: { sessionId: string; itemId: string } | null }
const useMessageSheet = create<SheetState>(() => ({ at: null }));

/** The meta.json key of the one-time 「长按消息…」 hint. */
export const LONG_PRESS_HINT = 'ui.hint.longPress';

/** The window event that asks a user message to open its inline editor (UserRow listens). */
export const EDIT_MESSAGE_EVENT = 'cw:edit-message';

/**
 * Open the sheet on a message: its id, or the last reply / the last message of yours in the conversation (the ⋯
 * sheet's rows). Nothing to act on → a short toast.
 */
export function openMessageSheet(sessionId: string, which: string | 'assistant' | 'user'): void {
  const st = useStore.getState();
  const items = st.open[sessionId]?.conv.items ?? [];
  let id = which;
  if (which === 'assistant' || which === 'user') {
    const it = [...items].reverse().find((x) => (which === 'user' ? x.kind === 'user' && !(x as UserItem).meta : x.kind === 'assistant' && !(x as AssistantItem).parentToolUseId && (x as AssistantItem).blocks.some((b) => b.type === 'text' && b.text.trim())));
    if (!it) { st.toast(which === 'user' ? tr('这个对话里还没有你发的消息') : tr('这个对话里还没有回复')); return; }
    id = it.id;
  }
  useMessageSheet.setState({ at: { sessionId, itemId: id } });
  // the hint is not needed once it has been used
  if (st.metaLoaded && !st.settings[LONG_PRESS_HINT]) void st.setSetting(LONG_PRESS_HINT, true);
}

/**
 * Long press on a message inside `root` (a phone): 500 ms without moving opens the sheet on it; the click that would
 * follow is swallowed. The browser's context menu gesture (Android's long press, a mouse's right button) opens it too.
 */
export function useMessageLongPress(root: React.RefObject<HTMLElement | null>, sessionId: string | undefined, on: boolean): void {
  useEffect(() => {
    const el = root.current;
    if (!el || !on || !sessionId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number; id: number } | null = null;
    let fired = false;
    const target = (t: EventTarget | null): string | null => {
      const n = (t as Element | null)?.closest?.('.msg.user[data-item-id], .assistant-wrap[data-item-id]') as HTMLElement | null;
      // not on a control inside it (a code block's copy, a link, the inline editor)
      if (!n || (t as Element).closest('button, a, input, textarea, .code, .user-editor')) return null;
      return n.dataset.itemId ?? null;
    };
    const cancel = () => { clearTimeout(timer); timer = undefined; start = null; };
    const down = (e: PointerEvent) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const id = target(e.target);
      if (!id) return;
      fired = false;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      timer = setTimeout(() => { fired = true; timer = undefined; haptic('tap'); openMessageSheet(sessionId, id); }, 500);
    };
    const move = (e: PointerEvent) => { if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); };
    const up = () => cancel();
    // the press that opened the sheet is not also a click on what is under the finger
    const click = (e: MouseEvent) => { if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); } };
    const menu = (e: MouseEvent) => {
      const id = target(e.target);
      if (!id) return;
      e.preventDefault();
      if (!fired) openMessageSheet(sessionId, id);
      cancel();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('scroll', up, true);
    el.addEventListener('click', click, true);
    el.addEventListener('contextmenu', menu);
    return () => {
      cancel();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('scroll', up, true);
      el.removeEventListener('click', click, true);
      el.removeEventListener('contextmenu', menu);
    };
  }, [root, sessionId, on]);
}

/**
 * The one-time hint, the first time a phone shows a conversation with messages (`show`: there are some). A toast:
 * it says it once and goes; the setting is written when it is shown.
 */
export function useLongPressHint(show: boolean): void {
  const need = useStore((s) => s.mobile && s.metaLoaded && !s.settings[LONG_PRESS_HINT]);
  const said = useRef(false);
  useEffect(() => {
    if (!need || !show || said.current) return;
    said.current = true;
    const st = useStore.getState();
    st.toast(tr('长按一条消息，可以复制、编辑、重跑、分叉或朗读'), true, 6000, 'long-press');
    void st.setSetting(LONG_PRESS_HINT, true);
  }, [need, show]);
}

/** The sheet itself: mounted once (App), drawn while a message is picked. */
export function MessageSheet() {
  const at = useMessageSheet((s) => s.at);
  const it = useStore((s) => (at ? s.open[at.sessionId]?.conv.items.find((x) => x.id === at.itemId) : undefined));
  const busy = useStore((s) => { const o = at ? s.open[at.sessionId] : undefined; return !!o && (o.state === 'running' || o.state === 'waiting' || o.state === 'starting'); });
  if (!at || !it || (it.kind !== 'user' && it.kind !== 'assistant')) return null;
  const close = () => useMessageSheet.setState({ at: null });
  const st = useStore.getState;
  const sid = at.sessionId;
  const user = it.kind === 'user' ? (it as UserItem) : null;
  const reply = it.kind === 'assistant' ? (it as AssistantItem) : null;
  const text = user ? user.text : replyMarkdown(reply!);
  // a reply's 重跑: the message that started its turn, asked again
  const prompt = user ?? (() => { const o = st().open[sid]; const t = o ? groupTurns(o.conv.items).find((x) => x.body.some((b) => b.id === it.id)) : undefined; return t?.user ?? null; })();
  const last = !!prompt && isLastPrompt(st().open[sid]?.conv.items ?? [], prompt.id);
  const forkAt = user ? user.id : reply?.uuid;
  const run = (fn: () => unknown) => () => { close(); void fn(); };
  return (
    <ActionSheet onClose={close}>
      <div className="menu msg-sheet" role="menu" aria-label={user ? tr('这条消息的操作') : tr('这条回复的操作')} data-msg-kind={it.kind}>
        <div className="msg-sheet-quote">{text.replace(/\s+/g, ' ').trim().slice(0, 140)}</div>
        <button data-act="copy" onClick={run(() => { void navigator.clipboard?.writeText(text); st().toast(tr('已复制'), true); })}><Icon name="copy" size={14} /> {tr('复制')}</button>
        {user && <button data-act="edit" disabled={busy} onClick={run(() => window.dispatchEvent(new CustomEvent(EDIT_MESSAGE_EVENT, { detail: { id: user.id } })))}><Icon name="edit" size={14} /> {tr('编辑')}</button>}
        {prompt && <button data-act="rerun" disabled={busy} onClick={run(() => st().rerun(sid, prompt.id).catch((e) => st().toast(e.message)))}><Icon name="refresh" size={14} /> <span className="grow">{tr('重跑')}</span><span className="menu-sub">{last ? tr('同样的消息再问一次') : tr('分叉出新对话')}</span></button>}
        {forkAt && <button data-act="fork" onClick={run(() => st().forkAt(sid, forkAt).catch((e) => st().toast(e.message)))}><Icon name="branch" size={14} /> {tr('分叉')}</button>}
        {'speechSynthesis' in window && text.trim() && <button data-act="speak" onClick={run(() => speak(it.id, text, () => {}))}><Icon name="volume" size={14} /> {tr('朗读')}</button>}
      </div>
    </ActionSheet>
  );
}
