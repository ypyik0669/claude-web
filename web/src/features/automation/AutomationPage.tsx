import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { GoalsPanel } from '@/features/goals/GoalsPanel';
import { OrchestraPanel } from '@/features/orchestra/OrchestraPanel';
import { OverPage } from '@/features/sections/OverPage';
import { AUTOMATION_TAB_INFO, AUTOMATION_TITLE, type AutomationTab } from './page';
import { closeAutomation, newInAutomation, showAutomationTab, useAutomation } from './state';
import { SchedulesView } from './SchedulesView';
import { tr } from '@/i18n';

function Body({ tab }: { tab: AutomationTab }) {
  const n = useAutomation((s) => s.newAt[tab]);
  switch (tab) {
    case 'schedules': return <SchedulesView page newSignal={n} />;
    case 'goals': return <GoalsPanel page newSignal={n} />;
    case 'orchestra': return <OrchestraPanel page newSignal={n} />;
  }
}

/**
 * 定时任务 · 目标 · 编排 — three of 自动化's five tabs (spec §5.9; redesign 2026-11 stage 1: 运行中 and Bot are the
 * background and Bot pages, features/automation/family.tsx draws the one tab row over all three pages). 新建 at the top
 * right is the tab's own (a schedule, a goal, a workflow). A tab's body is mounted the first time it is shown and
 * only hidden after that — nothing here is unmounted by switching tabs or closing the page (a half-written workflow, a
 * goal form, the scroll position all survive).
 */
export function AutomationPage() {
  const open = useAutomation((s) => s.open);
  const tab = useAutomation((s) => s.tab);
  const seen = useAutomation((s) => s.seen);
  const info = AUTOMATION_TAB_INFO[tab];
  return (
    <OverPage
      name="auto"
      label={AUTOMATION_TITLE}
      open={open}
      onClose={closeAutomation}
      title={AUTOMATION_TITLE}
      desc={info.desc}
      tab={tab}
      tabs={[]}
      showTabs={false}
      onTab={(t) => showAutomationTab(t as AutomationTab)}
      narrow={tab !== 'orchestra'}
      actions={<button className="btn sm primary auto-new" onClick={() => newInAutomation(tab)} data-new={tab}><Icon name="plus" size={13} />{info.newLabel}</button>}
    >
      {seen.map((t) => (
        <div key={t} className={clsx('over-body auto-body', t !== 'orchestra' && 'narrow')} data-body={t} hidden={t !== tab}>
          <ErrorBoundary area={tr('自动化 · {label}', { label: AUTOMATION_TAB_INFO[t].label })}><Body tab={t} /></ErrorBoundary>
        </div>
      ))}
    </OverPage>
  );
}
