import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { anchoredMenuOpen } from '@/ui/menus';
import { GoalsPanel } from '@/features/goals/GoalsPanel';
import { OrchestraPanel } from '@/features/orchestra/OrchestraPanel';
import { useOrch, waitingOf } from '@/features/orchestra/state';
import { SidebarReveal } from '@/features/workbench/pane-edge';
import { AUTOMATION_TABS, AUTOMATION_TAB_INFO, type AutomationTab } from './page';
import { closeAutomation, newInAutomation, showAutomationTab, useAutomation } from './state';
import { SchedulesView } from './SchedulesView';
import type { AutomationId } from '@/features/sidebar/entries';

function Body({ tab }: { tab: AutomationTab }) {
  const n = useAutomation((s) => s.newAt[tab]);
  switch (tab) {
    case 'schedules': return <SchedulesView page newSignal={n} />;
    case 'goals': return <GoalsPanel page newSignal={n} />;
    case 'orchestra': return <OrchestraPanel page newSignal={n} />;
  }
}

/** Something else has the keyboard's Esc: a dialog, a menu, the palette, the settings page, the shortcut sheet. */
const escTaken = () => {
  const st = useStore.getState();
  return !!st.settingsOpen || st.paletteOpen || st.shortcutsOpen || anchoredMenuOpen() || !!document.querySelector('.modal-bg, .menu, .cmdk');
};

/** Back from the page: the keyboard goes to the conversation's composer in front (not left on <body>). */
function focusComposer() {
  requestAnimationFrame(() => {
    const a = document.activeElement;
    if (a && a !== document.body && !a.closest('.auto-page')) return; // something else took it (a new conversation…)
    const t = document.querySelector<HTMLTextAreaElement>('.pane.focused .composer textarea') ?? document.querySelector<HTMLTextAreaElement>('.pane .composer textarea');
    t?.focus({ preventScroll: true });
  });
}

/**
 * 自动化 (spec §5.9): 定时任务 · 目标 · 编排 on one page laid over the main area (the sidebar and the right panel stay
 * where they are), 新建 at the top right. A tab's body is mounted the first time it is shown and only hidden after
 * that — like the right panel, nothing here is unmounted by switching tabs or closing the page (a half-written
 * workflow, a goal form, the scroll position all survive). It closes with its ×, Esc, or whenever the main area is
 * sent somewhere (a conversation opened from the sidebar, the palette, a notification, 新对话…; state.ts).
 */
export function AutomationPage() {
  const open = useAutomation((s) => s.open);
  const tab = useAutomation((s) => s.tab);
  const seen = useAutomation((s) => s.seen);
  const schedules = useStore((s) => s.schedules);
  const mobile = useStore((s) => s.mobile);
  const orchFull = useOrch((s) => s.full);
  const orchWaiting = useMemo(() => waitingOf(orchFull).length, [orchFull]);
  const root = useRef<HTMLDivElement>(null);
  // the page takes the keyboard when it opens (the conversation under it is inert while it is open); closing gives
  // it back to the composer (review 7 M1)
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open) root.current?.focus({ preventScroll: true });
    else if (wasOpen.current) focusComposer();
    wasOpen.current = open;
  }, [open]);
  // Esc also when the focus fell to <body> (a click on empty space, a closed menu) — unless something else owns it
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && a !== document.body) return;
      if (escTaken()) return;
      closeAutomation();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  // the tab says how many there are (review 7 M3: not 「2/3」); how many are on is the tooltip. 编排's number is
  // what waits for you (审批 / 比选), a status rather than a count
  const count: Record<AutomationTab, React.ReactNode> = {
    schedules: schedules.length ? <span className="n">{schedules.length}</span> : null,
    goals: null,
    orchestra: orchWaiting ? <span className="n need">{orchWaiting} 等你</span> : null,
  };
  const tabTitle: Record<AutomationTab, string | undefined> = {
    schedules: schedules.length ? `${schedules.length} 个定时任务，${schedules.filter((s) => s.enabled).length} 个启用` : undefined,
    goals: undefined,
    orchestra: orchWaiting ? `${orchWaiting} 个审批 / 比选在等你` : undefined,
  };
  const info = AUTOMATION_TAB_INFO[tab];
  const id = (x: AutomationId) => x;
  return (
    <div
      className={clsx('auto-page', mobile && 'phone')}
      hidden={!open}
      ref={root}
      tabIndex={-1}
      role="region"
      aria-label="自动化"
      data-tab={tab}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const t = e.target as HTMLElement;
        if (t.closest('input, textarea, select, [contenteditable="true"]')) return;
        e.preventDefault();
        closeAutomation();
      }}
    >
      <div className={clsx('auto-head', tab !== 'orchestra' && 'narrow')}>
        <SidebarReveal />
        {/* the title and 新建 span the content's width (新建 lines up with the list's right edge, review 7 M13) */}
        <div className="auto-head-in">
          <h2>自动化</h2>
          <span className="grow" />
          <button className="btn sm primary auto-new" onClick={() => newInAutomation(tab)} data-new={tab}><Icon name="plus" size={13} />{info.newLabel}</button>
        </div>
        <button className="icon-btn" title="关闭 (Esc)" aria-label="关闭自动化" onClick={closeAutomation}><Icon name="close" size={16} /></button>
      </div>
      <div className="utabs auto-tabs" role="tablist" aria-label="自动化">
        {AUTOMATION_TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={clsx('ht', tab === t && 'on')} data-id={id(t)} title={tabTitle[t]} onClick={() => showAutomationTab(t)}>
            <Icon name={AUTOMATION_TAB_INFO[t].icon} size={14} />{AUTOMATION_TAB_INFO[t].label}{count[t]}
          </button>
        ))}
      </div>
      <div className="auto-desc">{info.desc}</div>
      {seen.map((t) => (
        <div key={t} className={clsx('auto-body', t !== 'orchestra' && 'narrow')} data-body={t} hidden={t !== tab}>
          <ErrorBoundary area={`自动化 · ${AUTOMATION_TAB_INFO[t].label}`}><Body tab={t} /></ErrorBoundary>
        </div>
      ))}
    </div>
  );
}
