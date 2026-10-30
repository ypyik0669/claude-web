import { useCallback, useMemo, useState } from 'react';
import { AppMenu } from './AppMenu';
import { desktop } from '@/desktop';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon, type IconName } from '@/ui/icons';
import { panelToggleEffect, workbenchOn, type PanelId } from '@/model/layout';
import { modKey } from '@/features/workbench/shortcuts';
import { showPanel } from '@/features/workbench/right-panel';
import { closePages, useSection, type Section } from '@/features/sections';
import { openAutomation } from '@/features/automation/state';
import { openExtensions } from '@/features/extensions/state';
import { openBackground } from '@/features/background/state';
import { openBots } from '@/features/bots/state';
import { openHub } from '@/features/model-hub/state';
import { useOrch, waitingOf } from '@/features/orchestra/state';
import { Menu } from '@/features/sidebar/menus';
import { AccountMenu } from '@/features/sidebar/account';
import { worstWindow } from '@/features/sidebar/UsageRing';
import { accountName } from '@/features/sidebar/status';
import { ACCOUNT_PANELS, type AccountId, type TopId } from '@/features/sidebar/entries';
import { MAX_PINS, RAIL_MORE, RAIL_PINS_KEY, RAIL_SECTIONS, railPanel, readPins, togglePin } from './rail-model';
import { tr } from '@/i18n';

/** One button of the rail: an icon, its name beside it on hover (`data-tip`, drawn by the style sheet). */
function RailBtn({ id, icon, tip, on, className, children, ...rest }: { id: string; icon: IconName; tip: string; on?: boolean; className?: string; children?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={clsx('rail-btn', on && 'on', className)} data-id={id} data-tip={tip} aria-label={tip} {...rest}>
      <Icon name={icon} size={18} />
      {children}
    </button>
  );
}

const OPEN: Record<Section, () => void> = {
  chat: closePages,
  background: () => { openBackground(); },
  automation: () => { openAutomation(); },
  bots: () => { openBots(); },
  gateway: () => { openHub(); },
  extensions: () => { openExtensions(); },
};

/** ···: the panels that are not sections; each row opens one in the right panel, its pin puts it on the rail. */
function MoreMenu({ pins, onClose }: { pins: PanelId[]; onClose: () => void }) {
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const pin = (id: PanelId) => {
    const next = togglePin(pins, id);
    if (!next) { toast(tr('图标栏上最多钉 {MAX_PINS} 个：先取下一个', { MAX_PINS })); return; }
    setSetting(RAIL_PINS_KEY, next);
  };
  return (
    <Menu onClose={onClose} className="rail-menu" side="right" label={tr('更多')}>
      <div className="rm-h">{tr('更多')}</div>
      {RAIL_MORE.map((id) => {
        const p = railPanel(id);
        const pinned = pins.includes(id);
        return (
          <div key={id} className="rm-row">
            <button className="rm-open" data-id={`open-${id}`} onClick={() => { showPanel(id); onClose(); }}>
              <Icon name={p.icon} size={16} />
              <span className="rm-t"><span className="l">{p.label}</span><span className="h">{p.hint}</span></span>
            </button>
            <button className={clsx('rm-pin', pinned && 'on')} data-id={`pin-${id}`} aria-pressed={pinned} aria-label={pinned ? tr('从图标栏取下「{label}」', { label: p.label }) : tr('把「{label}」钉到图标栏', { label: p.label })} title={pinned ? tr('从图标栏取下') : tr('钉到图标栏')} onClick={(e) => { e.stopPropagation(); pin(id); }}>
              <Icon name="pin" size={13} />
            </button>
          </div>
        );
      })}
    </Menu>
  );
}

