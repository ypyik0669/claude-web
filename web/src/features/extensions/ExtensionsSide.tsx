import type { OverTab } from '@/features/sections/OverPage';
import { SectionSide } from '@/features/sections/SectionSide';
import { EXTENSIONS_TITLE, EXTENSION_TABS, EXTENSION_TAB_INFO, showExtensionTab, useExtensions, type ExtensionTab } from './state';

/** The section's parts, as the sidebar's rows and — where there is no sidebar — the page's tabs. */
export const EXTENSION_NAV: OverTab[] = EXTENSION_TABS.map((t) => ({ id: t, label: EXTENSION_TAB_INFO[t].label, icon: EXTENSION_TAB_INFO[t].icon }));

/**
 * The sidebar column of the 扩展 section. Apart from the page (ExtensionsPage.tsx), which is loaded when it is first
 * opened: this row of three names is part of the app's first file, the directory behind them is not.
 */
export function ExtensionsSide() {
  const tab = useExtensions((s) => s.tab);
  return <SectionSide name="ext" title={EXTENSIONS_TITLE} tab={tab} tabs={EXTENSION_NAV} onTab={(t) => showExtensionTab(t as ExtensionTab)} />;
}
