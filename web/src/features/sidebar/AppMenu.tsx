import { Menu } from './menus';
import { runCommand } from '@/features/workbench/commands';
import { modKey } from '@/features/workbench/shortcuts';
import { useNav } from '@/features/workbench/nav-history';
import { useStore } from '@/store';
import { Icon } from '@/ui/icons';
import { tr } from '@/i18n';

/**
 * The brand mark's menu in a browser (the official title bar's application menu; redesign 2026-11 stage 1: the
 * sidebar's brand mark, the rail's ☰ before). The desktop app pops up its native menu instead — it has every item with
 * its accelerator. The same groups, as one menu with headings.
 */
export function AppMenu({ onClose }: { onClose: () => void }) {
  const canBack = useNav((n) => n.back.length > 0);
  const canFwd = useNav((n) => n.forward.length > 0);
  const infoOn = useStore((s) => s.settings['ui.infoPanel'] !== false);
  const run = (id: string) => () => { onClose(); runCommand(id); };
  const edit = (cmd: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => () => { onClose(); document.execCommand(cmd); };
  // the edit rows act on the text box that had the focus: the menu must not take it
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <Menu onClose={onClose} className="app-menu" align="left" prefer="down" label={tr('应用菜单')}>
      <div className="menu-label">{tr('对话')}</div>
      <button data-act="new" onClick={run('new')}><Icon name="edit" size={14} /> {tr('新对话')}<span className="k">Alt N</span></button>
      <button data-act="palette" onClick={run('palette')}><Icon name="search" size={14} /> {tr('搜索对话 / 命令面板')}<span className="k">{modKey} K</span></button>
      <div className="menu-sep" />
      <div className="menu-label">{tr('编辑')}</div>
      <button data-act="undo" onMouseDown={keep} onClick={edit('undo')}><Icon name="undo" size={14} /> {tr('撤销')}<span className="k">{modKey} Z</span></button>
      <button data-act="copy" onMouseDown={keep} onClick={edit('copy')}><Icon name="copy" size={14} /> {tr('复制')}<span className="k">{modKey} C</span></button>
      <button data-act="paste" onMouseDown={keep} onClick={() => { onClose(); void navigator.clipboard?.readText().then((t) => document.execCommand('insertText', false, t)).catch(() => {}); }}><Icon name="clipboard" size={14} /> {tr('粘贴')}<span className="k">{modKey} V</span></button>
      <button data-act="select-all" onMouseDown={keep} onClick={edit('selectAll')}><Icon name="check" size={14} /> {tr('全选')}<span className="k">{modKey} A</span></button>
      <div className="menu-sep" />
      <div className="menu-label">{tr('视图')}</div>
      <button data-act="sidebar" onClick={run('sidebar')}><Icon name="sidebar" size={14} /> {tr('侧栏')}<span className="k">{modKey} B</span></button>
      <button data-act="dock" onClick={run('dock.toggle')}><Icon name="inspector" size={14} /> {tr('右侧面板')}<span className="k">{modKey} J</span></button>
      <button data-act="info" onClick={() => { onClose(); void useStore.getState().setSetting('ui.infoPanel', !infoOn); }}><Icon name="info" size={14} /> {infoOn ? tr('收起对话信息栏') : tr('打开对话信息栏')}</button>
      <button data-act="view" onClick={run('view.cycle')}><Icon name="eye" size={14} /> {tr('切换查看模式')}<span className="k">{modKey} O</span></button>
      <div className="menu-sep" />
      <div className="menu-label">{tr('前往')}</div>
      <button data-act="back" disabled={!canBack} onClick={run('nav.back')}><Icon name="arrowLeft" size={14} /> {tr('后退')}<span className="k">Alt ←</span></button>
      <button data-act="forward" disabled={!canFwd} onClick={run('nav.forward')}><Icon name="arrowRight" size={14} /> {tr('前进')}<span className="k">Alt →</span></button>
      <button data-act="settings" onClick={run('settings')}><Icon name="settings" size={14} /> {tr('设置')}<span className="k">{modKey} ,</span></button>
      <div className="menu-sep" />
      <div className="menu-label">{tr('帮助')}</div>
      <button data-act="shortcuts" onClick={run('shortcuts')}><Icon name="keyboard" size={14} /> {tr('键盘快捷键')}<span className="k">{modKey} /</span></button>
    </Menu>
  );
}
