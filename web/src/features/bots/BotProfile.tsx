// 值班 Bot 资料栏（spec 2026-10-31 聊天优先 §1 / §6）: one bot's profile — 资料 / 电脑 / 例行 / 权限 / 记忆 / 用量 — in a
// column at the right of its conversation (a phone: its own screen). Hidden, never unmounted; it scrolls back to the
// section it was left on (useBots.profileSection). Every edit here is the user's own (updateBot), never the bot's.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotRun, BotStatus, MemoryItem, Routine } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { dlg } from '@/ui/dialog';
import { Switch } from '@/ui/Switch';
import { Icon } from '@/ui/icons';
import { fillComposer } from '@/features/composer/fill';
import { useContextUsage } from '@/features/composer/ContextMeter';
import { ago, clsx } from '@/util';
import { dateLocale, tr } from '@/i18n';
import { BotAvatar } from './BotAvatar';
import { avatarString, COLORS, SHAPES } from './avatar-model';
import { cadenceText, runCost, usd } from './model';
import { lastScreen } from './profile-model';
import { loadRuns, runNow, showProfile, updateBot, useBots, type BotProfileSection } from './state';
import { BlurField, patchRoutines } from './fields';
import { PolicyEditor } from './PolicyEditor';

const NO_RUNS: BotRun[] = [];

const SECTIONS: { id: BotProfileSection; label: () => string }[] = [
  { id: 'profile', label: () => tr('资料') },
  { id: 'computer', label: () => tr('电脑') },
  { id: 'routines', label: () => tr('例行') },
  { id: 'policy', label: () => tr('权限') },
  { id: 'memory', label: () => tr('记忆') },
  { id: 'usage', label: () => tr('用量') },
];

