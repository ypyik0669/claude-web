import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { parsePeerId } from '@shared';
import type { AssistantItem, UserItem } from '@/model/conversation';
import { useStore } from '@/store';
import { Icon, type IconName } from '@/ui/icons';
import { useDropdown } from '@/ui/menus';
import { MENU_ORIGIN } from '@/features/models/place';
import { useMenuMotion } from '@/ui/menu-motion';
import { tr } from '@/i18n';
import { quoteInComposer } from '@/features/composer/quote';
import { menuKey } from '@/features/composer/dir-menu';
import { modKey } from '@/features/workbench/shortcuts';
import { codeOf } from './CodeBlock';
import { forkFrom, replyMarkdown, togglePin, useForkable } from './MessageActions';
import { refineDoubleClick } from './dblclick-select';
import { openSideChat } from './side-chat';
import { isQuoteKey, placeSelectionMenu, selectionItems, type Rect, type SelItem } from './selection-menu';

// The menu that comes up as soon as text in the conversation is selected (2026-10-20, user request: 「不想右键」 — like
// the Claude panel in VS Code): 复制 · 复制代码块 · 复制整条消息 / 复制为 Markdown · 引用到输入框 (Ctrl+Shift+L) · 旁聊 ·
// 钉住 · 从这里分叉. Pure parts (which rows, where it goes) in selection-menu.ts; the desktop right-click menu stays.
//
// A double click in a reply selects one thing (dblclick-select.ts: a whole inline code span, one word), then the menu.
// Shown on the mouse-up of a drag (or double click) that started in this conversation, and on the key-up of a
// keyboard selection; not for a touch (the system has its own), not for text in a field / editor / terminal. Gone on
// Esc, a click elsewhere, a scroll, a resize, the selection collapsing, another menu opening. It does not take the
// focus (the user may go on extending the selection with Shift+arrows); Tab while it is up moves into it, then
// ↑ ↓ Home End and 1–9 like the composer's menus. A mouse-down on it is prevented: the selection stays.

/** What the selection was when the menu came up. */
interface Snap {
  text: string;
  code?: string;
  msg?: { el: HTMLElement; item: UserItem | AssistantItem };
  end: Rect;
  bounds: Rect;
  forward: boolean;
}

/** Text that is not the conversation's own: fields, editors, terminals, a message being edited. */
const NOT_TEXT = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], .monaco-editor, .xterm, .user-editor, .side-chat';

function elOf(n: Node | null): Element | null {
  return !n ? null : n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
}

function edges(r: DOMRect): Rect {
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

/** The selection, when it lies inside this conversation's transcript and is worth a menu. */
function readSelection(root: HTMLElement, sessionId: string): Snap | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString();
  if (!text.trim()) return null;
  const inner = root.querySelector<HTMLElement>(':scope > .chat-inner');
  const range = sel.getRangeAt(0);
  const common = elOf(range.commonAncestorContainer);
  if (!inner || !common || !inner.contains(common)) return null;
  const act = document.activeElement;
  if (act && root.contains(act) && act.matches(NOT_TEXT)) return null;
  if ([sel.anchorNode, sel.focusNode].some((n) => elOf(n)?.closest(NOT_TEXT))) return null;
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
  if (!rects.length) return null;
  const a = sel.anchorNode!, f = sel.focusNode!;
  const forward = a === f ? sel.anchorOffset <= sel.focusOffset : !!(a.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING);
  const block = common.closest('.code');
  const code = block && inner.contains(block) ? codeOf(block) : undefined;
  // the one message the selection is in — a top-level one of this conversation (not one inside a sub-agent's card)
  const msgEl = common.closest<HTMLElement>('.msg.user[data-item-id], .assistant-wrap[data-item-id]');
  const id = msgEl?.dataset.itemId;
  const item = id ? useStore.getState().open[sessionId]?.conv.items.find((x) => x.id === id) : undefined;
  const msg = msgEl && item && (item.kind === 'user' || item.kind === 'assistant') ? { el: msgEl, item } : undefined;
  return { text, code, msg, end: edges(forward ? rects[rects.length - 1] : rects[0]), bounds: edges(range.getBoundingClientRect()), forward };
}

/** A reply as it reads (its text segments as drawn, without the Markdown marks); its Markdown when nothing is drawn. */
function plainOf(m: NonNullable<Snap['msg']>): string {
  if (m.item.kind === 'user') return m.item.text;
  const drawn = [...m.el.querySelectorAll<HTMLElement>(':scope > .msg.assistant > .msg-text')].map(asRead).filter(Boolean);
  return drawn.length ? drawn.join('\n\n') : replyMarkdown(m.item);
}

