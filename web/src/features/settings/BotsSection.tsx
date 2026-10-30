// 设置 › 通用 › 值班 Bot (spec 2026-10-30-duty-bots-design §「设置 → Bot」, §10): the controls of the rows that are more than a
// plain meta.json switch — the global budget, the default source, the headless duty service, the desktop shell's
// tray / launch-at-login, and 放开全部 / 收回. Every value still goes through `settings.set`.
import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { desktop } from '@/desktop';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { Select as MenuSelect } from '@/ui/Select';
import { useBots } from '@/features/bots/state';
import { tr } from '@/i18n';
import { dutyAfter, dutyShown, eachUntilError, parseBudget, type DutyResult } from './bots-settings';

const msg = (e: unknown) => (e as Error)?.message ?? String(e);

/** 全局预算 (USD a day across all bots): a number ≥ 0; empty or 0 = none. Saved on blur / Enter. */
export function BotsBudget({ label }: { label: string }) {
  const v = useStore((s) => s.settings['bots.globalBudgetUsd']);
  const set = useStore((s) => s.setSetting);
  const saved = typeof v === 'number' ? String(v) : '';
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const commit = () => {
    if (text.trim() === saved) return;
    const r = parseBudget(text);
    // the text stays as typed, so you see what was refused
    if (!r.ok) { useStore.getState().toast(tr('预算要填一个不小于 0 的数，或者留空')); return; }
    // empty or 0 = no global budget (the server reads only a positive number)
    void set('bots.globalBudgetUsd', r.value);
    if (r.value === undefined) setText('');
  };
  return (
    <input className="field" type="text" inputMode="decimal" aria-label={label} placeholder={tr('不设')} value={text}
      style={{ width: 110 }}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) { e.preventDefault(); commit(); } }} />
  );
}

/**
 * 默认来源: a provider bots without their own use. Empty = the conversation default — named in the blank option, and
 * warned about under the row when that is (or may be) a Claude subscription (no default provider = this computer's
 * Claude login). A Claude account is allowed (the product refuses nothing, §10) but asks once with the concrete risk.
 */
export function BotsDefaultProvider({ label }: { label: string }) {
  const v = useStore((s) => s.settings['bots.defaultProvider']);
  const providers = useStore((s) => s.providers);
  const convDefault = useStore((s) => s.settings.defaultProviderId);
  const set = useStore((s) => s.setSetting);
  useEffect(() => { if (!useStore.getState().providers.length) void useStore.getState().loadProviders().catch(() => {}); }, []);
  const cur = typeof v === 'string' ? v : '';
  const def = typeof convDefault === 'string' && convDefault ? providers.find((p) => p.id === convDefault) : undefined;
  const defName = def ? (def.type === 'claude-account' ? tr('{name}（Claude 订阅）', { name: def.name }) : def.name) : tr('本机的 Claude 登录');
  // blank: bots run on what new conversations use — a Claude subscription when that is an account or no provider at all
  const maySubscription = !cur && (!def || def.type === 'claude-account');
  const options = [
    { value: '', label: tr('跟新对话的默认一样（现在是 {name}）', { name: defName }) },
    ...providers.map((p) => ({ value: p.id, label: p.type === 'claude-account' ? tr('{name}（Claude 订阅）', { name: p.name }) : p.name })),
  ];
  // a provider that was deleted since: still shown, so the value is not silently something else
  if (cur && !providers.some((p) => p.id === cur)) options.push({ value: cur, label: tr('{id}（已删除）', { id: cur }) });
  const pick = async (id: string) => {
    if (id === cur) return;
    const p = providers.find((x) => x.id === id);
    if (p?.type === 'claude-account' && !(await dlg.confirm(tr('让 Bot 用 Claude 订阅登录跑？'), {
      message: tr('Anthropic 条款自 2026-04 起可能禁止用订阅这样 7×24 小时跑，有封号风险。建议用 API Key 或网关来源。'),
      danger: true, focusCancel: true, okLabel: tr('仍然使用'),
    }))) return;
    void set('bots.defaultProvider', id || undefined);
  };
  const select = <MenuSelect className="field" aria-label={label} label={label} value={cur} onValueChange={(x) => void pick(String(x))} options={options} />;
  if (!maySubscription) return select;
  return (
    <div className="bots-source" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, maxWidth: 300 }}>
      {select}
      <span className="bots-source-warn" role="note" style={{ fontSize: 12, textAlign: 'right', color: 'var(--warn)' }}>
        {tr('Bot 会用新对话的默认来源，可能是 Claude 订阅：Anthropic 条款可能禁止用订阅 7×24 小时跑，有封号风险。建议在这里选一个 API Key 或网关来源。')}
      </span>
    </div>
  );
}

const failed = (on: boolean, detail: string) => (on ? tr('没能打开值班服务：{detail}', { detail }) : tr('没能关闭值班服务：{detail}', { detail }));
// machine-local: settings sync only carries routing.* / models.* (sync/backup.ts)
const DUTY_KEY = 'bots.duty.last';

/**
 * 值班服务 (headless): register the server as a per-user service. The switch shows what the system says
 * (`bots.duty.status`); while that is unknown (an older server, a remote window), the state the last change left.
 */
