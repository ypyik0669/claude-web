// Single source of truth for keyboard shortcuts: the browser keydown handler, the Electron menu accelerators
// (desktop/src/main.ts mirrors the `desktop` column) and the cheat sheet all read this table.
import { desktop, isDesktop } from '@/desktop';

export interface Shortcut { id: string; label: string; desktop: string; browser: string; group: string }

export const SHORTCUTS: Shortcut[] = [
  { id: 'new', label: '新对话', desktop: 'Ctrl+N', browser: 'Alt+N', group: '全局' },
  { id: 'palette', label: '搜索对话 / 命令面板', desktop: 'Ctrl+K', browser: 'Ctrl+K', group: '全局' },
  { id: 'sidebar', label: '收起 / 展开侧栏', desktop: 'Ctrl+B', browser: 'Ctrl+B', group: '全局' },
  { id: 'find', label: '在对话中查找', desktop: 'Ctrl+F', browser: 'Ctrl+F', group: '全局' },
  { id: 'shortcuts', label: '快捷键速查', desktop: 'F1', browser: '?', group: '全局' },
  { id: 'group.new', label: '新分组', desktop: 'Ctrl+T', browser: 'Alt+T', group: '分组' },
  { id: 'group.close', label: '关闭分组', desktop: 'Ctrl+Shift+W', browser: 'Alt+Shift+W', group: '分组' },
  { id: 'group.rename', label: '重命名分组 / 标签页', desktop: 'F2', browser: 'F2', group: '分组' },
  { id: 'group.jump', label: '跳到分组 1..9', desktop: 'Ctrl+1..9', browser: 'Ctrl+Alt+1..9', group: '分组' },
  { id: 'group.next', label: '下一个分组', desktop: 'Ctrl+Tab', browser: 'Alt+PageDown', group: '分组' },
  { id: 'group.prev', label: '上一个分组', desktop: 'Ctrl+Shift+Tab', browser: 'Alt+PageUp', group: '分组' },
  { id: 'pane.splitRight', label: '向右分屏', desktop: 'Ctrl+D', browser: 'Ctrl+D', group: '分屏' },
  { id: 'pane.splitDown', label: '向下分屏', desktop: 'Ctrl+Shift+D', browser: 'Ctrl+Shift+D', group: '分屏' },
  { id: 'tile.close', label: '关闭标签页（最后一个则关掉这个分屏）', desktop: 'Ctrl+W', browser: 'Alt+W', group: '分屏' },
  { id: 'pane.zoom', label: '放大 / 还原分屏', desktop: 'Ctrl+Shift+Enter', browser: 'Ctrl+Shift+Enter', group: '分屏' },
  { id: 'pane.jump', label: '跳到分屏 1..6', desktop: 'Alt+1..6', browser: 'Alt+1..6', group: '分屏' },
  { id: 'pane.next', label: '下一个分屏', desktop: 'Ctrl+Alt+→ / Alt+]', browser: 'Ctrl+Alt+→ / Alt+]', group: '分屏' },
  { id: 'pane.prev', label: '上一个分屏', desktop: 'Ctrl+Alt+← / Alt+[', browser: 'Ctrl+Alt+← / Alt+[', group: '分屏' },
  { id: 'tile.new', label: '新标签页', desktop: 'Ctrl+Shift+T', browser: 'Alt+Shift+T', group: '分屏' },
  { id: 'tile.next', label: '下一个标签页', desktop: 'Ctrl+PageDown', browser: 'Alt+.', group: '分屏' },
  { id: 'tile.prev', label: '上一个标签页', desktop: 'Ctrl+PageUp', browser: 'Alt+,', group: '分屏' },
  { id: 'dock.toggle', label: '显示 / 隐藏右侧面板', desktop: 'Ctrl+J', browser: 'Ctrl+J', group: '面板' },
  { id: 'dock.minimize', label: '右侧面板收成图标栏', desktop: 'Ctrl+Shift+J', browser: 'Ctrl+Shift+J', group: '面板' },
  { id: 'panel.mission', label: '总览（Mission Control）', desktop: 'Ctrl+Shift+M', browser: 'Ctrl+Shift+M', group: '面板' },
  { id: 'panel.tasks', label: '任务面板', desktop: 'Ctrl+Shift+1', browser: 'Ctrl+Shift+1', group: '面板' },
  { id: 'panel.files', label: '文件改动面板', desktop: 'Ctrl+Shift+2', browser: 'Ctrl+Shift+2', group: '面板' },
  { id: 'panel.usage', label: '用量面板', desktop: 'Ctrl+Shift+3', browser: 'Ctrl+Shift+3', group: '面板' },
  { id: 'settings', label: '设置（可搜索）', desktop: 'Ctrl+,', browser: 'Ctrl+,', group: '面板' },
  { id: 'panel.config', label: '配置中心（右侧面板）', desktop: '命令面板', browser: '命令面板', group: '面板' },
  { id: 'panel.terminal', label: '终端', desktop: 'Ctrl+`', browser: 'Ctrl+`', group: '面板' },
  { id: 'interrupt', label: '中断当前轮', desktop: 'Ctrl+Shift+C / Esc', browser: 'Esc', group: '会话' },
  { id: 'close', label: '结束当前对话的进程', desktop: 'Ctrl+Shift+Q', browser: '命令面板', group: '会话' },
  { id: 'tab', label: '对话 / 步骤视图', desktop: 'Alt+J', browser: 'Alt+J', group: '会话' },
  { id: 'send', label: '发送 / 换行', desktop: 'Enter / Shift+Enter', browser: 'Enter / Shift+Enter', group: '输入' },
  { id: 'slash', label: '命令补全', desktop: '/ 然后 Tab', browser: '/ 然后 Tab', group: '输入' },
  { id: 'paste', label: '粘贴图片 / 长文本成附件', desktop: 'Ctrl+V', browser: 'Ctrl+V', group: '输入' },
];

