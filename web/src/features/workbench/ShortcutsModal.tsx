import { useStore } from '@/store';
import { SHORTCUTS, keyLabel } from './shortcuts';

export function ShortcutsModal() {
  const open = useStore((s) => s.shortcutsOpen);
  if (!open) return null;
  const close = () => useStore.setState({ shortcutsOpen: false });
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal wide">
        <h3>键盘快捷键</h3>
        <div className="shortcut-groups">
          {groups.map((g) => (
            <div key={g} className="sc-group">
              <h5>{g}</h5>
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <div key={s.id}><span>{s.label}</span><span className="kbd">{keyLabel(s)}</span></div>
              ))}
            </div>
          ))}
        </div>
        <div className="actions"><button className="btn" onClick={close}>关闭</button></div>
      </div>
    </div>
  );
}
