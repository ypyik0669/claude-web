// 设置 → Bot (spec 2026-10-30-duty-bots-design §「设置 → Bot」, §10): the controls of the rows that are more than a
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

const msg = (e: unknown) => (e as Error)?.message ?? String(e);

/** 全局预算 (USD a day across all bots): a number ≥ 0; empty or 0 = none. Saved on blur / Enter. */
export function BotsBudget({ label }: { label: string }) {
  const v = useStore((s) => s.settings['bots.globalBudgetUsd']);
  const set = useStore((s) => s.setSetting);
  const saved = typeof v === 'number' ? String(v) : '';
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  const commit = () => {
    const t = text.trim();
    if (t === saved) return;
    const n = Number(t);
    if (t && (!Number.isFinite(n) || n < 0)) {
      useStore.getState().toast(tr('预算要填一个不小于 0 的数，或者留空'));
      setText(saved);
      return;
    }
    // empty or 0 = no global budget (the server reads only a positive number)
    void set('bots.globalBudgetUsd', t && n > 0 ? n : undefined);
    if (!(n > 0)) setText('');
  };
  return (
    <input className="field" type="number" min={0} step="any" inputMode="decimal" aria-label={label} placeholder={tr('不设')} value={text}
      style={{ width: 110 }}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) { e.preventDefault(); commit(); } }} />
  );
}

/**
 * 默认来源: a provider bots without their own use. Empty = the conversation default. A Claude account is allowed (the
 * product refuses nothing, §10) but asks once with the concrete risk.
 */
export function BotsDefaultProvider({ label }: { label: string }) {
  const v = useStore((s) => s.settings['bots.defaultProvider']);
  const providers = useStore((s) => s.providers);
  const set = useStore((s) => s.setSetting);
  useEffect(() => { if (!useStore.getState().providers.length) void useStore.getState().loadProviders().catch(() => {}); }, []);
  const cur = typeof v === 'string' ? v : '';
  const options = [
    { value: '', label: tr('跟新对话的默认一样') },
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
  return <MenuSelect className="field" aria-label={label} label={label} value={cur} onValueChange={(x) => void pick(String(x))} options={options} />;
}

const failed = (on: boolean, detail: string) => (on ? tr('没能打开值班服务：{detail}', { detail }) : tr('没能关闭值班服务：{detail}', { detail }));

interface DutyResult { on: boolean; ok: boolean; detail: string; at: number }
const DUTY_KEY = 'bots.duty.last';

/**
 * 值班服务 (headless): register the server as a per-user service. There is no "is it installed" request, so the switch
 * shows the last result (kept in meta.json) and says the system's own task list is what counts.
 */
export function BotsDutyService({ label }: { label: string }) {
  const last = useStore((s) => s.settings[DUTY_KEY]) as DutyResult | undefined;
  const set = useStore((s) => s.setSetting);
  const [busy, setBusy] = useState(false);
  const on = !!last && last.ok && last.on;
  const flip = async () => {
    const want = !on;
    setBusy(true);
    try {
      const r = await ws.request<{ ok: boolean; detail: string }>({ kind: 'bots.duty.install', mode: 'service', on: want });
      const res: DutyResult = { on: want, ok: !!r?.ok, detail: r?.detail ?? '', at: Date.now() };
      // a failed "off" leaves it as it was: keep showing on
      void set(DUTY_KEY, res.ok ? res : { ...res, on: on });
      useStore.getState().toast(res.ok ? res.detail || (want ? tr('值班服务已打开') : tr('值班服务已关闭')) : failed(want, res.detail));
    } catch (e) {
      useStore.getState().toast(failed(want, msg(e)));
    } finally {
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
    let done = 0;
    try {
      for (const b of targets) {
        try {
          await ws.request({ kind: 'bots.unleash', id: b.id, on });
          done++;
        } catch (e) {
          const message = msg(e);
          useStore.getState().toast(on
            ? tr('「{name}」没能放开，后面的没有再动（已处理 {done} 个）：{message}', { name: b.name, done, message })
            : tr('「{name}」没能收回，后面的没有再动（已处理 {done} 个）：{message}', { name: b.name, done, message }));
          return;
        }
      }
      useStore.getState().toast(on ? tr('已放开 {count} 个 Bot', { count: done }) : tr('已收回 {count} 个 Bot', { count: done }));
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
