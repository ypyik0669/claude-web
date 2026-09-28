import { useEffect, useState } from 'react';
import type { LedgerEntry } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { fmtCost } from '@/model/cost';
import { modKey } from '@/features/workbench/shortcuts';
import { Menu } from './menus';
import { QuotaWindows, UsageRing } from './UsageRing';
import { accountName, planLabel, todayCost } from './status';
import type { AccountId } from './entries';
import { showPanel } from './panels';

interface Auth { loggedIn?: boolean; email?: string; orgName?: string; subscriptionType?: string; authMethod?: string }

/**
 * Who is signed in (`config.auth` = `claude auth status`; the server shares one run for 30 s with the welcome page
 * and the onboarding), asked once per connection — never polled: every forced check is an engine start.
 */
function useAuth(): Auth | null {
  const connected = useStore((s) => s.connected);
  const [auth, setAuth] = useState<Auth | null>(null);
  useEffect(() => {
    if (!connected) return;
    let live = true;
    ws.request<Auth>({ kind: 'config.auth' }).then((a) => { if (live) setAuth(a ?? { loggedIn: false }); }).catch(() => { if (live) setAuth((x) => x ?? { loggedIn: false }); });
    return () => { live = false; };
  }, [connected]);
  return auth;
}

/**
 * The account row at the bottom of the sidebar (spec §5.1): avatar · name · 「Max 套餐 · 已用 34%」 · settings gear.
 * The row opens a popover upwards (quota windows, today's spend, usage & ledger, the config panel, appearance,
 * shortcuts, the command palette). The connection shows only when it is lost (red dot on the avatar + the line).
 */
export function AccountRow() {
  const auth = useAuth();
  const providers = useStore((s) => s.providers.length);
  const connected = useStore((s) => s.connected);
  const [open, setOpen] = useState(false);
  const who = accountName(auth, providers);
  const id = (x: AccountId) => x;
  const settings = () => useStore.getState().openSettings();
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
      <button className="icon-btn" data-id={id('settings')} title={`设置 (${modKey}+,) · 右键：在右侧面板打开配置中心`} aria-label="设置" onClick={settings} onContextMenu={(e) => { e.preventDefault(); showPanel('config'); }}>
        <Icon name="settings" size={16} />
      </button>
      {open && <AccountMenu auth={auth} name={who.name} onClose={() => setOpen(false)} />}
    </div>
  );
}

function AccountMenu({ auth, name, onClose }: { auth: Auth | null; name: string; onClose: () => void }) {
  const limits = useStore((s) => s.limits);
  const [today, setToday] = useState<ReturnType<typeof todayCost> | null>(null);
  useEffect(() => {
    let live = true;
    ws.request<LedgerEntry[]>({ kind: 'ledger.list', days: 1 }).then((rows) => { if (live) setToday(todayCost(rows ?? [])); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const id = (x: AccountId) => x;
  const act = (fn: () => void) => () => { onClose(); fn(); };
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
      {limits && !limits.ok && <div className="menu-note">暂时读不到账号额度{limits.error ? `：${limits.error}` : ''}</div>}
      <div className="acct-today" data-id={id('today')} title="今天（本地时间）各对话的费用合计，来自账本">
        <span>今日费用</span>
        <span className="v">{today ? fmtCost(today.cost, today.unknown) : '…'}</span>
      </div>
      <div className="menu-sep" />
      <button data-id={id('usage')} onClick={act(() => showPanel('usage'))}><Icon name="usage" size={14} /> 用量与账本</button>
      <button data-id={id('config')} onClick={act(() => showPanel('config'))}><Icon name="config" size={14} /> 配置中心（右侧面板）</button>
      <button data-id={id('appearance')} onClick={act(() => st().openSettings({ section: 'appearance' }))}><Icon name="sun" size={14} /> 外观与主题…</button>
      <button data-id={id('shortcuts')} onClick={act(() => useStore.setState({ shortcutsOpen: true }))}><Icon name="keyboard" size={14} /> 键盘快捷键<span className="k">?</span></button>
      <button data-id={id('palette')} onClick={act(() => useStore.setState({ paletteOpen: true }))}><Icon name="command" size={14} /> 命令面板<span className="k">{modKey} K</span></button>
    </Menu>
  );
}
