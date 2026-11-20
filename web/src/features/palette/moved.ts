// Where things moved in the redesign 2026-11, as commands of the palette: each new place, found by its new name and by
// every name it had before (`old`) — someone who still types 后台, 扩展, 模型, 通用 or 配置中心 lands in the right
// place. Stage 1: the icon rail's entries; stage 2: the settings pages that merged or left (4 groups / 14 pages, MCP /
// 插件 / Skills → 自定义, 值班 Bot → 自动化 › Bot › 设置) and the 配置中心 panel, taken apart. Pure data (no store: the
// palette maps a target to what opens it; moved.test.ts checks the table).
// The rail's ··· panels that stayed panels (总览, 共享记忆, Issue 与 PR, Android, 网吧) are the palette's panel commands
// already; their old menu names are their `keywords` there (PANEL_OLD_NAMES).
import type { PanelId } from '@/model/layout';
import type { IconName } from '@/ui/icons';
import type { FamilyTab } from '@/features/automation/page';
import type { ExtensionTab } from '@/features/extensions/page';
import type { HubPageId } from '@/features/model-hub/page';
import { tr } from '@/i18n';

export type MovedTarget =
  | { to: 'automation'; tab: FamilyTab }
  | { to: 'extensions'; tab: ExtensionTab }
  | { to: 'hub'; page: HubPageId }
  | { to: 'artifacts' }
  | { to: 'panel'; panel: PanelId }
  | { to: 'settings'; section: string; tab?: string }
  | { to: 'bots-settings' };

export interface Moved { id: string; label: string; icon: IconName; old: string[]; target: MovedTarget }

export const MOVED: Moved[] = [
  { id: 'go.running', label: tr('自动化 › 运行中'), icon: 'office', old: [tr('后台'), tr('后台任务'), tr('在跑的子代理'), tr('工作流'), tr('后台命令'), tr('网吧')], target: { to: 'automation', tab: 'running' } },
  { id: 'go.schedules', label: tr('自动化 › 定时任务'), icon: 'tasks', old: [tr('定时任务')], target: { to: 'automation', tab: 'schedules' } },
  { id: 'go.bots', label: tr('自动化 › Bot'), icon: 'bot', old: [tr('Bot'), tr('值班'), tr('收件箱')], target: { to: 'automation', tab: 'bots' } },
  { id: 'go.bots.settings', label: tr('自动化 › Bot › 设置'), icon: 'settings', old: [tr('值班 Bot'), tr('Bot 设置'), tr('值班')], target: { to: 'bots-settings' } },
  { id: 'go.goals', label: tr('自动化 › 目标'), icon: 'goals', old: [tr('目标')], target: { to: 'automation', tab: 'goals' } },
  { id: 'go.orchestra', label: tr('自动化 › 编排'), icon: 'orchestra', old: [tr('编排')], target: { to: 'automation', tab: 'orchestra' } },
  { id: 'go.skills', label: tr('自定义 › Skills'), icon: 'skill', old: [tr('扩展'), tr('技能'), tr('Skills 备份')], target: { to: 'extensions', tab: 'skills' } },
  { id: 'go.connectors', label: tr('自定义 › 连接器'), icon: 'mcp', old: [tr('扩展'), 'MCP', tr('MCP 与插件')], target: { to: 'extensions', tab: 'connectors' } },
  { id: 'go.plugins', label: tr('自定义 › 插件'), icon: 'artifact', old: [tr('扩展'), tr('配置中心'), tr('MCP 与插件')], target: { to: 'extensions', tab: 'plugins' } },
  { id: 'go.types', label: tr('自定义 › Artifact 类型'), icon: 'works', old: [tr('Artifact 类型')], target: { to: 'extensions', tab: 'types' } },
  { id: 'go.artifacts', label: 'Artifacts', icon: 'works', old: [tr('生成的文件'), tr('最近所有对话生成的文件')], target: { to: 'artifacts' } },
  { id: 'go.hub', label: tr('模型看板 › 概览'), icon: 'gateway', old: [tr('模型'), tr('网关')], target: { to: 'hub', page: 'overview' } },
  { id: 'go.hub.sources', label: tr('模型看板 › 上游'), icon: 'gateway', old: [tr('模型'), tr('来源'), tr('账号')], target: { to: 'hub', page: 'sources' } },
  { id: 'go.hub.routing', label: tr('模型看板 › 路由'), icon: 'orchestra', old: [tr('模型'), tr('路由')], target: { to: 'hub', page: 'routing' } },
  { id: 'go.hub.usage', label: tr('模型看板 › 用量'), icon: 'usage', old: [tr('模型'), tr('用量')], target: { to: 'hub', page: 'usage' } },
  // the settings pages that merged (stage 2): by the names they had
  { id: 'go.settings.model', label: tr('设置 › 模型'), icon: 'cloud', old: [tr('模型'), tr('供应商'), tr('模型网关'), tr('模型与智能程度')], target: { to: 'settings', section: 'model' } },
  { id: 'go.settings.conversation', label: tr('设置 › 对话'), icon: 'chat', old: [tr('通用')], target: { to: 'settings', section: 'conversation' } },
  { id: 'go.settings.window', label: tr('设置 › 通知与窗口'), icon: 'bell', old: [tr('通用'), tr('通知'), tr('托盘')], target: { to: 'settings', section: 'window' } },
  { id: 'go.settings.remote', label: tr('设置 › 手机与远程'), icon: 'device', old: [tr('手机与其它电脑'), tr('IM 机器人'), tr('其它电脑')], target: { to: 'settings', section: 'remote' } },
  { id: 'go.memory', label: tr('设置 › 记忆与对话库'), icon: 'memory', old: [tr('共享记忆'), tr('记忆'), tr('对话库')], target: { to: 'settings', section: 'memory' } },
  { id: 'go.settings.secrets', label: tr('设置 › 隐私与密钥'), icon: 'lock', old: [tr('密钥'), tr('隐私')], target: { to: 'settings', section: 'secrets' } },
  // 配置中心 (a right-panel panel until stage 2): its 插件 / MCP / Skills are 自定义's (above), the rest is 设置 › 高级
  { id: 'go.settings.hooks', label: tr('设置 › Hooks 与 settings.json'), icon: 'bolt', old: [tr('配置中心'), 'Hooks', 'settings.json'], target: { to: 'settings', section: 'hooks' } },
  { id: 'go.settings.env', label: tr('设置 › 环境变量'), icon: 'config', old: [tr('配置中心'), tr('供应商 / 环境')], target: { to: 'settings', section: 'env' } },
  { id: 'go.settings.diagnostics', label: tr('设置 › 诊断与更新'), icon: 'refresh', old: [tr('诊断'), tr('更新'), tr('CLI 工具')], target: { to: 'settings', section: 'diagnostics' } },
];

/** The rail's ··· names of the panels that stayed panels (the palette's panel commands carry them as keywords). */
export const PANEL_OLD_NAMES: Partial<Record<PanelId, string[]>> = {
  usage: [tr('用量与账本'), tr('账本')],
  memory: [tr('共享记忆')],
  mission: [tr('总览')],
  cafe: [tr('网吧')],
  board: [tr('Issue 与 PR')],
  android: [tr('Android 屏幕')],
};
