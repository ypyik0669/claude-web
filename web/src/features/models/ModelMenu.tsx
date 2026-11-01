import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AgentKind } from '@shared';
import { useStore } from '@/store';
import { ago, clsx } from '@/util';
import { AGENT_ICONS, Icon } from '@/ui/icons';
import { TERMS } from '@/ui/terms';
import { buildModelMenu, filterMenu, foldMenu, pushRecent, recentKey, type ModelMenuItem, type ModelMenuSection } from './menu';
import { refreshAllModels, useRefreshRun } from './data';
import { fmtWindow } from '@/features/info/info-model';
import { placeMenu, samePlacement, withOrigin, type Placement } from './place';
import { MODEL_MENU_ID, SUBAGENT_MENU_ID } from '@/features/composer/ids';
import './models.css';
import { ErrorBoundary } from '@/ui/ErrorBoundary';
import { useMenuClaim } from '@/ui/menus';
import { imeComposing } from '@/ui/ime';
import { useMenuMotion } from '@/ui/menu-motion';
import { ActionSheet, useSheetMenu } from '@/ui/ActionSheet';
import { tr } from '@/i18n';
import { Switch } from '@/ui/Switch';

/** `5 分钟前` / `刚刚` / a date */
export function agoText(t: number): string {
  const a = ago(t);
  return /^\d+ (分钟|小时|天)$/.test(a) ? tr('{a}前', { a }) : a;
}

export interface ModelMenuProps {
  agent: AgentKind;
  current: { providerId?: string; model?: string | null };
  /** false (or a promise of false) = not done (refused, cancelled, failed): the pick is not recorded as recent */
  onPick: (item: ModelMenuItem) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  /** Claude's own model list when it reported one */
  builtin?: { value: string; displayName: string; description?: string }[];
  builtinTitle?: string;
  /** only this profile's entries (a session on another machine can switch models, not profiles) */
  lockProvider?: string;
  lockNote?: string;
  placement?: 'up' | 'down';
  align?: 'left' | 'right';
  /** the element the menu hangs off: the menu is then portalled to <body> with fixed coordinates, so a
   *  pane's `overflow: hidden` cannot clip it, and it opens on whichever side has more room */
  anchor?: RefObject<HTMLElement | null>;
  /**
   * The 子代理 chip's menu (SubagentChip): `lockProvider`'s own models only, a 「跟主模型一样」 row on top, no
   * favourites / recents / default entries, and at the bottom whether new conversations on this provider take it.
   */
  subagent?: SubagentMenuOptions;
  /**
   * The main menu of a Claude conversation: a row at the bottom with the subagents' model that opens the 子代理 menu
   * (2026-10-15: the user looked for it here, in the model menu, and did not see the chip next to it).
   */
  subagentRow?: { label: string; onOpen: () => void };
  /** a row opening the 强度 chip's menu (phase 6 §4: the official menu has Effort › in it) */
  effortRow?: { label: string; onOpen: () => void };
  /** 快速模式: only where the CLI reported it; `note` says why it can't be on now */
  fast?: { on: boolean; note?: string; onToggle: (on: boolean) => void };
}

export interface SubagentMenuOptions {
  /** nothing picked: the subagents run on the main model */
  same: boolean;
  onSame: () => void;
  /** the current pick is this provider's default for new conversations */
  isDefault: boolean;
  onToggleDefault: () => void;
}

/**
 * The flattened `<profile> / <model>` picker. Search box (profile or model name), sections for
 * favourites, recents and each profile (model count, last pull, pull error), a star per row, and at
 * the bottom "refresh every profile's model list" + a link to Settings → Models. Keyboard: ↑ ↓ Enter Esc.
 *
 * On a phone it is an action sheet from the bottom (UI refresh §8, ui/ActionSheet.tsx): the same element and rows,
 * not placed, and the search box does not take the focus (no keyboard coming up over the list).
 */
