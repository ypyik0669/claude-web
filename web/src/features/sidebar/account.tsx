import { useEffect, useState } from 'react';
import type { LedgerEntry } from '@shared';
import { useStore, type AccountAuth } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { fmtCost } from '@/model/cost';
import { modKey } from '@/features/workbench/shortcuts';
import { Menu, closeDrawer } from './menus';
import { QuotaWindows, UsageRing } from './UsageRing';
import { accountName, planLabel, todayCost } from './status';
import { ACCOUNT_PANELS, type AccountId } from './entries';
import { showPanel } from '@/features/workbench/right-panel';
import { ThemeQuick } from '@/features/settings/ThemePicker';

/**
 * Today's spend for the account popover: `ledger.list` parses the whole ledger file on the server, so one answer is
 * reused for 60 s (opening and closing the popover repeatedly asks once). Module-level: the sidebar unmounts.
 */
const TODAY_TTL_MS = 60_000;
type Today = ReturnType<typeof todayCost>;
let todayCache: { at: number; day: string; value: Today } | null = null;
let todayInflight: Promise<Today> | null = null;
const dayKey = () => new Date().toDateString();
/** the cached answer while it is fresh (and still about today) */
const cachedToday = (): Today | null => (todayCache && Date.now() - todayCache.at < TODAY_TTL_MS && todayCache.day === dayKey() ? todayCache.value : null);
function loadToday(): Promise<Today> {
  const hit = cachedToday();
  if (hit) return Promise.resolve(hit);
  todayInflight ??= ws.request<LedgerEntry[]>({ kind: 'ledger.list', days: 1 })
    .then((rows) => { const value = todayCost(rows ?? []); todayCache = { at: Date.now(), day: dayKey(), value }; return value; })
    .finally(() => { todayInflight = null; });
  return todayInflight;
}

/**
 * The account row at the bottom of the sidebar (spec §5.1): avatar · name · 「Max 套餐 · 已用 34%」 · settings gear.
 * The row opens a popover upwards (quota windows, today's spend, 浅色 / 深色 / 跟随系统, usage & ledger, the config
 * panel, appearance, shortcuts, the command palette). The connection shows only when it is lost (red dot on the avatar + the line).
 * Who is signed in comes from the store (`auth`: asked once per connection, and updated by every `checkAuth` — the
 * welcome page's 重新检查 / focus re-check, onboarding, settings); the popover is the sidebar's one menu.
 */
export function AccountRow({ open, setOpen }: { open: boolean; setOpen(v: boolean): void }) {
  const auth = useStore((s) => s.auth);
  const providers = useStore((s) => s.providers.length);
  const connected = useStore((s) => s.connected);
  const who = accountName(auth, providers);
  const id = (x: AccountId) => x;
  const settings = () => { useStore.getState().openSettings(); closeDrawer(); };
  return (
    <div className="sb-foot sb-account">
      <button className={clsx('acct', open && 'on')} data-id={id('account')} aria-haspopup="menu" aria-expanded={open} title={auth?.email ?? who.name} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <span className={clsx('avatar', !who.signedIn && 'anon')} data-id={id('connection')} data-state={connected ? 'on' : 'off'} title={connected ? '已连接' : '连接断开，正在重连…'}>
          {who.initial || <Icon name="user" size={15} />}
          {!connected && <span className="off-dot" />}
        </span>
        <span className="who">
          <span className="nm">{who.name}</span>
          <span className="sub">{connected ? <UsageRing tip={false} fallbackPlan={auth?.subscriptionType} /> : <span className="conn-off">连接断开，正在重连…</span>}</span>
        </span>
      </button>
      <button className="icon-btn" data-id={id('settings')} title={`设置 (${modKey}+,) · 右键：在右侧面板打开配置中心`} aria-label="设置" onClick={settings} onContextMenu={(e) => { e.preventDefault(); if (showPanel(ACCOUNT_PANELS.config)) closeDrawer(); }}>
        <Icon name="settings" size={16} />
      </button>
      {open && <AccountMenu auth={auth} name={who.name} onClose={() => setOpen(false)} />}
    </div>
  );
}

function AccountMenu({ auth, name, onClose }: { auth: AccountAuth | null; name: string; onClose: () => void }) {
  const limits = useStore((s) => s.limits);
  const [today, setToday] = useState(cachedToday);
  useEffect(() => {
    let live = true;
    loadToday().then((v) => { if (live) setToday(v); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const id = (x: AccountId) => x;
  // like 自动化: the phone drawer gets out of the way only when something opened (a panel is the bottom drawer there)
  const act = (fn: () => boolean | void) => () => { onClose(); if (fn() !== false) closeDrawer(); };
  const st = useStore.getState;
  const plan = planLabel(limits?.subscriptionType ?? auth?.subscriptionType);
  return (
    <Menu onClose={onClose} className="sb-acct-menu" align="left" prefer="up" label="账户">
      <div className="acct-head">
        <div className="nm">{name}</div>
        <div className="sub">{[auth?.email, plan].filter(Boolean).join(' · ') || (auth?.loggedIn === false ? '没有登录 Claude 账号' : '')}</div>
      </div>
      {limits?.ok && limits.windows.length > 0 && (
        <div className="acct-quota" data-id={id('quota')}>
          <QuotaWindows limits={limits} />
        </div>
      )}
      {/* not signed in to a Claude account: there is no quota to read (the raw error is a missing credentials path);
          otherwise one plain line, the raw error only in the tooltip */}
      {limits && !limits.ok && auth?.loggedIn !== false && <div className="menu-note" title={limits.error ?? undefined}>暂时读不到账号额度，稍后会自动重试</div>}
      <div className="acct-today" data-id={id('today')} title="今天（本地时间）各对话的费用合计，来自账本">
        <span>今日费用</span>
        <span className="v">{today ? fmtCost(today.cost, today.unknown) : '…'}</span>
      </div>
      <div className="menu-sep" />
      <ThemeQuick dataId={id('theme')} />
      <button data-id={id('usage')} onClick={act(() => showPanel(ACCOUNT_PANELS.usage))}><Icon name="usage" size={14} /> 用量与账本</button>
      <button data-id={id('config')} onClick={act(() => showPanel(ACCOUNT_PANELS.config))}><Icon name="config" size={14} /> 配置中心（右侧面板）</button>
      <button data-id={id('appearance')} onClick={act(() => st().openSettings({ section: 'appearance' }))}><Icon name="sun" size={14} /> 外观与主题…</button>
      <button data-id={id('shortcuts')} onClick={act(() => useStore.setState({ shortcutsOpen: true }))}><Icon name="keyboard" size={14} /> 键盘快捷键<span className="k">?</span></button>
      <button data-id={id('palette')} onClick={act(() => useStore.setState({ paletteOpen: true }))}><Icon name="command" size={14} /> 命令面板<span className="k">{modKey} K</span></button>
    </Menu>
  );
}
