// Single source of truth for keyboard shortcuts: the browser keydown handler, the Electron menu accelerators
// (desktop/src/main.ts mirrors the `desktop` column) and the cheat sheet all read this table.
import { desktop, isDesktop } from '@/desktop';
import { tr } from '@/i18n';

export interface Shortcut { id: string; label: string; desktop: string; browser: string; group: string }

export const SHORTCUTS: Shortcut[] = [
  { id: 'new', label: tr('新对话'), desktop: 'Ctrl+N', browser: 'Alt+N', group: tr('全局') },
  { id: 'palette', label: tr('搜索对话 / 命令面板'), desktop: 'Ctrl+K', browser: 'Ctrl+K', group: tr('全局') },
  { id: 'sidebar', label: tr('收起 / 展开侧栏'), desktop: 'Ctrl+B', browser: 'Ctrl+B', group: tr('全局') },
  // ← →: the conversations brought to the front before / after this one (workbench/nav-history.ts)
  { id: 'nav.back', label: tr('后退（上一个看过的对话）'), desktop: 'Alt+Left', browser: 'Alt+Left', group: tr('全局') },
  { id: 'nav.forward', label: tr('前进'), desktop: 'Alt+Right', browser: 'Alt+Right', group: tr('全局') },
  { id: 'find', label: tr('在对话中查找'), desktop: 'Ctrl+F', browser: 'Ctrl+F', group: tr('全局') },
  // stage E4: the 文件 panel's search (desktop Ctrl+P is already 搜索对话 in the menu)
  { id: 'files.search', label: tr('搜索文件'), desktop: 'Ctrl+Shift+F', browser: 'Alt+P', group: tr('全局') },
  { id: 'shortcuts', label: tr('快捷键速查'), desktop: 'Ctrl+/', browser: 'Ctrl+/', group: tr('全局') },
  // 界面缩放: the desktop shell's own (remembered, every window — desktop/src/zoom.ts); in a browser these keys are the
  // browser's zoom, which `matchBrowserKey` leaves alone
  { id: 'zoom.in', label: tr('放大界面'), desktop: 'Ctrl+=', browser: 'Ctrl+=', group: tr('全局') },
  { id: 'zoom.out', label: tr('缩小界面'), desktop: 'Ctrl+-', browser: 'Ctrl+-', group: tr('全局') },
  { id: 'zoom.reset', label: tr('还原界面大小'), desktop: 'Ctrl+0', browser: 'Ctrl+0', group: tr('全局') },
  { id: 'group.new', label: tr('新分组'), desktop: 'Ctrl+T', browser: 'Alt+T', group: tr('分组') },
  { id: 'group.close', label: tr('关闭分组'), desktop: 'Ctrl+Shift+W', browser: 'Alt+Shift+W', group: tr('分组') },
  { id: 'group.rename', label: tr('重命名分组 / 标签页'), desktop: 'F2', browser: 'F2', group: tr('分组') },
  // Ctrl 1–5 are the right panel's five since redesign 2026-11: the groups moved to Ctrl+Alt (the browser's key already)
  { id: 'group.jump', label: tr('跳到分组 1..9'), desktop: 'Ctrl+Alt+1..9', browser: 'Ctrl+Alt+1..9', group: tr('分组') },
  { id: 'group.next', label: tr('下一个分组'), desktop: 'Ctrl+Tab', browser: 'Alt+PageDown', group: tr('分组') },
  { id: 'group.prev', label: tr('上一个分组'), desktop: 'Ctrl+Shift+Tab', browser: 'Alt+PageUp', group: tr('分组') },
  { id: 'pane.splitRight', label: tr('向右分屏'), desktop: 'Ctrl+D', browser: 'Ctrl+D', group: tr('分屏') },
  { id: 'pane.splitDown', label: tr('向下分屏'), desktop: 'Ctrl+Shift+D', browser: 'Ctrl+Shift+D', group: tr('分屏') },
  { id: 'tile.close', label: tr('关闭标签页（最后一个则关掉这个分屏）'), desktop: 'Ctrl+W', browser: 'Alt+W', group: tr('分屏') },
  { id: 'pane.close', label: tr('关掉聚焦的分屏'), desktop: 'Ctrl+\\', browser: 'Ctrl+\\', group: tr('分屏') },
  { id: 'pane.zoom', label: tr('放大 / 还原分屏'), desktop: 'Ctrl+Shift+Enter', browser: 'Ctrl+Shift+Enter', group: tr('分屏') },
  { id: 'pane.jump', label: tr('跳到分屏 1..6'), desktop: 'Alt+1..6', browser: 'Alt+1..6', group: tr('分屏') },
  { id: 'pane.next', label: tr('下一个分屏'), desktop: 'Ctrl+Alt+→ / Alt+]', browser: 'Ctrl+Alt+→ / Alt+]', group: tr('分屏') },
  { id: 'pane.prev', label: tr('上一个分屏'), desktop: 'Ctrl+Alt+← / Alt+[', browser: 'Ctrl+Alt+← / Alt+[', group: tr('分屏') },
  { id: 'tile.new', label: tr('新标签页'), desktop: 'Ctrl+Shift+T', browser: 'Alt+Shift+T', group: tr('分屏') },
  { id: 'tile.next', label: tr('下一个标签页'), desktop: 'Ctrl+PageDown', browser: 'Alt+.', group: tr('分屏') },
  { id: 'tile.prev', label: tr('上一个标签页'), desktop: 'Ctrl+PageUp', browser: 'Alt+,', group: tr('分屏') },
  { id: 'dock.toggle', label: tr('显示 / 隐藏右侧面板'), desktop: 'Ctrl+J', browser: 'Ctrl+J', group: tr('面板') },
  { id: 'dock.minimize', label: tr('右侧面板收成图标栏'), desktop: 'Ctrl+Shift+J', browser: 'Ctrl+Shift+J', group: tr('面板') },
  { id: 'panel.mission', label: tr('总览（Mission Control）'), desktop: 'Ctrl+Shift+M', browser: 'Ctrl+Shift+M', group: tr('面板') },
  // the right panel's five, in the order of the header's tools and the panel's picker (redesign 2026-11): Ctrl 1–5 in
  // the desktop app (a browser keeps Ctrl+digit for its own tabs: Ctrl+Shift there, and in the desktop app too)
  { id: 'panel.tasks', label: tr('任务'), desktop: 'Ctrl+1', browser: 'Ctrl+Shift+1', group: tr('面板') },
  { id: 'panel.terminal', label: tr('终端'), desktop: 'Ctrl+2 / Ctrl+`', browser: 'Ctrl+Shift+2 / Ctrl+`', group: tr('面板') },
  { id: 'panel.files', label: tr('改动'), desktop: 'Ctrl+3', browser: 'Ctrl+Shift+3', group: tr('面板') },
  { id: 'panel.browser', label: tr('浏览器'), desktop: 'Ctrl+4', browser: 'Ctrl+Shift+4', group: tr('面板') },
  { id: 'panel.explorer', label: tr('文件'), desktop: 'Ctrl+5', browser: 'Ctrl+Shift+5', group: tr('面板') },
  { id: 'info.toggle', label: tr('对话信息栏'), desktop: 'Ctrl+I', browser: 'Ctrl+I', group: tr('面板') },
  { id: 'settings', label: tr('设置（可搜索）'), desktop: 'Ctrl+,', browser: 'Ctrl+,', group: tr('面板') },
  { id: 'panel.usage', label: tr('用量面板'), desktop: tr('命令面板'), browser: tr('命令面板'), group: tr('面板') },
  { id: 'interrupt', label: tr('中断当前轮'), desktop: 'Ctrl+Shift+C / Esc', browser: 'Esc', group: tr('对话') },
  { id: 'close', label: tr('结束当前对话的进程'), desktop: 'Ctrl+Shift+Q', browser: tr('命令面板'), group: tr('对话') },
  { id: 'side', label: tr('旁聊：问一个不进对话的小问题'), desktop: 'Ctrl+;', browser: 'Ctrl+;', group: tr('对话') },
  { id: 'menu.model', label: tr('模型菜单'), desktop: 'Alt+M', browser: 'Alt+M', group: tr('输入') },
  { id: 'menu.effort', label: tr('思考强度菜单'), desktop: 'Ctrl+Shift+E', browser: 'Ctrl+Shift+E', group: tr('输入') },
  { id: 'perm.cycle', label: tr('下一个权限模式（输入框为空时）'), desktop: 'Shift+Tab', browser: 'Shift+Tab', group: tr('输入') },
  { id: 'view.cycle', label: tr('查看模式：普通 / 显示思考 / 详细'), desktop: 'Ctrl+O', browser: 'Ctrl+O', group: tr('对话') },
  { id: 'tab', label: tr('对话 / 步骤视图'), desktop: 'Alt+J', browser: 'Alt+J', group: tr('对话') },
  { id: 'send', label: tr('发送 / 换行'), desktop: 'Enter / Shift+Enter', browser: 'Enter / Shift+Enter', group: tr('输入') },
  { id: 'slash', label: tr('命令补全'), desktop: tr('/ 然后 Tab'), browser: tr('/ 然后 Tab'), group: tr('输入') },
  { id: 'attach', label: tr('添加文件或图片'), desktop: 'Ctrl+U', browser: 'Ctrl+U', group: tr('输入') },
  { id: 'paste', label: tr('粘贴图片 / 长文本成附件'), desktop: 'Ctrl+V', browser: 'Ctrl+V', group: tr('输入') },
];