/** The account: the avatar inside a ring that fills with the quota window closest to its limit. */
function Avatar({ initial, signedIn, percent, connected }: { initial: string; signedIn: boolean; percent: number | null; connected: boolean }) {
  const r = 16, c = 2 * Math.PI * r;
  const tone = percent === null ? '' : percent >= 90 ? 'crit' : percent >= 70 ? 'hot' : '';
  const id = (x: AccountId) => x;
  return (
    <span className={clsx('rail-avatar', !signedIn && 'anon', tone)} data-id={id('connection')} data-state={connected ? 'on' : 'off'}>
      {percent !== null && (
        <svg className="ring" width="36" height="36" viewBox="0 0 36 36" aria-hidden data-id={id('quota')}>
          <circle cx="18" cy="18" r={r} fill="none" stroke="var(--edge-default)" strokeWidth="2" />
          <circle cx="18" cy="18" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(percent / 100) * c} ${c}`} transform="rotate(-90 18 18)" />
        </svg>
      )}
      <span className="face">{initial || <Icon name="user" size={14} />}</span>
      {!connected && <span className="off-dot" />}
    </span>
  );
}

/**
 * The icon rail (spec 2026-10-10-ui-structure §2.1), the window's first column at desktop width: the sidebar's
 * switch; the three sections (对话 · 自动化 · 扩展); what was pinned from ···; ··· itself; at the foot 设置 and the
 * account. The ids are the sidebar's own (`collapse`, `automation`, `settings`, `account`…): the entries a phone still
 * has in its drawer moved here, they did not change.
 */
export function Rail() {
  const section = useSection();
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const pinsRaw = useStore((s) => s.settings[RAIL_PINS_KEY]);
  const pins = useMemo(() => readPins(pinsRaw), [pinsRaw]);
  const dock = useStore((s) => s.layout.dock);
  const workbench = useStore((s) => workbenchOn(s.settings));
  const togglePanel = useStore((s) => s.togglePanel);
  const auth = useStore((s) => s.auth);
  const providers = useStore((s) => s.providers.length);
  const connected = useStore((s) => s.connected);
  const limits = useStore((s) => s.limits);
  // someone waits for an answer while another section is in front: the 对话 button says so
  const waiting = useStore((s) => Object.values(s.open).some((o) => o.pending.length > 0));
  const orchFull = useOrch((s) => s.full);
  const orchWaiting = useMemo(() => waitingOf(orchFull).length, [orchFull]);
  const [menu, setMenu] = useState<'more' | 'account' | 'app' | null>(null);
  const toggle = (k: 'more' | 'account' | 'app') => (e: React.MouseEvent) => { e.stopPropagation(); setMenu((m) => (m === k ? null : k)); };
  const close = useCallback((k: 'more' | 'account' | 'app') => setMenu((m) => (m === k ? null : m)), []);
  const who = accountName(auth, providers);
  const worst = worstWindow(limits);
  const top = (x: TopId) => x;
  const acct = (x: AccountId) => x;
  const dot: Partial<Record<Section, boolean>> = { chat: waiting && section !== 'chat', automation: orchWaiting > 0 && section !== 'automation' };
  return (
    <nav className="rail" aria-label={tr('分区')}>
      <div className="rail-top">
        {/* ☰ (the official title bar's application menu): the desktop pops up its native menu, a browser our own */}
        <span className="rail-anchor">
          <RailBtn
            id={top('app-menu')}
            icon="menu"
            tip={tr('菜单')}
            on={menu === 'app'}
            aria-haspopup="menu"
            aria-expanded={menu === 'app'}
            onClick={(e) => {
              if (desktop?.showAppMenu) { const r = e.currentTarget.getBoundingClientRect(); const z = desktop.getZoom?.() ?? 1; setMenu(null); desktop.showAppMenu(r.right * z, r.top * z); return; }
              toggle('app')(e);
            }}
          />
          {menu === 'app' && <AppMenu onClose={() => close('app')} />}
        </span>
        <RailBtn
          id={top('collapse')}
          icon="sidebar"
          tip={tr('{v}侧栏 ({modKey}+B)', { v: sidebarOpen ? tr('收起') : tr('展开'), modKey })}
          className={clsx('rail-side', !sidebarOpen && 'sb-reveal')}
          aria-expanded={sidebarOpen}
          onClick={() => useStore.setState({ sidebarOpen: !sidebarOpen })}
        />
      </div>
      <div className="rail-main">
        {RAIL_SECTIONS.map((s) => (
          <RailBtn key={s.id} id={s.id} icon={s.icon} tip={s.tip} on={section === s.id} aria-current={section === s.id ? 'page' : undefined} onClick={() => { setMenu(null); OPEN[s.id](); }}>
            {dot[s.id] && <span className="rail-dot" />}
          </RailBtn>
        ))}
        {pins.length > 0 && <span className="rail-div" />}
        {pins.map((id) => {
          const p = railPanel(id);
          const shown = panelToggleEffect(dock, id, workbench) !== 'show';
          return <RailBtn key={id} id={`panel-${id}`} icon={p.icon} tip={p.label} on={shown} aria-pressed={shown} className="pinned" onClick={() => togglePanel(id)} />;
        })}
        <span className="rail-anchor">
          <RailBtn id={top('more')} icon="more" tip={tr('更多')} on={menu === 'more'} aria-haspopup="menu" aria-expanded={menu === 'more'} onClick={toggle('more')} />
          {menu === 'more' && <MoreMenu pins={pins} onClose={() => close('more')} />}
        </span>
      </div>
      <div className="rail-foot">
        <RailBtn
          id={acct('settings')}
          icon="settings"
          tip={tr('设置 ({modKey}+,)', { modKey })}
          onClick={() => useStore.getState().openSettings()}
          onContextMenu={(e) => { e.preventDefault(); showPanel(ACCOUNT_PANELS.config); }}
        />
        <span className="rail-anchor">
          <button type="button" className={clsx('rail-acct', menu === 'account' && 'on')} data-id={acct('account')} data-tip={connected ? who.name : tr('连接断开，正在重连…')} aria-label={tr('账户：{name}', { name: who.name })} aria-haspopup="menu" aria-expanded={menu === 'account'} onClick={toggle('account')}>
            <Avatar initial={who.initial} signedIn={who.signedIn} percent={worst ? worst.percent : null} connected={connected} />
          </button>
          {menu === 'account' && <AccountMenu auth={auth} name={who.name} side="right" onClose={() => close('account')} />}
        </span>
      </div>
    </nav>
  );
}
