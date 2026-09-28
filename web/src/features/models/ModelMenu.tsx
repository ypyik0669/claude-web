import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AgentKind, EffortLevel } from '@shared';
import { useStore } from '@/store';
import { ago, clsx } from '@/util';
import { AGENT_ICONS, Icon } from '@/ui/icons';
import { TERMS, ULTRACODE } from '@/ui/terms';
import { buildModelMenu, filterMenu, pushRecent, recentKey, type AgentSource, type ModelMenuItem, type ModelMenuSection } from './menu';
import { refreshAllModels, useGatewayStatus, useRefreshRun } from './data';
import { placeMenu, samePlacement, type Placement } from './place';
import { effortCaption, effortSegments } from './intelligence';
import { MODEL_MENU_ID } from '@/features/composer/ids';
import './models.css';
import { ErrorBoundary } from '@/ui/ErrorBoundary';

/** `5 分钟前` / `刚刚` / a date */
export function agoText(t: number): string {
  const a = ago(t);
  return /^\d+ (分钟|小时|天)$/.test(a) ? `${a}前` : a;
}

export interface ModelMenuProps {
  agent: AgentKind;
  current: { providerId?: string; model?: string | null };
  /** false (or a promise of false) = not done (refused, cancelled, failed): the pick is not recorded as recent */
  onPick: (item: ModelMenuItem) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  /** the agent's own model list when it reported one */
  builtin?: { value: string; displayName: string; description?: string }[];
  builtinTitle?: string;
  agentDefault?: string;
  /** only this profile's entries (a session on another machine can switch models, not profiles) */
  lockProvider?: string;
  lockNote?: string;
  placement?: 'up' | 'down';
  align?: 'left' | 'right';
  /** the element the menu hangs off: the menu is then portalled to <body> with fixed coordinates, so a
   *  pane's `overflow: hidden` cannot clip it, and it opens on whichever side has more room */
  anchor?: RefObject<HTMLElement | null>;
  /** 智能程度 at the top (spec §5.5): the levels the current model takes; none → no control (Gemini) */
  intelligence?: { levels: EffortLevel[]; value?: EffortLevel | null; defaultLevel?: EffortLevel; onChange: (l: EffortLevel) => void; disabled?: boolean };
  /** 深度编排 switch — only for models that support it */
  ultracode?: { on: boolean; onChange: (on: boolean) => void; disabled?: boolean };
  /** the other agents as more sections of the flat list (picking one switches agent / hands over) */
  otherAgents?: AgentSource[];
}

/**
 * The flattened `<profile> / <model>` picker. Search box (profile or model name), sections for
 * favourites, recents and each profile (model count, last pull, pull error), a star per row, and at
 * the bottom "refresh every profile's model list" + a link to Settings → Models. Keyboard: ↑ ↓ Enter Esc.
 */