const isMac = /mac|darwin/i.test(desktop?.platform ?? (typeof navigator !== 'undefined' ? navigator.platform : ''));
/** The desktop menu uses `CmdOrCtrl+…` accelerators, so on macOS the cheat sheet must say Cmd, not Ctrl. */
/** Label of the primary modifier for hints written inline (⌘ on macOS). */
export const modKey = isMac ? '⌘' : 'Ctrl';
/** ← → on the macOS desktop are the menu's ⌘[ ⌘] (Option+← moves by word in text there). */
const MAC_DESKTOP: Record<string, string> = { 'nav.back': 'Cmd+[', 'nav.forward': 'Cmd+]' };
export const keyLabel = (s: Shortcut) => (isDesktop ? (isMac ? MAC_DESKTOP[s.id] ?? s.desktop.replace(/\bCtrl\b/g, 'Cmd') : s.desktop) : s.browser);

// physical key → the character the table means; used when a modifier changed `e.key`
const CODE_KEYS: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Period: '.', Comma: ',', Backquote: '`' };
function codeKey(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^(Digit|Numpad)\d$/.test(code)) return code.slice(-1);
  return CODE_KEYS[code];
}

/** Ctrl(+Shift) 1–5: the right panel's five, the order of the header's tools (model/layout.ts CORE_PANELS). */
export const PANEL_KEYS = ['tasks', 'terminal', 'files', 'browser', 'explorer'] as const;

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
  if (ctrl && !alt && !shift && lower === 'o') return 'view.cycle';
  if (ctrl && !alt && shift && lower === 'e') return 'menu.effort';
  if (alt && !ctrl && !shift && lower === 'm') return 'menu.model';
  if (ctrl && !alt && !shift && (k === ';' || e.code === 'Semicolon')) return 'side';
  if (ctrl && !alt && !shift && lower === 'j') return 'dock.toggle';
  if (ctrl && !alt && shift && lower === 'j') return 'dock.minimize';
  if (ctrl && !alt && shift && lower === 'm') return 'panel.mission';
  if (ctrl && !alt && !shift && lower === 'd') return 'pane.splitRight';
  if (ctrl && !alt && shift && lower === 'd') return 'pane.splitDown';
  if (ctrl && shift && k === 'Enter') return 'pane.zoom';
  if (ctrl && !alt && !shift && (k === '\\' || e.code === 'Backslash')) return 'pane.close';
  // the right panel's five (the desktop app's menu gives Ctrl 1–5 the same: desktop/src/main.ts)
  if (ctrl && shift && !alt && /^[1-5]$/.test(k)) return `panel.${PANEL_KEYS[Number(k) - 1]}`;
  // 对话信息栏 — not in the code editor or the terminal (their own Ctrl+I)
  if (ctrl && !alt && !shift && lower === 'i' && !(e.target as HTMLElement)?.closest?.('.monaco-editor, .xterm')) return 'info.toggle';
  if (ctrl && !alt && !shift && k === ',') return 'settings';
  if (ctrl && !alt && !shift && k === '`') return 'panel.terminal';
  if (ctrl && alt && /^[1-9]$/.test(k)) return `group.jump.${Number(k) - 1}`;
  if (ctrl && alt && k === 'ArrowRight') return 'pane.next';
  if (ctrl && alt && k === 'ArrowLeft') return 'pane.prev';
  if (alt && !ctrl && !shift && lower === 'n') return 'new';
  if (alt && !ctrl && !shift && lower === 'p') return 'files.search';
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
  // not in a text field, the code editor or the terminal: Option+← / Alt+← moves by word there (macOS, editors)
  if (alt && !ctrl && !shift && (k === 'ArrowLeft' || k === 'ArrowRight') && !inField && !(e.target as HTMLElement)?.isContentEditable && !(e.target as HTMLElement)?.closest?.('.monaco-editor, .xterm')) return k === 'ArrowLeft' ? 'nav.back' : 'nav.forward';
  if (k === 'F2') return 'group.rename';
  if (!inField && k === '?') return 'shortcuts';
  // Ctrl+/ (the official key; F1 and ? still work) — but not in the code editor or the terminal, where it is theirs
  if (ctrl && !alt && !shift && (k === '/' || e.code === 'Slash') && !(e.target as HTMLElement)?.closest?.('.monaco-editor, .xterm')) return 'shortcuts';
  return null;
}
