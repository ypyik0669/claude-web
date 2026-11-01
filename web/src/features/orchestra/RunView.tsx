import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { ago, basename, clsx, fmtMs } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { Markdown } from '@/features/chat/Markdown';
import type { NodeRun, OrchCleanup, OrchNode, OrchRun } from '@shared';
import { Graph, kindIcon, STATE_L } from './Graph';
import { agentLabel } from './labels';
import { orchAct, useOrch, useOrchBusy } from './state';
import { tr } from '@/i18n';

export const RUN_L: Record<OrchRun['state'], string> = { running: tr('运行中'), waiting: tr('等你'), done: tr('完成'), failed: tr('失败'), cancelled: tr('已取消') };
const OUT_SHOW = 6000;

function SessionLinks({ ids }: { ids: string[] }) {
  const loadHistory = useStore((s) => s.loadHistory);
  if (!ids.length) return null;
  return (
    <span className="orch-sess">
      {ids.map((id, i) => <button key={id} className="btn xs ghost" onClick={() => void loadHistory(id)} title={id}><Icon name="chat" size={11} /> {tr('对话{v}', { v: ids.length > 1 ? ` ${i + 1}` : '' })}</button>)}
    </span>
  );
}

function ApprovalBox({ run, node }: { run: OrchRun; node: OrchNode & { kind: 'approval' } }) {
  const [comment, setComment] = useState('');
  const key = `${run.id}:${node.id}`;
  const busy = useOrchBusy((s) => !!s.keys[key]);
  const act = (decision: 'approve' | 'reject') => orchAct(key, { kind: 'orchestra.node.approve', runId: run.id, nodeId: node.id, decision, comment }, decision === 'approve' ? tr('已通过') : tr('已驳回'));
  return (
    <div className="orch-approval">
      {node.note && <div className="note">{node.note}</div>}
      <textarea className="field" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={tr('意见（可选；下游提示词里用 {{nodes.<id>.approval}} 引用）')} />
      <div className="acts">
        <button className="btn sm primary" disabled={busy} onClick={() => void act('approve')}><Icon name="check" size={12} /> {tr('通过')}</button>
        <button className="btn sm danger" disabled={busy} onClick={() => void act('reject')}><Icon name="close" size={12} /> {tr('驳回')}</button>
      </div>
    </div>
  );
}

function NodeDetail({ run, node, nr, selected }: { run: OrchRun; node: OrchNode; nr: NodeRun; selected: boolean }) {
  const secs = nr.startedAt ? (nr.finishedAt ?? Date.now()) - nr.startedAt : 0;
  const canRetry = nr.state === 'failed' || nr.state === 'cancelled' || nr.state === 'skipped';
  const busy = useOrchBusy((s) => !!s.keys[run.id]);
  const wts = [...(nr.worktrees ?? []), ...(nr.retained ?? [])];
  const retry = async () => {
    const lines = [
      tr('这个节点会在新的对话里重新跑，还没完成的下游节点也会重新排队。'),
      nr.mergePending ? tr('这个节点的活已经做完、只是没合并进去：处理冲突后点「重新合并」就够了（或手动 git merge 它的分支），不必整个重跑。') : '',
      wts.length ? tr("现有的独立副本与分支都保留，不会删除：\n{map}", { map: wts.map((w) => `· ${w.path}（${w.branch}）`).join('\n') }) : '',
    ].filter(Boolean).join('\n\n');
    if (wts.length) { if (!(await dlg.confirm(tr('重试「{title}」？', { title: node.title || node.id }), { message: lines, okLabel: tr('重试') }))) return; }
    await orchAct(run.id, { kind: 'orchestra.node.retry', runId: run.id, nodeId: node.id }, tr('已重新开始'));
  };
  const remerge = async () => {
    const wt = nr.worktrees?.[nr.worktrees.length - 1];
    const message = tr('把 {branch} 再合并一次到 {baseBranch}：先提交 {path} 里新的改动，然后同样检查（你有进行中的 merge / rebase 或暂存区有改动就拒绝，冲突只撤销它自己的这次合并）。成功后下游节点继续跑。', { branch: wt?.branch, baseBranch: run.baseBranch, path: wt?.path });
    if (!(await dlg.confirm(tr('重新合并「{title}」？', { title: node.title || node.id }), { message, okLabel: tr('重新合并') }))) return;
    await orchAct(run.id, { kind: 'orchestra.node.remerge', runId: run.id, nodeId: node.id }, tr('已处理'));
  };
  return (
    <div className={clsx('orch-detail', `st-${nr.state}`, selected && 'sel')} id={`orch-node-${run.id}-${node.id}`}>
      <div className="hd">
        <Icon name={kindIcon(node.kind)} size={14} />
        <b>{node.title || node.id}</b>
        <span className={clsx('pill', `st-${nr.state}`)}>{STATE_L[nr.state]}</span>
        <span className="muted">{node.kind === 'task' ? agentLabel(node.agent) : ''}{secs && nr.state !== 'pending' ? ` · ${fmtMs(secs)}` : ''}{nr.costUsd ? ` · $${nr.costUsd.toFixed(3)}` : ''}{(nr.attempts ?? 0) > 1 ? tr(' · 第 {attempts} 次', { attempts: nr.attempts }) : ''}</span>
        <span className="grow" />
        <SessionLinks ids={nr.sessionIds} />
        {nr.mergePending && nr.state === 'failed' && <button className="btn xs" disabled={busy} onClick={() => void remerge()}><Icon name="branch" size={11} /> {tr('重新合并')}</button>}
        {canRetry && <button className="btn xs ghost" disabled={busy} onClick={() => void retry()}><Icon name="refresh" size={11} /> {tr('重试')}</button>}
      </div>
      {nr.error && <div className="orch-errline">{nr.error}</div>}
      {nr.note && <div className="orch-note">{nr.note}</div>}
      {node.kind === 'approval' && nr.state === 'waiting' && <ApprovalBox run={run} node={node} />}
      {node.kind === 'approval' && nr.approval && <div className="muted sm">{nr.approval.decision === 'approve' ? tr('已通过') : tr('已驳回')}{nr.approval.comment ? `：${nr.approval.comment}` : ''} · {ago(nr.approval.at)}</div>}
      {wts.length > 0 && nr.state !== 'done' && (
        <details className="orch-wts"><summary>{tr('独立副本 {wtsCount} 个（保留着，不会自动删除）', { wtsCount: wts.length })}</summary>{wts.map((w) => <div key={w.path} className="mono">{w.path} · {w.branch}</div>)}</details>
      )}
      {nr.output && node.kind !== 'approval' && (
        <details className="orch-out" open={selected && node.kind === 'task'}>
          <summary>{tr('输出{v}', { v: nr.output.length > OUT_SHOW ? tr('（前 {OUT_SHOW} 字）', { OUT_SHOW }) : '' })}</summary>
          <Markdown text={nr.output.slice(0, OUT_SHOW)} />
        </details>
      )}
    </div>
  );
}

