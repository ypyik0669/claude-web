import { useEffect, useMemo, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon, type IconName } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { Markdown } from '@/features/chat/Markdown';
import type { Goal, GoalEvidence } from '@shared';

const STATUS_L: Record<Goal['status'], string> = { draft: '草稿', active: '进行中', paused: '已暂停', complete: '已完成', blocked: '卡住', max_turns: '到上限' };
const EV_IC: Record<GoalEvidence['kind'], IconName> = { file: 'edit', command: 'bash', test: 'checkCircle', commit: 'commit', note: 'info', error: 'close', blocked: 'alert' };
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const since = (t?: number) => { if (!t) return ''; const s = (Date.now() - t) / 1000; return s < 60 ? `${Math.floor(s)}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${(s / 3600).toFixed(1)}h`; };

function Editor({ g, onDone }: { g: Partial<Goal> & { cwd: string }; onDone: (v: { objective: string; spec: string; cwd: string; maxTurns: number; tokenBudget: number | null; agent: string; permissionMode: string }) => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const agents = useStore((s) => s.agents);
  const [f, setF] = useState({ objective: g.objective ?? '', spec: g.spec ?? '', cwd: g.cwd, maxTurns: g.maxTurns ?? 50, tokenBudget: g.tokenBudget ?? null, agent: g.agent ?? '', permissionMode: g.permissionMode ?? 'acceptEdits' });
  return (
    <div className="goal-editor">
      <label>目标（一句话说清「做到什么算完成」）<textarea className="field" rows={3} value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} placeholder="例如：把 /api/users 的 N+1 查询修掉，加上回归测试，CI 全绿" /></label>
      <label>活规格 / 验收标准（Markdown，可随时改，下一轮生效）<textarea className="field mono" rows={6} value={f.spec} onChange={(e) => setF({ ...f, spec: e.target.value })} placeholder={'- [ ] 验收点 1\n- [ ] 验收点 2\n约束：不改公共 API'} /></label>
      <div className="row3">
        <label>目录<select className="field" value={f.cwd} onChange={(e) => setF({ ...f, cwd: e.target.value })}>{[...new Set([f.cwd, ...workspaces.map((w) => w.path)])].filter(Boolean).map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label>引擎<select className="field" value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value })}><option value="">Claude Code</option>{agents.filter((a) => a.kind !== 'claude' && a.installed && a.enabled).map((a) => <option key={a.kind} value={a.kind}>{a.icon} {a.name}</option>)}</select></label>
        <label>权限<select className="field" value={f.permissionMode} onChange={(e) => setF({ ...f, permissionMode: e.target.value })}><option value="default">每次询问</option><option value="acceptEdits">自动接受编辑</option><option value="bypassPermissions">完全权限</option></select></label>
        <label>最大轮数<input className="field" type="number" value={f.maxTurns} onChange={(e) => setF({ ...f, maxTurns: Number(e.target.value) || 50 })} /></label>
        <label>Token 预算（空 = 不限）<input className="field" type="number" value={f.tokenBudget ?? ''} onChange={(e) => setF({ ...f, tokenBudget: e.target.value ? Number(e.target.value) : null })} /></label>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button className="btn sm" disabled={!f.objective.trim() || !f.cwd} onClick={() => onDone(f)}>保存</button>
      </div>
    </div>
  );
}

