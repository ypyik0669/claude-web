// The model hub's pages: one page, one job. No second-level tabs and no 高级设置.
import type { IconName } from '@/ui/icons';
import { tr } from '@/i18n';

export type HubPageId =
  | 'overview'
  | 'sources'
  | 'routing'
  | 'usage'
  | 'privacy'
  | 'plugins'
  | 'agents'
  | 'settings';

export interface HubPageDef {
  id: HubPageId;
  label: string;
  icon: IconName;
  title: string;
  desc: string;
}

export const HUB_TITLE = tr('模型');

export const HUB_PAGES: HubPageDef[] = [
  { id: 'overview', label: tr('概览'), icon: 'mission', title: tr('概览'), desc: tr('所有来源、账号与路由的实时状态') },
  { id: 'sources', label: tr('上游'), icon: 'gateway', title: tr('上游'), desc: tr('来源、账号、模型与额度') },
  { id: 'routing', label: tr('路由'), icon: 'orchestra', title: tr('路由'), desc: tr('这一轮为什么去了这个模型') },
  { id: 'usage', label: tr('用量'), icon: 'usage', title: tr('用量'), desc: tr('Token、缓存、费用与额度') },
  { id: 'privacy', label: tr('隐私'), icon: 'shield', title: tr('隐私'), desc: tr('厂商能看到什么，留在这台电脑上') },
  { id: 'plugins', label: tr('插件'), icon: 'puzzle', title: tr('插件'), desc: tr('供应商、中间件、工具与页面') },
  { id: 'agents', label: tr('接入'), icon: 'agent', title: tr('接入'), desc: tr('哪个 Agent 用哪个模型') },
  { id: 'settings', label: tr('设置'), icon: 'config', title: tr('设置'), desc: tr('网关地址、分享、备份与请求记录') },
];

export const hubPage = (id: HubPageId): HubPageDef => HUB_PAGES.find((p) => p.id === id) ?? HUB_PAGES[0];
