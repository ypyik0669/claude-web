import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { claimMenu } from '@/ui/menus';
import { useLeaveGhost } from '@/ui/ghost';
import { byPointer } from '@/ui/input-intent';
import { MENU_OUT_MS } from '@/ui/menu-motion';
import { ActionSheet, useSheetMenu } from '@/ui/ActionSheet';
import { pushBackLayer } from '@/ui/back-layer';
import { Icon, type IconName } from '@/ui/icons';
import { flyOrigin, placeFixed, placeFly, spotOrigin } from './place';
import { captionBox } from '@/ui/caption';
import { tr } from '@/i18n';

/** On a phone the sidebar is a drawer over the page: after an action it gets out of the way of what the action did. */
export const closeDrawer = () => { if (useStore.getState().mobile) useStore.setState({ sidebarOpen: false }); };

/** What a fly-out's leaving copy of its menu leaves out (ui/ghost.ts): an open fly-out does not fade with it. */
const FLY = '.sb-fly';

/**
 * Position a menu rendered inside its anchor (the parent element) fixed to the viewport, and close it on a click
 * elsewhere, a right-click elsewhere, Escape, or a scroll that moves the anchor. A streaming chat in another pane
 * (auto-scroll) or a scrolling list elsewhere leaves it open. Inside the sidebar the menu follows its anchor when
 * the list above it changes (the 「已筛选」 row appears while typing in the filter box, a pinned row is filtered out…).
 *
 * It scales in from its anchor (`--menu-origin`, from where it was placed) unless the keyboard opened it (`data-kb`),
 * and fades out when the pointer closes it (an inert copy, ui/ghost.ts) — UI refresh §4.5.
 *
 * On a phone the menu is an action sheet from the bottom (UI refresh §8): its root is rendered inside `MenuHost`,
 * which puts it in the sheet (ui/ActionSheet.tsx) — nothing is placed and nothing anchors it, so only Escape, a
 * click that reaches the window and another menu's claim are left here; the scrim, 取消, the handle and the system's
 * back are the sheet's.
 *
 * `onPlace`: called after every placement (a `Menu` re-places its open fly-outs then). `onEscape`: Escape goes there
 * first — true when it took the key (a `Menu` closes its innermost fly-out: one Esc does one thing).
 */
