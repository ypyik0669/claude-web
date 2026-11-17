import { useEffect, useRef } from 'react';
import type { SlashCommandInfo } from '@shared';
import { tr, trAs } from '@/i18n';
import { nameParts, type SlashGroupId, type SlashMenuModel } from './slash';
import './slash.css';

/** The group headings and where each row comes from, in the user's words (no word for Claude Code's own). */
function groupTitle(id: SlashGroupId): string {
  return id === 'commands' ? trAs('命令', 'Commands') : id === 'skills' ? tr('技能') : tr('其它');
}
export function sourceLabel(c: SlashCommandInfo): string {
  switch (c.source) {
    case 'user': return tr('个人');
    case 'project': return tr('项目');
    case 'plugin': return c.owner ? tr('插件 · {name}', { name: c.owner }) : tr('插件');
    case 'mcp': return c.owner ? `MCP · ${c.owner}` : 'MCP';
    default: return '';
  }
}

/**
 * The / menu above the box: groups with a small heading, a row each — the name (the typed part in bold), its argument
 * hint, the description cut to one line (the whole of it on hover), where it comes from on the right. The keys stay in
 * the box (Composer's onKey: ↑ ↓ across the groups, Tab / Enter take the row); the mouse hovering a row selects it.
 */
export function SlashMenu({ menu, sel, onPick, onHover }: { menu: SlashMenuModel; sel: number; onPick: (name: string) => void; onHover: (i: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  // the selected row in view (the keys move it past the edge of the list) — the list's own scroll only: scrollIntoView
  // would scroll the panes around the box too. The first row of a group brings its heading along.
  useEffect(() => {
    const b = box.current;
    const el = b?.querySelector<HTMLElement>('[data-sel]');
    if (!b || !el) return;
    const head = el.previousElementSibling?.classList.contains('sm-h') ? el.parentElement : null;
    const top = (head ?? el).offsetTop;
    const bottom = el.offsetTop + el.offsetHeight;
    if (top < b.scrollTop) b.scrollTop = head && head === b.firstElementChild ? 0 : top;
    else if (bottom > b.scrollTop + b.clientHeight) b.scrollTop = bottom - b.clientHeight;
  }, [sel, menu]);
  let i = 0;
  return (
    <div ref={box} className="palette slash-menu" role="listbox" aria-label={tr('斜杠命令')}>
      {menu.groups.map((g) => (
        <div key={g.id} className="sm-group" role="group" aria-label={groupTitle(g.id)} data-group={g.id}>
          <div className="sm-h" aria-hidden>{groupTitle(g.id)}</div>
          {g.items.map((it) => {
            const idx = i++;
            const on = idx === sel;
            const src = sourceLabel(it.cmd);
            const tip = [`/${it.cmd.name}${it.cmd.argumentHint ? ` ${it.cmd.argumentHint}` : ''}`, it.cmd.description, it.cmd.aliases?.length ? it.cmd.aliases.map((a) => `/${a}`).join(' ') : '', src].filter(Boolean).join('\n');
            return (
              <div
                key={it.cmd.name}
                role="option"
                aria-selected={on}
                data-sel={on ? '' : undefined}
                data-cmd={it.cmd.name}
                className={`it${on ? ' sel' : ''}`}
                title={tip}
                onMouseMove={() => { if (!on) onHover(idx); }}
                onMouseDown={(e) => { e.preventDefault(); onPick(it.cmd.name); }}
              >
                <span className="n">
                  /{nameParts(it.cmd.name, it.hit).map((p, k) => (p.hit ? <b key={k}>{p.text}</b> : <span key={k}>{p.text}</span>))}
                  {it.alias && <span className="sm-alias"> /{nameParts(it.alias, it.aliasHit ?? null).map((p, k) => (p.hit ? <b key={k}>{p.text}</b> : <span key={k}>{p.text}</span>))}</span>}
                  {it.cmd.argumentHint && <span className="sm-arg"> {it.cmd.argumentHint}</span>}
                </span>
                <span className="d">{it.cmd.description}</span>
                {src && <span className="sm-src">{src}</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
