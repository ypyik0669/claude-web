import { useEffect, useMemo, useRef, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { ago, clsx, fmtMs } from '@/util';
import { dlg } from '@/ui/dialog';
import type { PermissionMode, Schedule, ScheduleRun } from '@shared';
import { EMPTY, MODE_LABEL } from '@/ui/terms';
import { EmptyState } from '@/ui/EmptyState';
import { untilText } from '@/features/home/model';
import { Icon } from '@/ui/icons';

interface Template { id: string; name: string; cron: string; prompt: string; permissionMode: PermissionMode; freshSession?: boolean }

const PRESET_CRONS = [
  { l: '每 30 分钟', v: '*/30 * * * *' },
  { l: '每小时', v: '0 * * * *' },
  { l: '工作日 9:00', v: '0 9 * * 1-5' },
  { l: '每天 18:00', v: '0 18 * * *' },
  { l: '每周一 9:00', v: '0 9 * * 1' },
];

function describe(s: Schedule) {
  if (s.cron) return s.cron;
  return `每 ${s.everyMinutes} 分钟`;
}

/**
 * Schedule editor: interval or cron, template gallery, run history with links into the conversation. `page`: on the
 * automation page, whose header has the 新建 button (`newSignal` is its last click); `compact`: in 任务.
 */
export function SchedulesView({ compact = false, page = false, newSignal = 0 }: { compact?: boolean; page?: boolean; newSignal?: number }) {
  const schedules = useStore((s) => s.schedules);
  const active = useScopedSession();
  const toast = useStore((s) => s.toast);
  const loadHistory = useStore((s) => s.loadHistory);
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null);
  const [mode, setMode] = useState<'interval' | 'cron'>('cron');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [showRuns, setShowRuns] = useState<string | null>(null);
  const [tab, setTab] = useState<'list' | 'templates' | 'history'>('list');
  useEffect(() => { ws.request<Template[]>({ kind: 'schedules.templates' }).then(setTemplates).catch(() => {}); }, []);
  useEffect(() => { if (tab === 'history' || showRuns) ws.request<ScheduleRun[]>({ kind: 'schedules.history', id: showRuns ?? undefined, limit: 100 }).then(setRuns).catch(() => setRuns([])); }, [tab, showRuns, schedules]);

  const save = async () => {
    const e = editing!;
    if (!e.prompt?.trim()) return toast('需要提示词');
    const cwd = e.cwd?.trim() || active?.cwd;
    if (!cwd) return toast('需要工作目录');
    const patch: Partial<Schedule> = { ...e, cwd, name: e.name?.trim() || e.prompt!.slice(0, 30), enabled: e.enabled ?? true };
    if (mode === 'cron') { if (!e.cron?.trim()) return toast('需要 cron 表达式'); patch.cron = e.cron.trim(); }
    // '' not undefined: undefined is dropped by JSON and the server merges the patch, so a cron schedule
    // switched to an interval kept its cron (which wins over everyMinutes)
    else { patch.cron = ''; patch.everyMinutes = Number(e.everyMinutes) || 60; }
    try { await ws.request({ kind: 'schedules.upsert', schedule: patch }); setEditing(null); toast('已保存', true); } catch (x: any) { toast(x.message); }
  };
  const fromTemplate = (t: Template) => { setMode('cron'); setEditing({ name: t.name, prompt: t.prompt, cron: t.cron, permissionMode: t.permissionMode, freshSession: t.freshSession, cwd: active?.cwd ?? '' }); setTab('list'); };
  const byId = useMemo(() => new Map(schedules.map((s) => [s.id, s])), [schedules]);
  const startNew = () => { setMode('cron'); setEditing({ cwd: active?.cwd ?? '', permissionMode: 'acceptEdits', everyMinutes: 60, cron: '0 9 * * 1-5' }); setTab('list'); };
  // the automation page's 新建: each click once (not on mount — the page mounts this tab on its first visit)
  const appliedNew = useRef(newSignal);
  useEffect(() => { if (newSignal && newSignal !== appliedNew.current) { appliedNew.current = newSignal; startNew(); } }, [newSignal]);

  const form = editing && (
    <div className="sched-form">
      <input className="field" placeholder="名称（可选）" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
      <textarea className="field" rows={3} placeholder="每次运行发送给 Claude 的提示词" value={editing.prompt ?? ''} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} />
      <div className="row" style={{ gap: 6 }}>
        <span className="seg mini"><button className={mode === 'cron' ? 'active' : ''} onClick={() => setMode('cron')}>cron</button><button className={mode === 'interval' ? 'active' : ''} onClick={() => setMode('interval')}>间隔</button></span>
        {mode === 'cron' ? (
          <>
            <input className="field mono" style={{ width: 150 }} placeholder="分 时 日 月 周" value={editing.cron ?? ''} onChange={(e) => setEditing({ ...editing, cron: e.target.value })} />
            <select className="field" value="" onChange={(e) => e.target.value && setEditing({ ...editing, cron: e.target.value })}><option value="">常用…</option>{PRESET_CRONS.map((p) => <option key={p.v} value={p.v}>{p.l} · {p.v}</option>)}</select>
          </>
        ) : (
          <>每 <input className="field" type="number" min={1} style={{ width: 70 }} value={editing.everyMinutes ?? 60} onChange={(e) => setEditing({ ...editing, everyMinutes: Number(e.target.value) })} /> 分钟</>
        )}
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input className="field grow" placeholder={active?.cwd ? `工作目录：${active.cwd}` : '工作目录'} value={editing.cwd ?? ''} onChange={(e) => setEditing({ ...editing, cwd: e.target.value })} />
        <select className="field" value={editing.permissionMode ?? 'acceptEdits'} onChange={(e) => setEditing({ ...editing, permissionMode: e.target.value })}>{Object.entries(MODE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>
      <label className="row muted" style={{ gap: 6, fontSize: 12 }}><input type="checkbox" checked={!!editing.freshSession} onChange={(e) => setEditing({ ...editing, freshSession: e.target.checked })} /> 每次新开对话（不累积上下文）</label>
      <div className="row" style={{ gap: 6 }}><button className="btn sm primary" onClick={save}>保存</button><button className="btn sm" onClick={() => setEditing(null)}>取消</button></div>
    </div>
  );

  return (
    <div className={clsx('sched-view', compact && 'compact', page && 'page')}>
      <div className="subtabs">
        <button className={tab === 'list' ? 'active' : ''} onClick={() => setTab('list')}>{page ? '全部' : '定时任务'} {schedules.length ? <span className="badge">{schedules.length}</span> : null}</button>
        <button className={tab === 'templates' ? 'active' : ''} onClick={() => setTab('templates')}>模板</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => { setShowRuns(null); setTab('history'); }}>历史</button>
        <span className="grow" />
        {!page && <button className="icon-btn" title="新建定时任务" aria-label="新建定时任务" onClick={startNew}><Icon name="plus" size={15} /></button>}
      </div>
      {tab === 'list' && (
        <div className="list">
          {form}
          {schedules.map((sc) => (
            <div key={sc.id} className={clsx('row sched', sc.lastError && 'err')}>
              <button className={clsx('toggle', sc.enabled && 'on')} onClick={() => ws.request({ kind: 'schedules.upsert', schedule: { id: sc.id, enabled: !sc.enabled } })} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sc.name} <span className="mono muted" style={{ fontSize: 11 }}>{describe(sc)}</span>{sc.freshSession && <span className="badge">每次新对话</span>}</div>
                <div className="sub">{sc.lastRunAt ? `上次 ${ago(sc.lastRunAt)}` : '未运行'}{sc.runs ? ` · ${sc.runs} 次` : ''}{sc.enabled && sc.nextRunAt ? ` · 下次 ${untilText(sc.nextRunAt)}` : ''}{sc.lastError ? ` · ${sc.lastError}` : ''}</div>
              </div>
              {sc.sessionId && <button className="btn sm ghost" title="打开它的对话" onClick={() => loadHistory(sc.sessionId!)}>对话</button>}
              <button className="btn sm ghost" title="历史" onClick={() => { setShowRuns(sc.id); setTab('history'); }}>历史</button>
              <button className="btn sm ghost" title="编辑" onClick={() => { setMode(sc.cron ? 'cron' : 'interval'); setEditing({ ...sc }); }}><Icon name="edit" size={13} /></button>
              <button className="btn sm ghost" title="立即运行" onClick={() => ws.request({ kind: 'schedules.runNow', id: sc.id }).catch((e) => toast(e.message))}><Icon name="play" size={12} /></button>
              <button className="btn sm ghost danger" title="删除" onClick={async () => { if (await dlg.confirm(`删除定时任务「${sc.name}」？`, { danger: true })) void ws.request({ kind: 'schedules.remove', id: sc.id }); }}><Icon name="trash" size={13} /></button>
            </div>
          ))}
          {!schedules.length && !editing && <EmptyState e={EMPTY.schedules} action={<button className="btn sm" onClick={() => setTab('templates')}>从模板开始</button>} />}
        </div>
      )}
      {tab === 'templates' && (
        <div className="list">
          {templates.map((t) => (
            <div key={t.id} className="row">
              <span><Icon name="tasks" size={13} /></span>
              <div className="grow"><div>{t.name} <span className="mono muted" style={{ fontSize: 11 }}>{t.cron}</span></div><div className="sub">{t.prompt.slice(0, 120)}…</div></div>
              <button className="btn sm" onClick={() => fromTemplate(t)}>使用</button>
            </div>
          ))}
        </div>
      )}
      {tab === 'history' && (
        <div className="list">
          {showRuns && <div className="row muted" style={{ fontSize: 12 }}>只看「{byId.get(showRuns)?.name ?? showRuns}」 <button className="link" onClick={() => setShowRuns(null)}>全部</button></div>}
          {runs.map((r) => (
            <div key={r.id} className="row">
              <span className={clsx('dot', r.ok ? 'idle' : 'error')} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div>{byId.get(r.scheduleId)?.name ?? r.scheduleId} <span className="muted" style={{ fontSize: 11.5 }}>{ago(r.at)}{r.durationMs ? ` · ${fmtMs(r.durationMs)}` : ''}</span></div>
                <div className="sub" style={{ whiteSpace: 'pre-wrap' }}>{r.error ?? r.summary ?? ''}</div>
              </div>
              {r.sessionId && <button className="btn sm ghost" title="打开这次运行的对话" onClick={() => loadHistory(r.sessionId!)}>对话</button>}
            </div>
          ))}
          {!runs.length && <EmptyState e={EMPTY.scheduleRuns} />}
        </div>
      )}
    </div>
  );
}
