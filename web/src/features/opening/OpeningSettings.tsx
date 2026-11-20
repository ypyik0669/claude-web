import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { OpeningGithubOffer, OpeningInfo } from '@shared';
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
import { runCommand } from '@/features/workbench/commands';
import { fillComposer } from '@/features/composer/fill';
import { DEFAULT_PACK, IGNITE_ID, OPACITY_MAX, OPENING_KEYS, isBuiltinId, keepOn, opacityOf, openingCards, packFileUrl, packOf, type OpeningCard } from './model';
import { useOpeningPacks } from './packs';
import { playOpening, type PreviewRequest } from './preview-state';

// the card's little preview brings the opening page generator: its own chunk, fetched on the first hover
const CardPreview = lazy(() => import('./CardPreview'));

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

/** The new pack is chosen at once (自己的视频, 从文件夹导入, 从 GitHub 安装). */
async function chooseNew(p: OpeningInfo, said: string) {
  await useOpeningPacks.getState().load();
  await useStore.getState().setSetting(OPENING_KEYS.pack, p.id);
  useStore.getState().toast(said);
}

/** 自己的视频 / 从文件夹导入. */
async function add(kind: 'openings.addVideo' | 'openings.import', path: string) {
  try {
    const p = await ws.request<OpeningInfo>({ kind, path });
    await chooseNew(p, tr('已添加「{name}」，下次打开时放', { name: p.name }));
  } catch (e) { toastErr(e); }
}

/** WebGL here at all (网吧开门 needs it; without it a start plays 点火). Probed once, its context let go at once. */
let webgl: boolean | undefined;
function webglOk(): boolean {
  if (webgl !== undefined) return webgl;
  try {
    const c = document.createElement('canvas');
    const g = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    g?.getExtension('WEBGL_lose_context')?.loseContext();
    webgl = !!g;
  } catch { webgl = false; }
  return webgl;
}

const dots = (arr: number[][], fill: string) => arr.map(([x, y, r, o], i) => <circle key={i} cx={x} cy={y} r={r} fill={fill} fillOpacity={o} />);

