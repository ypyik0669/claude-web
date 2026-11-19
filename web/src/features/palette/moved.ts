// Where the icon rail's entries went (redesign 2026-11 stage 1), as commands of the palette: each new place, found by
// its new name and by every name it had before (`old`) — someone who still types 后台, 扩展 or 模型 lands in the right
// place. Pure data (no store: the palette maps a target to what opens it; moved.test.ts checks the table).
// The rail's ··· panels (总览, 共享记忆, Issue 与 PR, Android, 配置中心, 网吧) are the palette's panel commands already;
// their old menu names are their `keywords` there (PANEL_OLD_NAMES).
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
  | { to: 'settings'; section: string };

export interface Moved { id: string; label: string; icon: IconName; old: string[]; target: MovedTarget }

export const MOVED: Moved[] = [
  { id: 'go.running', label: tr('自动化 › 运行中'), icon: 'office', old: [tr('后台'), tr('后台任务'), tr('在跑的子代理'), tr('工作流'), tr('后台命令'), tr('网吧')], target: { to: 'automation', tab: 'running' } },
  { id: 'go.schedules', label: tr('自动化 › 定时任务'), icon: 'tasks', old: [tr('定时任务')], target: { to: 'automation', tab: 'schedules' } },
  { id: 'go.bots', label: tr('自动化 › Bot'), icon: 'bot', old: [tr('Bot'), tr('值班'), tr('收件箱')], target: { to: 'automation', tab: 'bots' } },
  { id: 'go.goals', label: tr('自动化 › 目标'), icon: 'goals', old: [tr('目标')], target: { to: 'automation', tab: 'goals' } },
  { id: 'go.orchestra', label: tr('自动化 › 编排'), icon: 'orchestra', old: [tr('编排')], target: { to: 'automation', tab: 'orchestra' } },
  { id: 'go.connectors', label: tr('自定义 › 连接器'), icon: 'mcp', old: [tr('扩展'), 'MCP'], target: { to: 'extensions', tab: 'connectors' } },
  { id: 'go.skills', label: tr('自定义 › Skills'), icon: 'skill', old: [tr('扩展'), tr('技能')], target: { to: 'extensions', tab: 'skills' } },
  { id: 'go.plugins', label: tr('自定义 › 插件'), icon: 'artifact', old: [tr('扩展'), tr('配置中心')], target: { to: 'extensions', tab: 'plugins' } },
  { id: 'go.artifacts', label: 'Artifacts', icon: 'works', old: [tr('生成的文件'), tr('最近所有对话生成的文件')], target: { to: 'artifacts' } },
  { id: 'go.hub', label: tr('模型看板 › 概览'), icon: 'gateway', old: [tr('模型'), tr('网关')], target: { to: 'hub', page: 'overview' } },
  { id: 'go.hub.sources', label: tr('模型看板 › 上游'), icon: 'gateway', old: [tr('模型'), tr('来源'), tr('账号')], target: { to: 'hub', page: 'sources' } },
  { id: 'go.hub.routing', label: tr('模型看板 › 路由'), icon: 'orchestra', old: [tr('模型'), tr('路由')], target: { to: 'hub', page: 'routing' } },
  { id: 'go.hub.usage', label: tr('模型看板 › 用量'), icon: 'usage', old: [tr('模型'), tr('用量')], target: { to: 'hub', page: 'usage' } },
  { id: 'go.memory', label: tr('设置 › 共享记忆'), icon: 'memory', old: [tr('共享记忆'), tr('记忆')], target: { to: 'settings', section: 'memory' } },
];

/** The rail's ··· names of the panels that stayed panels (the palette's panel commands carry them as keywords). */
export const PANEL_OLD_NAMES: Partial<Record<PanelId, string[]>> = {
  usage: [tr('用量与账本'), tr('账本')],
  memory: [tr('共享记忆')],
  mission: [tr('总览')],
  cafe: [tr('网吧')],
  board: [tr('Issue 与 PR')],
  android: [tr('Android 屏幕')],
  config: [tr('配置中心')],
};