/**
 * A text segment as it reads, its code blocks as their whole source: a block's drawn text has its header (language,
 * line count) and only the lines shown when it is long — each is swapped for its code, in order.
 */
function asRead(seg: HTMLElement): string {
  let text = seg.innerText;
  let from = 0;
  for (const block of seg.querySelectorAll<HTMLElement>('.code')) {
    const code = codeOf(block);
    const drawn = block.innerText;
    const at = code === undefined ? -1 : text.indexOf(drawn, from);
    if (at < 0) continue;
    text = text.slice(0, at) + code!.replace(/\n$/, '') + text.slice(at + drawn.length);
    from = at + code!.length;
  }
  return text.trim();
}

function copy(text: string) {
  const st = useStore.getState();
  void navigator.clipboard.writeText(text).then(() => st.toast(tr('已复制'), true), () => st.toast(tr('没能复制')));
}

function quote(text: string) {
  if (!quoteInComposer(text)) useStore.getState().toast(tr('先打开一个对话（或新对话），再引用'));
}

/** 旁聊 is offered as the header's ··· offers it (ChatTile): a running conversation of this machine. */
function canSideChat(sessionId: string): boolean {
  const active = useStore.getState().open[sessionId];
  const live = !!active && active.state !== 'history' && active.state !== 'closed' && active.state !== 'error';
  return live && !parsePeerId(sessionId);
}

const mac = modKey === '⌘';
const KEYS: Partial<Record<SelItem, string>> = { copy: mac ? '⌘C' : 'Ctrl+C', quote: mac ? '⇧⌘L' : 'Ctrl+Shift+L' };

/** Mounted once per conversation view (ChatView): watches the selection; the menu itself mounts per showing. */
export function SelectionMenu({ root, sessionId }: { root: RefObject<HTMLDivElement | null>; sessionId: string }) {
  // `n` keys the menu: a new selection while it is up is a new menu (placed anew, its entrance again)
  const [snap, setSnap] = useState<(Snap & { n: number }) | null>(null);
  const shown = useRef(false);
  shown.current = !!snap;
  const box = useRef<HTMLDivElement>(null);
  const close = () => setSnap(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let pressed = false, touch = false;
    const down = (e: PointerEvent) => { pressed = e.button === 0; touch = e.pointerType === 'touch' || e.pointerType === 'pen'; };
    // after the browser has settled the selection (a click that collapses it, a double click's word)
    const show = () => requestAnimationFrame(() => {
      const s = root.current ? readSelection(root.current, sessionId) : null;
      if (s) setSnap((cur) => ({ ...s, n: (cur?.n ?? 0) + 1 })); else if (shown.current) close();
    });
    // the double click's own word / code span, in place of the browser's (it fires after the mouse-up above)
    // (not for a touch: the system has its own)
    const dbl = (e: MouseEvent) => { if (!touch && refineDoubleClick(e, el)) show(); };
    const up = (e: MouseEvent) => {
      if (!pressed || e.button !== 0) return;
      pressed = false;
      if (!touch) show();
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.shiftKey && /^(Arrow|Home|End|Page)/.test(e.key)) show();
    };
    const keyDown = (e: KeyboardEvent) => {
      if (isQuoteKey(e)) {
        const s = readSelection(el, sessionId);
        if (!s) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        quote(s.text);
        return;
      }
      // Tab while the menu is up: into it (it does not take the focus by itself)
      if (e.key === 'Tab' && !e.shiftKey && shown.current && !box.current?.contains(document.activeElement)) {
        const first = box.current?.querySelector<HTMLElement>('[data-mi]');
        if (first) { e.preventDefault(); first.focus(); }
      }
    };
    const changed = () => {
      if (!shown.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) close();
    };
    const gone = () => { if (shown.current) close(); };
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('scroll', gone, true);
    el.addEventListener('dblclick', dbl);
    document.addEventListener('mouseup', up);
    document.addEventListener('keyup', keyUp);
    document.addEventListener('keydown', keyDown);
    document.addEventListener('selectionchange', changed);
    window.addEventListener('resize', gone);
    return () => {
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('scroll', gone, true);
      el.removeEventListener('dblclick', dbl);
      document.removeEventListener('mouseup', up);
      document.removeEventListener('keyup', keyUp);
      document.removeEventListener('keydown', keyDown);
      document.removeEventListener('selectionchange', changed);
      window.removeEventListener('resize', gone);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, sessionId]);

  return snap ? <Menu key={snap.n} snap={snap} sessionId={sessionId} box={box} close={close} /> : null;
}