/** The cards' pictures when there is no poster: little stills, always dark like film frames (the proposal's). */
function Still({ kind }: { kind: 'ignite' | 'stars' | 'ascii' | 'cafe' | 'web' }) {
  if (kind === 'ignite') {
    return (
      <svg viewBox="0 0 120 68" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <defs><radialGradient id="op-ig" cx=".6" cy=".5" r=".45"><stop offset="0" stopColor="#ff7a2f" stopOpacity=".6" /><stop offset="1" stopColor="#ff7a2f" stopOpacity="0" /></radialGradient></defs>
        <rect width="120" height="68" fill="#13110e" />
        <rect width="120" height="68" fill="url(#op-ig)" />
        <rect x="45" y="19" width="30" height="30" rx="9" fill="#0b0b0c" stroke="#4a4136" />
        <path d="M50 41V29h7v4h-3v8zM59.5 29h4l-2 12h-4zM65 25h3v16h-3z" fill="#fff" />
        <circle cx="72" cy="35" r="3.4" fill="#ff5a1f" />
        {dots([[84, 24, 1, 0.9], [92, 31, 0.8, 0.7], [88, 45, 1.1, 0.8], [61, 13, 0.7, 0.6], [99, 40, 0.6, 0.6], [79, 54, 0.9, 0.7], [38, 30, 0.7, 0.5], [33, 47, 0.6, 0.4], [102, 21, 0.7, 0.5], [70, 60, 0.6, 0.5]], '#ffb347')}
      </svg>
    );
  }
  if (kind === 'stars') {
    return (
      <svg viewBox="0 0 120 68" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <rect width="120" height="68" fill="#0e0f15" />
        {dots([[8, 9, 0.6, 0.6], [20, 52, 0.5, 0.5], [33, 18, 0.7, 0.7], [96, 12, 0.6, 0.6], [108, 48, 0.6, 0.5], [14, 33, 0.5, 0.5], [101, 60, 0.5, 0.5], [88, 62, 0.4, 0.5], [27, 63, 0.5, 0.4], [112, 26, 0.5, 0.6]], '#efe4cf')}
        <path d="M48 20H72Q76 20 76 24V45Q76 49 72 49H48Q44 49 44 45V24Q44 20 48 20Z" fill="none" stroke="#e9c27a" strokeOpacity=".55" strokeWidth=".8" />
        {dots([[48, 20, 1.1, 1], [60, 20, 1, 1], [72, 20, 1.1, 1], [76, 32, 1, 1], [76, 45, 1, 1], [62, 49, 1.1, 1], [48, 49, 1, 1], [44, 36, 1, 1], [44, 24, 1, 1]], '#fff3d8')}
        <circle cx="70" cy="37" r="2.6" fill="#ff5a1f" />
      </svg>
    );
  }
  if (kind === 'ascii') {
    return (
      <svg viewBox="0 0 120 68" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <rect width="120" height="68" fill="#100f0d" />
        <g fontFamily="monospace" fontSize="5.5" fill="#c99a52" fillOpacity=".5"><text x="4" y="9">{'{ } = 0 1 ; # / < >'}</text><text x="70" y="15">+ * % 1 0 ;</text><text x="2" y="62">a b = 0x1f / *</text><text x="78" y="66">{'} ; 0 1 #'}</text><text x="6" y="36">01</text><text x="104" y="40">{'=>'}</text></g>
        <g fontFamily="monospace" fontSize="6.5" fill="#6a6156"><text x="44" y="25">▓▓▓▓▓▓</text><text x="44" y="32">▓▓▓▓▓▓</text><text x="44" y="39">▓▓▓▓▓▓</text><text x="44" y="46">▓▓▓▓▓▓</text></g>
        <g fontFamily="monospace" fontSize="6.5" fill="#f3eee6"><text x="48" y="32">█ █ █</text><text x="48" y="39">█ █ █</text></g>
        <text x="68" y="39" fontFamily="monospace" fontSize="6.5" fill="#ff5a1f">@</text>
      </svg>
    );
  }
  if (kind === 'cafe') {
    const pcs = [[46, 34], [58, 40], [70, 46], [62, 28], [74, 34], [86, 40]];
    return (
      <svg viewBox="0 0 120 68" preserveAspectRatio="xMidYMid slice" aria-hidden>
        <rect width="120" height="68" fill="#110e1d" />
        <polygon points="16,40 60,18 60,6 16,28" fill="#1b1534" />
        <polygon points="60,18 104,40 104,28 60,6" fill="#221b44" />
        <polygon points="60,18 104,40 60,62 16,40" fill="#261e48" stroke="#5b4aa0" strokeWidth=".6" />
        {pcs.map(([x, y], i) => <g key={i}><polygon points={`${x},${y - 3} ${x + 6},${y} ${x},${y + 3} ${x - 6},${y}`} fill="#5b4aa0" /><rect x={x - 2.5} y={y - 8} width="5" height="4" fill="#38d0ff" fillOpacity=".7" /></g>)}
        <circle cx="80" cy="36" r="11" fill="#ff4fb3" fillOpacity=".18" />
        <circle cx="42" cy="42" r="10" fill="#38d0ff" fillOpacity=".14" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 120 68" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <rect width="120" height="68" fill="#121019" />
      <rect x="30" y="16" width="60" height="36" rx="4" fill="#1c1926" stroke="#3a3550" />
      <path d="M52 28l-6 6 6 6M68 28l6 6-6 6M62 26l-4 16" fill="none" stroke="#d8d2c8" strokeOpacity=".75" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="96" cy="18" r="1.4" fill="#ff5a1f" />
    </svg>
  );
}

/** A card: its picture (a poster or a still), its name and what it is; a little live preview while the pointer rests on it. */
function Card({ c, on, name, sub, thumb, onPick, onRemove }: { c: OpeningCard; on: boolean; name: string; sub: string; thumb: ReactNode; onPick: () => void; onRemove?: () => void }) {
  const [hover, setHover] = useState(false);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!hover) { setLive(false); return; }
    // a pointer passing over the row does not start six of them
    const t = setTimeout(() => setLive(true), 350);
    return () => clearTimeout(t);
  }, [hover]);
  return (
    <div
      className="op-card-wrap"
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(true); }}
      onPointerLeave={() => setHover(false)}
      onFocus={(e) => { if ((e.target as HTMLElement).matches?.(':focus-visible')) setHover(true); }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHover(false); }}
    >
      <button type="button" className="op-card" role="radio" aria-checked={on} data-opening={c.id} onClick={onPick}>
        <span className="th">{thumb}</span>
        <b>{name}</b>
        <small>{sub}</small>
      </button>
      {live && <span className="op-hover" data-preview={c.id} aria-hidden><Suspense fallback={null}><CardPreview card={c} /></Suspense></span>}
      {onRemove && (
        <button type="button" className="op-rm" title={tr('删除')} aria-label={tr('删除开场「{name}」', { name })} onClick={onRemove}>
          <Icon name="close" size={13} />
        </button>
      )}
    </div>
  );
}

