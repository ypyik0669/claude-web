import { useEffect } from 'react';
import type { OpeningInfo } from '@shared';
import { useStore } from '@/store';
import { ws, authToken } from '@/ws/client';
import { desktop } from '@/desktop';
import { appUrl } from '@/util/app-url';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import { pickFolder } from '@/ui/pick-folder';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import { Row } from '@/features/settings/controls';
import { DEFAULT_PACK, IGNITE_ID, OPACITY_MAX, OPENING_KEYS, keepOn, opacityOf, openingCards, packFileUrl, packOf } from './model';
import { useOpeningPacks } from './packs';
import { playOpening } from './preview-state';

const toastErr = (e: unknown) => useStore.getState().toast(e instanceof Error ? e.message : String(e));

function usePacks(): OpeningInfo[] | null {
  const packs = useOpeningPacks((s) => s.list);
  const load = useOpeningPacks((s) => s.load);
  useEffect(() => { if (packs === null) void load(); }, [packs, load]);
  return packs;
}

/** A path on the machine the server runs on: the system's dialog on the desktop, else typed in. */
async function pickVideo(): Promise<string | null> {
  if (desktop?.pickFile) return desktop.pickFile({ title: tr('选择开场视频'), filters: [{ name: tr('视频'), extensions: ['mp4', 'webm', 'mov'] }] });
  const p = await dlg.prompt(tr('视频文件的完整路径'), '', { message: tr('运行 Claude Web 的那台电脑上的一个 mp4 / webm 文件，最多放前 12 秒。') });
  return p?.trim() || null;
}

/** 自己的视频 / 从文件夹导入: the new pack is chosen at once. */
async function add(kind: 'openings.addVideo' | 'openings.import', path: string) {
  try {
    const p = await ws.request<OpeningInfo>({ kind, path });
    await useOpeningPacks.getState().load();
    await useStore.getState().setSetting(OPENING_KEYS.pack, p.id);
    useStore.getState().toast(tr('已添加「{name}」，下次打开时放', { name: p.name }));
  } catch (e) { toastErr(e); }
}

/** 点火's card: the logo in gold on the dark ground, the dot lit, a few sparks (the proposal's thumbnail). */
function IgniteThumb() {
  return (
    <svg viewBox="0 0 120 68" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs><radialGradient id="op-ig" cx=".6" cy=".5" r=".45"><stop offset="0" stopColor="#ff7a2f" stopOpacity=".6" /><stop offset="1" stopColor="#ff7a2f" stopOpacity="0" /></radialGradient></defs>
      <rect width="120" height="68" fill="#13110e" />
      <rect width="120" height="68" fill="url(#op-ig)" />
      <rect x="45" y="19" width="30" height="30" rx="9" fill="#0b0b0c" stroke="#4a4136" />
      <path d="M50 41V29h7v4h-3v8zM59.5 29h4l-2 12h-4zM65 25h3v16h-3z" fill="#fff" />
      <circle cx="72" cy="35" r="3.4" fill="#ff5a1f" />
      {[[84, 24, 1], [92, 31, 0.8], [88, 45, 1.1], [61, 13, 0.7], [99, 40, 0.6], [79, 54, 0.9], [38, 30, 0.7], [33, 47, 0.6], [102, 21, 0.7], [70, 60, 0.6]].map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r} fill="#ffb347" fillOpacity={0.5 + (i % 4) * 0.12} />)}
    </svg>
  );
}

/**
 * 开场动画: the cards (Claude Web 娘 · 点火 · the user's packs · 自己的视频) and 试放一次. The chosen card is what a start
 * plays (每天第一次 by default); a chosen pack that is gone plays 点火.
 */
