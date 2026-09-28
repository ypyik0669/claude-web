import { useStore } from '@/store';
import { chromeVisibility, workbenchOn } from '@/model/layout';
import { clsx } from '@/util';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { AutomationPage } from '@/features/automation/AutomationPage';
import { useAutomation } from '@/features/automation/state';
import { GroupBar } from './GroupBar';
import { PaneLayer } from './PaneLayer';
import { ConnectionBanner } from './ConnectionBanner';

/**
 * Center column: the pane tree of the active group, plus the group bar when there is more than one group or the
 * 「显示工作台工具」 setting is on. There is no global top bar any more — each pane's first row (session header /
 * tab strip) is the top of the window (spec §5.2, §5.10).
 *
 * The automation page (spec §5.9) lies over the panes (not the group bar): once opened it stays mounted and is only
 * hidden, and while it is open the panes under it are inert (no typing into a conversation nobody can see).
 */
export function Workbench() {
  const layout = useStore((s) => s.layout);
  const workbench = useStore((s) => workbenchOn(s.settings));
  const mobile = useStore((s) => s.mobile);
  const autoOpen = useAutomation((s) => s.open);
  const autoSeen = useAutomation((s) => s.seen.length > 0);
  // a phone never gets the group bar / tab strips / rail (spec §5.11): its one row is the conversation header
  const vis = chromeVisibility(layout, { workbench, mobile });
  return (
    <div className={clsx('center workbench', vis.groupBar && 'gb', autoOpen && 'auto-open')}>
      {vis.groupBar && <GroupBar rail={vis.dockRail} />}
      <div className="main-stack">
        <PaneLayer tabStrips={vis.tabStrip} underGroupBar={vis.groupBar} workbench={workbench && !mobile} inert={autoOpen} />
        {autoSeen && <ErrorBoundary area="自动化"><AutomationPage /></ErrorBoundary>}
      </div>
      <ConnectionBanner />
    </div>
  );
}
