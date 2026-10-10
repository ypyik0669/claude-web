import { clsx } from '@/util';
import { useStore } from '@/store';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { OverPage } from '@/features/sections/OverPage';
import { Connectors } from './Connectors';
import { SkillsView } from './SkillsView';
import { PluginsView } from './PluginsView';
import { EXTENSIONS_TITLE, EXTENSION_TAB_INFO, closeExtensions, showExtensionTab, useExtensions, type ExtensionTab } from './state';

import { EXTENSION_NAV as TABS } from './ExtensionsSide';

function Body({ tab }: { tab: ExtensionTab }) {
  switch (tab) {
    case 'connectors': return <Connectors />;
    case 'skills': return <SkillsView />;
    case 'plugins': return <PluginsView />;
  }
}

/**
 * 扩展 (spec 2026-10-10-ui-structure §4): what an Agent can be given beyond the model — 连接器 (MCP servers), Skills,
 * 插件 — as a directory, on a page laid over the main area like 自动化. With the icon rail the three are rows of the
 * section's sidebar; elsewhere the page has them as tabs. The settings pages for the same things stay where they
 * were (the old ids open them) and make the same requests; this page draws them its own way (a mark, a name, one
 * line, one action).
 */
export function ExtensionsPage() {
  const open = useExtensions((s) => s.open);
  const tab = useExtensions((s) => s.tab);
  const seen = useExtensions((s) => s.seen);
  const sideNav = useStore((s) => !s.mobile && s.sidebarOpen);
  const info = EXTENSION_TAB_INFO[tab];
  return (
    <OverPage
      name="ext"
      label={EXTENSIONS_TITLE}
      open={open}
      onClose={closeExtensions}
      title={sideNav ? info.label : EXTENSIONS_TITLE}
      desc={info.desc}
      tab={tab}
      tabs={TABS}
      showTabs={!sideNav}
      onTab={(t) => showExtensionTab(t as ExtensionTab)}
      narrow
    >
      {seen.map((t) => (
        <div key={t} className={clsx('over-body ext-body narrow')} data-body={t} hidden={t !== tab}>
          <ErrorBoundary area={`扩展 · ${EXTENSION_TAB_INFO[t].label}`}><Body tab={t} /></ErrorBoundary>
        </div>
      ))}
    </OverPage>
  );
}