/** One run: header + actions, the live execution graph, and a detail card per node (approvals inline). */
export function RunView({ runId, onClose }: { runId: string; onClose: () => void }) {
  const run = useOrch((s) => s.full[runId]);
  const [sel, setSel] = useState<string | null>(null);
  const busy = useOrchBusy((s) => !!s.keys[runId]);
  const [, tick] = useState(0);
  useEffect(() => { if (!run) void useOrch.getState().loadRun(runId); }, [runId, !!run]);
  useEffect(() => { if (run?.state !== 'running' && run?.state !== 'waiting') return; const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [run?.state]);
  if (!run) return <div className="orch-idle">{tr('加载中…')}</div>;
  const live = run.state === 'running' || run.state === 'waiting';
  const removeRun = async () => {
    if (!(await dlg.confirm(tr('删除这条运行记录？'), { message: tr('对话本身不会被删除。'), danger: true, okLabel: tr('删除') }))) return;
    const hasWts = Object.values(run.nodes).some((n) => n.worktrees?.length || n.retained?.length);
    const cleanup = hasWts && (await dlg.confirm(tr('同时清理这次运行的独立副本与 cw/ 分支？'), { message: tr('只删除干净、已合并（或仍是编排自己提交的）的独立副本与分支；有未提交改动或未合并提交的只列出来，不删。'), okLabel: tr('清理'), cancelLabel: tr('只删记录') }));
    const r = await orchAct<OrchCleanup>(runId, { kind: 'orchestra.run.remove', runId, cleanup });
    if (!r) return;
    onClose();
    if (r.kept.length) await dlg.alert(tr('这些没有删除'), { message: r.kept.map((k) => `· ${k.path ?? k.branch}（${k.branch}）：${k.reason}`).join('\n') });
  };
  const select = (id: string) => { setSel(id); document.getElementById(`orch-node-${run.id}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  return (
    <div className="orch-run">
      <div className="orch-run-h">
        <span className={clsx('pill', `st-${run.state}`)}>{RUN_L[run.state]}</span>
        <b className="name">{run.name}</b>
        <span className="muted">{basename(run.cwd)}{run.baseBranch ? ` · ${run.baseBranch}` : ''} · {live ? fmtMs(Date.now() - run.startedAt) : `${ago(run.startedAt)}${run.finishedAt ? tr(' · 用时 {fmtMs}', { fmtMs: fmtMs(run.finishedAt - run.startedAt) }) : ''}`}</span>
        <span className="grow" />
        {live && <button className="btn xs ghost" disabled={busy} onClick={async () => { if (await dlg.confirm(tr('取消这次运行？'), { message: tr('会中断正在运行的对话；已经建的独立副本与分支都保留。正在合并时不能取消。'), danger: true, okLabel: tr('取消运行') })) await orchAct(runId, { kind: 'orchestra.run.cancel', runId }); }}><Icon name="stop" size={11} /> {tr('取消')}</button>}
        {(run.state === 'failed' || run.state === 'cancelled') && <button className="btn xs" disabled={busy} onClick={() => void orchAct(runId, { kind: 'orchestra.run.resume', runId }, tr('从未完成的节点续跑'))}><Icon name="play" size={11} /> {tr('续跑')}</button>}
        {!live && <button className="btn xs ghost" disabled={busy} title={tr('删除运行记录')} aria-label={tr('删除运行记录')} onClick={() => void removeRun()}><Icon name="trash" size={11} /></button>}
      </div>
      {run.error && <div className="orch-errline">{run.error}</div>}
      {run.input && <details className="orch-input"><summary>{tr('输入')}</summary><div className="mono">{run.input}</div></details>}
      <Graph nodes={run.workflow} runs={run.nodes} selected={sel} onSelect={select} />
      <div className="orch-details">
        {run.workflow.map((n) => <NodeDetail key={n.id} run={run} node={n} nr={run.nodes[n.id]} selected={sel === n.id} />)}
      </div>
    </div>
  );
}
