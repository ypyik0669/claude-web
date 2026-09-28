import { useEffect, useMemo, useRef } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
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
    case 'orchestra': return <OrchestraPanel newSignal={n} />;
  }
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
  // the page takes the keyboard when it opens (the conversation under it is inert while it is open)
  useEffect(() => { if (open) root.current?.focus({ preventScroll: true }); }, [open]);
  const count: Record<AutomationTab, React.ReactNode> = {
    schedules: schedules.length ? <span className="n">{schedules.filter((s) => s.enabled).length}/{schedules.length}</span> : null,
    goals: null,
    orchestra: orchWaiting ? <span className="n need">{orchWaiting} 等你</span> : null,
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
      <div className="auto-head">
        <SidebarReveal />
        <h2>自动化</h2>
        <span className="grow" />
        <button className="btn sm primary auto-new" onClick={() => newInAutomation(tab)} data-new={tab}><Icon name="plus" size={13} />{info.newLabel}</button>
        <button className="icon-btn" title="关闭 (Esc)" aria-label="关闭自动化" onClick={closeAutomation}><Icon name="close" size={16} /></button>
      </div>
      <div className="utabs auto-tabs" role="tablist" aria-label="自动化">
        {AUTOMATION_TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={clsx('ht', tab === t && 'on')} data-id={id(t)} onClick={() => showAutomationTab(t)}>
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
