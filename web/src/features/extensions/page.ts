// The 自定义 page (structure round 2's 扩展, spec 2026-10-10-ui-structure §4; renamed in the redesign 2026-11 stage 1,
// one of the sidebar's five entries; stage 2: the four tabs of spec #ia 「自定义 · 4 个标签」 — Skills · 连接器 · 插件 ·
// Artifact 类型 — and the settings no longer keep a copy of the first three): its name and its parts. Pure —
// ExtensionsPage.tsx draws it, state.ts opens / closes it (and ui/heading-text.ts reads the titles in node). The ids
// stay `extensions` (meta, tests, scripts).
import type { IconName } from '@/ui/icons';
import type { OverTab } from '@/features/sections/OverPage';
import { tr, trAs } from '@/i18n';

/** The page's title. It is set in the heading face, so ui/heading-text.ts lists it. */
export const EXTENSIONS_TITLE = trAs('自定义', 'Customize');

export const EXTENSION_TABS = ['skills', 'connectors', 'plugins', 'types'] as const;
export type ExtensionTab = (typeof EXTENSION_TABS)[number];

/** Each part: its name (a heading too, where the section's sidebar shows the parts) and one line on what it is for. */
export const EXTENSION_TAB_INFO: Record<ExtensionTab, { label: string; icon: IconName; desc: string }> = {
  skills: { label: 'Skills', icon: 'skill', desc: tr('写好的做事方法：Agent 遇到对应的任务时自己取用') },
  connectors: { label: tr('连接器'), icon: 'mcp', desc: tr('把 GitHub、数据库、浏览器这些外部工具和数据接给 Agent') },
  plugins: { label: tr('插件'), icon: 'artifact', desc: tr('成套的扩展：一次装上命令、Skills、子代理和连接器') },
  types: { label: tr('Artifact 类型'), icon: 'works', desc: tr('Claude 能做成哪几种 Artifact：幻灯片、文档、设计这些，还有你自己加的') },
};

/** The parts as the page's tabs (the sidebar never shows them: it stays the conversation list). */
export const EXTENSION_NAV: OverTab[] = EXTENSION_TABS.map((t) => ({ id: t, label: EXTENSION_TAB_INFO[t].label, icon: EXTENSION_TAB_INFO[t].icon }));
