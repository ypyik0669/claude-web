import { clsx } from '@/util';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { OverPage } from '@/features/sections/OverPage';
import { Connectors } from './Connectors';
import { SkillsView } from './SkillsView';
import { PluginsView } from './PluginsView';
import { ArtifactTypesView } from './ArtifactTypesView';
import { EXTENSIONS_TITLE, EXTENSION_NAV as TABS, EXTENSION_TAB_INFO, closeExtensions, showExtensionTab, useExtensions, type ExtensionTab } from './state';
import { tr } from '@/i18n';

function Body({ tab }: { tab: ExtensionTab }) {
  switch (tab) {
    case 'skills': return <SkillsView />;
    case 'connectors': return <Connectors />;
    case 'plugins': return <PluginsView />;
    case 'types': return <ArtifactTypesView />;
  }
}

/**
 * 自定义 (structure round 2's 扩展, spec 2026-10-10-ui-structure §4): what an Agent can be given beyond the model —
 * Skills, 连接器 (MCP servers), 插件 and Artifact 类型 — as a directory, on a page laid over the main area like 自动化,
 * its parts as tabs (redesign 2026-11 stage 1: the sidebar stays the conversation list). Stage 2: the settings keep no
 * copy of the first three any more (their old ids open these tabs); the page draws them its own way (a mark, a name,
 * one line, one action).
 */
export function ExtensionsPage() {
  const open = useExtensions((s) => s.open);
  const tab = useExtensions((s) => s.tab);
  const seen = useExtensions((s) => s.seen);
  const info = EXTENSION_TAB_INFO[tab];
  return (
    <OverPage
      name="ext"
      label={EXTENSIONS_TITLE}
      open={open}
      onClose={closeExtensions}
      title={EXTENSIONS_TITLE}
      desc={info.desc}
      tab={tab}
      tabs={TABS}
      showTabs
      onTab={(t) => showExtensionTab(t as ExtensionTab)}
      narrow
    >
      {seen.map((t) => (
        <div key={t} className={clsx('over-body ext-body narrow')} data-body={t} hidden={t !== tab}>
          <ErrorBoundary area={tr('自定义 · {label}', { label: EXTENSION_TAB_INFO[t].label })}><Body tab={t} /></ErrorBoundary>
        </div>
      ))}
    </OverPage>
  );
}
