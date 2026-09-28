import { useMemo, useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import type { AgentKind, OrchNode, PermissionMode, Workflow } from '@shared';
import { Graph, KIND_ICON } from './Graph';
import { nextNodeId, promptVars } from './graph-layout';
import { agentIcon, agentLabel } from './labels';

export type WorkflowDraft = Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

const KIND_L: Record<OrchNode['kind'], string> = { task: '任务', compare: '比选', approval: '审批' };
const PERM: { v: PermissionMode; l: string }[] = [{ v: 'default', l: '每次询问' }, { v: 'acceptEdits', l: '自动接受编辑' }, { v: 'plan', l: '只规划' }, { v: 'bypassPermissions', l: '完全权限' }];

/** Convert a node to another kind, keeping what carries over (id, title, deps, prompt). */
function withKind(n: OrchNode, kind: OrchNode['kind'], agents: AgentKind[]): OrchNode {
  const base = { id: n.id, title: n.title, dependsOn: n.dependsOn };
  const prompt = n.kind === 'approval' ? '' : n.prompt;
  if (kind === 'task') return { ...base, kind, agent: n.kind === 'task' ? n.agent : (n.kind === 'compare' ? n.agents[0] : undefined) ?? agents[0] ?? 'claude', prompt, workspace: 'shared', permissionMode: 'acceptEdits' };
  if (kind === 'compare') return { ...base, kind, agents: agents.slice(0, 2), prompt, permissionMode: 'acceptEdits' };
  return { ...base, kind, note: '' };
}

function NodeCard({ n, all, agents, index, count, onChange, onMove, onRemove }: {
  n: OrchNode; all: OrchNode[]; agents: AgentKind[]; index: number; count: number;
  onChange: (n: OrchNode) => void; onMove: (d: -1 | 1) => void; onRemove: () => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const others = all.filter((x) => x.id !== n.id);
  const vars = promptVars(all, n.id);
  const insert = (token: string) => {
    if (n.kind === 'approval') return;
    const el = ta.current;
    const at = el ? el.selectionStart : n.prompt.length;
    const next = n.prompt.slice(0, at) + token + n.prompt.slice(el ? el.selectionEnd : at);
    onChange({ ...n, prompt: next });
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = at + token.length; } });
  };
  const agentOpts = (cur?: AgentKind): AgentKind[] => [...new Set([...(cur ? [cur] : []), ...agents])];
  return (
    <div className={clsx('orch-node-edit', `k-${n.kind}`)} id={`orch-edit-${n.id}`}>
      <div className="hd">
        <Icon name={KIND_ICON[n.kind]} size={14} />
        <input className="field title" value={n.title} placeholder="节点名称" onChange={(e) => onChange({ ...n, title: e.target.value })} />
        <span className="mono id" title="模板里用这个 id 引用它">{n.id}</span>
        <button className="icon-btn xs" disabled={index === 0} onClick={() => onMove(-1)} title="上移" aria-label="上移"><Icon name="chevronDown" size={12} className="flip" /></button>
        <button className="icon-btn xs" disabled={index === count - 1} onClick={() => onMove(1)} title="下移" aria-label="下移"><Icon name="chevronDown" size={12} /></button>
        <button className="icon-btn xs" onClick={onRemove} title="删除节点" aria-label="删除节点"><Icon name="trash" size={12} /></button>
      </div>
      <div className="grid">
        <label>类型<select className="field" value={n.kind} onChange={(e) => onChange(withKind(n, e.target.value as OrchNode['kind'], agents))}>{(['task', 'compare', 'approval'] as const).map((k) => <option key={k} value={k}>{KIND_L[k]}</option>)}</select></label>
        {n.kind === 'task' && <>
          <label>Agent<select className="field" value={n.agent} onChange={(e) => onChange({ ...n, agent: e.target.value as AgentKind })}>{agentOpts(n.agent).map((a) => <option key={a} value={a}>{agentLabel(a)}{agents.includes(a) ? '' : '（不可用）'}</option>)}</select></label>
          <label>工作区<select className="field" value={n.workspace} onChange={(e) => onChange({ ...n, workspace: e.target.value as 'shared' | 'worktree' })}><option value="shared">共享工作目录</option><option value="worktree">独立 worktree（完成后合并）</option></select></label>
          <label>权限<select className="field" value={n.permissionMode ?? 'default'} onChange={(e) => onChange({ ...n, permissionMode: e.target.value as PermissionMode })}>{PERM.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}</select></label>
          <label>模型（空 = 默认）<input className="field" value={n.model ?? ''} onChange={(e) => onChange({ ...n, model: e.target.value || undefined })} /></label>
          <label className="check"><input type="checkbox" checked={!!n.untilDone} onChange={(e) => onChange({ ...n, untilDone: e.target.checked || undefined })} /> 一直做到完成（目标协议）</label>
        </>}
        {n.kind === 'compare' && <>
          <label>裁判（可选）<select className="field" value={n.judge ?? ''} onChange={(e) => onChange({ ...n, judge: (e.target.value || undefined) as AgentKind | undefined })}><option value="">不用裁判</option>{agents.map((a) => <option key={a} value={a}>{agentLabel(a)}</option>)}</select></label>
          <label>权限<select className="field" value={n.permissionMode ?? 'acceptEdits'} onChange={(e) => onChange({ ...n, permissionMode: e.target.value as PermissionMode })}>{PERM.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}</select></label>
        </>}
        {n.kind === 'approval' && <label className="wide">说明（给审批人看）<input className="field" value={n.note ?? ''} onChange={(e) => onChange({ ...n, note: e.target.value })} placeholder="例如：看一眼计划再决定是否实现" /></label>}
      </div>
      {n.kind === 'compare' && (
        <div className="chips" role="group" aria-label="候选 agent">
          <span className="lbl">候选</span>
          {agentOpts().concat(n.agents.filter((a) => !agents.includes(a))).map((a) => (
            <button key={a} type="button" className={clsx('chip', n.agents.includes(a) && 'on', !agents.includes(a) && 'bad')} onClick={() => onChange({ ...n, agents: n.agents.includes(a) ? n.agents.filter((x) => x !== a) : [...n.agents, a] })}><Icon name={agentIcon(a)} size={11} /> {agentLabel(a)}</button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="chips" role="group" aria-label="依赖">
          <span className="lbl">依赖</span>
          {others.map((o) => <button key={o.id} type="button" className={clsx('chip', n.dependsOn.includes(o.id) && 'on')} onClick={() => onChange({ ...n, dependsOn: n.dependsOn.includes(o.id) ? n.dependsOn.filter((x) => x !== o.id) : [...n.dependsOn, o.id] })}>{o.title || o.id}</button>)}
        </div>
      )}
      {n.kind !== 'approval' && <>
        <textarea ref={ta} className="field mono" rows={4} value={n.prompt} onChange={(e) => onChange({ ...n, prompt: e.target.value })} placeholder="提示词。可以用下面的变量引用启动输入和上游节点的结果" />
        <div className="vars">{vars.map((v) => <button key={v.token} type="button" className="var" onClick={() => insert(v.token)} title={v.label}>{v.token}</button>)}</div>
      </>}
    </div>
  );
}

/** Form editor: node list with live graph preview above. Saving validates on the server (cycles, deps, git). */
export function WorkflowEditor({ initial, onSaved, onRun, onCancel }: { initial: WorkflowDraft; onSaved: (w: Workflow) => void; onRun: (w: Workflow) => void; onCancel: () => void }) {
  const allAgents = useStore((s) => s.agents);
  const workspaces = useStore((s) => s.workspaces);
  const [w, setW] = useState<WorkflowDraft>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agents = useMemo(() => {
    const ok = allAgents.filter((a) => a.installed && a.enabled).map((a) => a.kind);
    return ok.length ? ok : (['claude'] as AgentKind[]);
  }, [allAgents]);
  // node ids are fixed once created (templates reference them), so replacing in place is enough
  const setNode = (i: number, n: OrchNode) => setW((cur) => ({ ...cur, nodes: cur.nodes.map((x, j) => (j === i ? n : x)) }));
  const add = (kind: OrchNode['kind']) => setW((cur) => {
    const id = nextNodeId(cur.nodes.map((n) => n.id));
    const last = cur.nodes[cur.nodes.length - 1];
    const seed: OrchNode = { id, kind: 'task', title: '', agent: agents[0], prompt: '', dependsOn: last ? [last.id] : [], workspace: 'shared', permissionMode: 'acceptEdits' };
    const n = kind === 'task' ? seed : withKind(seed, kind, agents);
    n.title = `${KIND_L[kind]} ${id.slice(1)}`;
    return { ...cur, nodes: [...cur.nodes, n] };
  });
  const move = (i: number, d: -1 | 1) => setW((cur) => { const nodes = [...cur.nodes]; const [x] = nodes.splice(i, 1); nodes.splice(i + d, 0, x); return { ...cur, nodes }; });
  const remove = (i: number) => setW((cur) => { const gone = cur.nodes[i].id; return { ...cur, nodes: cur.nodes.filter((_, j) => j !== i).map((n) => ({ ...n, dependsOn: n.dependsOn.filter((d) => d !== gone) })) }; });
  const save = async (): Promise<Workflow | null> => {
    setBusy(true);
    setErr(null);
    try { const saved = await ws.request<Workflow>({ kind: 'orchestra.workflows.save', workflow: w }); setW({ ...w, id: saved.id }); onSaved(saved); return saved; } catch (e: any) { setErr(e.message); return null; } finally { setBusy(false); }
  };
  const cwds = [...new Set([w.cwd, ...workspaces.map((x) => x.path)])].filter(Boolean);
  return (
    <div className="orch-editor">
      <div className="orch-meta">
        <input className="field name" value={w.name} placeholder="工作流名称" onChange={(e) => setW({ ...w, name: e.target.value })} />
        <select className="field" value={w.cwd} onChange={(e) => setW({ ...w, cwd: e.target.value })} title="工作目录（worktree / 比选要求是 git 仓库）">{!w.cwd && <option value="">选择工作目录…</option>}{cwds.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        <input className="field desc" value={w.description ?? ''} placeholder="说明（可选）" onChange={(e) => setW({ ...w, description: e.target.value || undefined })} />
      </div>
      <div className="orch-sec-h">执行图预览</div>
      <Graph nodes={w.nodes} onSelect={(id) => document.getElementById(`orch-edit-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })} />
      <div className="orch-sec-h">节点 <span className="muted">{w.nodes.length}</span></div>
      <div className="orch-nodes">
        {w.nodes.map((n, i) => <NodeCard key={n.id} n={n} all={w.nodes} agents={agents} index={i} count={w.nodes.length} onChange={(x) => setNode(i, x)} onMove={(d) => move(i, d)} onRemove={() => remove(i)} />)}
        <div className="orch-add">
          <button className="btn sm ghost" onClick={() => add('task')}><Icon name="plus" size={12} /> 任务</button>
          <button className="btn sm ghost" onClick={() => add('compare')}><Icon name="compare" size={12} /> 比选</button>
          <button className="btn sm ghost" onClick={() => add('approval')}><Icon name="approval" size={12} /> 审批</button>
        </div>
      </div>
      {err && <pre className="orch-err">{err}</pre>}
      <div className="orch-foot">
        <button className="btn sm ghost" onClick={onCancel}>关闭</button>
        <span className="grow" />
        <button className="btn sm" disabled={busy || !w.name.trim() || !w.cwd} onClick={() => void save()}>保存</button>
        <button className="btn sm primary" disabled={busy || !w.name.trim() || !w.cwd || !w.nodes.length} onClick={async () => { const s = await save(); if (s) onRun(s); }}><Icon name="play" size={12} /> 保存并运行</button>
      </div>
    </div>
  );
}
