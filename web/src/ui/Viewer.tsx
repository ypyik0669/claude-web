// The full-window viewer: the image viewer's look (a dark layer, a bar with the close button at the top right, a stage)
// for whatever is shown as big as the window — the pictures of a message (features/chat/ImageViewer) and, issue #17, a
// node graph or a Mermaid picture from the conversation (features/chat/GraphFullscreen, MermaidBlock).
//
//   <body>
//     <div class="viewer" role="dialog" aria-modal="true">   z 100; the --viewer-* tokens: dark in every theme
//       <div class="viewer-bar">{bar, or the title} … <button class="viewer-close">
//       {children}                                           the stage: .viewer-stage …
//
// In <body>, because nothing may clip it (a reply's code block sits in a scrolling column). Modal:
//  - the focus goes in when it opens (`initialFocus`, else the layer itself) and back when it closes (`returnFocus`,
//    else what had it before); Tab goes round inside it (ui/focus-trap);
//  - Esc closes it — taken in the capture phase on window, so nothing under it acts on the key too (the composer would
//    stop a running turn, a page under it would close) — but only when it is meant for it (viewer-esc.ts): not the
//    input method's, not while a menu is open (a dropdown on a card closes first) or a dialog lies over it;
//  - keys typed in it go no further (no shortcut of the page under it), nor do clicks and wheels: it is a portal, and
//    React hands its events to whoever rendered it (the conversation). Presses (mousedown / pointerdown) do go on: a
//    dropdown that is open closes on a press elsewhere (Popover listens on document);
//  - phones: the system's back gesture closes it (ui/back-layer).
// The phone's sheet and drawer and the sidebar's Esc know it is there by the `.viewer` class.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import { pushBackLayer } from './back-layer';
import { trapTab } from './focus-trap';
import { Icon } from './icons';
import { imeComposing } from './ime';
import { byPointer } from './input-intent';
import { anchoredMenuOpen, closeAnchoredMenus } from './menus';
import { viewerTakesEsc, type EscScene } from './viewer-esc';

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** drawn right now: not inside something hidden (panels stay mounted), not the fading copy of a menu that just closed (ui/ghost.ts) */
const onScreen = (sel: string): boolean => [...document.querySelectorAll(sel)].some((el) => el.getClientRects().length > 0 && !el.closest('.leaving, .as-leaving'));

function escScene(e: KeyboardEvent, me: HTMLElement | null): EscScene {
  const all = document.querySelectorAll('.viewer');
  return {
    key: e.key,
    defaultPrevented: e.defaultPrevented,
    composing: imeComposing(e),
    menuOpen: anchoredMenuOpen() || onScreen('.menu'),
    dialogAbove: onScreen('.dialog-bg'),
    topmost: !!me && all[all.length - 1] === me,
  };
}

export interface ViewerProps {
  /** what it shows: the dialog's name, and the bar's title unless `bar` is given */
  label: string;
  onClose: () => void;
  /** the bar's own content, before the close button (the image viewer's counter and buttons) */
  bar?: ReactNode;
  /** where the focus goes when it opens (default: the layer itself) */
  initialFocus?: (layer: HTMLElement) => HTMLElement | null;
  /** where the focus goes back when it closes (default: what had it when it opened) */
  returnFocus?: HTMLElement | null;
  /** keys inside it, before they stop there (Esc never arrives: it is taken earlier) */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  className?: string;
  children: ReactNode;
}

export function Viewer({ label, onClose, bar, initialFocus, returnFocus, onKeyDown, className, children }: ViewerProps) {
  const layer = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // both read once, when it opens
  const focusIn = useRef(initialFocus);
  const backTo = useRef(returnFocus);
  // opened from the keyboard: simply there, no fade (UI refresh §4.5)
  const [kb] = useState(() => !byPointer());

  // the focus: in now (before the first paint), back on the way out — unless something else took it meanwhile. A menu
  // still open elsewhere closes first: portalled to <body> above this layer, it would float over the picture
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    closeAnchoredMenus();
    const prev = backTo.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    (focusIn.current?.(el) ?? el).focus({ preventScroll: true });
    return () => {
      const a = document.activeElement;
      if (prev && prev !== document.body && prev.isConnected && (!a || a === document.body || el.contains(a))) prev.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!viewerTakesEsc(escScene(e, layer.current))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // the history entry is given back a task later, as ActionSheet does (what the closing opens next pushes its own)
  useEffect(() => {
    const release = pushBackLayer(() => closeRef.current());
    return () => { setTimeout(release, 0); };
  }, []);

  const keys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    trapTab(e, layer.current);
    e.stopPropagation();
  };

  return createPortal(
    <div ref={layer} className={clsx('viewer', className)} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-kb={kb ? '' : undefined}
      onKeyDown={keys} onClick={stop} onDoubleClick={stop} onAuxClick={stop} onContextMenu={stop} onWheel={stop}>
      <div className="viewer-bar">
        {bar ?? <><span className="viewer-title" title={label}>{label}</span><span className="grow" /></>}
        <button type="button" className="btn sm ghost viewer-close" onClick={() => closeRef.current()} title={tr('关闭 (Esc)')} aria-label={tr('关闭')}><Icon name="close" size={13} /></button>
      </div>
      {children}
    </div>,
    document.body,
  );
}
