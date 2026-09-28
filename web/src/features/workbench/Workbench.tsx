import { useStore } from '@/store';
import { chromeVisibility, workbenchOn } from '@/model/layout';
import { clsx } from '@/util';
import { GroupBar } from './GroupBar';
import { PaneLayer } from './PaneLayer';

/**
 * Center column: the pane tree of the active group, plus the group bar when there is more than one group or the
 * 「显示工作台工具」 setting is on. There is no global top bar any more — each pane's first row (session header /
 * tab strip) is the top of the window (spec §5.2, §5.10).
 */
export function Workbench() {
  const layout = useStore((s) => s.layout);
  const workbench = useStore((s) => workbenchOn(s.settings));
  const mobile = useStore((s) => s.mobile);
  // a phone never gets the group bar / tab strips / rail (spec §5.11): its one row is the conversation header
  const vis = chromeVisibility(layout, { workbench, mobile });
  return (
    <div className={clsx('center workbench', vis.groupBar && 'gb')}>
      {vis.groupBar && <GroupBar rail={vis.dockRail} />}
      <PaneLayer tabStrips={vis.tabStrip} underGroupBar={vis.groupBar} workbench={workbench && !mobile} />
    </div>
  );
}
