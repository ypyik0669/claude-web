import { useRef, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import type { AgentKind, OrchNode, PermissionMode, Workflow } from '@shared';
import { Graph, kindIcon } from './Graph';
import { nextNodeId, promptVars } from './graph-layout';
import { agentLabel } from './labels';
import { tr } from '@/i18n';
import { Select } from '@/ui/Select';
import { SwitchChip } from '@/ui/Switch';

export type WorkflowDraft = Omit<Workflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };

const KIND_L: Record<OrchNode['kind'], string> = { task: tr('任务'), approval: tr('审批') };
const PERM: { v: PermissionMode; l: string }[] = [{ v: 'default', l: tr('每次询问') }, { v: 'acceptEdits', l: tr('自动接受编辑') }, { v: 'plan', l: tr('只规划') }, { v: 'bypassPermissions', l: tr('完全权限') }];

/** Convert a node to another kind, keeping what carries over (id, title, deps, prompt). */
function withKind(n: OrchNode, kind: OrchNode['kind'], agents: AgentKind[]): OrchNode {
  const base = { id: n.id, title: n.title, dependsOn: n.dependsOn };
  const prompt = n.kind === 'approval' ? '' : n.prompt;
  if (kind === 'task') return { ...base, kind, agent: n.kind === 'task' ? n.agent : agents[0] ?? 'claude', prompt: prompt ?? '', workspace: 'shared', permissionMode: 'acceptEdits' };
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
        <Icon name={kindIcon(n.kind)} size={14} />
        <input className="field title" value={n.title} placeholder={tr('节点名称')} onChange={(e) => onChange({ ...n, title: e.target.value })} />
        <span className="mono id" title={tr('模板里用这个 id 引用它')}>{n.id}</span>
        <button className="icon-btn xs" disabled={index === 0} onClick={() => onMove(-1)} title={tr('上移')} aria-label={tr('上移')}><Icon name="chevronDown" size={12} className="flip" /></button>
        <button className="icon-btn xs" disabled={index === count - 1} onClick={() => onMove(1)} title={tr('下移')} aria-label={tr('下移')}><Icon name="chevronDown" size={12} /></button>
        <button className="icon-btn xs" onClick={onRemove} title={tr('删除节点')} aria-label={tr('删除节点')}><Icon name="trash" size={12} /></button>
      </div>
      <div className="grid">
        <label>{tr('类型')}<Select className="field" value={n.kind} onValueChange={(value) => onChange(withKind(n, String(value) as OrchNode['kind'], agents))} aria-label={tr('类型')} options={(['task', 'approval'] as const).map((k) => ({ value: k, label: KIND_L[k] }))} /></label>
        {n.kind === 'task' && <>
          <label>Agent<Select className="field" value={n.agent} onValueChange={(value) => onChange({ ...n, agent: String(value) as AgentKind })} aria-label="Agent" options={agentOpts(n.agent).map((a) => ({ value: a, label: agentLabel(a), description: agents.includes(a) ? undefined : tr('不可用') }))} /></label>
          <label>{tr('工作区')}<Select className="field" value={n.workspace} onValueChange={(value) => onChange({ ...n, workspace: String(value) as 'shared' | 'worktree' })} aria-label={tr('工作区')} options={[{ value: 'shared', label: tr('共享工作目录') }, { value: 'worktree', label: tr('独立副本（worktree），完成后合并') }]} /></label>
          <label>{tr('权限')}<Select className="field" value={n.permissionMode ?? 'default'} onValueChange={(value) => onChange({ ...n, permissionMode: String(value) as PermissionMode })} aria-label={tr('权限')} options={PERM.map((p) => ({ value: p.v, label: p.l }))} /></label>
          <label>{tr('模型（空 = 默认）')}<input className="field" value={n.model ?? ''} onChange={(e) => onChange({ ...n, model: e.target.value || undefined })} /></label>
          <SwitchChip className="check" on={!!n.untilDone} onChange={(on) => onChange({ ...n, untilDone: on || undefined })}>{tr('一直做到完成（目标协议）')}</SwitchChip>
        </>}
        {n.kind === 'approval' && <label className="wide">{tr('说明（给审批人看）')}<input className="field" value={n.note ?? ''} onChange={(e) => onChange({ ...n, note: e.target.value })} placeholder={tr('例如：看一眼计划再决定是否实现')} /></label>}
      </div>
      {others.length > 0 && (
        <div className="chips" role="group" aria-label={tr('依赖')}>
          <span className="lbl">{tr('依赖')}</span>
          {others.map((o) => <button key={o.id} type="button" className={clsx('chip', n.dependsOn.includes(o.id) && 'on')} onClick={() => onChange({ ...n, dependsOn: n.dependsOn.includes(o.id) ? n.dependsOn.filter((x) => x !== o.id) : [...n.dependsOn, o.id] })}>{o.title || o.id}</button>)}
        </div>
      )}
      {n.kind !== 'approval' && <>
        <textarea ref={ta} className="field mono" rows={4} value={n.prompt} onChange={(e) => onChange({ ...n, prompt: e.target.value })} placeholder={tr('提示词。可以用下面的变量引用启动输入和上游节点的结果')} />
        <div className="vars">{vars.map((v) => <button key={v.token} type="button" className="var" onClick={() => insert(v.token)} title={v.label}>{v.token}</button>)}</div>
      </>}
    </div>
  );
}

