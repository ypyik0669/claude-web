import { useMemo } from 'react';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { GoalsPanel } from '@/features/goals/GoalsPanel';
import { OrchestraPanel } from '@/features/orchestra/OrchestraPanel';
import { useOrch, waitingOf } from '@/features/orchestra/state';
import { OverPage, type OverTab } from '@/features/sections/OverPage';
import { AUTOMATION_TABS, AUTOMATION_TAB_INFO, AUTOMATION_TITLE, type AutomationTab } from './page';
import { closeAutomation, newInAutomation, showAutomationTab, useAutomation } from './state';
import { SchedulesView } from './SchedulesView';

function Body({ tab }: { tab: AutomationTab }) {
  const n = useAutomation((s) => s.newAt[tab]);
  switch (tab) {
    case 'schedules': return <SchedulesView page newSignal={n} />;
    case 'goals': return <GoalsPanel page newSignal={n} />;
    case 'orchestra': return <OrchestraPanel page newSignal={n} />;
  }
}

/**
 * 定时任务 · 目标 · 编排 as tabs: the page draws them when the section's sidebar is not there (a phone, a collapsed
 * sidebar), the sidebar draws them otherwise (AutomationSide). The tab says how many there are (review 7 M3: not
 * 「2/3」); how many are on is the tooltip. 编排's number is what waits for you (审批 / 比选), a status rather than a count.
 */
export function useAutomationTabs(): OverTab[] {
  const schedules = useStore((s) => s.schedules);
  const orchFull = useOrch((s) => s.full);
  const orchWaiting = useMemo(() => waitingOf(orchFull).length, [orchFull]);
  return useMemo(() => {
    const count: Record<AutomationTab, React.ReactNode> = {
      schedules: schedules.length ? <span className="n">{schedules.length}</span> : null,
      goals: null,
      orchestra: orchWaiting ? <span className="n need">{orchWaiting} 等你</span> : null,
    };
    const title: Record<AutomationTab, string | undefined> = {
      schedules: schedules.length ? `${schedules.length} 个定时任务，${schedules.filter((s) => s.enabled).length} 个启用` : undefined,
      goals: undefined,
      orchestra: orchWaiting ? `${orchWaiting} 个审批 / 比选在等你` : undefined,
    };
    return AUTOMATION_TABS.map((t) => ({ id: t, label: AUTOMATION_TAB_INFO[t].label, icon: AUTOMATION_TAB_INFO[t].icon, count: count[t], title: title[t] }));
  }, [schedules, orchWaiting]);
}

/**
 * 自动化 (spec §5.9; structure round 2 §2.2): 定时任务 · 目标 · 编排 on one page laid over the main area, 新建 at the
 * top right. With the icon rail the three are rows of the section's own sidebar and the page shows one of them under
 * its own name; where that sidebar is not on screen the page has them as tabs. A tab's body is mounted the first time
 * it is shown and only hidden after that — nothing here is unmounted by switching tabs or closing the page (a
 * half-written workflow, a goal form, the scroll position all survive).
 */
export function AutomationPage() {
  const open = useAutomation((s) => s.open);
  const tab = useAutomation((s) => s.tab);
  const seen = useAutomation((s) => s.seen);
  const sideNav = useStore((s) => !s.mobile && s.sidebarOpen);
  const tabs = useAutomationTabs();
  const info = AUTOMATION_TAB_INFO[tab];
  return (
    <OverPage
      name="auto"
      label={AUTOMATION_TITLE}
      open={open}
      onClose={closeAutomation}
      title={sideNav ? info.label : AUTOMATION_TITLE}
      desc={info.desc}
      tab={tab}
      tabs={tabs}
      showTabs={!sideNav}
      onTab={(t) => showAutomationTab(t as AutomationTab)}
      narrow={tab !== 'orchestra'}
      actions={<button className="btn sm primary auto-new" onClick={() => newInAutomation(tab)} data-new={tab}><Icon name="plus" size={13} />{info.newLabel}</button>}
    >
      {seen.map((t) => (
        <div key={t} className={clsx('over-body auto-body', t !== 'orchestra' && 'narrow')} data-body={t} hidden={t !== tab}>
          <ErrorBoundary area={`自动化 · ${AUTOMATION_TAB_INFO[t].label}`}><Body tab={t} /></ErrorBoundary>
        </div>
      ))}
    </OverPage>
  );
}