export function OpeningPicker({ label }: { label: string }) {
  const cur = useStore((s) => packOf(s.settings));
  const set = useStore((s) => s.setSetting);
  const packs = usePacks();
  const cards = openingCards(packs ?? []);
  const known = cur === IGNITE_ID || cards.some((c) => c.id === cur);
  // the chosen one is gone (removed in another window): what a start would play is 点火
  const shown = packs && !known ? IGNITE_ID : cur;
  const pick = (id: string) => { if (id !== cur) void set(OPENING_KEYS.pack, id); };
  const remove = async (p: OpeningInfo) => {
    if (!(await dlg.confirm(tr('删除开场「{name}」？', { name: p.name }), { message: tr('它在数据目录 openings 文件夹里的副本会被删掉，原来的视频或文件夹不受影响。'), okLabel: tr('删除'), danger: true, focusCancel: true }))) return;
    try {
      await ws.request({ kind: 'openings.remove', id: p.id });
      if (cur === p.id) await set(OPENING_KEYS.pack, DEFAULT_PACK);
      await useOpeningPacks.getState().load();
    } catch (e) { toastErr(e); }
  };
  const tryIt = () => {
    const c = cards.find((x) => x.id === shown);
    playOpening(c?.kind === 'video' ? { kind: 'video', pack: c.pack } : { kind: 'ignite' });
  };
  const addVideo = async () => { const p = await pickVideo().catch((e) => { toastErr(e); return null; }); if (p) await add('openings.addVideo', p); };
  return (
    <div className="op-picker">
      <div className="op-cards" role="radiogroup" aria-label={label}>
        {cards.map((c) => {
          const on = c.id === shown;
          const pack = c.kind === 'video' ? c.pack : null;
          const sub = c.kind === 'ignite' ? tr('不用视频') : pack!.builtin ? (pack!.id === DEFAULT_PACK ? tr('默认 · 视频') : tr('视频')) : pack!.author ? tr('{author} · 视频', { author: pack!.author }) : tr('自己的视频');
          return (
            <div key={c.id} className="op-card-wrap">
              <button type="button" className="op-card" role="radio" aria-checked={on} data-opening={c.id} onClick={() => pick(c.id)}>
                <span className="th">
                  {c.kind === 'ignite' ? <IgniteThumb /> : pack!.poster ? <img src={appUrl(packFileUrl(pack!.id, pack!.poster, authToken()))} alt="" loading="lazy" draggable={false} /> : <span className="add"><Icon name="play" size={20} /></span>}
                </span>
                <b>{c.kind === 'ignite' ? tr('点火') : pack!.name}</b>
                <small>{sub}</small>
              </button>
              {pack && !pack.builtin && (
                <button type="button" className="op-rm" title={tr('删除')} aria-label={tr('删除开场「{name}」', { name: pack.name })} onClick={() => void remove(pack)}>
                  <Icon name="close" size={13} />
                </button>
              )}
            </div>
          );
        })}
        <button type="button" className="op-card" data-opening="add-video" onClick={() => void addVideo()}>
          <span className="th"><span className="add"><Icon name="plus" size={20} /></span></span>
          <b>{tr('自己的视频')}</b>
          <small>{tr('选一个 mp4 / webm')}</small>
        </button>
      </div>
      <div className="op-tools">
        <button type="button" className="btn sm" data-act="opening-try" onClick={tryIt}><Icon name="play" size={12} />{tr('试放一次')}</button>
        <span className="faint">{tr('桌面版启动时放；点一下或按任意键随时跳过。')}</span>
      </div>
    </div>
  );
}

/** 放完留作背景 + 浓淡 (0–60 %): how much of her loop (or 火星) shows through the shell. */
export function OpeningKeep({ label }: { label: string }) {
  const on = useStore((s) => keepOn(s.settings));
  const op = useStore((s) => opacityOf(s.settings));
  const set = useStore((s) => s.setSetting);
  return (
    <span className="op-keep">
      <label aria-disabled={!on}>
        {tr('浓淡')}
        <input type="range" min={0} max={OPACITY_MAX} step={1} value={op} disabled={!on} aria-label={tr('背景浓淡')}
          onChange={(e) => void set(OPENING_KEYS.opacity, Number(e.target.value))} />
        <output>{op}%</output>
      </label>
      <button className={clsx('toggle', on && 'on')} role="switch" aria-checked={on} aria-label={label} onClick={() => void set(OPENING_KEYS.keep, !on)} />
    </span>
  );
}

/** 动画包: a folder with an opening.json (the format of the built-in one) is copied in and chosen. */
export function OpeningPacks() {
  const importFolder = async () => {
    const p = await pickFolder({ title: tr('选择动画包文件夹') }).catch((e) => { toastErr(e); return null; });
    if (p) await add('openings.import', p);
  };
  return (
    <div className="section opening-packs">
      <h5>{tr('动画包')}</h5>
      <Row label={tr('装别的开场')} hint={tr('一个文件夹：opening.json 写上名字、作者、许可和视频（intro，最多放 12 秒；loop 是放完留在后面的循环），和 Claude Web 娘的格式一样。别人的画按它自己的许可用。')}>
        <button className="btn sm" data-act="opening-import" onClick={() => void importFolder()}><Icon name="folder" size={12} />{tr('从文件夹导入')}</button>
      </Row>
    </div>
  );
}