export function BotsDutyService({ label }: { label: string }) {
  const last = useStore((s) => s.settings[DUTY_KEY]) as DutyResult | undefined;
  const set = useStore((s) => s.setSetting);
  const [busy, setBusy] = useState(false);
  const [installed, setInstalled] = useState<boolean | null>(null);
  const ask = () => ws.request<{ installed: boolean }>({ kind: 'bots.duty.status' })
    .then((r) => setInstalled(typeof r?.installed === 'boolean' ? r.installed : null)).catch(() => setInstalled(null));
  useEffect(() => { void ask(); }, []);
  const on = dutyShown(last, installed);
  const flip = async () => {
    const want = !on;
    setBusy(true);
    try {
      const r = await ws.request<{ ok: boolean; detail: string }>({ kind: 'bots.duty.install', mode: 'service', on: want });
      const res = dutyAfter(on, want, { ok: !!r?.ok, detail: r?.detail ?? '' }, Date.now());
      void set(DUTY_KEY, res);
      useStore.getState().toast(res.ok ? res.detail || (want ? tr('值班服务已打开') : tr('值班服务已关闭')) : failed(want, res.detail));
    } catch (e) {
      void set(DUTY_KEY, dutyAfter(on, want, { ok: false, detail: msg(e) }, Date.now()));
      useStore.getState().toast(failed(want, msg(e)));
    } finally {
      await ask();
      setBusy(false);
    }
  };
  const status = busy ? tr('正在处理…') : !last ? '' : last.ok ? (last.on ? tr('上一次：打开成功') : tr('上一次：关闭成功')) : tr('上一次没成功：{detail}', { detail: last.detail });
  return (
    <div className="bots-duty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, maxWidth: 260 }}>
      <button className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={on} aria-label={label} disabled={busy} onClick={() => void flip()} />
      {status && <span className="faint" style={{ fontSize: 12, textAlign: 'right' }} title={last?.detail}>{status}</span>}
      {desktop && <span className="faint" style={{ fontSize: 12, textAlign: 'right' }}>{tr('桌面版关窗口会缩到托盘继续值班；开机自启在下面一行')}</span>}
    </div>
  );
}

/** Desktop only: launch at login (the shell's login item) and a jump to 关闭窗口时留在托盘. */
export function BotsDesktopKeep({ label }: { label: string }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { void desktop?.getLoginItem().then((v) => setOn(!!v)).catch(() => setOn(null)); }, []);
  if (!desktop) return <span className="faint" style={{ fontSize: 12 }}>{tr('只在桌面版里有')}</span>;
  const flip = async () => {
    const want = !on;
    try { await desktop!.setLoginItem(want); setOn(want); } catch (e) { useStore.getState().toast(tr('操作失败：{message}', { message: msg(e) })); }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button className="btn sm ghost" onClick={() => useStore.getState().openSettings({ reveal: 'ui.closeToTray' })}>{tr('关窗口留在托盘…')}</button>
      <button className={`toggle${on ? ' on' : ''}`} role="switch" aria-checked={!!on} aria-label={label} disabled={on === null} onClick={() => void flip()} />
    </div>
  );
}

/** 放开全部 / 收回: every bot but the manager, one after another; the first failure stops it (toasted). */
export function BotsUnleashAll() {
  const bots = useBots((s) => s.bots);
  const [busy, setBusy] = useState(false);
  const workers = bots.filter((b) => !b.manager);
  const unleashed = workers.filter((b) => b.policy?.unleashed).length;
  const apply = async (on: boolean) => {
    const targets = useBots.getState().bots.filter((b) => !b.manager && !!b.policy?.unleashed !== on);
    if (!targets.length) return;
    if (on && !(await dlg.confirm(tr('放开全部 Bot 的限制？'), {
      message: tr('放开后，这 {count} 个 Bot 在你不在时也会直接对外发送、付款和不可恢复地删除，不再先问你；只有停止和审计还在。', { count: targets.length }),
      danger: true, focusCancel: true, okLabel: tr('放开全部'),
    }))) return;
    setBusy(true);
    try {
      const { done, failed: f } = await eachUntilError(targets, (b) => ws.request({ kind: 'bots.unleash', id: b.id, on }));
      if (f) {
        const o = { name: f.target.name, done, message: msg(f.error) };
        useStore.getState().toast(on
          ? tr('「{name}」没能放开，后面的没有再动（已处理 {done} 个）：{message}', o)
          : tr('「{name}」没能收回，后面的没有再动（已处理 {done} 个）：{message}', o));
      } else useStore.getState().toast(on ? tr('已放开 {count} 个 Bot', { count: done }) : tr('已收回 {count} 个 Bot', { count: done }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="faint" style={{ fontSize: 12 }}>{tr('已放开 {n} / {total}', { n: unleashed, total: workers.length })}</span>
      <button className="btn sm ghost" disabled={busy || !unleashed} onClick={() => void apply(false)}>{tr('收回')}</button>
      <button className="btn sm ghost danger" disabled={busy || unleashed === workers.length} onClick={() => void apply(true)}>{tr('放开全部 Bot')}</button>
    </div>
  );
}