/** Form editor: node list with live graph preview above. Saving validates on the server (cycles, deps, git). */
export function WorkflowEditor({ initial, onSaved, onRun, onCancel }: { initial: WorkflowDraft; onSaved: (w: Workflow) => void; onRun: (w: Workflow) => void; onCancel: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const [w, setW] = useState<WorkflowDraft>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agents: AgentKind[] = ['claude'];
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
        <input className="field name" value={w.name} placeholder={tr('工作流名称')} onChange={(e) => setW({ ...w, name: e.target.value })} />
        <Select className="field" value={w.cwd} onValueChange={(value) => setW({ ...w, cwd: String(value) })} title={tr('工作目录（worktree 要求是 git 仓库）')} aria-label={tr('工作目录')} searchable options={[...(cwds.includes(w.cwd) ? [] : [{ value: '', label: tr('选择工作目录…') }]), ...cwds.map((p) => ({ value: p, label: p }))]} />
        <input className="field desc" value={w.description ?? ''} placeholder={tr('说明（可选）')} onChange={(e) => setW({ ...w, description: e.target.value || undefined })} />
      </div>
      <div className="orch-sec-h">{tr('执行图预览')}</div>
      <Graph nodes={w.nodes} onSelect={(id) => document.getElementById(`orch-edit-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })} />
      <div className="orch-sec-h">{tr('节点')} <span className="muted">{w.nodes.length}</span></div>
      <div className="orch-nodes">
        {w.nodes.map((n, i) => <NodeCard key={n.id} n={n} all={w.nodes} agents={agents} index={i} count={w.nodes.length} onChange={(x) => setNode(i, x)} onMove={(d) => move(i, d)} onRemove={() => remove(i)} />)}
        <div className="orch-add">
          <button className="btn sm ghost" onClick={() => add('task')}><Icon name="plus" size={12} /> {tr('任务')}</button>
          <button className="btn sm ghost" onClick={() => add('approval')}><Icon name="approval" size={12} /> {tr('审批')}</button>
        </div>
      </div>
      {err && <pre className="orch-err">{err}</pre>}
      <div className="orch-foot">
        <button className="btn sm ghost" onClick={onCancel}>{tr('关闭')}</button>
        <span className="grow" />
        <button className="btn sm" disabled={busy || !w.name.trim() || !w.cwd} onClick={() => void save()}>{tr('保存')}</button>
        <button className="btn sm primary" disabled={busy || !w.name.trim() || !w.cwd || !w.nodes.length} onClick={async () => { const s = await save(); if (s) onRun(s); }}><Icon name="play" size={12} /> {tr('保存并运行')}</button>
      </div>
    </div>
  );
}