function GoalCard({ g, open, onOpen }: { g: Goal; open: boolean; onOpen: () => void }) {
  const toast = useStore((s) => s.toast);
  const setActive = useStore((s) => s.setActive);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'graph' | 'spec' | 'evidence'>('graph');
  const [spec, setSpec] = useState(g.spec);
  useEffect(() => setSpec(g.spec), [g.spec]);
  const req = async (r: any, ok?: string) => { try { await ws.request(r); if (ok) toast(ok, true); } catch (e: any) { toast(e.message); } };
  const done = g.steps.filter((s) => s.status === 'completed').length;
  const pct = g.steps.length ? Math.round((done / g.steps.length) * 100) : g.status === 'complete' ? 100 : 0;
  const tests = g.evidence.filter((e) => e.kind === 'test');
  const lastTest = tests[tests.length - 1];
  return (
    <div className={clsx('goal-card', g.status, open && 'open')}>
      <div className="goal-h" onClick={onOpen}>
        <span className={clsx('dot', g.status === 'active' ? 'running' : g.status === 'blocked' ? 'error' : g.status === 'complete' ? 'idle' : g.status === 'paused' || g.status === 'max_turns' ? 'waiting' : 'idle')} />
        <div className="grow">
          <div className="t">{g.objective.split('\n')[0].slice(0, 120)}</div>
          <div className="m">{STATUS_L[g.status]} · {g.turnsExecuted}/{g.maxTurns} 轮 · {fmt(g.tokensUsed)} tok{g.tokenBudget ? ` / ${fmt(g.tokenBudget)}` : ''}{g.costUsd ? ` · $${g.costUsd.toFixed(2)}` : ''}{g.startedAt && g.status === 'active' ? ` · ${since(g.startedAt)}` : ''}{lastTest ? ` · 测试 ${lastTest.ok === false ? '✗' : lastTest.ok ? '✓' : '…'}` : ''}</div>
        </div>
        <div className="prog" title={`${done}/${g.steps.length} 步`}><div style={{ width: `${pct}%` }} /></div>
      </div>
      {open && (
        <div className="goal-b">
          <div className="actions">
            {(g.status === 'draft' || g.status === 'paused' || g.status === 'blocked' || g.status === 'max_turns') && <button className="btn sm" onClick={() => req({ kind: g.status === 'draft' ? 'goals.start' : 'goals.resume', id: g.id }, g.status === 'draft' ? '已启动' : '继续推进')}><Icon name="play" size={12} /> {g.status === 'draft' ? '启动' : '继续'}</button>}
            {g.status === 'active' && <button className="btn sm ghost" onClick={() => req({ kind: 'goals.pause', id: g.id }, '已暂停')}><Icon name="pause" size={12} /> 暂停</button>}
            {g.status !== 'complete' && <button className="btn sm ghost" onClick={() => req({ kind: 'goals.complete', id: g.id }, '已标记完成')}><Icon name="check" size={12} /> 标记完成</button>}
            {g.sessionId && <button className="btn sm ghost" onClick={() => setActive(g.sessionId!)}>打开会话</button>}
            <button className="btn sm ghost" onClick={() => setEditing(!editing)}>{editing ? '收起' : '编辑'}</button>
            <span className="grow" />
            <button className="btn sm ghost danger" onClick={async () => { if (await dlg.confirm('删除这个目标？', { message: '会话不会被删除。', danger: true, okLabel: '删除' })) await req({ kind: 'goals.remove', id: g.id }); }}>删除</button>
          </div>
          {editing && <Editor g={g} onDone={async (v) => { await req({ kind: 'goals.update', id: g.id, patch: v }, '已保存'); setEditing(false); }} />}
          <div className="seg mini" style={{ alignSelf: 'flex-start' }}>
            <button className={clsx(tab === 'graph' && 'active')} onClick={() => setTab('graph')}>执行图 {g.steps.length ? `${done}/${g.steps.length}` : ''}</button>
            <button className={clsx(tab === 'spec' && 'active')} onClick={() => setTab('spec')}>活规格</button>
            <button className={clsx(tab === 'evidence' && 'active')} onClick={() => setTab('evidence')}>证据 {g.evidence.length}</button>
          </div>
          {tab === 'graph' && (
            <div className="goal-graph">
              {g.steps.length === 0 && <div className="empty">还没有步骤：模型用 TodoWrite 规划后会出现在这里</div>}
              {g.steps.map((s, i) => (
                <div key={s.id} className={clsx('step', s.status)}>
                  <span className="n">{s.status === 'completed' ? <Icon name="check" size={12} /> : s.status === 'in_progress' ? <Icon name="play" size={11} /> : i + 1}</span>
                  <span className="txt">{s.text}</span>
                  {i < g.steps.length - 1 && <span className="edge" />}
                </div>
              ))}
              {g.lastResult && <details className="last"><summary>上一轮结论</summary><Markdown text={g.lastResult} /></details>}
            </div>
          )}
          {tab === 'spec' && (
            <div className="goal-spec">
              <textarea className="field mono" rows={10} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="验收标准、约束、不变量… 改完保存，下一轮提示里生效" />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
                <button className="btn sm" disabled={spec === g.spec} onClick={() => req({ kind: 'goals.update', id: g.id, patch: { spec } }, '规格已更新')}>保存规格</button>
              </div>
            </div>
          )}
          {tab === 'evidence' && (
            <div className="goal-evidence">
              {[...g.evidence].reverse().map((e, i) => (
                <div key={i} className={clsx('ev', e.kind, e.ok === false && 'bad', e.ok === true && 'good')}>
                  <span className="ic">{EV_IC[e.kind]}</span>
                  <span className="txt">{e.summary}</span>
                  <span className="when">{new Date(e.at).toLocaleTimeString()}</span>
                </div>
              ))}
              {g.evidence.length === 0 && <div className="empty">还没有证据</div>}
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input className="field" placeholder="加一条人工备注…" onKeyDown={async (e) => { const v = (e.target as HTMLInputElement).value.trim(); if (e.key === 'Enter' && v) { await req({ kind: 'goals.note', id: g.id, text: v }); (e.target as HTMLInputElement).value = ''; } }} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Goal room: objectives with a living spec, auto-continued sessions, execution graph and evidence. */
export function GoalsPanel() {
  const toast = useStore((s) => s.toast);
  const workspaces = useStore((s) => s.workspaces);
  const activeCwd = useStore((s) => (s.activeId ? s.open[s.activeId]?.cwd : undefined));
  const [goals, setGoals] = useState<Goal[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const load = () => ws.request<Goal[]>({ kind: 'goals.list' }).then(setGoals).catch((e) => toast(e.message));
  useEffect(() => { void load(); const off = ws.on((e) => { if (e.kind === 'goals.changed') void load(); }); return () => { off(); }; }, []);
  const shown = useMemo(() => goals.filter((g) => filter === 'all' || (g.status !== 'complete')).sort((a, b) => b.updatedAt - a.updatedAt), [goals, filter]);
  const counts = useMemo(() => ({ active: goals.filter((g) => g.status === 'active').length, blocked: goals.filter((g) => g.status === 'blocked' || g.status === 'max_turns').length }), [goals]);
  return (
    <div className="goals">
      <div className="goals-head">
        <div className="seg mini"><button className={clsx(filter === 'active' && 'active')} onClick={() => setFilter('active')}>未完成</button><button className={clsx(filter === 'all' && 'active')} onClick={() => setFilter('all')}>全部</button></div>
        <span className="muted" style={{ fontSize: 12 }}>{counts.active} 进行中{counts.blocked ? ` · ${counts.blocked} 需要你` : ''}</span>
        <span className="grow" />
        <button className="btn sm" onClick={() => setCreating(!creating)}>{creating ? '收起' : <><Icon name="plus" size={12} /> 新目标</>}</button>
      </div>
      {creating && <Editor g={{ cwd: activeCwd ?? workspaces[0]?.path ?? '' }} onDone={async (v) => { try { const g = await ws.request<Goal>({ kind: 'goals.create', ...v }); setCreating(false); setOpenId(g.id); if (await dlg.confirm('目标已创建，现在启动？', { message: '会开一个新会话并把目标 + 规格发过去，然后自动一轮轮推进。', okLabel: '启动' })) await ws.request({ kind: 'goals.start', id: g.id }); } catch (e: any) { toast(e.message); } }} />}
      <div className="goals-list">
        {shown.map((g) => <GoalCard key={g.id} g={g} open={openId === g.id} onOpen={() => setOpenId(openId === g.id ? null : g.id)} />)}
        {shown.length === 0 && !creating && <div className="empty">还没有目标。目标 = 一句话的完成标准 + 活规格；会话会一轮轮自动推进，直到模型报告 GOAL_STATUS: complete。也可以在输入框里用 <code>/goal 目标描述</code> 创建。</div>}
      </div>
    </div>
  );
}
