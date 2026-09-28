import { useEffect, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { ago, basename, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import type { OrchRun, Workflow, WorkflowTemplate } from '@shared';
import { WorkflowEditor, type WorkflowDraft } from './WorkflowEditor';
import { RunView, RUN_L } from './RunView';
import { useOrch } from './state';
import { Orphans } from './Orphans';
import { EMPTY, emptyText } from '@/ui/terms';
import './orchestra.css';

type View = { kind: 'none' } | { kind: 'edit'; draft: WorkflowDraft; key: number } | { kind: 'run'; runId: string };

/** Ask for the run input, start it, return the run (or null when cancelled / failed). */
export async function startWorkflow(w: Workflow): Promise<OrchRun | null> {
  const usesInput = w.nodes.some((n) => n.kind !== 'approval' && n.prompt.includes('{{input}}'));
  const input = usesInput ? await dlg.prompt(`运行「${w.name}」`, '', { message: '这段文字会填进提示词里的 {{input}}。', multiline: true, placeholder: '要做的事 / bug 描述 / 需求…', okLabel: '开始' }) : ((await dlg.confirm(`运行「${w.name}」？`, { okLabel: '开始' })) ? '' : null);
  if (input === null) return null;
  try { return await ws.request<OrchRun>({ kind: 'orchestra.run.start', workflowId: w.id, input }); } catch (e: any) { await dlg.alert('没能启动', { message: e.message }); return null; }
}

/**
 * Orchestration panel: workflows + run history on the left; the form editor (with a live graph preview)
 * or a run view (execution graph, approvals, compare) on the right. Stacks vertically when narrow. `newSignal`: the
 * automation page's 新建 (its last click) opens a new workflow.
 */
export function OrchestraPanel({ newSignal = 0 }: { newSignal?: number }) {
  const workflows = useOrch((s) => s.workflows);
  const runs = useOrch((s) => s.runs);
  const templates = useOrch((s) => s.templates);
  const intent = useOrch((s) => s.intent);
  const workspaces = useStore((s) => s.workspaces);
  const activeCwd = useStore((s) => (s.activeId ? s.open[s.activeId]?.cwd : undefined));
  const [view, setView] = useState<View>({ kind: 'none' });
  const [hint, setHint] = useState(false);
  const defaultCwd = activeCwd ?? workspaces[0]?.path ?? '';

  const newDraft = (t?: WorkflowTemplate): WorkflowDraft => ({ name: t?.name ?? '新编排', description: t?.description, cwd: defaultCwd, nodes: t ? structuredClone(t.nodes) : [] });
  const edit = (draft: WorkflowDraft) => setView({ kind: 'edit', draft, key: Date.now() });
  const run = async (w: Workflow) => { const r = await startWorkflow(w); if (r) { useOrch.setState((s) => ({ full: { ...s.full, [r.id]: r } })); setView({ kind: 'run', runId: r.id }); } };

  useEffect(() => { void useOrch.getState().loadAll().catch(() => {}); }, []);
  const appliedNew = useRef(newSignal);
  useEffect(() => { if (newSignal && newSignal !== appliedNew.current) { appliedNew.current = newSignal; edit(newDraft()); } }, [newSignal]);
  useEffect(() => {
    if (!intent) return;
    if (intent.mode === 'new') edit(newDraft());
    else if (intent.mode === 'open') setView({ kind: 'run', runId: intent.runId });
    else { setView({ kind: 'none' }); setHint(true); }
  }, [intent?.at]);

  return (
    <div className="orch">
      <div className="orch-side">
        <div className="orch-side-h">
          <b>工作流</b>
          <span className="grow" />
          <select className="field tpl" value="" onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) edit(newDraft(t)); }} title="从内置模板新建">
            <option value="">模板…</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="icon-btn xs" title="新建工作流" aria-label="新建工作流" onClick={() => edit(newDraft())}><Icon name="plus" size={13} /></button>
        </div>
        {hint && <div className="orch-hint">选一个工作流，点 <Icon name="play" size={11} /> 运行</div>}
        <div className="orch-list">
          {workflows.map((w) => (
            <div key={w.id} className={clsx('orch-row', view.kind === 'edit' && view.draft.id === w.id && 'sel')} onClick={() => edit(structuredClone(w))}>
              <div className="grow">
                <div className="t">{w.name}</div>
                <div className="s">{w.nodes.length} 个节点 · {basename(w.cwd)}</div>
              </div>
              <button className="icon-btn xs" title="运行" aria-label={`运行 ${w.name}`} onClick={(e) => { e.stopPropagation(); setHint(false); void run(w); }}><Icon name="play" size={12} /></button>
              <button className="icon-btn xs" title="删除" aria-label={`删除 ${w.name}`} onClick={async (e) => { e.stopPropagation(); if (await dlg.confirm(`删除工作流「${w.name}」？`, { message: '运行记录保留。', danger: true, okLabel: '删除' })) { await ws.request({ kind: 'orchestra.workflows.remove', id: w.id }).catch(() => {}); if (view.kind === 'edit' && view.draft.id === w.id) setView({ kind: 'none' }); } }}><Icon name="trash" size={12} /></button>
            </div>
          ))}
          {!workflows.length && <div className="orch-empty sm">{emptyText(EMPTY.workflows)}</div>}
        </div>
        <div className="orch-side-h"><b>运行记录</b><span className="grow" /><span className="muted">{runs.length}</span></div>
        <div className="orch-list runs">
          {runs.map((r) => (
            <div key={r.id} className={clsx('orch-row', view.kind === 'run' && view.runId === r.id && 'sel')} onClick={() => setView({ kind: 'run', runId: r.id })}>
              <span className={clsx('dot', r.state === 'running' ? 'running' : r.state === 'waiting' ? 'waiting' : r.state === 'failed' ? 'error' : r.state === 'done' ? 'idle' : '')} />
              <div className="grow">
                <div className="t">{r.name}</div>
                <div className="s">{RUN_L[r.state]} · {r.done}/{r.total} · {ago(r.startedAt)}</div>
              </div>
              {r.waiting > 0 && <span className="badge run">{r.waiting} 等你</span>}
            </div>
          ))}
          {!runs.length && <div className="orch-empty sm">{emptyText(EMPTY.orchestraRuns)}</div>}
        </div>
        <Orphans />
      </div>
      <div className="orch-main">
        {view.kind === 'none' && (
          <div className="orch-empty">
            <Icon name="orchestra" size={28} />
            <div>把一件事拆成几步，每步交给一个 agent；可以并行、可以让几个 agent 各做一版再比选，关键节点等你审批。</div>
            <div className="acts">
              <button className="btn sm" onClick={() => edit(newDraft())}><Icon name="plus" size={12} /> 新建工作流</button>
              {templates.map((t) => <button key={t.id} className="btn sm ghost" onClick={() => edit(newDraft(t))}>{t.name}</button>)}
            </div>
          </div>
        )}
        {view.kind === 'edit' && <WorkflowEditor key={view.key} initial={view.draft} onSaved={(w) => useOrch.setState((s) => ({ workflows: [w, ...s.workflows.filter((x) => x.id !== w.id)] }))} onRun={(w) => void run(w)} onCancel={() => setView({ kind: 'none' })} />}
        {view.kind === 'run' && <RunView key={view.runId} runId={view.runId} onClose={() => setView({ kind: 'none' })} />}
      </div>
    </div>
  );
}
