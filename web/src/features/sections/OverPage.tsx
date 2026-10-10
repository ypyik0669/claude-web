import { useEffect, useRef } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon, type IconName } from '@/ui/icons';
import { anchoredMenuOpen } from '@/ui/menus';
import { SidebarReveal } from '@/features/workbench/pane-edge';

/** Something else has the keyboard's Esc: a dialog, a menu, the palette, the settings page, the shortcut sheet. */
const escTaken = () => {
  const st = useStore.getState();
  return !!st.settingsOpen || st.paletteOpen || st.shortcutsOpen || anchoredMenuOpen() || !!document.querySelector('.modal-bg, .menu, .cmdk');
};

/** Back from the page: the keyboard goes to the conversation's composer in front (not left on <body>). */
function focusComposer() {
  requestAnimationFrame(() => {
    const a = document.activeElement;
    // something else took it (a new conversation, the other page, a row of the section's sidebar…)
    if (a && a !== document.body && !a.closest('.over-page')) return;
    const t = document.querySelector<HTMLTextAreaElement>('.pane.focused .composer textarea') ?? document.querySelector<HTMLTextAreaElement>('.pane .composer textarea');
    t?.focus({ preventScroll: true });
  });
}

export interface OverTab { id: string; label: string; icon: IconName; count?: React.ReactNode; title?: string }

/**
 * A page laid over the main area — 自动化, 扩展 (spec 2026-10-10-ui-structure §2.2). Mounted once it has been opened
 * and only hidden after that; while it is open it has the keyboard (the panes under it are inert) and closing gives
 * the keyboard back to the composer. It closes with Esc, its × (where there is no icon rail to leave by), or
 * whenever the main area is sent somewhere (automation/state.ts `installAutomation`).
 *
 * `name` prefixes the class names the page had before the two pages shared this shell (`auto-page`, `auto-head`…):
 * tests and scripts find the pages by them; the style sheet uses the shared `over-*` ones.
 *
 * `tabs`: drawn in the page only while the section's own sidebar is not there to show them (a phone, a collapsed
 * sidebar) — the caller decides and passes `showTabs`.
 */
export function OverPage(p: {
  name: string;
  label: string;
  open: boolean;
  onClose(): void;
  title: string;
  desc?: string;
  tab: string;
  tabs: OverTab[];
  showTabs: boolean;
  onTab(id: string): void;
  actions?: React.ReactNode;
  narrow?: boolean;
  children: React.ReactNode;
}) {
  const mobile = useStore((s) => s.mobile);
  const root = useRef<HTMLDivElement>(null);
  // the page takes the keyboard when it opens; closing gives it back to the composer (review 7 M1)
  const wasOpen = useRef(p.open);
  useEffect(() => {
    if (p.open) root.current?.focus({ preventScroll: true });
    else if (wasOpen.current) focusComposer();
    wasOpen.current = p.open;
  }, [p.open]);
  // Esc also when the focus fell to <body> (a click on empty space, a closed menu) or sits in the section's sidebar
  // — unless something else owns it
  const close = useRef(p.onClose);
  close.current = p.onClose;
  useEffect(() => {
    if (!p.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const a = document.activeElement;
      // on <body>, or on one of the section's own rows in the sidebar (they are this page's tabs: not in a field)
      if (a && a !== document.body && !a.closest('.sect-side')) return;
      if (a?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (escTaken()) return;
      close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p.open]);
  const n = p.name;
  return (
    <div
      className={clsx('over-page', `${n}-page`, mobile && 'phone')}
      hidden={!p.open}
      ref={root}
      tabIndex={-1}
      role="region"
      aria-label={p.label}
      data-tab={p.tab}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const t = e.target as HTMLElement;
        if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
        e.preventDefault();
        p.onClose();
      }}
    >
      <div className={clsx('over-head', `${n}-head`, p.narrow && 'narrow')}>
        <SidebarReveal />
        {/* the title and the actions span the content's width (新建 lines up with the list's right edge, review 7 M13) */}
        <div className={clsx('over-head-in', `${n}-head-in`)}>
          <div className="over-title">
            <h2>{p.title}</h2>
            {p.desc && !p.showTabs && <span className="over-sub">{p.desc}</span>}
          </div>
          <span className="grow" />
          {p.actions}
        </div>
        <button className="icon-btn over-close" title="关闭 (Esc)" aria-label={`关闭${p.label}`} onClick={p.onClose}><Icon name="close" size={16} /></button>
      </div>
      {p.showTabs && (
        <div className={clsx('utabs over-tabs', `${n}-tabs`)} role="tablist" aria-label={p.label}>
          {p.tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={p.tab === t.id} className={clsx('ht', p.tab === t.id && 'on')} data-id={t.id} title={t.title} onClick={() => p.onTab(t.id)}>
              <Icon name={t.icon} size={14} />{t.label}{t.count}
            </button>
          ))}
        </div>
      )}
      {p.showTabs && p.desc && <div className={clsx('over-desc', `${n}-desc`)}>{p.desc}</div>}
      {p.children}
    </div>
  );
}
