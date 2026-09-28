import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AgentKind } from '@shared';
import { useStore } from '@/store';
import { ago, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { buildModelMenu, filterMenu, pushRecent, recentKey, type ModelMenuItem, type ModelMenuSection } from './menu';
import { refreshAllModels, useGatewayGroups, useRefreshRun } from './data';
import './models.css';

/** `5 分钟前` / `刚刚` / a date */
export function agoText(t: number): string {
  const a = ago(t);
  return /^\d+ (分钟|小时|天)$/.test(a) ? `${a}前` : a;
}

export interface ModelMenuProps {
  agent: AgentKind;
  current: { providerId?: string; model?: string | null };
  onPick: (item: ModelMenuItem) => void;
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
}

/** Fixed coordinates next to `anchor`: preferred side unless the other has clearly more room; height capped to the room. */
function placeNear(anchor: HTMLElement, prefer: 'up' | 'down', align: 'left' | 'right'): CSSProperties {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight, gap = 6, margin = 8;
  const above = r.top - gap - margin, below = vh - r.bottom - gap - margin;
  const up = prefer === 'up' ? above >= 260 || above >= below : !(below >= 260 || below >= above);
  const st: CSSProperties = { position: 'fixed', maxHeight: Math.max(160, Math.min(560, up ? above : below)) };
  if (up) st.bottom = vh - r.top + gap; else st.top = r.bottom + gap;
  if (align === 'right') st.right = Math.max(margin, vw - r.right); else st.left = Math.max(margin, r.left);
  return st;
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
  const groups = useGatewayGroups();
  const refresh = useRefreshRun();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const keyNav = useRef(false); // scroll the active row into view only when the keyboard moved it

  // portalled: follow the anchor on resize; after the first paint keep the menu inside the viewport horizontally
  useLayoutEffect(() => {
    const a = p.anchor?.current;
    if (!a) return;
    const place = () => setPos(placeNear(a, p.placement ?? 'up', p.align ?? 'right'));
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [p.anchor, p.placement, p.align]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!pos || !el) return;
    const r = el.getBoundingClientRect();
    if (r.left < 8 && pos.right !== undefined) setPos({ ...pos, right: undefined, left: 8 });
    else if (r.right > window.innerWidth - 8 && pos.left !== undefined) setPos({ ...pos, left: undefined, right: 8 });
  }, [pos]);

  const menu = useMemo(() => {
    const m = buildModelMenu({ agent: p.agent, providers, gatewayGroups: groups, settings, current: p.current, builtin: p.builtin, builtinTitle: p.builtinTitle, agentDefault: p.agentDefault });
    if (!p.lockProvider) return m;
    const keep = (s: ModelMenuSection) => ({ ...s, items: s.items.filter((i) => i.providerId === p.lockProvider) });
    return { ...m, sections: m.sections.map(keep).filter((s) => s.items.length) };
  }, [p.agent, providers, groups, settings, p.current.providerId, p.current.model, p.builtin, p.builtinTitle, p.agentDefault, p.lockProvider]);
  const shown = useMemo(() => filterMenu(menu, q), [menu, q]);
  const flat = useMemo(() => shown.sections.flatMap((s) => s.items.map((it) => ({ s, it }))), [shown]);

  // open on the current entry (marked, not scrolled to: the list starts at favourites / recents)
  useLayoutEffect(() => {
    const i = flat.findIndex((x) => x.it.current && x.s.kind !== 'favorites' && x.s.kind !== 'recent');
    setActive(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a portalled menu renders on the second pass (after it is measured): focus the search box then
  const mounted = !p.anchor || !!pos;
  useLayoutEffect(() => { if (mounted) input.current?.focus(); }, [mounted]);
  useEffect(() => { if (q) { setActive(0); if (list.current) list.current.scrollTop = 0; } }, [q]);
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

  const pick = (it: ModelMenuItem) => {
    void setSetting('ui.recentModels', pushRecent(settings['ui.recentModels'] as string[] | undefined, recentKey(p.agent, it.providerId, it.model)));
    p.onPick(it);
    p.onClose();
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
    else if (e.key === 'Enter') { e.preventDefault(); const x = flat[active]; if (x) pick(x.it); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.onClose(); }
  };

  let idx = -1;
  const portal = !!p.anchor;
  if (portal && !pos) return null; // measured in the layout effect before the first paint
  const body = (
    <div ref={box} className={clsx('menu mm', portal ? 'fixed' : [p.placement === 'down' ? 'down' : 'up', p.align === 'left' ? 'left' : 'right'].join(' '))} style={pos ?? undefined} role="dialog" aria-label="选择模型" onKeyDown={onKey}>
      <div className="mm-search">
        <Icon name="search" size={13} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索档案或模型…" aria-label="搜索模型" role="combobox" aria-expanded aria-controls="mm-list" />
        {q && <button className="icon-btn xs" aria-label="清除" onClick={() => { setQ(''); input.current?.focus(); }}><Icon name="close" size={11} /></button>}
      </div>
      {p.lockProvider && p.lockNote && <div className="mm-note">{p.lockNote}</div>}
      <div ref={list} className="mm-list" id="mm-list" role="listbox">
        {shown.sections.map((s) => (
          <div key={s.id} className="mm-sec">
            <div className="mm-head">
              <Icon name={s.kind === 'favorites' ? 'star' : s.kind === 'recent' ? 'refresh' : s.kind === 'builtin' ? 'claude' : s.providerType === 'gateway' ? 'gateway' : 'cloud'} size={11} />
              <span className="t">{s.title}</span>
              {s.providerType && <span className="ty">{s.providerType}</span>}
              {s.kind === 'provider' && !s.error && <span className="meta">{s.count ? `${s.count} 个模型` : '未拉取'}{s.modelsAt ? ` · ${agoText(s.modelsAt)}` : ''}</span>}
              {s.error && <span className="err" title={s.error}>拉取失败：{s.error}</span>}
            </div>
            {s.items.map((it) => {
              idx++;
              const i = idx;
              const own = it.providerId === 'claude';
              return (
                <div key={`${s.id}:${it.key}:${it.isDefault ? 'd' : ''}`} data-idx={i} role="option" aria-selected={i === active} className={clsx('mm-row', i === active && 'active', it.current && 'cur')} onMouseMove={() => i !== active && setActive(i)} onClick={() => pick(it)} title={it.label}>
                  <span className="mm-check">{it.current && <Icon name="check" size={12} />}</span>
                  <span className="mm-label">
                    {!own && <span className="p">{it.providerName} / </span>}
                    <span className="m">{it.display}</span>
                  </span>
                  {it.profileDefault && <span className="badge">默认</span>}
                  {it.hint && <span className="mm-hint">{it.hint}</span>}
                  {!it.isDefault && (
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
      </div>
      <div className="mm-foot">
        <button onClick={() => void refreshAllModels()} disabled={refresh.running} title="拉取每个供应商档案的 /v1/models（只列模型，不花 token）">
          {refresh.running ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
          {refresh.running ? `刷新中 ${refresh.done}/${refresh.total}` : '刷新全部模型'}
        </button>
        <span className="grow" />
        <button onClick={() => { p.onClose(); useStore.getState().openSettings({ section: 'models' }); }}>
          <Icon name="settings" size={13} /> 管理模型…
        </button>
      </div>
    </div>
  );
  return portal ? createPortal(body, document.body) : body;
}

/** A composer chip that opens the menu. `busy` shows a spinner while a profile switch restarts the session. */
export function ModelChip(p: Omit<ModelMenuProps, 'onClose'> & { label: string; title?: string; busy?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const { label, title, busy, disabled, ...menu } = p;
  return (
    <span ref={anchor} className="mm-anchor">
      <button type="button" className={clsx('chip', open && 'active')} title={title ?? label} disabled={disabled} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {busy && <span className="spinner" />}
        <span className="mm-chip-label">{label}</span>
        <span className="caret"><Icon name="chevronDown" size={10} /></span>
      </button>
      {open && <ModelMenu {...menu} anchor={anchor} onClose={() => setOpen(false)} />}
    </span>
  );
}
