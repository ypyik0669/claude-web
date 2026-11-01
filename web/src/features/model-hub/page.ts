// The hub's pages (the rail's 用量与隐私 section): one page, one job. No second-level tabs and no 高级设置.
import type { IconName } from '@/ui/icons';
import { tr } from '@/i18n';

export type HubPageId = 'usage' | 'privacy' | 'control' | 'settings';

export interface HubPageDef {
  id: HubPageId;
  label: string;
  icon: IconName;
  title: string;
  desc: string;
}

export const HUB_TITLE = tr('用量与隐私');

export const HUB_PAGES: HubPageDef[] = [
  { id: 'usage', label: tr('用量'), icon: 'usage', title: tr('用量'), desc: tr('Token、缓存与费用') },
  { id: 'privacy', label: tr('隐私'), icon: 'shield', title: tr('隐私'), desc: tr('厂商能看到什么，留在这台电脑上') },
  { id: 'control', label: tr('操控'), icon: 'browser', title: tr('操控'), desc: tr('看正在跑的操控任务、接管、批应用授权') },
  { id: 'settings', label: tr('备份'), icon: 'config', title: tr('备份'), desc: tr('供应商、模型设置和隐私规则的备份与同步') },
];

export const hubPage = (id: HubPageId): HubPageDef => HUB_PAGES.find((p) => p.id === id) ?? HUB_PAGES[0];
