import { useEffect, useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ago, basename, clsx, fmtMs } from '@/util';
import { walkTools } from '@/model/conversation';
import { Icon } from '@/ui/icons';
import { sessionPeer } from '@/features/peers';
import { orchAct, useOrch, useOrchBusy, waitingOf } from '@/features/orchestra/state';
import { accessAsk } from '@/features/computer/computer-tools';
import { dockKind, isEgoScriptRequest } from '@/features/chat/permission-dock';
import { tr } from '@/i18n';
import { usePrs } from '@/features/vcs/PrBar';
import { laneOf, quickAnswer, resolved, type Lane } from './mission-lanes';
import { SwitchChip } from '@/ui/Switch';

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
  // orchestration approvals waiting for a human belong in "needs you" too
  const orchFull = useOrch((s) => s.full);
  const orchWait = useMemo(() => waitingOf(orchFull), [orchFull]);
  const orchBusy = useOrchBusy((s) => s.keys);
  // the PRs the conversations' PR bars found (待审 / 落地中) and what was archived lately (已解决)
  const prs = usePrs((s) => s.bySession);
  const sessionMeta = useStore((s) => s.sessionMeta);
  const done = useMemo(() => resolved(sessions.filter((x) => !x.peer), (id) => !!sessionMeta[id]?.archived), [sessions, sessionMeta]);
  const [showDone, setShowDone] = useState(false);

  const cards = useMemo(() => {
    const now = Date.now();
    return Object.values(open).map((o) => {
      const meta = sessions.find((s) => s.sessionId === o.sessionId);
      const pr = prs[o.sessionId];
      const lane: Lane = laneOf({ state: o.state, pending: o.pending.length, pr });
      const tools = [...walkTools(o.conv.items)];
      const lastTool = tools.length ? tools[tools.length - 1].tool : undefined;
      const running = o.conv.runningTool;
      const cost = o.conv.lastResult?.costUsd ?? 0;
      return { o, meta, peer: sessionPeer(o.sessionId, sessions), lane, title: meta?.title || tr('新对话'), cwd: o.cwd, lastTool, running, quietMs: o.conv.lastEventAt ? now - o.conv.lastEventAt : 0, cost, turns: o.conv.items.filter((i) => i.kind === 'user').length, sched: schedules.find((s) => s.sessionId === o.sessionId), pr };
    });
  }, [open, sessions, schedules, prs]);
  const lanes: { id: Lane; l: string; hint: string }[] = [
    { id: 'attention', l: tr('需要你'), hint: tr('等待权限或提问') },
    { id: 'running', l: tr('运行中'), hint: tr('模型或工具正在执行') },
    { id: 'error', l: tr('出错'), hint: tr('进程异常退出') },
    { id: 'review', l: tr('待审'), hint: tr('分支的 PR 开着，等人审') },
    { id: 'landing', l: tr('落地中'), hint: tr('PR 已批准，或开了自动合并') },
    { id: 'idle', l: tr('空闲'), hint: tr('已连接，等待输入') },
  ];
  // federation: sessions running on other machines that this window has not opened (opened ones are cards above)
  const remote = useMemo(() => sessions.filter((s) => s.peer && !s.peer.offline && !open[s.sessionId] && (s.live === 'running' || s.live === 'waiting' || s.live === 'starting')), [sessions, open]);
  const total = cards.length;
  return (
    <div className="mission">
      <div className="mission-head">
        <span>{tr('{total} 个活动对话 · {filterCount} 需要你 · {filterCount2} 运行中', { total, filterCount: cards.filter((c) => c.lane === 'attention').length + orchWait.length + remote.filter((s) => s.live === 'waiting').length, filterCount2: cards.filter((c) => c.lane === 'running').length + remote.filter((s) => s.live !== 'waiting').length })}</span>
        <span className="grow" />
        <SwitchChip on={showIdle} onChange={setShowIdle}>{tr('显示空闲')}</SwitchChip>
        <SwitchChip on={showDone} onChange={setShowDone}>{tr('显示已解决')}</SwitchChip>
      </div>
      {!total && !remote.length && !orchWait.length && <div className="empty">{tr('没有活动的对话。侧栏点开一个，或用「恢复」继续。')}</div>}
      <div className="mission-lanes">
        {remote.length > 0 && (
          <div className="lane running remote">
            <div className="lane-h"><b>{tr('其它机器上运行中')}</b><span className="badge">{remote.length}</span><span className="muted">{tr('点开即可接管：续聊、审批、中断')}</span></div>
            {remote.map((s) => (
              <div key={s.sessionId} className="mcard" onClick={() => void loadHistory(s.sessionId)}>
                <div className="t"><span className={clsx('dot', s.live)} />{s.title}</div>
                <div className="sub"><Icon name="machine" size={11} /> {s.peer!.name} · {basename(s.cwd)}{s.gitBranch ? ` · ${s.gitBranch}` : ''}</div>
                <div className="foot"><span className="muted">{s.live === 'waiting' ? tr('等待审批') : tr('运行中')} · {ago(s.lastModified)}</span></div>
              </div>
            ))}
          </div>
        )}
        {lanes.filter((l) => l.id !== 'idle' || showIdle).map((lane) => {
          const items = cards.filter((c) => c.lane === lane.id);
          const orch = lane.id === 'attention' ? orchWait : [];
          if (!items.length && lane.id !== 'attention' && lane.id !== 'running') return null;
          // (待审 / 落地中 only appear when a conversation is in them)
          return (
            <div key={lane.id} className={clsx('lane', lane.id)}>
              <div className="lane-h"><b>{lane.l}</b><span className="badge">{items.length + orch.length}</span><span className="muted">{lane.hint}</span></div>
              {items.map((c) => (
                <div key={c.o.sessionId} className="mcard" onClick={() => openInPane(c.o.sessionId, 'replace')}>
                  <div className="t"><span className={clsx('dot', c.o.state)} />{c.title}</div>
                  <div className="sub">{c.peer && <><Icon name="machine" size={11} /> {c.peer.name} · </>}{basename(c.cwd)}{c.meta?.gitBranch ? ` · ${c.meta.gitBranch}` : ''}{c.sched ? ` · ${c.sched.name}` : ''}</div>
                  {c.lane === 'attention' && c.o.pending.map((p) => (
                    // 操控电脑 asking for applications: which ones and why is on the conversation's own card, and that is
                    // where it is answered (a click on this card opens it) — no 允许 here, where neither can be read
                    dockKind(p) === 'access' ? <div key={p.requestId} className="perm" data-kind="access" title={tr('打开对话，看它要操控哪些应用再决定')}>{tr('想操控这台电脑上的应用：{apps}（打开对话再决定）', { apps: accessAsk(p.input as Record<string, unknown>).apps.join('、') })}</div> :
                    // 允许的网站: which site, and the script it wants to run, are read on the conversation's card
                    isEgoScriptRequest(p) ? <div key={p.requestId} className="perm" data-kind="site" title={tr('打开对话，看它要在网页上做什么再决定')}>{tr('想在 ego lite 里运行一段脚本（打开对话再决定）')}</div> :
                    p.toolName === 'browser.site' ? <div key={p.requestId} className="perm" data-kind="site" title={tr('打开对话，看它要在网页上做什么再决定')}>{tr('想在网站 {host} 上操作网页（打开对话再决定）', { host: String((p.input as { host?: unknown }).host ?? '').slice(0, 80) })}</div> :
                    <div key={p.requestId} className="perm">
                      <span className="mono">{p.toolName}</span> {String((p.input as any).command ?? (p.input as any).file_path ?? (p.input as any).question ?? '').slice(0, 60)}
                      {quickAnswer(p.toolName) && (
                        <span className="acts"><button className="btn sm primary" onClick={(e) => { e.stopPropagation(); void respond(p.requestId, { behavior: 'allow' }); }}>{tr('允许')}</button><button className="btn sm" onClick={(e) => { e.stopPropagation(); void respond(p.requestId, { behavior: 'deny', message: tr('用户拒绝') }); }}>{tr('拒绝')}</button></span>
                      )}
                    </div>
                  ))}
                  {c.lane === 'running' && <div className="sub">{c.running ? `${c.running.name} · ${fmtMs(Date.now() - c.running.since)}` : c.o.state === 'starting' ? tr('启动中…') : tr('模型思考中')}{c.quietMs > 15000 ? tr(' · 安静 {fmtMs}', { fmtMs: fmtMs(c.quietMs) }) : ''}</div>}
                  {c.lane === 'error' && <div className="sub" style={{ color: 'var(--red)' }}>{c.o.error ?? tr('进程退出')}</div>}
                  {(c.lane === 'review' || c.lane === 'landing') && c.pr && <div className="sub"><a href={c.pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>PR #{c.pr.number}</a>{c.pr.review === 'changes' ? ` · ${tr('要求修改')}` : c.pr.autoMerge ? ` · ${tr('会自动合并')}` : ''}{c.pr.checks.failed ? ` · ${tr('{n} 个检查失败', { n: c.pr.checks.failed })}` : ''}</div>}
                  <div className="foot">
                    <span className="muted">{tr('{turns} 轮{v}{v2}{v3}', { turns: c.turns, v: c.cost ? ` · $${c.cost.toFixed(3)}` : '', v2: c.lastTool ? tr(' · 最近 {name}', { name: c.lastTool.name }) : '', v3: c.o.conv.lastEventAt ? ` · ${ago(c.o.conv.lastEventAt)}` : '' })}</span>
                    <span className="grow" />
                    {c.lane === 'running' && <button className="icon-btn" title={tr('中断')} onClick={(e) => { e.stopPropagation(); void interrupt(c.o.sessionId); }} aria-label={tr('中断')}><Icon name="stop" size={12} /></button>}
                    {c.lane === 'error' && <button className="icon-btn" title={tr('重新打开')} onClick={(e) => { e.stopPropagation(); void loadHistory(c.o.sessionId); }} aria-label={tr('重新打开')}><Icon name="refresh" size={13} /></button>}
                  </div>
                </div>
              ))}
              {orch.map((w) => (
                <div key={`${w.runId}:${w.nodeId}`} className="mcard orch-wait" onClick={() => useOrch.getState().ask('open', w.runId)}>
                  <div className="t"><Icon name="approval" size={13} />{w.title}</div>
                  <div className="sub">{tr('编排「{runName}」· {v}{v2}', { runName: w.runName, v: w.kind === 'approval' ? tr('等你审批') : tr('候选跑完了，等你选一个合并'), v2: w.since ? ` · ${ago(w.since)}` : '' })}</div>
                  {w.kind === 'approval' && (
                    <div className="orch-wait-acts">
                      <button className="btn sm primary" disabled={!!orchBusy[`${w.runId}:${w.nodeId}`]} onClick={(e) => { e.stopPropagation(); void orchAct(`${w.runId}:${w.nodeId}`, { kind: 'orchestra.node.approve', runId: w.runId, nodeId: w.nodeId, decision: 'approve' }, tr('已通过')); }}>{tr('通过')}</button>
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); useOrch.getState().ask('open', w.runId); }}>{tr('去看看')}</button>
                    </div>
                  )}
                </div>
              ))}
              {!items.length && !orch.length && <div className="empty sm">—</div>}
            </div>
          );
        })}
      </div>
      {showDone && (
        <div className="lane resolved">
          <div className="lane-h"><b>{tr('已解决')}</b><span className="badge">{done.length}</span><span className="muted">{tr('最近 7 天归档的')}</span></div>
          {done.map((s) => (
            <div key={s.sessionId} className="mcard" onClick={() => void loadHistory(s.sessionId)}>
              <div className="t">{s.customTitle || s.title}</div>
              <div className="sub">{basename(s.cwd)}{s.gitBranch ? ` · ${s.gitBranch}` : ''} · {ago(s.lastModified)}</div>
            </div>
          ))}
          {!done.length && <div className="empty sm">—</div>}
        </div>
      )}
    </div>
  );
}
