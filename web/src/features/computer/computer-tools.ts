// 操控电脑 as a conversation shows it (server/src/computer: the MCP server agents know as `computer`): a step's verb
// and target, and what its access request puts to the user. Pure.
import type { IconName } from '@/ui/icons';

export const COMPUTER_TOOLS = [
  'request_access', 'list_granted_applications', 'open_application', 'screenshot', 'zoom', 'cursor_position', 'mouse_move',
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up',
  'scroll', 'type', 'key', 'hold_key', 'wait', 'read_clipboard', 'write_clipboard', 'computer_batch',
] as const;
export type ComputerTool = (typeof COMPUTER_TOOLS)[number];

/** `mcp__computer__left_click` → the tool; anything else (another server's `left_click`, a bare name) is not ours. */
export function computerToolOf(name: string): ComputerTool | null {
  const m = /^mcp__computer__(.+)$/.exec(name);
  return m && (COMPUTER_TOOLS as readonly string[]).includes(m[1]) ? (m[1] as ComputerTool) : null;
}

/** The one request the user answers: which applications the agent may control. */
export const isAccessRequest = (toolName: string): boolean => computerToolOf(toolName) === 'request_access';

type Input = Record<string, unknown> | undefined;
const str = (i: Input, k: string) => (typeof i?.[k] === 'string' ? (i[k] as string) : '');
const at = (v: unknown) => (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number') ? `(${Math.round(v[0] as number)}, ${Math.round(v[1] as number)})` : '');
const cut = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
const DIRECTION: Record<string, string> = { up: '向上', down: '向下', left: '向左', right: '向右' };
const CLICKS: Partial<Record<ComputerTool, string>> = { left_click: '点击屏幕:', right_click: '右键点击屏幕:', middle_click: '中键点击屏幕:', double_click: '双击屏幕:', triple_click: '三连击屏幕:' };

export interface ComputerToolLabel { icon: IconName; verb: string; arg: string }

/** A step of the conversation, in words: what was done on the desktop, and where. */
export function computerToolLabel(tool: ComputerTool, input: Input): ComputerToolLabel {
  if (CLICKS[tool]) return { icon: 'cursor', verb: CLICKS[tool]!, arg: at(input?.coordinate) };
  switch (tool) {
    case 'request_access': return { icon: 'shield', verb: '请求操控应用:', arg: names(input?.apps).join('、') };
    case 'list_granted_applications': return { icon: 'machine', verb: '查看已允许操控的应用', arg: '' };
    case 'open_application': return { icon: 'machine', verb: '切到应用:', arg: str(input, 'app') };
    case 'screenshot': return { icon: 'image', verb: '看屏幕', arg: '' };
    case 'zoom': return { icon: 'image', verb: '放大看屏幕的一块', arg: '' };
    case 'cursor_position': return { icon: 'cursor', verb: '看鼠标在哪', arg: '' };
    case 'mouse_move': return { icon: 'cursor', verb: '把鼠标移到:', arg: at(input?.coordinate) };
    case 'left_click_drag': return { icon: 'cursor', verb: '在屏幕上拖动:', arg: [at(input?.start_coordinate), at(input?.coordinate)].filter(Boolean).join(' → ') };
    case 'left_mouse_down': return { icon: 'cursor', verb: '按住鼠标左键', arg: '' };
    case 'left_mouse_up': return { icon: 'cursor', verb: '松开鼠标左键', arg: '' };
    case 'scroll': return { icon: 'cursor', verb: `${DIRECTION[str(input, 'scroll_direction')] ?? ''}滚动屏幕:`, arg: at(input?.coordinate) };
    case 'type': return { icon: 'keyboard', verb: '用键盘输入:', arg: cut(str(input, 'text')) };
    case 'key': return { icon: 'keyboard', verb: '按键:', arg: `${str(input, 'text')}${typeof input?.repeat === 'number' && input.repeat > 1 ? ` × ${input.repeat}` : ''}` };
    case 'hold_key': return { icon: 'keyboard', verb: '按住键:', arg: `${str(input, 'text')}${typeof input?.duration === 'number' ? ` ${input.duration} 秒` : ''}` };
    case 'wait': return { icon: 'machine', verb: '等一会儿', arg: typeof input?.duration === 'number' ? `${input.duration} 秒` : '' };
    case 'read_clipboard': return { icon: 'copy', verb: '读剪贴板', arg: '' };
    case 'write_clipboard': return { icon: 'copy', verb: '写剪贴板:', arg: cut(str(input, 'text')) };
    case 'computer_batch': return { icon: 'machine', verb: '连续操作电脑:', arg: Array.isArray(input?.actions) ? `${input.actions.length} 步` : '' };
    default: return { icon: 'machine', verb: '操作电脑', arg: '' };
  }
}

export interface AccessAsk { apps: string[]; reason: string; extras: string[] }

/** What the access card shows: the applications, the agent's reason, and what else it said it would do. */
export function accessAsk(input: Input): AccessAsk {
  const extras: string[] = [];
  if (input?.clipboardRead === true) extras.push('读剪贴板');
  if (input?.clipboardWrite === true) extras.push('写剪贴板（会替换你复制的内容）');
  if (input?.systemKeyCombos === true) extras.push('按系统快捷键（比如 Alt+Tab、Win 键）');
  return { apps: names(input?.apps), reason: str(input, 'reason').trim(), extras };
}

/** The card's title. */
export function accessTitle(input: Input, agent = 'Claude'): string {
  const apps = names(input?.apps);
  if (apps.length === 1) return `${agent} 想操控这台电脑上的 ${apps[0]}`;
  return apps.length ? `${agent} 想操控这台电脑上的 ${apps.length} 个应用` : `${agent} 想操控这台电脑上的应用`;
}

/** What the user is told the yes means — under the list, before the buttons. */
export const ACCESS_NOTE = '允许后，它可以看整个屏幕的截图，并在这些应用位于最前面时用键盘鼠标操作它们；别的应用和 Claude Web 自己它动不了。只对这一个对话有效，对话结束就收回。';