export function ModelMenu(p: ModelMenuProps) {
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const gateway = useGatewayStatus();
  const engine = useStore((s) => s.engine);
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
  // portalled: follow the anchor — window resizes, scrolling, and layout changes that move it without resizing
  // it (a splitter drag resizes the pane, a growing composer pushes the chip up): observe those boxes too
  useLayoutEffect(() => {
    const a = p.anchor?.current;
    if (!a) return;
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
  }, [p.anchor, p.placement, p.align]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!pos || !el) return;
    if (need.current === undefined) {
      const l = list.current;
      need.current = el.offsetHeight - (l ? l.clientHeight - l.scrollHeight : 0);
      placeRef.current?.();
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.left < 8 && pos.right !== undefined) setPos({ ...pos, right: undefined, left: 8 });
    else if (r.right > window.innerWidth - 8 && pos.left !== undefined) setPos({ ...pos, left: undefined, right: 8 });
  }, [pos]);

  const menu = useMemo(() => {
    const m = buildModelMenu({ agent: p.agent, providers, gatewayGroups: gateway.groups, gatewayEnabled: gateway.enabled, engine, settings, current: p.current, builtin: p.builtin, builtinTitle: p.builtinTitle, agentDefault: p.agentDefault, otherAgents: p.lockProvider ? undefined : p.otherAgents });
    if (!p.lockProvider) return m;
    const keep = (s: ModelMenuSection) => ({ ...s, items: s.items.filter((i) => i.providerId === p.lockProvider && !i.agent) });
    return { ...m, sections: m.sections.map(keep).filter((s) => s.items.length) };
  }, [p.agent, providers, gateway, engine, settings, p.current.providerId, p.current.model, p.builtin, p.builtinTitle, p.agentDefault, p.lockProvider, p.otherAgents]);
  const shown = useMemo(() => filterMenu(menu, q), [menu, q]);
  // keyboard / Enter only walk entries that can be picked (unavailable profiles are shown, not selectable)
  const flat = useMemo(() => shown.sections.flatMap((s) => s.items.filter((it) => !it.unavailable).map((it) => ({ s, it }))), [shown]);

  // open on the current entry (marked, not scrolled to: the list starts at favourites / recents)
  useLayoutEffect(() => {
    const i = flat.findIndex((x) => x.it.current && x.s.kind !== 'favorites' && x.s.kind !== 'recent');
    setActive(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a portalled menu renders on the second pass (after it is measured): focus the search box then
  const mounted = !p.anchor || !!pos;
  useLayoutEffect(() => { if (mounted) input.current?.focus(); }, [mounted]);
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

  const pick = async (it: ModelMenuItem) => {
    if (it.unavailable) return;
    p.onClose();
    // recorded only once the pick went through (a confirm dialog may still say no, a switch may fail)
    const done = await p.onPick(it);
    if (done === false) return;
    const st = useStore.getState();
    void st.setSetting('ui.recentModels', pushRecent(st.settings['ui.recentModels'] as string[] | undefined, recentKey(it.agent ?? p.agent, it.providerId, it.model)));
  };
  const toggleFav = (it: ModelMenuItem) => {
    const favs = (settings['ui.favoriteModels'] as string[] | undefined) ?? [];
    void setSetting('ui.favoriteModels', favs.includes(it.key) ? favs.filter((k) => k !== it.key) : [...favs, it.key]);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') keyNav.current = true;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (flat.length ? (i + 1) % flat.length : 0)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0)); }
    // Enter picks only from the search box: on a focused star (or the footer buttons) it is that button's click
    else if (e.key === 'Enter' && e.target === input.current) { e.preventDefault(); const x = flat[active]; if (x) void pick(x.it); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.onClose(); }
  };

  let idx = -1;
  const portal = !!p.anchor;
  if (portal && !pos) return null; // measured in the layout effect before the first paint
  const body = (
    <div ref={box} className={clsx('menu mm', portal ? 'fixed' : [p.placement === 'down' ? 'down' : 'up', p.align === 'left' ? 'left' : 'right'].join(' '))} style={pos ?? undefined} role="dialog" aria-label="选择模型" onKeyDown={onKey}>
      <div className="mm-search">
        <Icon name="search" size={13} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索模型或供应商…" aria-label="搜索模型" role="combobox" aria-expanded aria-controls="mm-list" aria-activedescendant={flat[active] ? `mm-opt-${active}` : undefined} />
        {q && <button className="icon-btn xs" aria-label="清除" onClick={() => { setQ(''); input.current?.focus(); }}><Icon name="close" size={11} /></button>}
      </div>
      {!q && p.intelligence && p.intelligence.levels.length > 0 && (
        <div className="mm-intel" data-id={MODEL_MENU_ID.effort}>
          <div className="mm-intel-h" title={`${TERMS.effort}（effort）：想得越久越稳，也越慢、越费额度`}>{TERMS.effort}</div>
          <div className="mm-seg" role="radiogroup" aria-label={TERMS.effort}>
            {effortSegments(p.intelligence.levels, p.intelligence.value, p.intelligence.defaultLevel).map((s) => (
              <button key={s.level} type="button" role="radio" aria-checked={s.on} data-level={s.level} className={clsx(s.on && 'on')} title={s.title} disabled={p.intelligence!.disabled}
                onClick={() => { if (!s.on || p.intelligence!.value !== s.level) p.intelligence!.onChange(s.level); }}>{s.label}</button>
            ))}
          </div>
          <div className="mm-intel-d">{effortCaption(p.intelligence.value, p.intelligence.defaultLevel)}</div>
        </div>
      )}
      {!q && p.ultracode && (
        <button type="button" className="mm-ultra" data-id={MODEL_MENU_ID.ultracode} role="switch" aria-checked={p.ultracode.on} title={ULTRACODE.title} disabled={p.ultracode.disabled} onClick={() => p.ultracode!.onChange(!p.ultracode!.on)}>
          <Icon name="bolt" size={15} />
          <span className="mm-ultra-t"><span className="l">{ULTRACODE.label}</span><span className="d">{ULTRACODE.desc}</span></span>
          <span className={clsx('toggle sm', p.ultracode.on && 'on')} aria-hidden />
        </button>
      )}
      {p.lockProvider && p.lockNote && <div className="mm-note">{p.lockNote}</div>}
      <div ref={list} className="mm-list" id="mm-list" role="listbox">
        {shown.sections.map((s, si) => (
          <div key={s.id} className={clsx('mm-sec', s.kind === 'agent' && 'agent')} data-sec={s.id}>
            {s.kind === 'agent' && shown.sections[si - 1]?.kind !== 'agent' && <div className="mm-group">{TERMS.agents}</div>}
            <div className="mm-head">
              <Icon name={s.kind === 'favorites' ? 'star' : s.kind === 'recent' ? 'refresh' : s.kind === 'builtin' ? AGENT_ICONS[p.agent] ?? 'agent' : s.kind === 'agent' ? AGENT_ICONS[s.agent ?? ''] ?? 'agent' : s.providerType === 'gateway' ? 'gateway' : 'cloud'} size={11} />
              <span className="t">{s.title}</span>
              {s.providerType && <span className="ty">{s.providerType}</span>}
              {s.unavailable && <span className="err off" title={s.unavailable}>{s.unavailable}</span>}
              {s.kind === 'provider' && !s.error && !s.unavailable && <span className="meta">{s.count ? `${s.count} 个模型` : '未拉取'}{s.modelsAt ? ` · ${agoText(s.modelsAt)}` : ''}</span>}
              {s.error && !s.unavailable && <span className="err" title={s.error}>拉取失败：{s.error}</span>}
            </div>
            {s.items.map((it) => {
              const own = it.providerId === 'claude';
              if (it.unavailable) {
                return (
                  <div key={`${s.id}:${it.key}:${it.isDefault ? 'd' : ''}`} role="option" aria-disabled className={clsx('mm-row', 'off', it.current && 'cur')} title={`${it.label} — ${it.unavailable}`}>
                    <span className="mm-check">{it.current && <Icon name="check" size={12} />}</span>
                    <span className="mm-label">{!own && <span className="p">{it.providerName} / </span>}<span className="m">{it.display}</span></span>
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
                  </span>
                  {it.profileDefault && <span className="badge">默认</span>}
                  {it.hint && <span className="mm-hint">{it.hint}</span>}
                  {!it.isDefault && !it.agent && (
                    <button className={clsx('mm-star', it.favorite && 'on')} aria-label={it.favorite ? '取消收藏' : '收藏'} title={it.favorite ? '取消收藏' : '收藏（置顶）'} onClick={(e) => { e.stopPropagation(); toggleFav(it); }}>
                      <Icon name="star" size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {!flat.length && <div className="mm-empty">{q ? `没有匹配「${q}」的模型` : '没有可选的模型'}</div>}
        {!q && !p.lockProvider && (
          <button type="button" className="mm-add" data-id={MODEL_MENU_ID.addProvider} onClick={() => { p.onClose(); useStore.getState().openSettings({ section: 'providers' }); }} title="加一个中转 / 自己的 API key（Anthropic、OpenAI、Gemini、Grok 兼容）">
            <Icon name="plus" size={12} /> 添加供应商…
          </button>
        )}
      </div>
      <div className="mm-foot">
        <button data-id={MODEL_MENU_ID.refresh} onClick={() => void refreshAllModels()} disabled={refresh.running} title="拉取每个供应商的模型列表（/v1/models，只列模型，不花 token）">
          {refresh.running ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
          {refresh.running ? `刷新中 ${refresh.done}/${refresh.total}` : '刷新全部模型'}
        </button>
        <span className="grow" />
        {p.otherAgents && !p.lockProvider && (
          <button data-id={MODEL_MENU_ID.agents} onClick={() => { p.onClose(); useStore.getState().openSettings({ section: 'agents' }); }} title="安装、登录、配置 Codex / Gemini CLI 等其它 Agent">
            <Icon name="agent" size={13} /> {TERMS.agents}…
          </button>
        )}
        <button data-id={MODEL_MENU_ID.manage} onClick={() => { p.onClose(); useStore.getState().openSettings({ section: 'models' }); }}>
          <Icon name="settings" size={13} /> 管理模型与供应商…
        </button>
      </div>
    </div>
  );
  return portal ? createPortal(body, document.body) : body;
}

/**
 * A composer chip that opens the menu: `模型 · 档位` (`suffix` is the dimmer 档位 / 深度编排 part). `busy` shows a
 * spinner while a profile switch restarts the session.
 */
export function ModelChip(p: Omit<ModelMenuProps, 'onClose'> & { label: string; suffix?: string; title?: string; busy?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const { label, suffix, title, busy, disabled, ...menu } = p;
  return (
    <span ref={anchor} className="mm-anchor">
      <button type="button" className={clsx('chip', open && 'active')} title={title ?? label} disabled={disabled} aria-label={`模型：${label}${suffix ? ` · ${suffix}` : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {busy && <span className="spinner" />}
        <span className="mm-chip-label">{label}{suffix && <span className="mm-chip-suffix"> · {suffix}</span>}</span>
        <span className="caret"><Icon name="chevronDown" size={10} /></span>
      </button>
      {open && (
        <ErrorBoundary area="模型菜单" compact onReset={() => setOpen(false)}>
          <ModelMenu {...menu} anchor={anchor} onClose={() => setOpen(false)} />
        </ErrorBoundary>
      )}
    </span>
  );
}