export function useAnchoredMenu(ref: React.RefObject<HTMLElement | null>, onClose: () => void, o: { align?: 'left' | 'right'; prefer?: 'down' | 'up'; side?: 'right'; deps?: unknown[]; onPlace?: () => void; onEscape?: () => boolean } = {}) {
  const opts = useRef(o);
  opts.current = o;
  const sheet = useSheetMenu();
  // decided as the menu mounts: a click handler mounts it within the same task as the pointer event
  const [kb] = useState(() => !byPointer());
  // where the anchor was when the menu was last placed: a scroll closes the menu only when it moved the anchor from there
  const anchorAt = useRef<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (sheet) return;
    const el = ref.current, anchor = el?.parentElement;
    if (!el || !anchor) return;
    if (kb) el.dataset.kb = '';
    const place = () => {
      // measuring at full height drops the scroll of a pinned menu; a re-place (any change in the sidebar) keeps it
      const scrolled = el.scrollTop;
      Object.assign(el.style, { position: 'fixed', right: 'auto', bottom: 'auto', maxHeight: '', overflowY: '', overscrollBehavior: '' });
      const a = anchor.getBoundingClientRect(), size = { w: el.offsetWidth, h: el.scrollHeight };
      anchorAt.current = { top: a.top, left: a.left };
      const side = anchor.closest('.sidebar')?.getBoundingClientRect();
      const spot = placeFixed(a, size, { vw: window.innerWidth, vh: window.innerHeight }, { ...opts.current, caption: captionBox(), ...(side && opts.current.side !== 'right' ? { minLeft: Math.max(8, Math.round(side.left) + 4) } : {}) });
      el.style.left = `${spot.left}px`;
      el.style.top = `${spot.top}px`;
      if (spot.maxHeight) Object.assign(el.style, { maxHeight: `${spot.maxHeight}px`, overflowY: 'auto', overscrollBehavior: 'contain' });
      if (scrolled) el.scrollTop = scrolled;
      el.style.setProperty('--menu-origin', spotOrigin(a, spot, size, opts.current));
      opts.current.onPlace?.();
    };
    place();
    // rows inserted / removed above the anchor move it without a scroll or a resize of the anchor itself
    const scope = anchor.closest('.sidebar');
    let raf = 0;
    const again = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };
    const mo = scope ? new MutationObserver(again) : null;
    mo?.observe(scope!, { childList: true, subtree: true });
    window.addEventListener('resize', again);
    return () => { mo?.disconnect(); cancelAnimationFrame(raf); window.removeEventListener('resize', again); };
  }, o.deps ?? []);
  useLeaveGhost(() => ref.current, () => (!sheet && byPointer() ? { ms: MENU_OUT_MS, className: 'leaving', strip: FLY } : null), []);
  // parents pass a fresh closure every render; the listeners below must not re-subscribe for that
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onScroll = (e: Event) => {
      const anchor = ref.current?.parentElement;
      const t = e.target as Node | null;
      if (!anchor || !t || ref.current?.contains(t)) return;
      if (!(t === document || (t as Node).contains?.(anchor))) return;
      // only a scroll that moved the anchor: the browser's scroll anchoring (rows inserted above a scrolled list keep
      // the visible ones still) and a scroll made just before the menu opened (its event comes a frame later) fire
      // `scroll` with the anchor where it was (the sidebar's list is shorter since the account row moved into it)
      const at = anchorAt.current, now = anchor.getBoundingClientRect();
      if (at && Math.abs(now.top - at.top) < 1 && Math.abs(now.left - at.left) < 1) return;
      closeRef.current();
    };
    const k = () => closeRef.current();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (opts.current.onEscape?.()) { e.preventDefault(); return; }
      closeRef.current();
    };
    // a sheet has no anchor a scroll could move (its parent is the sheet's own scrolling body), and a long press on
    // it — the one that opened it may still be down — is a `contextmenu` on a phone, not a wish to close it
    if (!sheet) {
      window.addEventListener('scroll', onScroll, true);
      window.addEventListener('contextmenu', k, true);
    }
    window.addEventListener('click', k);
    window.addEventListener('keydown', esc, true);
    // the one anchored menu app-wide: close the others (the header ···, a composer / right-panel popover…); the next
    // one to open, or the settings page covering the app, closes this one
    const offClaim = claimMenu(k);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('click', k); window.removeEventListener('contextmenu', k, true); window.removeEventListener('keydown', esc, true); offClaim(); };
  }, []);
}

/**
 * Where the root element of a `useAnchoredMenu` menu is drawn: in place on a desktop (inside its anchor, fixed next
 * to it by the hook); on a phone inside an action sheet in <body> — the sidebar drawer is a transformed,
 * overflow-hidden box, nothing fixed inside it gets out. `children` is exactly the menu's root element.
 */