const when = (t: number | undefined) => (t ? new Date(t).toLocaleString(dateLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

function Section({ id, title, children }: { id: BotProfileSection; title: string; children: React.ReactNode }) {
  return (
    <section className="bp-sect" data-section={id}>
      <h4 className="bp-h">{title}</h4>
      {children}
    </section>
  );
}

/** 资料: the face (换一个), name, 职位, whether it may notify you. */
function ProfilePart({ bot }: { bot: BotStatus }) {
  const reface = () => void updateBot(bot.id, { avatar: avatarString({ shape: Math.floor(Math.random() * SHAPES.length), color: Math.floor(Math.random() * COLORS.length), seed: Math.floor(Math.random() * 1000) }) });
  return (
    <div className="bp-profile">
      <div className="bp-face">
        <BotAvatar name={bot.name} avatar={bot.avatar} size={64} />
        <button className="btn sm ghost" onClick={reface}><Icon name="refresh" size={12} />{tr('换一个')}</button>
      </div>
      <div className="bd-form">
        <label><span>{tr('名字')}</span><BlurField label={tr('名字')} value={bot.name} onSave={(v) => (v.trim() ? updateBot(bot.id, { name: v.trim() }) : false)} /></label>
        <label><span>{tr('职位')}</span><BlurField label={tr('职位')} placeholder={tr('一句话说它是干什么的')} value={bot.title ?? ''} onSave={(v) => updateBot(bot.id, { title: v.trim() || undefined })} /></label>
        <div className="bd-row"><span>{tr('通知我')}</span><Switch on={bot.notify !== false} label={tr('通知我')} onChange={(on) => void updateBot(bot.id, { notify: on })} /></div>
      </div>
    </div>
  );
}

/** 电脑 (最近画面): the last picture a browser / computer tool returned in its conversation or its latest run. */
function ComputerPart({ bot }: { bot: BotStatus }) {
  const runs = useBots((s) => s.runs[bot.id] ?? NO_RUNS);
  const runSid = runs.find((r) => r.sessionId)?.sessionId ?? '';
  const thread = useStore((s) => (bot.threadId ? s.open[bot.threadId] : undefined));
  const run = useStore((s) => (runSid ? s.open[runSid] : undefined));
  const shot = useMemo(() => {
    const a = lastScreen(thread?.conv), b = lastScreen(run?.conv);
    return a && b ? ((b.at ?? 0) > (a.at ?? 0) ? b : a) : a ?? b;
    // the conversations change in place: their version says when
  }, [thread?.conv, thread?.version, run?.conv, run?.version]);
  if (!shot) return <div className="bd-note bp-idle">{tr('电脑闲着')}</div>;
  return (
    <figure className="bp-screen">
      <img src={shot.src} alt={tr('最近画面')} />
      <figcaption>{tr('最近画面')}{shot.at ? ` · ${ago(shot.at)}` : ''}</figcaption>
    </figure>
  );
}

/** One routine: a dot, its name, its rhythm, the switch; open: what it does, the next run, the last five, the buttons. */
function RoutineRow({ bot, r, runs }: { bot: BotStatus; r: Routine; runs: BotRun[] }) {
  const [open, setOpen] = useState(false);
  const mine = useMemo(() => runs.filter((x) => x.routineId === r.id).slice(0, 5), [runs, r.id]);
  const setEnabled = (enabled: boolean) => void patchRoutines(bot.id, (cur) => cur.map((x) => (x.id === r.id ? { ...x, enabled } : x)));
  const remove = async () => {
    if (await dlg.confirm(tr('删除例行「{name}」？', { name: r.name }), { danger: true, focusCancel: true, okLabel: tr('删除') })) void patchRoutines(bot.id, (cur) => cur.filter((x) => x.id !== r.id));
  };
  // 编辑 is said to the bot in its conversation: it changes its own routines
  const edit = () => { showProfile(false); fillComposer({ tileId: 'bot', text: tr('改一下例行：{name}', { name: r.name }), focus: true }); };
  const failing = (r.failures ?? 0) > 0;
  return (
    <li className={clsx('bp-routine', open && 'open')} data-id={r.id}>
      <div className="bp-r-line">
        <button className="bp-r-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <i className={clsx('bp-dot', r.enabled ? (failing ? 'bad' : 'on') : 'off')} />
          <span className="bp-r-name">{r.name}</span>
          <span className="bp-r-when">{cadenceText(r) || tr('只在手动运行时')}</span>
        </button>
        <Switch on={r.enabled} label={tr('启用')} onChange={setEnabled} />
      </div>
      {open && (
        <div className="bp-r-body">
          <div className="bp-r-prompt">{r.prompt}</div>
          <div className="bd-hint">{tr('下次运行：{when}', { when: r.enabled ? when(r.nextRunAt) : '—' })}</div>
          {mine.length > 0 && (
            <ul className="bp-r-runs">
              {mine.map((x) => (
                <li key={x.id} data-ok={x.ok === undefined ? undefined : String(x.ok)}>
                  <span>{when(x.at)}</span>
                  <span>{x.skipped ? tr('跳过') : !x.endedAt ? tr('在跑…') : x.ok ? tr('完成') : tr('失败')}</span>
                  {!x.skipped && x.endedAt && <span className="bd-hint">{runCost(x)}</span>}
                </li>
              ))}
            </ul>
          )}
          <div className="bp-r-acts">
            <button className="btn sm" onClick={() => setEnabled(!r.enabled)}>{r.enabled ? tr('暂停') : tr('继续')}</button>
            <button className="btn sm" onClick={() => void runNow(bot.id, r.id)}>{tr('测试')}</button>
            <button className="btn sm" onClick={edit}>{tr('编辑')}</button>
            <button className="btn sm danger" onClick={() => void remove()}>{tr('删除')}</button>
          </div>
        </div>
      )}
    </li>
  );
}

function RoutinesPart({ bot }: { bot: BotStatus }) {
  const runs = useBots((s) => s.runs[bot.id] ?? NO_RUNS);
  useEffect(() => { void loadRuns(bot.id); }, [bot.id]);
  return (
    <div className="bp-routines">
      {bot.routines.length > 0 && <ul className="bp-list">{bot.routines.map((r) => <RoutineRow key={r.id} bot={bot} r={r} runs={runs} />)}</ul>}
      <div className="bd-note">{tr('在对话里说一句就能加')}</div>
    </div>
  );
}

/** 记忆: what it remembers (scope 'bot'); edit in place, 「这条不对」 removes it. */
function MemoryPart({ bot, shown }: { bot: BotStatus; shown: boolean }) {
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    setErr('');
    ws.request<MemoryItem[]>({ kind: 'memory.search', scope: 'bot', botId: bot.id, limit: 200 })
      .then((m) => { if (live) setItems((Array.isArray(m) ? m : []).filter((x) => x.scope === 'bot')); })
      .catch((e: any) => { if (live) { setItems([]); setErr(String(e?.message ?? e)); } });
    return () => { live = false; };
  }, [bot.id, tick, shown]);
  const save = async (m: MemoryItem, text: string) => {
    if (!text.trim()) return false;
    try { await ws.request({ kind: 'memory.update', id: m.id, patch: { text: text.trim() } }); setTick((t) => t + 1); return true; }
    catch (e: any) { useStore.getState().toast(tr('保存失败：{message}', { message: String(e?.message ?? e) })); return false; }
  };
  const wrong = async (m: MemoryItem) => {
    if (!(await dlg.confirm(tr('删掉这条记忆？'), { message: m.text, danger: true, focusCancel: true, okLabel: tr('删除') }))) return;
    try { await ws.request({ kind: 'memory.remove', id: m.id }); setTick((t) => t + 1); } catch (e: any) { useStore.getState().toast(tr('删除失败：{message}', { message: String(e?.message ?? e) })); }
  };
  if (err) return <div className="bd-note">{tr('读不到记忆：{err}', { err })}</div>;
  if (!items) return <div className="bd-note">{tr('读取中…')}</div>;
  if (!items.length) return <div className="bd-note">{tr('它还没记下什么。在对话里让它记住的事会在这里。')}</div>;
  return (
    <ul className="bd-memory">
      {items.map((m) => (
        <li key={m.id}>
          <BlurField multiline className="bd-mem-text" label={tr('记忆')} value={m.text} onSave={(v) => save(m, v)} />
          <button className="btn sm ghost" onClick={() => void wrong(m)}>{tr('这条不对')}</button>
        </li>
      ))}
    </ul>
  );
}

