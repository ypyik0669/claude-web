import { useStore } from '@/store';
import { TopBar } from '@/features/topbar/TopBar';
import { GroupBar } from './GroupBar';
import { PaneLayer } from './PaneLayer';

/** Center column: global top bar + group tabs + the pane tree of the active group. */
export function Workbench() {
  const singleWindow = useStore((s) => !!s.settings['ui.singleWindow']);
  return (
    <div className="center workbench">
      <TopBar />
      {!singleWindow && <GroupBar />}
      <PaneLayer />
    </div>
  );
}