export function MenuHost({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const sheet = useSheetMenu();
  return sheet ? <ActionSheet onClose={onClose}>{children}</ActionSheet> : <>{children}</>;
}

// ---- submenus (redesign 2026-11 stage 3: 图 7, 「子菜单往右展开」) ----
//
// There is one anchored menu app-wide (ui/menus.ts): a second menu opened from a row would close the first. So a
// submenu is not a menu of its own — it belongs to the `Menu` it comes out of: its panel is a DOM child of its row's
// wrapper inside that menu (a click in it is a click inside the menu, a scroll in it moves no anchor, Esc reaches the
// menu's own handler), drawn `position: fixed` beside the menu on a desktop. The menu keeps the path of open
// submenus (one per level: opening a row closes its open sibling and whatever was open under that); Esc and ← close
// the innermost one. On a phone the menu is an action sheet: a submenu is pushed inside the same sheet instead — the
// rows under it make way, a ‹ at the top left goes back one level (so does the system's back gesture).
//
//   <div class="menu sb-menu [data-fly-open] [data-pushed]">        the Menu (data-pushed: a phone page is shown)
//     <div class="sb-push-head">‹ 分组方式</div>                    a phone, while something is pushed
//     <div class="sb-sub [data-open]" data-sub="group-by">          a SubMenu
//       <button class="sb-sub-row" aria-haspopup="menu">分组方式 <span class="v">文件夹 ›</span></button>
//       <div class="menu sb-menu sb-fly" role="menu">…</div>       while open (a desktop: fixed beside the menu)

interface MenuTree {
  sheet: boolean;
  /** the open submenus from the top level down, by key */
  path: string[];
  setPath: React.Dispatch<React.SetStateAction<string[]>>;
  /** each open fly-out's placement, run again whenever the menu is placed again (the list above it changed) */
  placers: Set<() => void>;
  /** the row of each open submenu, to give the focus back to when it closes from the keyboard */
  rows: Map<string, HTMLElement>;
  /** the labels of the open submenus: the title of a pushed page on a phone */
  labels: Map<string, string>;
}
const TreeCtx = createContext<MenuTree | null>(null);
const DepthCtx = createContext(0);

/** Hovering a row opens its submenu after this long (a pointer passing over it on its way does not). */
const HOVER_OPEN_MS = 120;
/** With a submenu open, the pointer on another row of the same menu closes it after this long — time enough to cross
 *  that row on the way into the submenu diagonally (the submenu's own rows cancel it). */
const HOVER_CLOSE_MS = 280;

/** The rows a ↑ ↓ moves between inside one submenu (not the rows of a deeper one). */
const flyItems = (panel: HTMLElement) => [...panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].filter((b) => b.closest(FLY) === panel && b.getClientRects().length > 0);

/** A sidebar popover menu (filter / automation / project / account): `.menu` fixed next to its parent element. */
export function Menu({ onClose, className, align, prefer, side, label, title, children }: { onClose: () => void; className?: string; align?: 'left' | 'right'; prefer?: 'down' | 'up'; side?: 'right'; label: string; /** a phone: a title at the top of the sheet */ title?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const sheet = useSheetMenu();
  const [path, setPath] = useState<string[]>([]);
  const pathRef = useRef(path);
  pathRef.current = path;
  // what every level shares for the menu's life; the context value changes with the path only
  const shared = useMemo(() => ({ placers: new Set<() => void>(), rows: new Map<string, HTMLElement>(), labels: new Map<string, string>() }), []);
  const tree = useMemo<MenuTree>(() => ({ sheet, path, setPath, ...shared }), [sheet, path, shared]);
  useAnchoredMenu(ref, onClose, {
    align, prefer, side,
    onPlace: () => { for (const f of shared.placers) f(); },
    // Esc closes the innermost submenu first, the focus back on its row
    onEscape: () => {
      const p = pathRef.current;
      if (!p.length) return false;
      setPath(p.slice(0, -1));
      const row = shared.rows.get(p[p.length - 1]);
      if (row && !sheet) row.focus({ preventScroll: true });
      return true;
    },
  });
  // a phone: the system's back gesture goes back one page before it closes the sheet
  useEffect(() => {
    if (!sheet || !path.length) return;
    const release = pushBackLayer(() => setPath((p) => p.slice(0, -1)));
    return () => { setTimeout(release, 0); };
  }, [sheet, path.length]);
  // (a phone: a long press in the filter box is its paste menu — the only way to paste there)
  const onContextMenu = (e: React.MouseEvent) => { if (!(sheet && (e.target as Element).tagName === 'INPUT')) e.preventDefault(); e.stopPropagation(); };
  const pushed = sheet && path.length > 0;
  const top = pushed ? path[path.length - 1] : null;
  return (
    <MenuHost onClose={onClose}>
      <div ref={ref} role="menu" aria-label={label} title="" className={clsx('menu sb-menu', className)} data-fly-open={!sheet && path.length ? '' : undefined} data-pushed={pushed ? '' : undefined} onClick={(e) => e.stopPropagation()} onContextMenu={onContextMenu}>
        {sheet && title && !pushed && <div className="sb-sheet-title">{title}</div>}
        {pushed && (
          <div className="sb-push-head">
            <button type="button" className="sb-push-back" aria-label={tr('返回')} onClick={() => setPath((p) => p.slice(0, -1))}><Icon name="chevronLeft" size={20} /></button>
            <span className="t">{(top && shared.labels.get(top)) || ''}</span>
          </div>
        )}
        <TreeCtx.Provider value={tree}><DepthCtx.Provider value={0}>{children}</DepthCtx.Provider></TreeCtx.Provider>
      </div>
    </MenuHost>
  );
}

/**
 * A row of a `Menu` with a submenu behind it (分组方式 ›, 语言 ›…): its label, a value at its end, and the submenu —
 * `children` are the submenu's rows. A desktop: it flies out to the right of the menu (to the left when the right has
 * no room) on a click, on a hover, or on → / Enter / Space (the focus to its first row); ← or Esc closes it (the focus
 * back here), so does the pointer resting on another row. A phone: a tap pushes it inside the same sheet.
 * Submenus nest (显示 › 来源 ›). Outside a `Menu` (no tree) the rows simply open in place under it.
 */
export function SubMenu({ id, icon, label, value, className, panelClass, children }: { id?: string; icon?: IconName; label: string; value?: React.ReactNode; className?: string; panelClass?: string; children: React.ReactNode }) {
  const tree = useContext(TreeCtx);
  const depth = useContext(DepthCtx);
  const key = id ?? label;
  const [solo, setSolo] = useState(false); // no tree: open in place
  const open = tree ? tree.path[depth] === key : solo;
  const deeper = !!tree && open && tree.path.length > depth + 1;
  const sheet = !!tree?.sheet;
  const wrap = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLButtonElement>(null);
  const timer = useRef(0);
  const viaKeys = useRef(false);
  const clear = () => { window.clearTimeout(timer.current); timer.current = 0; };
  useEffect(() => clear, []);

  const show = (keys: boolean) => {
    clear();
    viaKeys.current = keys;
    if (!tree) { setSolo(true); return; }
    tree.labels.set(key, label);
    if (row.current) tree.rows.set(key, row.current);
    tree.setPath((p) => (p[depth] === key && p.length === depth + 1 ? p : [...p.slice(0, depth), key]));
  };
  const hide = (refocus = false) => {
    clear();
    if (!tree) setSolo(false);
    else tree.setPath((p) => (p[depth] === key ? p.slice(0, depth) : p));
    if (refocus) row.current?.focus({ preventScroll: true });
  };
  const onRowKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    if (!open) { show(true); return; }
    const p = wrap.current?.querySelector<HTMLElement>(`:scope > ${FLY}`);
    if (p) flyItems(p)[0]?.focus({ preventScroll: true });
  };

  return (
    <div ref={wrap} className={clsx('sb-sub', className)} data-sub={key} data-open={open ? '' : undefined}>
      <button
        ref={row}
        type="button"
        className={clsx('sb-sub-row', open && 'open')}
        data-id={id}
        aria-haspopup="menu"
        aria-expanded={open}
        // a click opens it (and keeps it open: a hover may have opened it a moment ago); outside a Menu it toggles
        onClick={(e) => { e.stopPropagation(); if (!tree && open) hide(); else show(false); }}
        onKeyDown={onRowKey}
        onPointerEnter={(e) => { if (sheet || !tree || e.pointerType !== 'mouse' || open) return; clear(); timer.current = window.setTimeout(() => { timer.current = 0; show(false); }, HOVER_OPEN_MS); }}
        onPointerLeave={() => { if (!open) clear(); }}
      >
        {icon && <Icon name={icon} size={14} />}
        <span className="grow">{label}</span>
        <span className="v">{value != null && value !== '' && <span className="vt">{value}</span>}<Icon name={!tree && open ? 'chevronDown' : 'chevronRight'} size={12} /></span>
      </button>
      {open && (
        <FlyPanel tree={tree} wrap={wrap} row={row} label={label} className={panelClass} deeper={deeper} focusFirst={viaKeys.current} hide={hide} clear={clear} timer={timer}>
          <DepthCtx.Provider value={depth + 1}>{children}</DepthCtx.Provider>
        </FlyPanel>
      )}
    </div>
  );
}

/**
 * The open submenu's panel (mounted while it is open). A desktop: placed beside the menu it comes out of — again
 * whenever that menu is placed again (the sidebar list under it changed) or the window resizes — scaling in from the
 * row (not when the keyboard opened it) and fading out when the pointer closes it, like a menu; ↑ ↓ Home End move
 * between its rows, ← closes it; the pointer resting on another row of the menu closes it. A phone: the page shown in
 * the sheet (its rows; a deeper page pushed over them).
 */
function FlyPanel({ tree, wrap, row, label, className, deeper, focusFirst, hide, clear, timer, children }: { tree: MenuTree | null; wrap: React.RefObject<HTMLDivElement | null>; row: React.RefObject<HTMLButtonElement | null>; label: string; className?: string; deeper: boolean; focusFirst: boolean; hide: (refocus?: boolean) => void; clear: () => void; timer: React.MutableRefObject<number>; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const sheet = !!tree?.sheet;
  const [kb] = useState(() => focusFirst || !byPointer());
  useLayoutEffect(() => {
    const el = ref.current, r = row.current;
    if (!el) return;
    if (focusFirst) flyItems(el)[0]?.focus({ preventScroll: true });
    if (sheet || !tree || !r) return;
    const box = wrap.current?.parentElement?.closest('.menu');
    if (!box) return;
    if (kb) el.dataset.kb = '';
    const place = () => {
      const scrolled = el.scrollTop;
      Object.assign(el.style, { position: 'fixed', right: 'auto', bottom: 'auto', maxHeight: '', overflowY: '' });
      const size = { w: el.offsetWidth, h: el.scrollHeight };
      const rr = r.getBoundingClientRect();
      const spot = placeFly(rr, box.getBoundingClientRect(), size, { vw: window.innerWidth, vh: window.innerHeight }, captionBox());
      el.style.left = `${spot.left}px`;
      el.style.top = `${spot.top}px`;
      el.dataset.side = spot.side;
      if (spot.maxHeight) Object.assign(el.style, { maxHeight: `${spot.maxHeight}px`, overflowY: 'auto' });
      if (scrolled) el.scrollTop = scrolled;
      el.style.setProperty('--menu-origin', flyOrigin(rr, spot, size));
    };
    place();
    tree.placers.add(place);
    window.addEventListener('resize', place);
    return () => { tree.placers.delete(place); window.removeEventListener('resize', place); };
  }, []);
  useLeaveGhost(() => ref.current, () => (!sheet && byPointer() ? { ms: MENU_OUT_MS, className: 'leaving', strip: FLY } : null), []);
  // the pointer resting on another row of the same menu closes it (its own row and panel keep it open)
  useEffect(() => {
    if (sheet || !tree) return;
    const host = wrap.current?.parentElement;
    if (!host) return;
    const over = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      if (wrap.current?.contains(e.target as Node)) { clear(); return; }
      if (!timer.current) timer.current = window.setTimeout(() => { timer.current = 0; hide(); }, HOVER_CLOSE_MS);
    };
    host.addEventListener('pointerover', over);
    return () => host.removeEventListener('pointerover', over);
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = ref.current;
    if (!el || (e.target as Element).closest(FLY) !== el) return; // a deeper submenu's own keys
    if (e.key === 'ArrowLeft' && !sheet) { e.preventDefault(); e.stopPropagation(); hide(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    if ((e.target as Element).tagName === 'INPUT') return;
    e.preventDefault();
    e.stopPropagation();
    const items = flyItems(el);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : at <= 0 ? items.length - 1 : at - 1;
    items[next].focus({ preventScroll: true });
  };
  return (
    <div ref={ref} className={clsx('menu sb-menu sb-fly', className)} role="menu" aria-label={label} title="" data-pushed={sheet && deeper ? '' : undefined} data-fly-open={!sheet && deeper ? '' : undefined} onKeyDown={onKeyDown} onPointerEnter={clear}>
      {children}
    </div>
  );
}