function Menu({ snap, sessionId, box, close }: { snap: Snap; sessionId: string; box: RefObject<HTMLDivElement | null>; close: () => void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // the one anchored menu while it is up; a mouse-down elsewhere and Esc close it
  useDropdown(true, close, box);
  // placed once its size is known (the first pass is drawn hidden)
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    setPos(placeSelectionMenu(snap.end, snap.bounds, snap.forward, { w: b.offsetWidth, h: b.offsetHeight }, { vw: window.innerWidth, vh: window.innerHeight }));
  }, [snap, box]);
  const m = snap.msg;
  const pinned = useStore((s) => !!m && !!s.sessionMeta[sessionId]?.pinnedMsgs?.some((p) => p.id === m.item.id));
  const motion = useMenuMotion(() => box.current, [!!pos]);

  const reply = m?.item.kind === 'assistant' ? (m.item as AssistantItem) : undefined;
  const forkable = useForkable();
  const groups = selectionItems({
    inCode: snap.code !== undefined,
    msg: m ? m.item.kind : null,
    hasText: !!reply && !!replyMarkdown(reply).trim(),
    canFork: forkable && !!m && (m.item.kind === 'user' ? !(m.item as UserItem).meta : !!reply?.uuid),
    canSide: canSideChat(sessionId),
  });
  const run = (it: SelItem) => {
    close();
    switch (it) {
      case 'copy': return copy(snap.text);
      case 'copyCode': return snap.code !== undefined && copy(snap.code);
      case 'copyMsg': return m && copy(plainOf(m));
      case 'copyMd': return reply && copy(replyMarkdown(reply));
      case 'quote': return quote(snap.text);
      case 'side': return openSideChat(sessionId, undefined, `> ${snap.text.replace(/\n/g, '\n> ')}\n\n`);
      case 'pin': return reply && togglePin(sessionId, reply.id, replyMarkdown(reply));
      case 'fork': return m && forkFrom(sessionId, m.item);
    }
  };
  const label: Record<SelItem, { icon: IconName; l: string; d?: string }> = {
    copy: { icon: 'copy', l: tr('复制') },
    copyCode: { icon: 'code', l: tr('复制代码块') },
    copyMsg: { icon: 'clipboard', l: tr('复制整条消息') },
    copyMd: { icon: 'read', l: tr('复制为 Markdown') },
    quote: { icon: 'quote', l: tr('引用到输入框') },
    side: { icon: 'chat', l: tr('旁聊'), d: tr('带上这段，在旁边问一句，不打断这条对话') },
    pin: pinned ? { icon: 'pinOff', l: tr('取消钉住') } : { icon: 'pin', l: tr('钉住这条回复'), d: tr('在右边信息栏的「钉住的回复」里能找回') },
    fork: { icon: 'branch', l: tr('从这里分叉'), d: m?.item.kind === 'user' ? tr('从这条消息之前新开一个对话，这个保留') : tr('新开一个对话，这个保留') },
  };
  const onKey = (e: React.KeyboardEvent) => {
    const rows = [...(box.current?.querySelectorAll<HTMLElement>('[data-mi]') ?? [])];
    const act = menuKey(e.key, rows.indexOf(document.activeElement as HTMLElement), rows.length);
    if (!act) return;
    e.preventDefault();
    e.stopPropagation();
    if ('focus' in act) rows[act.focus]?.focus();
    else if ('pick' in act) rows[act.pick]?.click();
    else close();
  };
  return createPortal(
    <div
      ref={box}
      className="menu cm sel-menu"
      role="menu"
      aria-label={tr('选中文字的操作')}
      style={pos ? { position: 'fixed', left: pos.left, top: pos.top, [MENU_ORIGIN]: pos.top >= snap.end.top ? '0% 0%' : '0% 100%' } as React.CSSProperties : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }}
      // the selection stays: a press on the menu must not start a new one
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={onKey}
      {...motion}
    >
      {groups.map((g, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <div className="menu-sep" role="separator" />}
          {g.map((it) => {
            const x = label[it];
            return (
              <button key={it} type="button" role="menuitem" data-mi data-act={it} className="cm-it" tabIndex={-1} onClick={() => run(it)}>
                <span className="cm-ic"><Icon name={x.icon} size={14} /></span>
                <span className="cm-tx"><span className="cm-l">{x.l}</span>{x.d && <span className="cm-d">{x.d}</span>}</span>
                {KEYS[it] && <span className="cm-r">{KEYS[it]}</span>}
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