/** A pack's name as the card shows it: the built-in one's in the interface's language (its opening.json says 「Claude Web 娘」); the user's as they wrote it. */
const packName = (p: OpeningInfo) => (p.builtin && p.id === DEFAULT_PACK ? tr('Claude Web 娘') : p.name);

const requestFor = (c: OpeningCard | undefined): PreviewRequest =>
  !c ? { kind: 'ignite' } : c.kind === 'video' ? { kind: 'video', pack: c.pack } : c.kind === 'web' ? { kind: 'web', pack: c.pack } : c.kind === 'cafe' ? { kind: 'cafe' } : { kind: c.kind };

/**
 * 开场动画: the cards (Claude Web 娘 · 点火 · 星图 · 字符雨 · 网吧开门 · the user's packs · 自己的视频) and 试放一次.
 * The chosen card is what a start plays (every start by default); a chosen pack that is gone plays 点火.
 */
export function OpeningPicker({ label }: { label: string }) {
  const cur = useStore((s) => packOf(s.settings));
  const set = useStore((s) => s.setSetting);
  const packs = usePacks();
  const cards = openingCards(packs ?? []);
  const known = isBuiltinId(cur) || cards.some((c) => c.id === cur);
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
  const addVideo = async () => { const p = await pickVideo().catch((e) => { toastErr(e); return null; }); if (p) await add('openings.addVideo', p); };
  const describe = (c: OpeningCard): { name: string; sub: string; thumb: ReactNode } => {
    if (c.kind === 'ignite') return { name: tr('点火'), sub: tr('不用视频'), thumb: <Still kind="ignite" /> };
    if (c.kind === 'stars') return { name: tr('星图'), sub: tr('星星连成标志'), thumb: <Still kind="stars" /> };
    if (c.kind === 'ascii') return { name: tr('字符雨'), sub: tr('代码拼成标志'), thumb: <Still kind="ascii" /> };
    if (c.kind === 'cafe') return { name: tr('网吧开门'), sub: webglOk() ? tr('3D，要 WebGL') : tr('这台电脑没有 WebGL，会放点火'), thumb: <Still kind="cafe" /> };
    const p = c.pack;
    const web = c.kind === 'web';
    const sub = p.builtin ? (p.id === DEFAULT_PACK ? tr('默认 · 视频') : web ? tr('网页') : tr('视频'))
      : p.author ? (web ? tr('{author} · 网页', { author: p.author }) : tr('{author} · 视频', { author: p.author }))
      : web ? tr('网页做的开场') : tr('自己的视频');
    const thumb = p.poster ? <img src={appUrl(packFileUrl(p.id, p.poster, authToken()))} alt="" loading="lazy" draggable={false} /> : c.kind === 'web' ? <Still kind="web" /> : <span className="add"><Icon name="play" size={20} /></span>;
    return { name: packName(p), sub, thumb };
  };
  return (
    <div className="op-picker">
      <div className="op-cards" role="radiogroup" aria-label={label}>
        {cards.map((c) => {
          const d = describe(c);
          const pack = c.kind === 'video' || c.kind === 'web' ? c.pack : null;
          return <Card key={c.id} c={c} on={c.id === shown} {...d} onPick={() => pick(c.id)} onRemove={pack && !pack.builtin ? () => void remove(pack) : undefined} />;
        })}
        <button type="button" className="op-card" data-opening="add-video" onClick={() => void addVideo()}>
          <span className="th"><span className="add"><Icon name="plus" size={20} /></span></span>
          <b>{tr('自己的视频')}</b>
          <small>{tr('选一个 mp4 / webm')}</small>
        </button>
      </div>
      <div className="op-tools">
        <button type="button" className="btn sm" data-act="opening-try" onClick={() => playOpening(requestFor(cards.find((x) => x.id === shown)))}><Icon name="play" size={12} />{tr('试放一次')}</button>
        <span className="faint">{tr('桌面版启动时放；鼠标停在卡片上能看小样，点一下或按任意键随时跳过。')}</span>
      </div>
    </div>
  );
}