export function ModelMenu(p: ModelMenuProps) {
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const refresh = useRefreshRun();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  const keyNav = useRef(false); // scroll the active row into view only when the keyboard moved it

  // the menu's natural height (measured once after the first paint): it opens on the side where it fits, else the
  // roomier one — below a composer in the middle of the welcome page, above one at the bottom of a conversation
  const need = useRef<number | undefined>(undefined);
  const placeRef = useRef<(() => void) | null>(null);
  const sheet = useSheetMenu();
  // portalled: follow the anchor — window resizes, scrolling, and layout changes that move it without resizing
  // it (a splitter drag resizes the pane, a growing composer pushes the chip up): observe those boxes too
  useLayoutEffect(() => {
    const a = p.anchor?.current;
    if (!a || sheet) return; // a sheet is not placed
    const place = () => {
      const next = placeMenu(a.getBoundingClientRect(), { vw: window.innerWidth, vh: window.innerHeight }, p.placement ?? 'up', p.align ?? 'right', need.current);
      setPos((cur) => (samePlacement(cur, next) ? cur : next)); // unchanged coordinates: no re-render
    };
    placeRef.current = place;
    // scrolling the menu's own list moves nothing: only scrolls elsewhere can move the anchor
    const onScroll = (e: Event) => { if (!box.current?.contains(e.target as Node)) place(); };
    place();
    const ro = new ResizeObserver(place);
    for (const el of [a, a.closest('.composer'), a.closest('.pane'), document.body]) if (el) ro.observe(el);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); };
  }, [p.anchor, p.placement, p.align, sheet]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!pos || !el) return;
    if (need.current === undefined) {
      const l = list.current;
      need.current = el.offsetHeight - (l ? l.clientHeight - l.scrollHeight : 0);
      placeRef.current?.();
      return;
    }
    // layout numbers, not the bounding box: while it scales in, the box on screen is smaller than the menu
    const left = el.offsetLeft, right = left + el.offsetWidth, vw = window.innerWidth;
    const a = p.anchor?.current?.getBoundingClientRect();
    const moved = left < 8 && pos.right !== undefined ? { ...pos, right: undefined, left: 8 } : right > vw - 8 && pos.left !== undefined ? { ...pos, left: undefined, right: 8 } : null;
    if (moved) setPos(a ? withOrigin(moved, a, vw) : moved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  const sub = !!p.subagent;
  const menu = useMemo(() => {
    const m = buildModelMenu({ agent: p.agent, providers, settings, current: p.current, builtin: p.builtin, builtinTitle: p.builtinTitle });
    if (!p.lockProvider) return m;
    const keep = (s: ModelMenuSection) => ({ ...s, items: s.items.filter((i) => i.providerId === p.lockProvider && !(sub && i.isDefault)) });
    // the 子代理 menu: one model of this provider each, no favourites / recents repeating them
    const own = sub ? m.sections.filter((s) => s.kind === 'builtin' || s.kind === 'provider') : m.sections;
    return { ...m, sections: own.map(keep).filter((s) => s.items.length) };
  }, [p.agent, providers, settings, p.current.providerId, p.current.model, p.builtin, p.builtinTitle, p.lockProvider, sub]);
  // 更多模型 ›: long lists fold after the first few until opened (models/menu.ts foldMenu)
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const shown = useMemo(() => foldMenu(filterMenu(menu, q), opened, q), [menu, q, opened]);
  // keyboard / Enter only walk entries that can be picked (unavailable profiles are shown, not selectable)
  const flat = useMemo(() => shown.sections.flatMap((s) => s.items.filter((it) => !it.unavailable).map((it) => ({ s, it }))), [shown]);

  // open on the current entry (marked, not scrolled to: the list starts at favourites / recents)
  useLayoutEffect(() => {
    const i = flat.findIndex((x) => x.it.current && x.s.kind !== 'favorites' && x.s.kind !== 'recent');
    setActive(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a portalled menu renders on the second pass (after it is measured): focus the search box then — not in a sheet
  // (a phone: the keyboard would come up over the list; the sheet takes the focus itself)
  const mounted = sheet || !p.anchor || !!pos;
  useLayoutEffect(() => { if (mounted && !sheet) input.current?.focus(); }, [mounted]);
  // every change of the query (clearing it too) starts over at the top; not on mount (the current entry is active)
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) { typed.current = true; return; }
    setActive(0);
    if (list.current) list.current.scrollTop = 0;
  }, [q]);
  useEffect(() => {
    if (!keyNav.current) return;
    list.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useEffect(() => {
    // the chip that opened the menu counts as inside: its own click toggles it closed
    const off = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || p.anchor?.current?.contains(t)) return;
      p.onClose();
    };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [p.onClose, p.anchor]);
  // the one anchored menu app-wide; the settings page opening over the app closes it too
  useMenuClaim(() => p.onClose());
  // scales in from the chip, fades out when the pointer closes it (not from the keyboard: UI refresh §4.5)
  const motion = useMenuMotion(() => box.current, [mounted], sheet);

  const pick = async (it: ModelMenuItem) => {
    if (it.unavailable) return;
    p.onClose();
    // recorded only once the pick went through (a confirm dialog may still say no, a switch may fail)
    const done = await p.onPick(it);
    if (done === false || sub) return; // the subagents' model is not a recent pick of the main one
    const st = useStore.getState();
    void st.setSetting('ui.recentModels', pushRecent(st.settings['ui.recentModels'] as string[] | undefined, recentKey(p.agent, it.providerId, it.model)));
  };
  const toggleFav = (it: ModelMenuItem) => {
    const favs = (settings['ui.favoriteModels'] as string[] | undefined) ?? [];
    void setSetting('ui.favoriteModels', favs.includes(it.key) ? favs.filter((k) => k !== it.key) : [...favs, it.key]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (imeComposing(e.nativeEvent)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') keyNav.current = true;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (flat.length ? (i + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
    // Enter picks only from the search box: on a focused star (or the footer buttons) it is that button's click
    else if (e.key === 'Enter' && e.target === input.current) { e.preventDefault(); const x = flat[active]; if (x) void pick(x.it); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.onClose(); }
    // 1–9 with nothing typed yet: that row, like the official menu's numbers (a search starting with a digit is rare)
    else if (/^[1-9]$/.test(e.key) && !q && e.target === input.current && !e.altKey && !e.ctrlKey && !e.metaKey) { const x = flat[Number(e.key) - 1]; if (x) { e.preventDefault(); void pick(x.it); } }
  };

  let idx = -1;
  const portal = !!p.anchor;
  if (portal && !pos && !sheet) return null; // measured in the layout effect before the first paint
  const body = (
    <div ref={box} className={clsx('menu mm', portal ? 'fixed' : [p.placement === 'down' ? 'down' : 'up', p.align === 'left' ? 'left' : 'right'].join(' '))} style={pos ?? undefined} role="dialog" aria-label={sub ? tr('子代理用的模型') : tr('选择模型')} onKeyDown={onKey} {...motion}>
      <div className="mm-search">
        <Icon name="search" size={13} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr('搜索模型或供应商…')} aria-label={tr('搜索模型')} role="combobox" aria-expanded aria-controls="mm-list" aria-activedescendant={flat[active] ? `mm-opt-${active}` : undefined} />
        {q && <button className="icon-btn xs" aria-label={tr('清除')} onClick={() => { setQ(''); input.current?.focus(); }}><Icon name="close" size={11} /></button>}
      </div>
      {p.lockProvider && p.lockNote && <div className="mm-note">{p.lockNote}</div>}
      <div ref={list} className="mm-list" id="mm-list" role="listbox">
        {p.subagent && !q && (
          <div role="option" aria-selected={false} data-id={SUBAGENT_MENU_ID.same} className={clsx('mm-row', 'mm-same', p.subagent.same && 'cur')} onClick={() => { p.onClose(); p.subagent!.onSame(); }} title={tr('子代理和主对话用同一个模型（Claude Code 的默认做法）')}>
            <span className="mm-check">{p.subagent.same && <Icon name="check" size={12} />}</span>
            <span className="mm-label"><span className="m">{tr('跟主模型一样')}</span></span>
          </div>
        )}
        {shown.sections.map((s) => (
          <div key={s.id} className="mm-sec" data-sec={s.id}>
            <div className="mm-head">
              <Icon name={s.kind === 'favorites' ? 'star' : s.kind === 'recent' ? 'refresh' : s.kind === 'builtin' || s.providerType === 'claude-account' ? AGENT_ICONS.claude ?? 'cloud' : 'cloud'} size={11} />
              <span className="t">{s.title}</span>
              {s.providerType && <span className="ty">{s.providerType === 'claude-account' ? tr('Claude 账号') : s.providerType}</span>}
              {s.unavailable && <span className="err off" title={s.unavailable}>{s.unavailable}</span>}
              {s.kind === 'provider' && !s.error && !s.unavailable && <span className="meta">{s.count ? tr('{count} 个模型', { count: s.count }) : tr('未拉取')}{s.modelsAt ? ` · ${agoText(s.modelsAt)}` : ''}</span>}
              {s.error && !s.unavailable && <span className="err" title={s.error}>{tr('拉取失败：{error}', { error: s.error })}</span>}
            </div>
            {s.items.map((it) => {
              const own = it.providerId === 'claude' || sub;
              if (it.unavailable) {
                return (
                  <div key={`${s.id}:${it.key}:${it.isDefault ? 'd' : ''}`} role="option" aria-disabled className={clsx('mm-row', 'off', it.current && 'cur')} title={`${it.label} — ${it.unavailable}`}>
                    <span className="mm-check">{it.current && <Icon name="check" size={12} />}</span>
                    <span className="mm-label">{!own && <span className="p">{it.providerName} / </span>}<span className="m">{it.display}</span>{it.window && <span className="mm-win">{fmtWindow(it.window)}</span>}</span>
                  </div>
                );
              }
              idx++;
              const i = idx;
              return (
                <div key={`${s.id}:${it.key}:${it.isDefault ? 'd' : ''}`} id={`mm-opt-${i}`} data-idx={i} role="option" aria-selected={i === active} className={clsx('mm-row', i === active && 'active', it.current && 'cur')} onMouseMove={() => i !== active && setActive(i)} onClick={() => void pick(it)} title={it.label}>
                  <span className="mm-check">{it.current && <Icon name="check" size={12} />}</span>
                  <span className="mm-label">
                    {!own && <span className="p">{it.providerName} / </span>}
                    <span className="m">{it.display}</span>
                    {it.window && <span className="mm-win">{fmtWindow(it.window)}</span>}
                  </span>
                  {it.profileDefault && !sub && <span className="badge">{tr('默认')}</span>}
                  {it.hint && <span className="mm-hint">{it.hint}</span>}
                  {!q && i < 9 && <span className="mm-num" aria-hidden>{i + 1}</span>}
                  {!it.isDefault && !sub && (
                    <button className={clsx('mm-star', it.favorite && 'on')} aria-label={it.favorite ? tr('取消收藏') : tr('收藏')} title={it.favorite ? tr('取消收藏') : tr('收藏（置顶）')} onClick={(e) => { e.stopPropagation(); toggleFav(it); }}>
                      <Icon name="star" size={12} />
                    </button>
                  )}
                </div>
              );
            })}
            {!!s.more && (
              <div role="option" aria-selected={false} data-id={MODEL_MENU_ID.more} className="mm-row mm-more" onClick={() => { setOpened((o) => new Set([...o, s.id])); input.current?.focus(); }} title={tr('列出这里其余的模型')}>
                <span className="mm-check" />
                <span className="mm-label"><span className="m">{tr('更多模型')}</span></span>
                <span className="mm-num">{s.more}</span>
                <Icon name="chevronRight" size={12} />
              </div>
            )}
          </div>
        ))}
        {!flat.length && <div className="mm-empty">{q ? tr('没有匹配「{q}」的模型', { q }) : tr('没有可选的模型')}</div>}
        {!q && !p.lockProvider && (
          <button type="button" className="mm-add" data-id={MODEL_MENU_ID.addProvider} onClick={() => { p.onClose(); useStore.getState().openSettings({ section: 'providers' }); }} title={tr('加一个 Anthropic 兼容的中转，或自己的 API key')}>
            <Icon name="plus" size={12} /> {tr('添加供应商…')}
          </button>
        )}
      </div>
      {p.subagent && (
        <label className="mm-subdef" data-id={SUBAGENT_MENU_ID.default} title={tr('新开的对话（也包括 IM、定时任务）的子代理都用这里选的，不管主对话用哪个供应商')}>
          <span className="grow">{tr('新对话都这样')}</span>
          <Switch on={p.subagent.isDefault} disabled={p.subagent.same && p.subagent.isDefault} onChange={() => p.subagent!.onToggleDefault()} />
        </label>
      )}
      {p.subagentRow && !p.subagent && (
        <button type="button" className="mm-subrow" data-id={SUBAGENT_MENU_ID.open} onClick={() => { p.onClose(); p.subagentRow!.onOpen(); }} title={tr('主任务用主模型，子代理（Task / 工作流）用这里选的，可以选个便宜的省额度')}>
          <Icon name="agent" size={13} />
          <span className="l">{tr('子代理用的模型')}</span>
          <span className="v">{p.subagentRow.label}</span>
          <Icon name="chevronRight" size={12} />
        </button>
      )}
      {p.effortRow && !p.subagent && (
        <button type="button" className="mm-subrow" data-id={MODEL_MENU_ID.effort} onClick={() => { p.onClose(); p.effortRow!.onOpen(); }}>
          <Icon name="gauge" size={13} />
          <span className="l">{TERMS.effort}</span>
          <span className="v">{p.effortRow.label}</span>
          <Icon name="chevronRight" size={12} />
        </button>
      )}
      {p.fast && !p.subagent && (
        <button type="button" className="mm-subrow mm-fast" data-id={MODEL_MENU_ID.fast} role="menuitemcheckbox" aria-checked={p.fast.on} disabled={!!p.fast.note && !p.fast.on} title={p.fast.note || tr('同一个模型，回答得更快，按更高的价格计费')} onClick={() => p.fast!.onToggle(!p.fast!.on)}>
          <Icon name="bolt" size={13} />
          <span className="l">{tr('快速模式')}</span>
          <span className="v">{p.fast.note ?? ''}</span>
          <span className={clsx('toggle sm', p.fast.on && 'on')} aria-hidden />
        </button>
      )}
      <div className="mm-foot">
        <button data-id={MODEL_MENU_ID.refresh} onClick={() => void refreshAllModels()} disabled={refresh.running} title={tr('拉取每个供应商的模型列表（/v1/models，只列模型，不花 token）')}>
          {refresh.running ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
          {refresh.running ? tr('刷新中 {done}/{total}', { done: refresh.done, total: refresh.total }) : tr('刷新全部模型')}
        </button>
        <span className="grow" />
        <button data-id={MODEL_MENU_ID.manage} onClick={() => { p.onClose(); useStore.getState().openSettings({ section: 'models' }); }}>
          <Icon name="settings" size={13} /> {tr('管理模型与供应商…')}
        </button>
      </div>
    </div>
  );
  if (sheet) return <ActionSheet onClose={() => p.onClose()} tall>{body}</ActionSheet>;
  return portal ? createPortal(body, document.body) : body;
}

/**
 * A composer chip that opens the menu, named after the model (想多深 is the chip next to it, EffortChip). `busy`
 * shows a spinner while a profile switch restarts the session.
 */
export function ModelChip(p: Omit<ModelMenuProps, 'onClose'> & { label: string; title?: string; busy?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const { label, title, busy, disabled, ...menu } = p;
  return (
    <span ref={anchor} className="mm-anchor">
      <button type="button" className={clsx('chip', open && 'active')} title={title ?? label} disabled={disabled} aria-label={tr('模型：{label}', { label })} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {busy && <span className="spinner" />}
        <span className="mm-chip-label">{label}</span>
        <span className="caret"><Icon name="chevronDown" size={10} /></span>
      </button>
      {open && (
        <ErrorBoundary area={tr('模型菜单')} compact onReset={() => setOpen(false)}>
          <ModelMenu {...menu} anchor={anchor} onClose={() => setOpen(false)} />
        </ErrorBoundary>
      )}
    </span>
  );
}
