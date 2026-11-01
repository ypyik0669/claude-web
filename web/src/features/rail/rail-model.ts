// The icon rail (structure round 2, spec 2026-10-10-ui-structure §2.1): what is on it. Pure — Rail.tsx draws it.
import { PANELS, type PanelId } from '@/model/layout';
import type { IconName } from '@/ui/icons';
import type { Section } from '@/features/sections/pages';
import { tr } from '@/i18n';

/** The sections, top to bottom. `automation` keeps the id the sidebar's row had. */
export const RAIL_SECTIONS: { id: Section; label: string; icon: IconName; tip: string }[] = [
  { id: 'chat', label: tr('对话'), icon: 'chat', tip: tr('对话') },
  { id: 'background', label: tr('后台'), icon: 'office', tip: tr('后台：在跑的子代理、工作流和后台命令') },
  { id: 'automation', label: tr('自动化'), icon: 'tasks', tip: tr('自动化：定时任务、目标、编排') },
  { id: 'gateway', label: tr('用量与隐私'), icon: 'gateway', tip: tr('用量与隐私：用量、隐私、操控、备份') },
  { id: 'extensions', label: tr('扩展'), icon: 'extensions', tip: tr('扩展：连接器、Skills、插件') },
];

/**
 * Behind ···: the panels that are neither a fixed tab of the right panel nor a section — each opens as a temporary
 * tab of the right panel, as before. 目标 / 编排 are the automation section's (and the right panel's own 更多);
 * 详情 follows what was clicked in a conversation.
 */
export const RAIL_MORE: PanelId[] = ['mission', 'cafe', 'usage', 'memory', 'board', 'android', 'config'];

/** What ··· calls each one (the right panel's tab keeps its short title). */
const MORE_LABEL: Partial<Record<PanelId, string>> = { usage: tr('用量与账本'), memory: tr('共享记忆') };
const MORE_HINT: Partial<Record<PanelId, string>> = {
  mission: tr('谁在等你、谁在跑、谁出错了'),
  cafe: tr('子代理在网吧里上机、吃泡面、结账'),
  usage: tr('用了多少、花了多少、缓存命中'),
  memory: tr('各 Agent 共用的决定和约束'),
  board: tr('这个仓库的 Issue 和 PR'),
  android: tr('手机或模拟器的屏幕'),
  config: tr('插件、Hooks、环境变量'),
};

export interface RailPanel { id: PanelId; label: string; hint: string; icon: IconName }

export const railPanel = (id: PanelId): RailPanel => {
  const p = PANELS.find((x) => x.id === id)!;
  return { id, label: MORE_LABEL[id] ?? p.title, hint: MORE_HINT[id] ?? '', icon: p.icon };
};

/** meta.json `settings['ui.railPins']`: the ··· entries pinned onto the rail itself, in the order they were pinned. */
export const RAIL_PINS_KEY = 'ui.railPins';
export const MAX_PINS = 4;

export function readPins(v: unknown): PanelId[] {
  if (!Array.isArray(v)) return [];
  const out: PanelId[] = [];
  for (const x of v) if (typeof x === 'string' && (RAIL_MORE as string[]).includes(x) && !out.includes(x as PanelId)) out.push(x as PanelId);
  return out.slice(0, MAX_PINS);
}

/** Pin / unpin; a fifth pin replaces nothing — it is refused (`null`), the menu says why. */
export function togglePin(pins: PanelId[], id: PanelId): PanelId[] | null {
  if (pins.includes(id)) return pins.filter((x) => x !== id);
  return pins.length >= MAX_PINS ? null : [...pins, id];
}

export const RAIL_WIDTH = 52;