/** 用量: this week against the budget, today, its own conversation, and how full that conversation's context is. */
function UsagePart({ bot }: { bot: BotStatus }) {
  const ctx = useContextUsage(bot.threadId ?? '');
  const weekBudget = bot.budget.weeklyUsd ?? (bot.budget.dailyUsd !== undefined ? bot.budget.dailyUsd * 7 : undefined);
  return (
    <div className="bd-form bp-usage">
      <div className="bd-row"><span>{tr('本周')}</span><span>{weekBudget !== undefined ? tr('{used} / 预算 {budget}', { used: usd(bot.weekUsd), budget: usd(weekBudget) }) : usd(bot.weekUsd)}</span></div>
      <div className="bd-row"><span>{tr('今天')}</span><span>{usd(bot.todayUsd)}</span></div>
      <div className="bd-row"><span>{tr('这个对话')}</span><span>{usd(bot.threadUsd ?? 0)}</span></div>
      {ctx && (
        <div className="bd-row">
          <span>{tr('上下文')}</span>
          <span className="bp-ctx" title={`${ctx.totalTokens} / ${ctx.maxTokens}`}>
            <svg width="14" height="14" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" className="bp-ring-bg" /><circle cx="18" cy="18" r="15" className="bp-ring" strokeDasharray={`${Math.min(100, ctx.percentage) * 0.942} 94.2`} /></svg>
            {Math.round(ctx.percentage)}%
          </span>
        </div>
      )}
    </div>
  );
}

/** The profile column. `shown`: on screen (the memory is only asked for then). */
export function BotProfile({ bot, shown }: { bot: BotStatus; shown: boolean }) {
  const section = useBots((s) => s.profileSection);
  const root = useRef<HTMLDivElement>(null);
  // back to where it was left, each time it shows (and when a section is picked)
  useEffect(() => {
    if (!shown) return;
    root.current?.querySelector(`[data-section="${section}"]`)?.scrollIntoView({ block: 'start' });
  }, [shown, section, bot.id]);
  return (
    <div className="bot-profile" ref={root} aria-label={tr('{name} 的资料', { name: bot.name })} data-bot={bot.id}>
      <div className="bp-top">
        <nav className="bp-nav" aria-label={tr('资料')}>
          {SECTIONS.map((s) => (
            <button key={s.id} className={clsx('chip', section === s.id && 'on')} aria-current={section === s.id ? 'true' : undefined} onClick={() => useBots.setState({ profileSection: s.id })}>{s.label()}</button>
          ))}
        </nav>
        <button className="icon-btn" title={tr('关闭资料')} aria-label={tr('关闭资料')} onClick={() => showProfile(false)}><Icon name="close" size={14} /></button>
      </div>
      <Section id="profile" title={tr('资料')}><ProfilePart bot={bot} /></Section>
      <Section id="computer" title={tr('电脑')}><ComputerPart bot={bot} /></Section>
      <Section id="routines" title={tr('例行')}><RoutinesPart bot={bot} /></Section>
      <Section id="policy" title={tr('权限')}><PolicyEditor bot={bot} /></Section>
      <Section id="memory" title={tr('记忆')}><MemoryPart bot={bot} shown={shown} /></Section>
      <Section id="usage" title={tr('用量')}><UsagePart bot={bot} /></Section>
    </div>
  );
}
