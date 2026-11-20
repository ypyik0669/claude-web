import { useEffect, useMemo, useRef, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { basename, clsx, fmtMs } from '@/util';
import { dlg } from '@/ui/dialog';
import type { PermissionMode, Schedule, ScheduleRun } from '@shared';
import { EMPTY, MODE_LABEL, TERMS } from '@/ui/terms';
import { EmptyState } from '@/ui/EmptyState';
import { agoText } from '@/features/home/model';
import { isWithin } from '@/features/paths';
import { Icon } from '@/ui/icons';
import { cronText, nextRunText, scheduleText } from './schedule-text';
import { SCHEDULES_HERO, templateLook } from './templates';
import { tr } from '@/i18n';
import { Select } from '@/ui/Select';
import { Switch, SwitchLine } from '@/ui/Switch';
import { pickFolder } from '@/ui/pick-folder';
import { Menu } from '@/features/sidebar/menus';

interface Template { id: string; name: string; cron: string; prompt: string; permissionMode: PermissionMode; freshSession?: boolean }

const setEnabled = (sc: Schedule, enabled: boolean) => ws.request({ kind: 'schedules.upsert', schedule: { id: sc.id, enabled } });
const runNow = (sc: Schedule, toast: (m: string) => void) => ws.request({ kind: 'schedules.runNow', id: sc.id }).catch((e) => toast(e.message));
async function removeSchedule(sc: Schedule): Promise<void> {
  if (await dlg.confirm(tr('删除定时任务「{name}」？', { name: sc.name }), { danger: true })) void ws.request({ kind: 'schedules.remove', id: sc.id });
}

/**
 * A phone's ⋯ on a scheduled task (problem 12 of the plan's phone table: four buttons squeezed the name to three
 * characters): 启用 · 立即运行 · 它的对话 · 运行记录 · 编辑 · 删除 — an action sheet there.
 */
function ScheduleMenu({ sc, onClose, onRuns, onEdit }: { sc: Schedule; onClose: () => void; onRuns: () => void; onEdit: () => void }) {
  const toast = useStore((s) => s.toast);
  const loadHistory = useStore((s) => s.loadHistory);
  const act = (fn: () => unknown) => () => { onClose(); void fn(); };
  return (
    <Menu onClose={onClose} label={sc.name} className="sched-menu" align="right">
      <button type="button" role="menuitemcheckbox" aria-checked={sc.enabled} data-id="enabled" onClick={act(() => setEnabled(sc, !sc.enabled))}>
        <Icon name="tasks" size={14} />{tr('启用')}<span className={clsx('toggle sm', sc.enabled && 'on')} aria-hidden />
      </button>
      <button type="button" data-id="run" onClick={act(() => runNow(sc, toast))}><Icon name="play" size={14} />{tr('立即运行')}</button>
      {sc.sessionId && <button type="button" data-id="chat" onClick={act(() => loadHistory(sc.sessionId!))}><Icon name="chat" size={14} />{tr('打开它的对话')}</button>}
      <button type="button" data-id="runs" onClick={act(onRuns)}><Icon name="refresh" size={14} />{tr('运行记录')}</button>
      <button type="button" data-id="edit" onClick={act(onEdit)}><Icon name="edit" size={14} />{tr('编辑')}</button>
      <div className="menu-sep" />
      <button type="button" data-id="delete" className="danger" onClick={act(() => removeSchedule(sc))}><Icon name="trash" size={14} />{tr('删除…')}</button>
    </Menu>
  );
}

/** A phone's row: the name on a line of its own (two at most), when it runs under it, the rest behind ⋯. */
function PhoneScheduleRow({ sc, onRuns, onEdit }: { sc: Schedule; onRuns: () => void; onEdit: () => void }) {
  const [menu, setMenu] = useState(false);
  const when = scheduleText(sc);
  return (
    <div className={clsx('row sched phone', sc.lastError && 'err', !sc.enabled && 'off')} data-sched={sc.id}>
      <div className="sched-tx">
        <div className="sched-name">{sc.name}</div>
        <div className="sched-when">
          <span title={when.title}>{when.text}</span>
          {sc.freshSession && <span className="badge">{tr('每次新对话')}</span>}
          {!sc.enabled && <span className="badge">{tr('已停用')}</span>}
        </div>
        <div className="sub">{sc.lastRunAt ? tr('上次 {agoText}', { agoText: agoText(sc.lastRunAt) }) : tr('未运行')}{sc.runs ? tr(' · {runs} 次', { runs: sc.runs }) : ''}{sc.enabled && sc.nextRunAt ? tr(' · 下次 {nextRunText}', { nextRunText: nextRunText(sc.nextRunAt) }) : ''}{sc.lastError ? ` · ${sc.lastError}` : ''}</div>
      </div>
      <span className="sched-more">
        <button type="button" className="icon-btn" title={tr('更多')} aria-label={tr('「{name}」的更多操作', { name: sc.name })} aria-haspopup="menu" aria-expanded={menu} data-act="more" onClick={(e) => { e.stopPropagation(); setMenu((m) => !m); }}><Icon name="more" size={18} /></button>
        {menu && <ScheduleMenu sc={sc} onClose={() => setMenu(false)} onRuns={onRuns} onEdit={onEdit} />}
      </span>
    </div>
  );
}

const PRESET_CRONS = [
  { l: tr('每 30 分钟'), v: '*/30 * * * *' },
  { l: tr('每小时'), v: '0 * * * *' },
  { l: tr('工作日 9:00'), v: '0 9 * * 1-5' },
  { l: tr('每天 18:00'), v: '0 18 * * *' },
  { l: tr('每周一 9:00'), v: '0 9 * * 1' },
];

/** The 「其它文件夹…」 entry of the project list (not a path). */
const OTHER = '<other>';

/**
 * Schedule editor: interval or cron, template gallery, run history with links into the conversation. `page`: on the
 * automation page, whose header has the 新建 button (`newSignal` is its last click); `compact`: in 任务.
 */
export function SchedulesView({ compact = false, page = false, newSignal = 0 }: { compact?: boolean; page?: boolean; newSignal?: number }) {
  const schedules = useStore((s) => s.schedules);
  const workspaces = useStore((s) => s.workspaces);
  const active = useScopedSession();
  const toast = useStore((s) => s.toast);
  const loadHistory = useStore((s) => s.loadHistory);
  const mobile = useStore((s) => s.mobile);
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null);
  // 手动 (the official app's Manual): no schedule, only 立即运行 starts it
  const [mode, setMode] = useState<'interval' | 'cron' | 'manual'>('cron');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [showRuns, setShowRuns] = useState<string | null>(null);
  const [tab, setTab] = useState<'list' | 'templates' | 'history'>('list');
  useEffect(() => { ws.request<Template[]>({ kind: 'schedules.templates' }).then(setTemplates).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'history' || showRuns) ws.request<ScheduleRun[]>({ kind: 'schedules.history', id: showRuns ?? undefined, limit: 100 }).then(setRuns).catch(() => setRuns([])); }, [tab, showRuns, schedules]);

  // the project a new schedule runs in: the current conversation's project, else the first project (review 7 I4)
  const defaultCwd = () => {
    const cur = active?.cwd;
    const ws = cur ? [...workspaces].sort((a, b) => b.path.length - a.path.length).find((w) => isWithin(cur, w.path)) : undefined;
    return ws?.path ?? cur ?? workspaces[0]?.path ?? '';
  };
  const browse = async () => {
    const p = await pickFolder({ start: editing?.cwd }).catch(() => null);
    if (p && editing) setEditing({ ...editing, cwd: p });
  };
  const save = async () => {
    const e = editing!;
    if (!e.prompt?.trim()) return toast(tr('需要提示词'));
    const cwd = e.cwd?.trim() || defaultCwd();
    if (!cwd) return toast(tr('先选一个项目文件夹'));
    const patch: Partial<Schedule> = { ...e, cwd, name: e.name?.trim() || e.prompt!.slice(0, 30), enabled: e.enabled ?? true };
    patch.manual = mode === 'manual';
    if (mode === 'manual') { /* the timing it had stays, for switching back */ }
    else if (mode === 'cron') { if (!e.cron?.trim()) return toast(tr('需要 cron 表达式')); patch.cron = e.cron.trim(); }
    // '' not undefined: undefined is dropped by JSON and the server merges the patch, so a cron schedule
    // switched to an interval kept its cron (which wins over everyMinutes)
    else { patch.cron = ''; patch.everyMinutes = Number(e.everyMinutes) || 60; }
    try { await ws.request({ kind: 'schedules.upsert', schedule: patch }); setEditing(null); toast(tr('已保存'), true); } catch (x: any) { toast(x.message); }
  };
  const fromTemplate = (t: Template) => { setMode('cron'); setEditing({ name: t.name, prompt: t.prompt, cron: t.cron, permissionMode: t.permissionMode, freshSession: t.freshSession, cwd: defaultCwd() }); setTab('list'); };
  const byId = useMemo(() => new Map(schedules.map((s) => [s.id, s])), [schedules]);
  const startNew = () => { setMode('cron'); setEditing({ cwd: defaultCwd(), permissionMode: 'acceptEdits', everyMinutes: 60, cron: '0 9 * * 1-5' }); setTab('list'); };
  // the automation page's 新建: each click once (not on mount — the page mounts this tab on its first visit)
  const appliedNew = useRef(newSignal);
  useEffect(() => { if (newSignal && newSignal !== appliedNew.current) { appliedNew.current = newSignal; startNew(); } }, [newSignal]);

  // the project list: the projects, plus the current conversation's folder and the schedule's own when they are not
  // one of them, and 其它文件夹… (a folder picker)
  const cwdNow = editing ? (editing.cwd?.trim() || defaultCwd()) : '';
  const projectOptions = useMemo(() => {
    const out = workspaces.map((w) => ({ path: w.path, label: w.name || basename(w.path) }));
    for (const extra of [active?.cwd, cwdNow]) if (extra && !out.some((o) => o.path === extra)) out.push({ path: extra, label: basename(extra) || extra });
    return out;
  }, [workspaces, active?.cwd, cwdNow]);
  const period = editing && mode === 'cron' && editing.cron ? cronText(editing.cron) : null;

  const form = editing && (
    <div className="sched-form">
      <input className="field sf-full" placeholder={tr('名称（可选）')} value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
      <textarea className="field sf-full" rows={3} placeholder={tr('每次运行发送给 Claude 的提示词')} value={editing.prompt ?? ''} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} />
      <div className="sf-row">
        <span className="sf-l">{tr('时间')}</span>
        <span className="seg mini"><button className={mode === 'cron' ? 'active' : ''} onClick={() => setMode('cron')} title={tr('cron 表达式：分 时 日 月 周')}>{tr('按时间')}</button><button className={mode === 'interval' ? 'active' : ''} onClick={() => setMode('interval')}>{tr('间隔')}</button><button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')} title={tr('不定时，只在点「立即运行」时跑')}>{tr('手动')}</button></span>
        {mode === 'cron' ? (
          <>
            <input className="field mono sf-cron" placeholder={tr('分 时 日 月 周')} value={editing.cron ?? ''} onChange={(e) => setEditing({ ...editing, cron: e.target.value })} />
            <Select className="field sf-pick" value="" onValueChange={(value) => String(value) && setEditing({ ...editing, cron: String(value) })} aria-label={tr('常用时间')} options={[{ value: '', label: tr('常用…') }, ...PRESET_CRONS.map((p) => ({ value: p.v, label: p.l }))]} />
            {period && <span className="sf-hint">{period}</span>}
          </>
        ) : mode === 'manual' ? (
          <span className="sf-hint">{tr('只在点「立即运行」时跑')}</span>
        ) : (
          <>{tr('每')} <input className="field sf-num" type="number" min={1} value={editing.everyMinutes ?? 60} onChange={(e) => setEditing({ ...editing, everyMinutes: Number(e.target.value) })} /> {tr('分钟')}</>
        )}
      </div>
      <div className="sf-row">
        <span className="sf-l">{tr('项目')}</span>
        <Select className="field sf-proj" data-id="sched-project" value={cwdNow} title={cwdNow} onValueChange={(value) => (String(value) === OTHER ? void browse() : setEditing({ ...editing, cwd: String(value) }))} aria-label={tr('项目')} searchable options={[
          ...(cwdNow ? [] : [{ value: '', label: tr('选一个项目…') }]),
          ...projectOptions.map((o) => ({ value: o.path, label: o.label })),
          { value: OTHER, label: tr('其它文件夹…') },
        ]} />
        <span className="sf-l">{tr('权限')}</span>
        <Select className="field sf-pick" value={editing.permissionMode ?? 'acceptEdits'} onValueChange={(value) => setEditing({ ...editing, permissionMode: String(value) })} aria-label={tr('权限')} options={Object.entries(MODE_LABEL).map(([k, l]) => ({ value: k, label: l }))} />
      </div>
      <SwitchLine className="sf-check" on={!!editing.freshSession} onChange={(on) => setEditing({ ...editing, freshSession: on, ...(on ? {} : { worktree: false }) })}>{tr('每次新开对话（不累积上下文）')}</SwitchLine>
      {editing.freshSession && <SwitchLine className="sf-check" on={!!editing.worktree} onChange={(on) => setEditing({ ...editing, worktree: on })}>{tr('每次在独立的{worktree}里跑（不碰你工作区里没提交的改动）', { worktree: TERMS.worktree })}</SwitchLine>}
      <div className="sf-row"><button className="btn sm primary" onClick={save}>{tr('保存')}</button><button className="btn sm" onClick={() => setEditing(null)}>{tr('取消')}</button></div>
    </div>
  );

  const templateRows = templates.map((t) => (
    <div key={t.id} className="row">
      <span><Icon name="tasks" size={13} /></span>
      <div className="grow"><div>{t.name} <span className="muted sched-period" title={`cron：${t.cron}`}>{cronText(t.cron) ?? t.cron}</span></div><div className="sub">{t.prompt.slice(0, 120)}…</div></div>
      <button className="btn sm" onClick={() => fromTemplate(t)}>{tr('使用')}</button>
    </div>
  ));

  const templateCards = templates.map((t) => {
    const look = templateLook(t);
    return (
      <button key={t.id} type="button" className="tpl-card" data-tpl={t.id} title={tr('用这个模板新建：{prompt}', { prompt: t.prompt })} onClick={() => fromTemplate(t)}>
        <span className={clsx('tile-ic', `tint-${look.tint}`)}><Icon name={look.icon} size={18} /></span>
        <span className="tpl-tx">
          <span className="tpl-n">{t.name}</span>
          <span className="tpl-d">{look.desc}</span>
          <span className="tpl-when" title={`cron：${t.cron}`}>{cronText(t.cron) ?? t.cron}</span>
        </span>
      </button>
    );
  });
  // nothing scheduled yet (and no form open): the page says what this is, then the templates
  const blank = page && tab === 'list' && !schedules.length && !editing;
  // the records of past runs: always one click away (a deleted task's runs are still there)
  const runsLink = <button className="link" data-id="sched-runs" title={tr('每次运行的结果和它的对话')} onClick={() => { setShowRuns(null); setTab('history'); }}><Icon name="refresh" size={13} />{tr('运行记录')}</button>;

  return (
    <div className={clsx('sched-view', compact && 'compact', page && 'page', blank && 'blank')} data-view={tab}>
      {/* the automation page's own 定时任务 tab is the title: no second tab row under it (polish: 定时任务 › 全部 read
          twice) — the list, then 从模板开始 below it; 运行记录 is a link, and the records say how to get back */}
      {page ? !blank && (
        <div className="sv-bar">
          {tab === 'history' ? (
            <>
              <button className="link sv-back" data-id="sched-back" onClick={() => { setShowRuns(null); setTab('list'); }}><Icon name="chevronLeft" size={13} />{tr('定时任务')}</button>
              <span className="sv-sep">/</span>
              <span className="sv-cur">{tr('运行记录{v}', { v: showRuns ? `：${byId.get(showRuns)?.name ?? showRuns}` : '' })}</span>
              {showRuns && <button className="link" onClick={() => setShowRuns(null)}>{tr('看全部')}</button>}
            </>
          ) : (
            <>
              <span className="grow" />
              {runsLink}
            </>
          )}
        </div>
      ) : (
        <div className="subtabs">
          <button className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')} title={schedules.length ? tr('{filterCount} 个启用', { filterCount: schedules.filter((x) => x.enabled).length }) : undefined}>{tr('定时任务')}{schedules.length ? <> <span className="badge">{schedules.length}</span></> : null}</button>
          <button className={tab === 'templates' ? 'active' : ''} onClick={() => setTab('templates')}>{tr('模板')}</button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => { setShowRuns(null); setTab('history'); }}>{tr('历史')}</button>
          <span className="grow" />
          <button className="icon-btn" title={tr('新建定时任务')} aria-label={tr('新建定时任务')} onClick={startNew}><Icon name="plus" size={15} /></button>
        </div>
      )}
      {blank && (
        <div className="page-hero" data-id="sched-hero">
          <span className="hero-ic tint-accent"><Icon name="calendar" size={26} /></span>
          <h3>{SCHEDULES_HERO.title}</h3>
          <p>{SCHEDULES_HERO.text}</p>
          <button className="btn primary" onClick={startNew}><Icon name="plus" size={14} />{tr('新建定时任务')}</button>
          {!templates.length && runsLink}
        </div>
      )}
      {tab === 'list' && !blank && (
        <div className="list">
          {form}
          {schedules.map((sc) => {
            const runsOf = () => { setShowRuns(sc.id); setTab('history'); };
            const edit = () => { setMode(sc.manual ? 'manual' : sc.cron ? 'cron' : 'interval'); setEditing({ ...sc }); };
            if (mobile) return <PhoneScheduleRow key={sc.id} sc={sc} onRuns={runsOf} onEdit={edit} />;
            return (
              <div key={sc.id} className={clsx('row sched', sc.lastError && 'err')} data-sched={sc.id}>
                <Switch on={sc.enabled} label={tr('启用「{name}」', { name: sc.name })} onChange={(on) => void setEnabled(sc, on)} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sc.name} <span className="muted sched-period" title={scheduleText(sc).title}>{scheduleText(sc).text}</span>{sc.freshSession && <span className="badge">{tr('每次新对话')}</span>}</div>
                  <div className="sub">{sc.lastRunAt ? tr('上次 {agoText}', { agoText: agoText(sc.lastRunAt) }) : tr('未运行')}{sc.runs ? tr(' · {runs} 次', { runs: sc.runs }) : ''}{sc.enabled && sc.nextRunAt ? tr(' · 下次 {nextRunText}', { nextRunText: nextRunText(sc.nextRunAt) }) : ''}{sc.lastError ? ` · ${sc.lastError}` : ''}</div>
                </div>
                {sc.sessionId && <button className="btn sm ghost" title={tr('打开它的对话')} onClick={() => loadHistory(sc.sessionId!)}>{tr('对话')}</button>}
                <button className="btn sm ghost" title={tr('历史')} onClick={runsOf}>{tr('历史')}</button>
                <button className="btn sm ghost" title={tr('编辑')} onClick={edit}><Icon name="edit" size={13} /></button>
                <button className="btn sm ghost" title={tr('立即运行')} onClick={() => void runNow(sc, toast)}><Icon name="play" size={12} /></button>
                <button className="btn sm ghost danger" title={tr('删除')} onClick={() => void removeSchedule(sc)}><Icon name="trash" size={13} /></button>
              </div>
            );
          })}
          {/* on the page the templates are right below: no button needed to reach them */}
          {!schedules.length && !editing && <EmptyState e={EMPTY.schedules} action={<button className="btn sm" onClick={() => setTab('templates')}>{tr('从模板开始')}</button>} />}
        </div>
      )}
      {page && tab === 'list' && templates.length > 0 && (
        <div className="sv-templates" data-id="sched-templates">
          <div className="sv-h"><span>{tr('从模板开始')}</span><span className="grow" />{blank && runsLink}</div>
          <div className="tpl-grid">{templateCards}</div>
        </div>
      )}
      {!page && tab === 'templates' && <div className="list">{templateRows}</div>}
      {tab === 'history' && (
        <div className="list">
          {!page && showRuns && <div className="row muted" style={{ fontSize: 13 }}>{tr('只看「{name}」', { name: byId.get(showRuns)?.name ?? showRuns })} <button className="link" onClick={() => setShowRuns(null)}>{tr('全部')}</button></div>}
          {runs.map((r) => (
            <div key={r.id} className="row">
              <span className={clsx('dot', r.ok ? 'idle' : 'error')} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div>{byId.get(r.scheduleId)?.name ?? r.scheduleId} <span className="muted" style={{ fontSize: 12 }}>{agoText(r.at)}{r.durationMs ? ` · ${fmtMs(r.durationMs)}` : ''}</span></div>
                <div className="sub" style={{ whiteSpace: 'pre-wrap' }}>{r.error ?? r.summary ?? ''}</div>
              </div>
              {r.sessionId && <button className="btn sm ghost" title={tr('打开这次运行的对话')} onClick={() => loadHistory(r.sessionId!)}>{tr('对话')}</button>}
            </div>
          ))}
          {!runs.length && <EmptyState e={EMPTY.scheduleRuns} />}
        </div>
      )}
    </div>
  );
}