const isMac = /mac|darwin/i.test(desktop?.platform ?? (typeof navigator !== 'undefined' ? navigator.platform : ''));
/** The desktop menu uses `CmdOrCtrl+…` accelerators, so on macOS the cheat sheet must say Cmd, not Ctrl. */
/** Label of the primary modifier for hints written inline (⌘ on macOS). */
export const modKey = isMac ? '⌘' : 'Ctrl';
export const keyLabel = (s: Shortcut) => (isDesktop ? (isMac ? s.desktop.replace(/Ctrl/g, 'Cmd') : s.desktop) : s.browser);

// physical key → the character the table means; used when a modifier changed `e.key`
const CODE_KEYS: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Period: '.', Comma: ',', Backquote: '`' };
function codeKey(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^(Digit|Numpad)\d$/.test(code)) return code.slice(-1);
  return CODE_KEYS[code];
}

/** Map a browser keydown to a command id (browser column; desktop uses menu accelerators). */
export function matchBrowserKey(e: KeyboardEvent): string | null {
  const ctrl = e.ctrlKey || e.metaKey;
  const alt = e.altKey, shift = e.shiftKey;
  // `e.key` is the produced character: Shift+1 is '!', and on macOS Option+N / Option+1 / Option+[ are
  // '˜' (dead key) / '¡' / '“' — none of which would match. Fall back to the physical key for those.
  const phys = codeKey(e.code);
  // Only when the produced key is not already a plain character, so other layouts (AZERTY…) keep their own letters.
  const plain = e.key.length === 1 && /[a-z0-9[\].,`]/i.test(e.key);
  const k = phys && !plain && (alt || shift) ? phys : e.key;
  const lower = k.toLowerCase();
  const inField = (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.closest?.('.xterm');
  if (ctrl && !alt && !shift && lower === 'k') return 'palette';
  if (ctrl && !alt && !shift && lower === 'b') return 'sidebar';
  if (ctrl && !alt && !shift && lower === 'j') return 'dock.toggle';
  if (ctrl && !alt && shift && lower === 'j') return 'dock.minimize';
  if (ctrl && !alt && shift && lower === 'm') return 'panel.mission';
  if (ctrl && !alt && !shift && lower === 'd') return 'pane.splitRight';
  if (ctrl && !alt && shift && lower === 'd') return 'pane.splitDown';
  if (ctrl && shift && k === 'Enter') return 'pane.zoom';
  if (ctrl && shift && /^[1-5]$/.test(k)) return `panel.${['tasks', 'files', 'usage', 'config', 'terminal'][Number(k) - 1]}`;
  if (ctrl && !alt && !shift && k === ',') return 'settings';
  if (ctrl && !alt && !shift && k === '`') return 'panel.terminal';
  if (ctrl && alt && /^[1-9]$/.test(k)) return `group.jump.${Number(k) - 1}`;
  if (ctrl && alt && k === 'ArrowRight') return 'pane.next';
  if (ctrl && alt && k === 'ArrowLeft') return 'pane.prev';
  if (alt && !ctrl && !shift && lower === 'n') return 'new';
  if (alt && !ctrl && !shift && lower === 't') return 'group.new';
  if (alt && !ctrl && shift && lower === 'w') return 'group.close';
  if (alt && !ctrl && !shift && lower === 'w') return 'tile.close';
  if (alt && !ctrl && shift && lower === 't') return 'tile.new';
  if (alt && !ctrl && !shift && lower === 'j') return 'tab';
  if (alt && !ctrl && k === 'PageDown') return 'group.next';
  if (alt && !ctrl && k === 'PageUp') return 'group.prev';
  if (alt && !ctrl && /^[1-6]$/.test(k)) return `pane.jump.${Number(k) - 1}`;
  if (alt && !ctrl && k === ']') return 'pane.next';
  if (alt && !ctrl && k === '[') return 'pane.prev';
  if (alt && !ctrl && k === '.') return 'tile.next';
  if (alt && !ctrl && k === ',') return 'tile.prev';
  if (k === 'F2') return 'group.rename';
  if (!inField && k === '?') return 'shortcuts';
  return null;
}
