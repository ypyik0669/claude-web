import { Suspense, lazy } from 'react';
import { useStore } from '@/store';
import { chromeVisibility, workbenchOn } from '@/model/layout';
import { clsx } from '@/util';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { AutomationPage } from '@/features/automation/AutomationPage';
import { useAutomation } from '@/features/automation/state';
import { useExtensions } from '@/features/extensions/state';
import { useHub } from '@/features/model-hub/state';
import { useBackground } from '@/features/background/state';
import { useBots } from '@/features/bots/state';
import { usePageOpen } from '@/features/sections';
import { GroupBar } from './GroupBar';
import { PaneLayer } from './PaneLayer';
import { ConnectionBanner } from './ConnectionBanner';
import { tr } from '@/i18n';

// the 扩展 page loads when it is first opened (the directory and its marks are not in the app's first file)
// 后台 too: the office and the graph are not in the app's first file
const BackgroundPage = lazy(() => import('@/features/background/BackgroundPage').then((m) => ({ default: m.BackgroundPage })));
const ExtensionsPage = lazy(() => import('@/features/extensions/ExtensionsPage').then((m) => ({ default: m.ExtensionsPage })));
const BotsPage = lazy(() => import('@/features/bots/BotsPage').then((m) => ({ default: m.BotsPage })));
const ModelHubPage = lazy(() => import('@/features/model-hub/ModelHubPage').then((m) => ({ default: m.ModelHubPage })));

/**
 * Center column: the pane tree of the active group, plus the group bar when there is more than one group or the
 * 「显示工作台工具」 setting is on. There is no global top bar any more — each pane's first row (session header /
 * tab strip) is the top of the window (spec §5.2, §5.10).
 *
 * The pages — 后台 (spec 2026-10-12), 自动化 (spec §5.9), 扩展 (structure round 2) — lie over the panes (not the group bar): once opened one
 * stays mounted and is only hidden, and while one is open the panes under it are inert (no typing into a
 * conversation nobody can see).
 */
export function Workbench() {
  const layout = useStore((s) => s.layout);
  const workbench = useStore((s) => workbenchOn(s.settings));
  const mobile = useStore((s) => s.mobile);
  const autoOpen = usePageOpen();
  const autoSeen = useAutomation((s) => s.seen.length > 0);
  const extSeen = useExtensions((s) => s.seen.length > 0);
  const hubSeen = useHub((s) => s.seen.length > 0);
  const bgSeen = useBackground((s) => s.seen);
  const botsSeen = useBots((s) => s.seen);
  // a phone never gets the group bar / tab strips / rail (spec §5.11): its one row is the conversation header
  const vis = chromeVisibility(layout, { workbench, mobile });
  return (
    <div className={clsx('center workbench', vis.groupBar && 'gb', autoOpen && 'auto-open')}>
      {vis.groupBar && <GroupBar />}
      <div className="main-stack">
        <PaneLayer tabStrips={vis.tabStrip} underGroupBar={vis.groupBar} workbench={workbench && !mobile} inert={autoOpen} />
        {bgSeen && <ErrorBoundary area={tr('后台')}><Suspense fallback={null}><BackgroundPage /></Suspense></ErrorBoundary>}
        {botsSeen && <ErrorBoundary area={tr('Bot')}><Suspense fallback={null}><BotsPage /></Suspense></ErrorBoundary>}
        {autoSeen && <ErrorBoundary area={tr('自动化')}><AutomationPage /></ErrorBoundary>}
        {extSeen && <ErrorBoundary area={tr('扩展')}><Suspense fallback={null}><ExtensionsPage /></Suspense></ErrorBoundary>}
        {hubSeen && <ErrorBoundary area={tr('模型')}><Suspense fallback={null}><ModelHubPage /></Suspense></ErrorBoundary>}
      </div>
      <ConnectionBanner />
    </div>
  );
}
