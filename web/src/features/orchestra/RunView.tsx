import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { ago, basename, clsx, fmtMs } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { Markdown } from '@/features/chat/Markdown';
import type { CompareCandidate, NodeRun, OrchCleanup, OrchNode, OrchRun } from '@shared';
import { Graph, KIND_ICON, STATE_L } from './Graph';
import { agentIcon, agentLabel } from './labels';
import { orchAct, useOrch, useOrchBusy } from './state';

export const RUN_L: Record<OrchRun['state'], string> = { running: '运行中', waiting: '等你', done: '完成', failed: '失败', cancelled: '已取消' };
const OUT_SHOW = 6000;

const req = async (r: any, ok?: string) => {
  try { const v = await ws.request(r); if (ok) useStore.getState().toast(ok, true); return v; } catch (e: any) { useStore.getState().toast(e.message); return null; }
};

function SessionLinks({ ids }: { ids: string[] }) {
  const loadHistory = useStore((s) => s.loadHistory);
  if (!ids.length) return null;
  return (
    <span className="orch-sess">
      {ids.map((id, i) => <button key={id} className="btn xs ghost" onClick={() => void loadHistory(id)} title={id}><Icon name="chat" size={11} /> 会话{ids.length > 1 ? ` ${i + 1}` : ''}</button>)}
    </span>
  );
}

function DiffText({ text }: { text: string }) {
  return (
    <pre className="orch-diff">
      {text.split('\n').map((l, i) => <span key={i} className={clsx(l.startsWith('+') && !l.startsWith('+++') && 'add', l.startsWith('-') && !l.startsWith('---') && 'del', l.startsWith('@@') && 'hunk')}>{l}{'\n'}</span>)}
    </pre>
  );
}

function Candidate({ run, nodeId, c, winner, recommended, canPick }: { run: OrchRun; nodeId: string; c: CompareCandidate; winner?: string; recommended?: string; canPick: boolean }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const loadHistory = useStore((s) => s.loadHistory);
  const toggleDiff = async () => {
    if (!open && diff === null) setDiff(((await req({ kind: 'orchestra.node.diff', runId: run.id, nodeId, agent: c.agent })) as string | null) ?? '');
    setOpen(!open);
  };
  const busy = useOrchBusy((s) => !!s.keys[run.id]);
  // the user may have kept talking to a candidate: merging it mid-turn would merge a moving target
  const live = useStore((s) => { const st = c.sessionId ? s.open[c.sessionId]?.state : undefined; return st === 'running' || st === 'starting' || st === 'waiting'; });
  const pick = async () => {
    const message = [
      `1. 先把 ${c.worktree?.path} 里还没提交的改动提交到 ${c.worktree?.branch}；`,
      `2. 用 merge --no-ff 合并到 ${run.baseBranch}（你手上有进行中的 merge / rebase 或暂存区有改动时会拒绝，什么都不动）；`,
      '3. 合并成功后：各候选的 worktree 目录在没有未提交改动时删除；落选分支只有在没被人动过（仍是跑完时的提交）时才删除；胜者分支保留。有改动的一律保留并列出来。',
      '合并失败时节点回到「等你选」，所有 worktree 和分支都不动。',
    ].join('\n');
    if (!(await dlg.confirm(`选 ${agentLabel(c.agent)} 的实现？`, { message, okLabel: '合并' }))) return;
    await orchAct(run.id, { kind: 'orchestra.node.pick', runId: run.id, nodeId, winner: c.agent }, '已处理');
  };
  return (
    <div className={clsx('orch-cand', `st-${c.state}`, winner === c.agent && 'win')}>
      <div className="hd">
        <Icon name={agentIcon(c.agent)} size={13} />
        <b>{agentLabel(c.agent)}</b>
        {winner === c.agent && <span className="badge ok">已选</span>}
        {recommended === c.agent && winner !== c.agent && <span className="badge info">裁判推荐</span>}
        <span className="grow" />
        <span className="muted">{c.state === 'running' ? '运行中…' : c.state === 'failed' ? '失败' : `${c.files ?? 0} 个文件${c.costUsd ? ` · $${c.costUsd.toFixed(3)}` : ''}`}</span>
      </div>
      {c.error && <div className="orch-errline">{c.error}</div>}
      {c.output && <div className="reply"><Markdown text={c.output.slice(0, OUT_SHOW)} /></div>}
      {c.diffStat && <pre className="stat">{c.diffStat}</pre>}
      <div className="acts">
        {c.sessionId && <button className="btn xs ghost" onClick={() => void loadHistory(c.sessionId!)}><Icon name="chat" size={11} /> 会话</button>}
        {c.state === 'done' && c.worktree && !winner && <button className="btn xs ghost" onClick={() => void toggleDiff()}><Icon name="eye" size={11} /> {open ? '收起 diff' : '完整 diff'}</button>}
        <span className="grow" />
        {canPick && c.state === 'done' && live && <span className="muted sm">胜者会话还在运行，先停止或等它结束</span>}
        {canPick && c.state === 'done' && <button className="btn xs primary" disabled={busy || live} title={live ? '胜者会话还在运行，先停止或等它结束' : undefined} onClick={() => void pick()}><Icon name="check" size={11} /> 选它合并</button>}
      </div>
      {open && diff !== null && (diff ? <DiffText text={diff} /> : <div className="muted sm">没有改动</div>)}
    </div>
  );
}

