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
  /** what the machine the server runs on has to offer for it (see `CapabilityEnv`) */
  needs?: keyof CapabilityEnv;
  /** shown under its name where `needs` is not met: why it cannot be turned on there (the row stays, off) */
  unavailable?: string;
}

/** What the server's machine offers (`engine.info`): 操控电脑 is Windows-only for now. Unknown counts as no. */
export interface CapabilityEnv { computer?: boolean }
const NO_ENV: CapabilityEnv = {};

export const CAPABILITIES: Capability[] = [
  // (the built-in browser needs no switch — every conversation has it; this one is the user's own Chrome)
  { key: 'chrome', label: '控制 Chrome', desc: '用你自己的 Chrome（要装 Claude 扩展）', title: 'Claude in Chrome（--chrome）：在你自己的 Chrome 里打开网页、点击、填表，用的是那里登录着的账号。内置浏览器不用开这个', icon: 'browser', group: 'main' },
  // the whole desktop, through our own `computer` MCP server (server/src/computer): which applications is asked of
  // the user every time, in a card of this app. Windows only for now — elsewhere the row says so
  { key: 'computerUse', label: '操控电脑', desc: '看屏幕、用键盘鼠标操作你允许的应用（每次先问你）', title: 'Computer Use：截图、键盘和鼠标操作整台电脑上你允许的应用。只对这一个对话开；要用哪些应用，每次都会先弹出来问你', icon: 'machine', group: 'main', needs: 'computer', unavailable: '目前只支持 Windows（看的是运行 Claude Web 的那台电脑）。上网不用它——搜索、打开网页、点击、截图都在右侧的「浏览器」里' },
  { key: 'coordinator', label: '协调者模式', desc: '自己不动手，只派活给子代理', title: '协调者模式（CLAUDE_CODE_COORDINATOR_MODE）', icon: 'orchestra', group: 'advanced' },
  { key: 'proactive', label: '主动模式', desc: '空闲时继续推进', title: '主动模式（--proactive）', icon: 'play', group: 'advanced' },
  { key: 'brief', label: 'Brief', desc: '让 Claude 用简报工具随时告诉你进展', title: 'Brief（--brief，SendUserMessage 工具）', icon: 'chat', group: 'advanced' },
];
export const FEATURE_KEYS = CAPABILITIES.map((c) => c.key);

/** The rows as this machine has them: `unavailable` only where what the row needs is missing. */
export function capabilitiesFor(env: CapabilityEnv = NO_ENV): Capability[] {
  return CAPABILITIES.map((c) => (c.needs && !env[c.needs] ? c : { ...c, unavailable: undefined }));
}

/** The ones that cannot be on here: a stored default for one is left out (it would start nothing). */
export function unavailableKeys(env: CapabilityEnv = NO_ENV): FeatureKey[] {
  return CAPABILITIES.filter((c) => c.needs && !env[c.needs]).map((c) => c.key);
}

/** Features as they are sent and shown: without what cannot be turned on on this machine. */
export function usable(f: SessionFeatures, env: CapabilityEnv = NO_ENV): SessionFeatures {
  const off = unavailableKeys(env);
  if (!off.some((k) => f[k])) return f;
  const next = { ...f };
  for (const k of off) delete next[k];
  return next;
}

/**
 * Capabilities that are asked for anew for every conversation: after a conversation was started with one, the next
 * new conversation starts without it. 操控电脑 reaches the whole desktop — it is not something to leave switched on.
 */
export const ONE_TIME_KEYS: FeatureKey[] = ['computerUse'];
export function afterStart(f: SessionFeatures): SessionFeatures {
  if (!ONE_TIME_KEYS.some((k) => f[k])) return f;
  const next = { ...f };
  for (const k of ONE_TIME_KEYS) delete next[k];
  return next;
}

export const CHANNELS = { label: '频道', desc: '让插件 / MCP 服务器往对话里推消息', title: '频道（--channels），格式 plugin:name@marketplace 或 server:name，逗号分隔', placeholder: 'plugin:name@marketplace, server:name' } as const;

export function withFeature(f: SessionFeatures, key: FeatureKey, on: boolean, env: CapabilityEnv = NO_ENV): SessionFeatures {
  const next = { ...f };
  if (on && !unavailableKeys(env).includes(key)) next[key] = true;
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
export function featureCount(f: SessionFeatures, env: CapabilityEnv = NO_ENV): number {
  const off = unavailableKeys(env);
  return FEATURE_KEYS.filter((k) => !!f[k] && !off.includes(k)).length + (f.channels?.length ? 1 : 0);
}

export interface CapabilityTag { key: FeatureKey | 'channels'; label: string; icon: IconName; title: string }

/** The small removable tags in the text box, in menu order. */
export function capabilityTags(f: SessionFeatures, env: CapabilityEnv = NO_ENV): CapabilityTag[] {
  const tags: CapabilityTag[] = capabilitiesFor(env).filter((c) => !!f[c.key] && !c.unavailable).map((c) => ({ key: c.key, label: c.label, icon: c.icon, title: `${c.label}：${c.desc}（${c.title}）` }));
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
  // (what cannot be on on this machine is left out where the defaults are read — `usable` — not here: the machine
  // is not known yet when this runs)
  if (isFeatures(stored)) return { value: stored, write: false, dropLegacy };
  let parsed: unknown = null;
  try { parsed = legacy ? JSON.parse(legacy) : null; } catch { /* a broken value is dropped */ }
  if (isFeatures(parsed)) return { value: afterStart(parsed), write: true, dropLegacy };
  return { value: {}, write: false, dropLegacy };
}
