import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { basename, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { dirMenuLayout, menuKey, sameLayout, type DirMenuLayout } from './dir-menu';
import { PROJECT_MENU_ID } from './ids';
import { useMenuClaim } from '@/ui/menus';

/**
 * Working-directory chip of the welcome composer. The list of recent directories opens only from this chip,
 * in our own popover (portalled to <body>, fixed coordinates, below the chip so it never covers the text box).
 *
 * It replaces an invisible native `<select>` that sat inside the chip with `position:absolute; inset:0` — the
 * chip itself was not positioned, so the select stretched over the whole composer and a click meant for the
 * text box opened the native folder list instead.
 */
export function DirPicker({ cwd, recent, onPick, onBrowse, footer, label, title }: {
  cwd: string;
  recent: string[];
  onPick: (dir: string) => void;
  onBrowse: () => void;
  /** more rows under 「浏览文件夹…」 (the project chip's 独立副本 switch); `close` closes the menu */
  footer?: (close: () => void) => React.ReactNode;
  /** the chip's text (default: the folder name) */
  label?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const dirs = cwd && !recent.includes(cwd) ? [cwd, ...recent] : recent;
  const click = () => {
    if (!dirs.length && !footer) { onBrowse(); return; } // nothing to choose from yet: straight to the folder dialog
    setOpen((o) => !o);
  };
  return (
    <>
      <button ref={chip} type="button" className={clsx('dirpick', open && 'active')} onClick={click} title={title ?? (cwd || '选择项目文件夹')} aria-label={`项目：${cwd ? basename(cwd) : '未选择'}`} aria-haspopup="menu" aria-expanded={open}>
        <span className="dirpick-ic"><Icon name="folder" size={14} /></span>
        <span className="dirpick-name opt">{label ?? (cwd ? basename(cwd) : '选择项目')}</span>
        {(dirs.length > 0 || footer) && <span className="caret opt"><Icon name="chevronDown" size={10} /></span>}
      </button>
      {open && (
        <ErrorBoundary area="目录菜单" compact onReset={() => setOpen(false)}>
          <DirMenu
            anchor={chip}
            cwd={cwd}
            dirs={dirs}
            onPick={(d) => { setOpen(false); onPick(d); chip.current?.focus(); }}
            onBrowse={() => { setOpen(false); onBrowse(); }}
            onClose={(refocus) => { setOpen(false); if (refocus) chip.current?.focus(); }}
            footer={footer ? footer(() => setOpen(false)) : null}
          />
        </ErrorBoundary>
      )}
    </>
  );
}

function DirMenu({ anchor, cwd, dirs, onPick, onBrowse, onClose, footer }: { anchor: React.RefObject<HTMLButtonElement | null>; cwd: string; dirs: string[]; onPick: (d: string) => void; onBrowse: () => void; onClose: (refocus: boolean) => void; footer?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<DirMenuLayout | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    const place = () => {
      // position AND width: a resize can shrink the room without moving the chip
      const next = dirMenuLayout(a.getBoundingClientRect(), { vw: window.innerWidth, vh: window.innerHeight });
      setPos((cur) => (sameLayout(cur, next) ? cur : next));
    };
    place();
    const onScroll = (e: Event) => { if (!box.current?.contains(e.target as Node)) place(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); };
  }, [anchor]);
  // focus the current directory (or the first row) once the menu is placed
  useLayoutEffect(() => {
    if (!pos) return;
    const rows = [...(box.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    (rows.find((b) => b.dataset.dir === cwd) ?? rows[0])?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!pos]);
  useEffect(() => {
    const off = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return; // the chip's own click toggles
      onClose(false);
    };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [anchor, onClose]);
  // the one anchored menu app-wide; the settings page opening over the app closes it too
  useMenuClaim(() => onClose(false));
  const onKey = (e: React.KeyboardEvent) => {
    const rows = [...(box.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const act = menuKey(e.key, rows.indexOf(document.activeElement as HTMLButtonElement), rows.length);
    if (!act) return;
    e.preventDefault(); // Tab too: focus goes back to the chip, not into whatever follows <body>'s portal
    e.stopPropagation();
    if ('focus' in act) rows[act.focus]?.focus();
    else onClose(act.refocus);
  };
  if (!pos) return null;
  return createPortal(
    <div ref={box} className="menu dirmenu" style={pos} role="menu" aria-label="项目" onKeyDown={onKey}>
      {dirs.length > 0 && <>
        <div className="dirmenu-head">最近的项目</div>
        <div className="dirmenu-list">
          {dirs.map((d) => (
            <button key={d} type="button" role="menuitemradio" aria-checked={d === cwd} data-dir={d} className={clsx(d === cwd && 'cur')} onClick={() => onPick(d)} title={d}>
              <span className="dirmenu-check">{d === cwd && <Icon name="check" size={12} />}</span>
              <span className="dirmenu-text"><span className="n">{basename(d) || d}</span><span className="p">{d}</span></span>
            </button>
          ))}
        </div>
        <div className="menu-sep" />
      </>}
      <button type="button" role="menuitem" data-id={PROJECT_MENU_ID.browse} onClick={onBrowse}><Icon name="folder" size={13} /> 打开文件夹…</button>
      {footer}
    </div>,
    document.body,
  );
}
