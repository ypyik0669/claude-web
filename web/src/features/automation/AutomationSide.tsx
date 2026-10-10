import { Icon } from '@/ui/icons';
import { SectionSide } from '@/features/sections/SectionSide';
import { AUTOMATION_TAB_INFO, AUTOMATION_TITLE, type AutomationTab } from './page';
import { newInAutomation, showAutomationTab, useAutomation } from './state';
import { useAutomationTabs } from './AutomationPage';

/** The sidebar column of the 自动化 section: 定时任务 · 目标 · 编排 as rows, 新建 for the one in front. */
export function AutomationSide() {
  const tab = useAutomation((s) => s.tab);
  const tabs = useAutomationTabs();
  const info = AUTOMATION_TAB_INFO[tab];
  return (
    <SectionSide
      name="auto"
      title={AUTOMATION_TITLE}
      tab={tab}
      tabs={tabs}
      onTab={(t) => showAutomationTab(t as AutomationTab)}
      action={<button className="icon-btn" title={info.newLabel} aria-label={info.newLabel} onClick={() => newInAutomation(tab)}><Icon name="plus" size={16} /></button>}
    />
  );
}
