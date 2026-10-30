import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { BotStatus, Routine } from '@shared';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { trapTab } from '@/ui/focus-trap';
import { useStore } from '@/store';
import { Segmented } from '@/ui/Segmented';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { Icon } from '@/ui/icons';
import { ago, clsx } from '@/util';
import { dateLocale, tr } from '@/i18n';
import { monthlyEstimate, runsPerMonth, usd } from './model';
import { runNow, updateBot } from './state';
import { currentBot } from './fields';

/** What one model wake-up costs, roughly, for the month estimate of a routine without a precheck. */
const PER_RUN_USD = 0.05;
const MONTH_MINUTES = 30 * 24 * 60;

export function cadenceText(r: Pick<Routine, 'cron' | 'everyMinutes'>): string {
  if (r.everyMinutes && r.everyMinutes > 0) return tr('每 {n} 分钟', { n: r.everyMinutes });
  if (r.cron) return `cron ${r.cron}`;
  return tr('只手动');
}

/** Wakes more often than every 5 minutes. */
const tooOften = (r: Routine) => { const n = runsPerMonth(r); return n > 0 && MONTH_MINUTES / n < 5; };

const when = (t: number | undefined) => (t ? new Date(t).toLocaleString(dateLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function onFailLabel(v: Routine['onFail']): string {
  switch (v) {
    case 'retry_up': return tr('换高一档重试');
    case 'resume': return tr('接着跑');
    case 'inbox': return tr('交给我');
  }
}

type Draft = { name: string; prompt: string; mode: 'cron' | 'every'; cron: string; every: string; precheck: string; script: string; timeout: string; onFail: Routine['onFail'] };

function toDraft(r?: Routine): Draft {
  return {
    name: r?.name ?? '', prompt: r?.prompt ?? '',
    mode: r?.cron && !r.everyMinutes ? 'cron' : 'every',
    cron: r?.cron ?? '', every: r?.everyMinutes ? String(r.everyMinutes) : (r ? '' : '60'),
    precheck: r?.precheck ?? '', script: r?.acceptance.kind === 'script' ? r.acceptance.script : '',
    timeout: r?.timeoutMin ? String(r.timeoutMin) : '', onFail: r?.onFail ?? 'inbox',
  };
}

/** The fields the form edits — merged into the routine as stored when 保存 is pressed (the rest is the scheduler's). */
export type RoutineEdit = Pick<Routine, 'name' | 'prompt' | 'cron' | 'everyMinutes' | 'precheck' | 'acceptance' | 'timeoutMin' | 'onFail'>;

function fromDraft(d: Draft): RoutineEdit | string {
  const name = d.name.trim();
  if (!name) return tr('例行需要一个名字');
  if (!d.prompt.trim()) return tr('写一下这个例行要做什么');
  const every = Number(d.every);
  if (d.mode === 'every' && !(Number.isFinite(every) && every >= 1)) return tr('间隔至少 1 分钟');
  if (d.mode === 'cron' && d.cron.trim().split(/\s+/).length !== 5) return tr('cron 要五段：分 时 日 月 周');
  const timeout = Number(d.timeout);
  return {
    name, prompt: d.prompt.trim(),
    cron: d.mode === 'cron' ? d.cron.trim() : undefined,
    everyMinutes: d.mode === 'every' ? every : undefined,
    precheck: d.precheck.trim() || undefined,
    acceptance: d.script.trim() ? { kind: 'script', script: d.script.trim() } : { kind: 'none' },
    timeoutMin: d.timeout.trim() && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    onFail: d.onFail,
  };
}

/**
 * Send the bot's routines with one change: `change` gets the list as the store has it at this moment (after any
 * await), so the scheduler's bookkeeping (lastRunAt / nextRunAt / failures) and other routines are never sent stale.
 */
export async function patchRoutines(botId: string, change: (cur: Routine[]) => Routine[] | string): Promise<boolean> {
  const bot = currentBot(botId);
  if (!bot) return false;
  const next = change(bot.routines);
  if (typeof next === 'string') { useStore.getState().toast(next); return false; }
  return updateBot(botId, { routines: next });
}

const newRoutineId = () => `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The one-screen form for a routine (new or existing). Escape closes it; nothing is saved until 保存. */
function RoutineEditor({ routine, onSave, onClose }: { routine?: Routine; onSave: (r: RoutineEdit) => Promise<boolean>; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  // the focus goes into the form when it opens (the name box)
  useEffect(() => { box.current?.querySelector<HTMLElement>('input, textarea')?.focus(); }, []);
  const [d, setD] = useState<Draft>(() => toDraft(routine));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const save = async () => {
    const r = fromDraft(d);
    if (typeof r === 'string') { setErr(r); return; }
    setBusy(true);
    const ok = await onSave(r);
    setBusy(false);
    if (ok) onClose();
  };
  // Escape from anywhere in the form (a Select's own list closes itself first: it prevents the default); Tab stays inside
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented && !imeComposing(e.nativeEvent)) { e.stopPropagation(); e.preventDefault(); onClose(); return; }
    trapTab(e, box.current);
  };
  const failOptions = (['retry_up', 'resume', 'inbox'] as const).map((v) => ({ value: v, label: onFailLabel(v) }));
  return (
    <div className="modal-bg dialog-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKey}>
      <div ref={box} tabIndex={-1} className="modal dialog bd-routine-editor" role="dialog" aria-modal="true" aria-label={routine ? tr('编辑例行') : tr('添加例行')}>
        <h3>{routine ? tr('编辑例行') : tr('添加例行')}</h3>
        <div className="bd-form">
          <label><span>{tr('名字')}</span><input className="field" value={d.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label><span>{tr('要做什么')}</span><textarea className="field" rows={4} value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} /></label>
          <div className="bd-row">
            <span>{tr('节奏')}</span>
            <span className="bd-pair">
              <Segmented label={tr('节奏')} value={d.mode} onChange={(mode) => set({ mode })} options={[{ value: 'every', label: tr('每隔') }, { value: 'cron', label: 'cron' }]} />
              {d.mode === 'every'
                ? <><input className="field num" aria-label={tr('间隔（分钟）')} value={d.every} onChange={(e) => set({ every: e.target.value })} /><span className="bd-unit">{tr('分钟')}</span></>
                : <input className="field mono" aria-label="cron" placeholder="0 9 * * 1-5" value={d.cron} onChange={(e) => set({ cron: e.target.value })} />}
            </span>
          </div>
          <label><span>{tr('预检脚本')}</span><textarea className="field mono" rows={2} placeholder={tr('输出没变就跳过、不唤醒模型（可不填）')} value={d.precheck} onChange={(e) => set({ precheck: e.target.value })} /></label>
          <label><span>{tr('验收脚本')}</span><textarea className="field mono" rows={2} placeholder={tr('退出码 0 算通过（可不填）')} value={d.script} onChange={(e) => set({ script: e.target.value })} /></label>
          <div className="bd-row">
            <span>{tr('超时')}</span>
            <span className="bd-pair"><input className="field num" aria-label={tr('超时（分钟）')} placeholder={tr('默认')} value={d.timeout} onChange={(e) => set({ timeout: e.target.value })} /><span className="bd-unit">{tr('分钟')}</span></span>
          </div>
          <div className="bd-row"><span>{tr('失败时')}</span><Select label={tr('失败时')} value={d.onFail} options={failOptions} onValueChange={(v) => set({ onFail: v as Routine['onFail'] })} /></div>
        </div>
        {err && <div className="bd-err" role="alert">{err}</div>}
        <div className="actions">
          <button className="btn" onClick={onClose}>{tr('取消')}</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>{tr('保存')}</button>
        </div>
      </div>
    </div>
  );
}

/** The routines of a bot: cadence, cost when nothing gates the model, acceptance, last / next, failures, on/off. */
export function RoutineTable({ bot, routines, adding }: { bot: BotStatus; routines: Routine[]; adding?: boolean }) {
  const [editing, setEditing] = useState<Routine | 'new' | null>(null);
  const setEnabled = (id: string, enabled: boolean) => void patchRoutines(bot.id, (cur) => cur.map((x) => (x.id === id ? { ...x, enabled } : x)));
  const remove = async (r: Routine) => {
    if (await dlg.confirm(tr('删除例行「{name}」？', { name: r.name }), { danger: true, focusCancel: true, okLabel: tr('删除') })) void patchRoutines(bot.id, (cur) => cur.filter((x) => x.id !== r.id));
  };
  // the form's fields over the routine as stored now (a form open for minutes doesn't put back an old copy)
  const save = (id: string | undefined) => (edit: RoutineEdit) => patchRoutines(bot.id, (cur) => {
    if (!id) return [...cur, { id: newRoutineId(), enabled: true, ...edit }];
    if (!cur.some((x) => x.id === id)) return tr('这个例行已经被删掉了');
    return cur.map((x) => (x.id === id ? { ...x, ...edit } : x));
  });
  return (
    <div className="bd-routines">
      {routines.length > 0 ? (
        <table className="bd-table">
          <thead>
            <tr>
              <th>{tr('名字')}</th><th>{tr('节奏')}</th><th>{tr('预检')}</th><th>{tr('验收')}</th><th>{tr('上次 / 下次')}</th><th>{tr('失败')}</th><th>{tr('开')}</th><th />
            </tr>
          </thead>
          <tbody>
            {routines.map((r) => {
              const hot = tooOften(r);
              return (
                <tr key={r.id} data-id={r.id}>
                  <td className="bd-r-name">{r.name}{r.shadow && <span className="bot-tag">{tr('影子')}</span>}</td>
                  <td>{cadenceText(r)}</td>
                  <td>
                    {r.precheck ? tr('有') : (
                      <span className={clsx('bd-cost', hot && 'hot')} title={tr('按每次约 {usd} 估算', { usd: usd(PER_RUN_USD) })}>
                        {tr('每次都会唤醒模型')}
                        {runsPerMonth(r) > 0 && <> · {tr('约 {usd}/月', { usd: usd(monthlyEstimate(r, PER_RUN_USD)) })}</>}
                      </span>
                    )}
                  </td>
                  <td>{r.acceptance.kind === 'script' ? tr('脚本') : tr('无')}</td>
                  <td className="bd-when" title={r.lastRunAt ? new Date(r.lastRunAt).toLocaleString(dateLocale()) : undefined}>{r.lastRunAt ? ago(r.lastRunAt) : '—'} / {when(r.nextRunAt)}</td>
                  <td className={clsx((r.failures ?? 0) > 0 && 'bd-fail')}>{r.failures ?? 0}</td>
                  <td><Switch on={r.enabled} label={tr('启用「{name}」', { name: r.name })} onChange={(enabled) => setEnabled(r.id, enabled)} /></td>
                  <td className="bd-acts">
                    <button className="icon-btn" title={tr('立即运行')} aria-label={tr('立即运行')} onClick={() => void runNow(bot.id, r.id)}><Icon name="play" size={13} /></button>
                    <button className="icon-btn" title={tr('编辑')} aria-label={tr('编辑')} onClick={() => setEditing(r)}><Icon name="edit" size={13} /></button>
                    <button className="icon-btn" title={tr('删除')} aria-label={tr('删除')} onClick={() => void remove(r)}><Icon name="trash" size={13} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <div className="bd-note">{tr('还没有例行任务')}</div>}
      {adding && <button className="btn sm bd-add" onClick={() => setEditing('new')}><Icon name="plus" size={12} />{tr('添加例行')}</button>}
      {editing && <RoutineEditor routine={editing === 'new' ? undefined : editing} onSave={save(editing === 'new' ? undefined : editing.id)} onClose={() => setEditing(null)} />}
    </div>
  );
}