function ApprovalBox({ run, node }: { run: OrchRun; node: OrchNode & { kind: 'approval' } }) {
  const [comment, setComment] = useState('');
  const key = `${run.id}:${node.id}`;
  const busy = useOrchBusy((s) => !!s.keys[key]);
  const act = (decision: 'approve' | 'reject') => orchAct(key, { kind: 'orchestra.node.approve', runId: run.id, nodeId: node.id, decision, comment }, decision === 'approve' ? '已通过' : '已驳回');
  return (
    <div className="orch-approval">
      {node.note && <div className="note">{node.note}</div>}
      <textarea className="field" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="意见（可选；下游提示词里用 {{nodes.<id>.approval}} 引用）" />
      <div className="acts">
        <button className="btn sm primary" disabled={busy} onClick={() => void act('approve')}><Icon name="check" size={12} /> 通过</button>
        <button className="btn sm danger" disabled={busy} onClick={() => void act('reject')}><Icon name="close" size={12} /> 驳回</button>
      </div>
    </div>
  );
}

function NodeDetail({ run, node, nr, selected }: { run: OrchRun; node: OrchNode; nr: NodeRun; selected: boolean }) {
  const secs = nr.startedAt ? (nr.finishedAt ?? Date.now()) - nr.startedAt : 0;
  const canRetry = nr.state === 'failed' || nr.state === 'cancelled' || nr.state === 'skipped' || (node.kind === 'compare' && nr.state === 'waiting');
  const busy = useOrchBusy((s) => !!s.keys[run.id]);
  const wts = [...(nr.worktrees ?? []), ...(nr.retained ?? [])];
  const retry = async () => {
    const lines = [
      node.kind === 'compare' ? '所有候选会在新的会话、新的 worktree（名字带 -attempt 后缀）里重新跑一遍，已经跑完的结果不再能选。' : '这个节点会在新的会话里重新跑，还没完成的下游节点也会重新排队。',
      nr.mergePending ? '这个节点的活已经做完、只是没合并进去：处理冲突后点「重新合并」就够了（或手动 git merge 它的分支），不必整个重跑。' : '',
      wts.length ? `现有的 worktree 与分支都保留，不会删除：\n${wts.map((w) => `· ${w.path}（${w.branch}）`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    if (nr.state === 'waiting' || wts.length) { if (!(await dlg.confirm(`重试「${node.title || node.id}」？`, { message: lines, okLabel: '重试' }))) return; }
    await orchAct(run.id, { kind: 'orchestra.node.retry', runId: run.id, nodeId: node.id }, '已重新开始');
  };
  const remerge = async () => {
    const wt = nr.worktrees?.[nr.worktrees.length - 1];
    const message = `把 ${wt?.branch} 再合并一次到 ${run.baseBranch}：先提交 ${wt?.path} 里新的改动，然后同样检查（你有进行中的 merge / rebase 或暂存区有改动就拒绝，冲突只撤销它自己的这次合并）。成功后下游节点继续跑。`;
    if (!(await dlg.confirm(`重新合并「${node.title || node.id}」？`, { message, okLabel: '重新合并' }))) return;
    await orchAct(run.id, { kind: 'orchestra.node.remerge', runId: run.id, nodeId: node.id }, '已处理');
  };
  return (
    <div className={clsx('orch-detail', `st-${nr.state}`, selected && 'sel')} id={`orch-node-${run.id}-${node.id}`}>
      <div className="hd">
        <Icon name={KIND_ICON[node.kind]} size={14} />
        <b>{node.title || node.id}</b>
        <span className={clsx('pill', `st-${nr.state}`)}>{STATE_L[nr.state]}</span>
        <span className="muted">{node.kind === 'task' ? agentLabel(node.agent) : node.kind === 'compare' ? node.agents.map(agentLabel).join(' / ') : ''}{secs && nr.state !== 'pending' ? ` · ${fmtMs(secs)}` : ''}{nr.costUsd ? ` · $${nr.costUsd.toFixed(3)}` : ''}{(nr.attempts ?? 0) > 1 ? ` · 第 ${nr.attempts} 次` : ''}</span>
        <span className="grow" />
        {node.kind !== 'compare' && <SessionLinks ids={nr.sessionIds} />}
        {nr.mergePending && nr.state === 'failed' && <button className="btn xs" disabled={busy} onClick={() => void remerge()}><Icon name="branch" size={11} /> 重新合并</button>}
        {canRetry && <button className="btn xs ghost" disabled={busy} onClick={() => void retry()}><Icon name="refresh" size={11} /> 重试</button>}
      </div>
      {nr.error && <div className="orch-errline">{nr.error}</div>}
      {nr.note && <div className="orch-note">{nr.note}</div>}
      {node.kind === 'approval' && nr.state === 'waiting' && <ApprovalBox run={run} node={node} />}
      {node.kind === 'approval' && nr.approval && <div className="muted sm">{nr.approval.decision === 'approve' ? '已通过' : '已驳回'}{nr.approval.comment ? `：${nr.approval.comment}` : ''} · {ago(nr.approval.at)}</div>}
      {node.kind === 'compare' && nr.candidates && (
        <>
          {nr.judge && (
            <div className="orch-judge">
              <div className="hd"><Icon name="approval" size={12} /> 裁判 {agentLabel(nr.judge.agent)} · {nr.judge.state === 'running' ? '评审中…' : nr.judge.state === 'failed' ? `失败：${nr.judge.error ?? ''}` : nr.judge.recommended ? `推荐 ${agentLabel(nr.judge.recommended)}` : '没给出明确推荐'}{nr.judge.sessionId && <SessionLinks ids={[nr.judge.sessionId]} />}</div>
              {nr.judge.output && <details><summary>裁判意见</summary><Markdown text={nr.judge.output.slice(0, OUT_SHOW)} /></details>}
            </div>
          )}
          <div className="orch-cands">
            {nr.candidates.map((c) => <Candidate key={c.agent} run={run} nodeId={node.id} c={c} winner={nr.winner} recommended={nr.judge?.recommended} canPick={nr.state === 'waiting'} />)}
          </div>
        </>
      )}
      {wts.length > 0 && nr.state !== 'done' && (
        <details className="orch-wts"><summary>worktree {wts.length} 个（保留着，不会自动删除）</summary>{wts.map((w) => <div key={w.path} className="mono">{w.path} · {w.branch}</div>)}</details>
      )}
      {nr.output && node.kind !== 'approval' && (
        <details className="orch-out" open={selected && node.kind === 'task'}>
          <summary>输出{nr.output.length > OUT_SHOW ? `（前 ${OUT_SHOW} 字）` : ''}</summary>
          <Markdown text={nr.output.slice(0, OUT_SHOW)} />
        </details>
      )}
    </div>
  );
}

/** One run: header + actions, the live execution graph, and a detail card per node (approval / compare inline). */
export function RunView({ runId, onClose }: { runId: string; onClose: () => void }) {
  const run = useOrch((s) => s.full[runId]);
  const [sel, setSel] = useState<string | null>(null);
  const busy = useOrchBusy((s) => !!s.keys[runId]);
  const [, tick] = useState(0);
  useEffect(() => { if (!run) void useOrch.getState().loadRun(runId); }, [runId, !!run]);
  useEffect(() => { if (run?.state !== 'running' && run?.state !== 'waiting') return; const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [run?.state]);
  if (!run) return <div className="orch-idle">加载中…</div>;
  const live = run.state === 'running' || run.state === 'waiting';
  const removeRun = async () => {
    if (!(await dlg.confirm('删除这条运行记录？', { message: '会话本身不会被删除。', danger: true, okLabel: '删除' }))) return;
    const hasWts = Object.values(run.nodes).some((n) => n.worktrees?.length || n.retained?.length || n.candidates?.some((c) => c.worktree));
    const cleanup = hasWts && (await dlg.confirm('同时清理这次运行的 worktree 与 cw/ 分支？', { message: '只删除干净、已合并（或仍是编排自己提交的）的 worktree 与分支；有未提交改动或未合并提交的只列出来，不删。', okLabel: '清理', cancelLabel: '只删记录' }));
    const r = await orchAct<OrchCleanup>(runId, { kind: 'orchestra.run.remove', runId, cleanup });
    if (!r) return;
    onClose();
    if (r.kept.length) await dlg.alert('这些没有删除', { message: r.kept.map((k) => `· ${k.path ?? k.branch}（${k.branch}）：${k.reason}`).join('\n') });
  };
  const select = (id: string) => { setSel(id); document.getElementById(`orch-node-${run.id}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  return (
    <div className="orch-run">
      <div className="orch-run-h">
        <span className={clsx('pill', `st-${run.state}`)}>{RUN_L[run.state]}</span>
        <b className="name">{run.name}</b>
        <span className="muted">{basename(run.cwd)}{run.baseBranch ? ` · ${run.baseBranch}` : ''} · {live ? fmtMs(Date.now() - run.startedAt) : `${ago(run.startedAt)}${run.finishedAt ? ` · 用时 ${fmtMs(run.finishedAt - run.startedAt)}` : ''}`}</span>
        <span className="grow" />
        {live && <button className="btn xs ghost" disabled={busy} onClick={async () => { if (await dlg.confirm('取消这次运行？', { message: '会中断正在运行的会话；已经建的 worktree 与分支都保留。正在合并时不能取消。', danger: true, okLabel: '取消运行' })) await orchAct(runId, { kind: 'orchestra.run.cancel', runId }); }}><Icon name="stop" size={11} /> 取消</button>}
        {(run.state === 'failed' || run.state === 'cancelled') && <button className="btn xs" disabled={busy} onClick={() => void orchAct(runId, { kind: 'orchestra.run.resume', runId }, '从未完成的节点续跑')}><Icon name="play" size={11} /> 续跑</button>}
        {!live && <button className="btn xs ghost" disabled={busy} title="删除运行记录" aria-label="删除运行记录" onClick={() => void removeRun()}><Icon name="trash" size={11} /></button>}
      </div>
      {run.error && <div className="orch-errline">{run.error}</div>}
      {run.input && <details className="orch-input"><summary>输入</summary><div className="mono">{run.input}</div></details>}
      <Graph nodes={run.workflow} runs={run.nodes} selected={sel} onSelect={select} />
      <div className="orch-details">
        {run.workflow.map((n) => <NodeDetail key={n.id} run={run} node={n} nr={run.nodes[n.id]} selected={sel === n.id} />)}
      </div>
    </div>
  );
}
