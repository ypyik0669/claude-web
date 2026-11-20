import { tr } from '@/i18n';

/**
 * The one-time 「东西搬到哪了」 card after the 2026-11 redesign (proposal 风险和对策 · 收尾): someone who used Claude Web
 * before lands on the start page once and sees where the icon bar's things went. Fresh installs never see it (the
 * first-run wizard marks it seen), and it stays dismissed in meta.json (`ui.movedNoticeSeen`).
 */
export const MOVED_NOTICE_KEY = 'ui.movedNoticeSeen';

export interface MovedLine { id: string; from: string; to: string }

/** Where things went, in the order people look for them. The search line differs on phones (no Ctrl K there). */
export function movedLines(mobile: boolean): MovedLine[] {
  return [
    { id: 'rail', from: tr('图标栏'), to: tr('没了：每天用的五个入口在侧栏顶上') },
    { id: 'automation', from: tr('后台、Bot、定时任务、目标、编排'), to: tr('自动化（页面顶上的标签）') },
    { id: 'models', from: tr('模型（来源、路由、用量）'), to: tr('设置 › 模型') },
    { id: 'customize', from: tr('扩展（Skills、连接器、插件）'), to: tr('自定义') },
    { id: 'settings', from: tr('设置、配置中心'), to: mobile ? tr('账号菜单 › 设置；配置中心拆进了自定义和设置') : tr('设置是弹窗了（Ctrl+,）；配置中心拆进了自定义和设置') },
    { id: 'account', from: tr('用量与账本、语言、主题'), to: mobile ? tr('点抽屉底部的头像') : tr('点左下角的头像') },
    { id: 'header', from: tr('Issue 与 PR、Android、对话信息栏'), to: tr('对话头的 ⋯') },
    { id: 'search', from: tr('还是找不到'), to: mobile ? tr('在抽屉顶上的搜索框里用原来的名字搜') : tr('按 Ctrl K 用原来的名字搜') },
  ];
}

/** Shown once, to someone who used Claude Web before this version (onboarded, or has a project), until dismissed. */
export function showMovedNotice(s: { metaLoaded: boolean; seen: boolean; onboarded: boolean; projects: number }): boolean {
  return s.metaLoaded && !s.seen && (s.onboarded || s.projects > 0);
}
