import type { SessionFeatures } from '@shared';
import type { IconName } from '@/ui/icons';
import { PLUS_ID } from './ids';

/**
 * The per-conversation capabilities (spec §5.4 「+ 菜单」): what used to be the composer's 「功能」 dropdown —
 * Claude in Chrome, Computer Use, coordinator / proactive mode, Brief and channels. They are launch parameters
 * (`SessionFeatures` → CLI flags / env in session-runner's featureArgs / featureEnv): a running conversation keeps
 * the ones it was started with, so there the menu edits what the NEXT new conversation starts with.
 * Pure — the + menu, the tags in the text box and the tests read the same table.
 */

export type FeatureKey = 'chrome' | 'computerUse' | 'coordinator' | 'proactive' | 'brief';

export interface Capability {
  key: FeatureKey;
  label: string;
  /** what it lets Claude do, one line */
  desc: string;
  /** tooltip: the implementation name for people who know it */
  title: string;
  icon: IconName;
  /** 'main' = 这次对话可以…, 'advanced' = 进阶 */
  group: 'main' | 'advanced';
}

export const CAPABILITIES: Capability[] = [
  { key: 'chrome', label: '控制浏览器', desc: '打开网页、点击、填表', title: 'Claude in Chrome（--chrome）', icon: 'browser', group: 'main' },
  { key: 'computerUse', label: '操控电脑', desc: '截图、键盘鼠标', title: 'Computer Use（--computer-use-mcp）', icon: 'machine', group: 'main' },
  { key: 'coordinator', label: '协调者模式', desc: '自己不动手，只派活给子代理', title: '协调者模式（CLAUDE_CODE_COORDINATOR_MODE）', icon: 'orchestra', group: 'advanced' },
  { key: 'proactive', label: '主动模式', desc: '空闲时继续推进', title: '主动模式（--proactive）', icon: 'play', group: 'advanced' },
  { key: 'brief', label: 'Brief', desc: '让 Claude 用简报工具随时告诉你进展', title: 'Brief（--brief，SendUserMessage 工具）', icon: 'chat', group: 'advanced' },
];
export const FEATURE_KEYS = CAPABILITIES.map((c) => c.key);

export const CHANNELS = { label: '频道', desc: '让插件 / MCP 服务器往对话里推消息', title: '频道（--channels），格式 plugin:name@marketplace 或 server:name，逗号分隔', placeholder: 'plugin:name@marketplace, server:name' } as const;

export function withFeature(f: SessionFeatures, key: FeatureKey, on: boolean): SessionFeatures {
  const next = { ...f };
  if (on) next[key] = true;
  else delete next[key];
  return next;
}

export function parseChannels(s: string): string[] {
  return s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

export function withChannels(f: SessionFeatures, list: string[]): SessionFeatures {
  const next = { ...f };
  if (list.length) next.channels = list;
  else delete next.channels;
  return next;
}

/** How many capabilities are on (env is plumbing, not a capability). */
export function featureCount(f: SessionFeatures): number {
  return FEATURE_KEYS.filter((k) => !!f[k]).length + (f.channels?.length ? 1 : 0);
}

export interface CapabilityTag { key: FeatureKey | 'channels'; label: string; icon: IconName; title: string }

/** The small removable tags in the text box, in menu order. */
export function capabilityTags(f: SessionFeatures): CapabilityTag[] {
  const tags: CapabilityTag[] = CAPABILITIES.filter((c) => !!f[c.key]).map((c) => ({ key: c.key, label: c.label, icon: c.icon, title: `${c.label}：${c.desc}（${c.title}）` }));
  if (f.channels?.length) tags.push({ key: 'channels', label: `${CHANNELS.label} ${f.channels.length}`, icon: 'bell', title: `${CHANNELS.label}：${f.channels.join(', ')}` });
  return tags;
}

export function withoutTag(f: SessionFeatures, key: CapabilityTag['key']): SessionFeatures {
  return key === 'channels' ? withChannels(f, []) : withFeature(f, key, false);
}

export interface AttachItem { id: typeof PLUS_ID.files | typeof PLUS_ID.folder | typeof PLUS_ID.reference; label: string; icon: IconName; note?: string; disabled?: string }

/**
 * Under 「这次对话可以…」 in a running conversation: the switches show what it was started with, read-only — the note
 * says where they CAN be changed (「改动在新对话生效」 read as if this menu changed them).
 */
export const LIVE_CAPS_NOTE = '开对话时就定下了，要改请在新对话的 + 里设置';

/**
 * What the + menu shows. `claude` = the conversation runs on Claude (the capabilities are Claude Code flags: the old
 * menu only showed them for Claude); `live` = an already running conversation (the capabilities are fixed there:
 * read-only switches + one note); `remote` = a conversation on another machine (uploads land on THIS disk, out of
 * its reach — images still go inline; goals run on this machine and cannot drive it).
 */
export function plusSections(o: { claude: boolean; live: boolean; remote?: boolean }): { attach: AttachItem[]; capabilities: boolean; readOnly: boolean; note?: string; goal: boolean } {
  const remoteNote = '其它机器上的对话只收图片（文件在本机，那边读不到）';
  return {
    attach: [
      { id: PLUS_ID.files, label: '添加文件或图片', icon: 'attach', note: o.remote ? remoteNote : '或拖进来' },
      { id: PLUS_ID.folder, label: '添加文件夹', icon: 'folder', disabled: o.remote ? remoteNote : undefined },
      { id: PLUS_ID.reference, label: '引用另一个对话', icon: 'quote' },
    ],
    capabilities: o.claude,
    readOnly: o.live,
    note: o.claude && o.live ? LIVE_CAPS_NOTE : undefined,
    goal: !o.remote,
  };
}

/** Every data-id the + menu can render (attachments, capability switches, goal, channels). */
export function plusMenuIds(): string[] {
  const s = plusSections({ claude: true, live: false });
  return [...s.attach.map((a) => a.id), ...FEATURE_KEYS, PLUS_ID.channels, PLUS_ID.goal];
}

/**
 * The capabilities a new conversation starts with live in meta.json (`ui.featureDefaults`: the desktop app's origin
 * changes with its port, localStorage does not survive a restart). Older builds kept them in localStorage
 * `cw.lastFeatures`: taken over once, then that key is dropped.
 */
export const FEATURE_DEFAULTS_KEY = 'ui.featureDefaults';
export const LEGACY_FEATURES_KEY = 'cw.lastFeatures';

const isFeatures = (v: unknown): v is SessionFeatures => !!v && typeof v === 'object' && !Array.isArray(v);

export function migrateFeatureDefaults(stored: unknown, legacy: string | null): { value: SessionFeatures; write: boolean; dropLegacy: boolean } {
  const dropLegacy = legacy !== null;
  if (isFeatures(stored)) return { value: stored, write: false, dropLegacy };
  let parsed: unknown = null;
  try { parsed = legacy ? JSON.parse(legacy) : null; } catch { /* a broken value is dropped */ }
  if (isFeatures(parsed)) return { value: parsed, write: true, dropLegacy };
  return { value: {}, write: false, dropLegacy };
}
