import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ago, basename, clsx, fmtMs } from '@/util';
import { walkTools } from '@/model/conversation';
import { Icon } from '@/ui/icons';
import { useOrch, waitingOf } from '@/features/orchestra/state';
import { ws } from '@/ws/client';

type Lane = 'attention' | 'running' | 'idle' | 'error';

/**
 * Mission Control: every session across workspaces at a glance — what needs you, what is running (with the
 * current tool and elapsed time), what is idle, what failed — with one-click focus / interrupt / approve.
 */
export function MissionPanel() {
  const open = useStore((s) => s.open);
  const sessions = useStore((s) => s.sessions);
  const schedules = useStore((s) => s.schedules);
  const openInPane = useStore((s) => s.openInPane);
  const loadHistory = useStore((s) => s.loadHistory);
  const interrupt = useStore((s) => s.interrupt);
  const respond = useStore((s) => s.respondPermission);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const [showIdle, setShowIdle] = useState(true);
  // orchestration nodes waiting for a human (approval / compare pick) belong in "needs you" too
  const orchFull = useOrch((s) => s.full);
  const orchWait = useMemo(() => waitingOf(orchFull), [orchFull]);

  const cards = useMemo(() => {
    const now = Date.now();
    return Object.values(open).map((o) => {
      const meta = sessions.find((s) => s.sessionId === o.sessionId);
      const lane: Lane = o.pending.length ? 'attention' : o.state === 'running' || o.state === 'waiting' || o.state === 'starting' ? 'running' : o.state === 'error' ? 'error' : 'idle';
      const tools = [...walkTools(o.conv.items)];
      const lastTool = tools.length ? tools[tools.length - 1].tool : undefined;
      const running = o.conv.runningTool;
      const cost = o.conv.lastResult?.costUsd ?? 0;
      return { o, meta, lane, title: meta?.title ?? o.sessionId.slice(0, 8), cwd: o.cwd, lastTool, running, quietMs: o.conv.lastEventAt ? now - o.conv.lastEventAt : 0, cost, turns: o.conv.items.filter((i) => i.kind === 'user').length, sched: schedules.find((s) => s.sessionId === o.sessionId) };
    });
  }, [open, sessions, schedules]);
  const lanes: { id: Lane; l: string; hint: string }[] = [
    { id: 'attention', l: '需要你', hint: '等待权限或提问' },
    { id: 'running', l: '运行中', hint: '模型或工具正在执行' },
    { id: 'error', l: '出错', hint: '进程异常退出' },
    { id: 'idle', l: '空闲', hint: '已连接，等待输入' },
  ];
  const total = cards.length;
  return (
    <div className="mission">
      <div className="mission-head">
        <span>{total} 个活动会话 · {cards.filter((c) => c.lane === 'attention').length + orchWait.length} 需要你 · {cards.filter((c) => c.lane === 'running').length} 运行中</span>
        <span className="grow" />
        <label className="muted" style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={showIdle} onChange={(e) => setShowIdle(e.target.checked)} /> 显示空闲</label>
      </div>
      {!total && !orchWait.length && <div className="empty">没有活动会话。侧栏点开一个，或用「恢复」继续。</div>}
      <div className="mission-lanes">
        {lanes.filter((l) => l.id !== 'idle' || showIdle).map((lane) => {
          const items = cards.filter((c) => c.lane === lane.id);
          const orch = lane.id === 'attention' ? orchWait : [];
          if (!items.length && lane.id !== 'attention' && lane.id !== 'running') return null;
          return (
            <div key={lane.id} className={clsx('lane', lane.id)}>
              <div className="lane-h"><b>{lane.l}</b><span className="badge">{items.length + orch.length}</span><span className="muted">{lane.hint}</span></div>
              {items.map((c) => (
                <div key={c.o.sessionId} className="mcard" onClick={() => openInPane(c.o.sessionId, 'replace')}>
                  <div className="t"><span className={clsx('dot', c.o.state)} />{c.title}</div>
                  <div className="sub">{basename(c.cwd)}{c.meta?.gitBranch ? ` · ${c.meta.gitBranch}` : ''}{c.sched ? ` · ${c.sched.name}` : ''}</div>
                  {c.lane === 'attention' && c.o.pending.map((p) => (
                    <div key={p.requestId} className="perm">
                      <span className="mono">{p.toolName}</span> {String((p.input as any).command ?? (p.input as any).file_path ?? (p.input as any).question ?? '').slice(0, 60)}
                      {p.toolName !== 'AskUserQuestion' && p.toolName !== 'ExitPlanMode' && (
                        <span className="acts"><button className="btn sm primary" onClick={(e) => { e.stopPropagation(); void respond(p.requestId, { behavior: 'allow' }); }}>允许</button><button className="btn sm" onClick={(e) => { e.stopPropagation(); void respond(p.requestId, { behavior: 'deny', message: '用户拒绝' }); }}>拒绝</button></span>
                      )}
                    </div>
                  ))}
                  {c.lane === 'running' && <div className="sub">{c.running ? `${c.running.name} · ${fmtMs(Date.now() - c.running.since)}` : c.o.state === 'starting' ? '启动中…' : '模型思考中'}{c.quietMs > 15000 ? ` · 安静 ${fmtMs(c.quietMs)}` : ''}</div>}
                  {c.lane === 'error' && <div className="sub" style={{ color: 'var(--red)' }}>{c.o.error ?? '进程退出'}</div>}
                  <div className="foot">
                    <span className="muted">{c.turns} 轮{c.cost ? ` · $${c.cost.toFixed(3)}` : ''}{c.lastTool ? ` · 最近 ${c.lastTool.name}` : ''}{c.o.conv.lastEventAt ? ` · ${ago(c.o.conv.lastEventAt)}` : ''}</span>
                    <span className="grow" />
                    {c.lane === 'running' && <button className="icon-btn" title="中断" onClick={(e) => { e.stopPropagation(); void interrupt(c.o.sessionId); }} aria-label="中断"><Icon name="stop" size={12} /></button>}
                    {c.lane === 'error' && <button className="icon-btn" title="重新打开" onClick={(e) => { e.stopPropagation(); void loadHistory(c.o.sessionId); }} aria-label="重新打开"><Icon name="refresh" size={13} /></button>}
                  </div>
                </div>
              ))}
              {orch.map((w) => (
                <div key={`${w.runId}:${w.nodeId}`} className="mcard orch-wait" onClick={() => useOrch.getState().ask('open', w.runId)}>
                  <div className="t"><Icon name={w.kind === 'approval' ? 'approval' : 'compare'} size={13} />{w.title}</div>
                  <div className="sub">编排「{w.runName}」· {w.kind === 'approval' ? '等你审批' : '候选跑完了，等你选一个合并'}{w.since ? ` · ${ago(w.since)}` : ''}</div>
                  {w.kind === 'approval' && (
                    <div className="orch-wait-acts">
                      <button className="btn sm primary" onClick={(e) => { e.stopPropagation(); void ws.request({ kind: 'orchestra.node.approve', runId: w.runId, nodeId: w.nodeId, decision: 'approve' }).catch(() => {}); }}>通过</button>
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); useOrch.getState().ask('open', w.runId); }}>去看看</button>
                    </div>
                  )}
                </div>
              ))}
              {!items.length && !orch.length && <div className="empty sm">—</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
