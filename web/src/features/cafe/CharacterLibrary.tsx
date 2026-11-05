// 角色库 (spec §4): every character — built-in, saved, draft — walking in place; who has which; give one to someone,
// delete one, or make a new one (a new conversation with the cafe-character skill asked for).
import { useEffect, useRef, useState } from 'react';
import type { AssignTarget, CafeAssign, CharacterDef } from '@characters';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import { imeComposing } from '@/ui/ime';
import { runCommand } from '@/features/workbench/commands';
import { fillComposer } from '@/features/composer/fill';
import { bakeCharacter } from './bake';
import { AGENT_NIGHT, closeLibrary, useCafe } from './state';
import { tr } from '@/i18n';

/** Who has a character, in words. */
export function holdersText(id: string, a: CafeAssign): string[] {
  const out: string[] = [];
  if (a.admin === id) out.push(tr('主对话'));
  if (a.default === id) out.push(tr('所有子代理'));
  for (const [k, v] of Object.entries(a.byType ?? {})) if (v === id) out.push(tr('{k} 类子代理', { k }));
  for (const [k, v] of Object.entries(a.byName ?? {})) if (v === id) out.push(tr('叫 {k} 的', { k }));
  return out;
}

export const MAKER_PROMPT = tr('用 cafe-character 帮我做一个网吧角色：');

/** A new conversation, its input holding the ask (the user adds a photo or a description). */
export function openCharacterMaker() {
  closeLibrary();
  runCommand('new');
  setTimeout(() => fillComposer({ text: MAKER_PROMPT, focus: true }), 80);
}

function Walker({ def, tint }: { def: CharacterDef; tint?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current?.getContext('2d');
    if (!c) return;
    let tick = 0;
    const draw = () => {
      const facing = Math.floor(tick / 8) % 2 ? 'ne' : 'se';
      const f = bakeCharacter(def, tint, facing, 'walk', tick);
      c.clearRect(0, 0, 26, 26);
      c.drawImage(f as CanvasImageSource, 0, 0);
      tick++;
    };
    draw();
    const still = document.documentElement.dataset.reduceMotion === '1' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (still) return;
    const t = setInterval(draw, 160);
    return () => clearInterval(t);
  }, [def, tint]);
  return <canvas ref={ref} width={26} height={26} aria-hidden />;
}

function AssignForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [type, setType] = useState('');
  const [name, setName] = useState('');
  const give = async (target: AssignTarget) => {
    try {
      await ws.request({ kind: 'characters.assign', id, target });
      onDone();
    } catch (e: any) { useStore.getState().toast(tr('没能指定：{message}', { message: e?.message ?? e })); }
  };
  const field = (v: string, set: (s: string) => void, ph: string, to: (s: string) => AssignTarget) => (
    <div className="row">
      <input className="field" value={v} placeholder={ph} onChange={(e) => set(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && v.trim()) void give(to(v.trim())); }} />
      <button className="btn sm" disabled={!v.trim()} onClick={() => void give(to(v.trim()))}>{tr('给')}</button>
    </div>
  );
  return (
    <div className="cafe-assign">
      <div className="row">
        <button className="btn sm" onClick={() => void give('admin')}>{tr('主对话')}</button>
        <button className="btn sm" onClick={() => void give('default')}>{tr('所有子代理')}</button>
      </div>
      {field(type, setType, tr('子代理类型，比如 Explore'), (s) => `type:${s}`)}
      {field(name, setName, tr('名字，比如 researcher'), (s) => `name:${s}`)}
    </div>
  );
}

export function CharacterLibrary() {
  const open = useCafe((s) => s.library);
  const list = useCafe((s) => s.list);
  const assign = useCafe((s) => s.assign);
  const [giving, setGiving] = useState<string | null>(null);
  if (!open) return null;
  const remove = async (c: CharacterDef) => {
    if (!(await dlg.confirm(tr('删除角色「{name}」？', { name: c.name }), { message: tr('用它的会换回默认的样子。'), focusCancel: true }))) return;
    await ws.request({ kind: 'characters.delete', id: c.id }).catch(() => {});
  };
  const takeBack = async (id: string) => {
    const a = useCafe.getState().assign;
    const targets: AssignTarget[] = [
      ...(a.admin === id ? ['admin' as const] : []),
      ...(a.default === id ? ['default' as const] : []),
      ...Object.entries(a.byType ?? {}).filter(([, v]) => v === id).map(([k]) => `type:${k}` as AssignTarget),
      ...Object.entries(a.byName ?? {}).filter(([, v]) => v === id).map(([k]) => `name:${k}` as AssignTarget),
    ];
    for (const t of targets) await ws.request({ kind: 'characters.assign', id: null, target: t }).catch(() => {});
  };
  return (
    <div className="modal-bg dialog-bg" onMouseDown={(e) => e.target === e.currentTarget && closeLibrary()} onKeyDown={(e) => { if (e.key === 'Escape' && !imeComposing(e.nativeEvent)) { e.stopPropagation(); closeLibrary(); } }}>
      <div className="modal cafe-lib" role="dialog" aria-label={tr('角色库')}>
        <div className="cafe-lib-head">
          <h3>{tr('角色库')}</h3>
          <button className="btn sm primary" onClick={openCharacterMaker}><Icon name="plus" size={13} /><span className="l">{tr('捏个角色')}</span></button>
          <button className="icon-btn" aria-label={tr('关闭')} title={tr('关闭')} onClick={closeLibrary} autoFocus><Icon name="close" size={16} /></button>
        </div>
        <div className="cafe-lib-grid">
          {list.map((c) => {
            const who = holdersText(c.id, assign);
            return (
              <div key={c.id} className="cafe-card" data-character={c.id}>
                {(c.builtin || c.draft) && <span className="tag">{c.builtin ? tr('内置') : tr('草稿')}</span>}
                <Walker def={c} tint={c.id === 'octopus' ? AGENT_NIGHT[6] : undefined} />
                <div className="n" title={c.id}>{c.name}</div>
                <div className="who">{c.id === 'octopus' && !assign.default ? tr('所有子代理（默认）') : c.id === 'admin' && !assign.admin ? tr('主对话（默认）') : who.join('、') || (c.draft ? tr('还没保存，在对话里说「保存」') : tr('还没给谁'))}</div>
                {!c.builtin && !c.draft && (
                  <div className="acts">
                    <button className="btn sm" aria-expanded={giving === c.id} onClick={() => setGiving(giving === c.id ? null : c.id)}>{tr('给谁用')}</button>
                    {who.length > 0 && <button className="btn sm" onClick={() => void takeBack(c.id)}>{tr('收回')}</button>}
                    <button className="icon-btn sm" aria-label={tr('删除{name}', { name: c.name })} title={tr('删除')} onClick={() => void remove(c)}><Icon name="trash" size={13} /></button>
                  </div>
                )}
                {c.draft && <div className="acts"><button className="icon-btn sm" aria-label={tr('删除{name}', { name: c.name })} title={tr('删除')} onClick={() => void remove(c)}><Icon name="trash" size={13} /></button></div>}
                {giving === c.id && <AssignForm id={c.id} onDone={() => setGiving(null)} />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