/** 放完留作背景 + 浓淡 (0–60 %): how much of her loop (or 火星, 星星, 字符) shows through the shell. */
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

/** What 「让 Claude 做一个」 types into a new conversation (the user finishes the sentence). */
export const OPENING_MAKER_PROMPT = tr('用 opening-pack 帮我做一个开场动画：');

/** 让 Claude 做一个: a new conversation, its input holding the ask (the opening-pack skill does the rest). */
export function openOpeningMaker() {
  useStore.setState({ settingsOpen: null });
  runCommand('new');
  setTimeout(() => fillComposer({ text: OPENING_MAKER_PROMPT, focus: true }), 80);
}

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * 从 GitHub 安装: an address → the server reads the pack and keeps its files aside → the user sees who made it and under
 * which licence (the pack's and the repository's), where it is from and what it is → only a yes installs it.
 */
async function installFromGithub() {
  const url = await dlg.prompt(tr('从 GitHub 安装开场动画'), '', {
    message: tr('仓库的地址，或者仓库里放动画包的那个文件夹的地址（里面要有 opening.json）。'),
    placeholder: 'https://github.com/…',
    okLabel: tr('读取'),
  });
  if (!url?.trim()) return;
  let offer: OpeningGithubOffer;
  try { offer = await ws.request<OpeningGithubOffer>({ kind: 'openings.github.inspect', url: url.trim() }); } catch (e) { toastErr(e); return; }
  const i = offer.info;
  const none = tr('（没写）');
  const items = [
    tr('作者：{author}', { author: i.author ?? none }),
    tr('许可：{license}', { license: i.license ?? none }),
    ...(offer.repoLicense && offer.repoLicense !== i.license ? [tr('仓库的许可：{license}', { license: offer.repoLicense })] : []),
    tr('来自：{source}', { source: offer.source }),
    i.kind === 'web' ? tr('网页做的开场：在沙盒里放，不联网，碰不到应用，最多 {s} 秒', { s: i.maxSeconds }) : tr('视频做的开场'),
    tr('大小：{size}', { size: size(offer.bytes) }),
  ];
  const ok = await dlg.confirm(tr('安装开场「{name}」？', { name: i.name }), {
    message: tr('别人的画和代码按它自己的许可用。'),
    items,
    okLabel: tr('安装'),
  });
  if (!ok) { void ws.request({ kind: 'openings.github.cancel', token: offer.token }).catch(() => {}); return; }
  try {
    const p = await ws.request<OpeningInfo>({ kind: 'openings.github.install', token: offer.token });
    await chooseNew(p, tr('已安装「{name}」，下次打开时放', { name: p.name }));
  } catch (e) { toastErr(e); }
}

/** 动画包: a folder with an opening.json (video or web), a GitHub address, or one Claude makes. */
export function OpeningPacks() {
  const importFolder = async () => {
    const p = await pickFolder({ title: tr('选择动画包文件夹') }).catch((e) => { toastErr(e); return null; });
    if (p) await add('openings.import', p);
  };
  return (
    <div className="section opening-packs">
      <h5>{tr('动画包')}</h5>
      <Row label={tr('装别的开场')} hint={tr('视频或网页做的都行：一个文件夹，opening.json 写上名字、作者、许可。视频包和 Claude Web 娘的格式一样（intro 最多放 12 秒，loop 是放完留在后面的循环）；网页包是一个自带一切的 index.html，在沙盒里放、不联网，12 秒还没放完就换成点火。装之前写清作者和许可，别人的画按它自己的许可用。')}>
        <span className="op-btns">
          <button className="btn sm" data-act="opening-import" onClick={() => void importFolder()}><Icon name="folder" size={12} />{tr('从文件夹导入')}</button>
          <button className="btn sm" data-act="opening-github" onClick={() => void installFromGithub()}><Icon name="link" size={12} />{tr('从 GitHub 安装')}</button>
          <button className="btn sm" data-act="opening-make" onClick={openOpeningMaker}><Icon name="sparkle" size={12} />{tr('让 Claude 做一个')}</button>
        </span>
      </Row>
    </div>
  );
}
