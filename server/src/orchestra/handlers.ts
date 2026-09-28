// Hub glue for orchestration: builds the service from the server's services, routes `orchestra.*`
// requests, and wires approvals into IM. hub.ts only dispatches here.
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { dataDir } from '../files/service.js';
import type { ImService } from '../im/service.js';
import { OrchestraService } from './service.js';
import { orchestraDeps, type RuntimeServices } from './runtime.js';
import type { OrchestraRequest, OrchRun } from './types.js';

export function isOrchestraRequest(req: { kind: string }): req is OrchestraRequest {
  return req.kind.startsWith('orchestra.');
}

/**
 * IM approval buttons. Callback ids are short tokens (`orch:<8 hex>:a|r`, Telegram allows 64 bytes) mapped
 * to (run, node) in memory — after a restart they are stale and the user is sent to the panel. A decision
 * is accepted only from a chat bound to one of the run's sessions (the router has already checked the
 * user is on the gateway's allow list).
 */
export class OrchImBridge {
  private tokens = new Map<string, { runId: string; nodeId: string }>();
  constructor(private svc: Pick<OrchestraService, 'get' | 'approve'>) {}

  buttons(runId: string, nodeId: string) {
    const token = randomBytes(4).toString('hex');
    this.tokens.set(token, { runId, nodeId });
    return [{ id: `orch:${token}:a`, label: '通过' }, { id: `orch:${token}:r`, label: '驳回', danger: true }];
  }

  async handle([token, choice]: string[], boundSessionId: string | undefined): Promise<string> {
    const t = this.tokens.get(token);
    if (!t) return '这个审批按钮已失效（可能服务重启过），到 claude-web 的「编排」面板里处理。';
    if (choice !== 'a' && choice !== 'r') return `不认识的操作：${choice}`;
    let run: OrchRun;
    try { run = this.svc.get(t.runId); } catch { return '这个编排运行已经不存在了。'; }
    if (!boundSessionId) return '这个聊天没有绑定会话，不能审批编排。';
    if (!Object.values(run.nodes).some((n) => n.sessionIds.includes(boundSessionId))) return '这个聊天绑定的会话不属于这个编排运行，不能审批。';
    const decision = choice === 'a' ? 'approve' : 'reject';
    await this.svc.approve(t.runId, t.nodeId, decision, decision === 'reject' ? '在 IM 上驳回' : undefined);
    this.tokens.delete(token);
    return `${decision === 'reject' ? '已驳回' : '已通过'}：${run.name}`;
  }
}

export async function createOrchestra(s: RuntimeServices & { im: ImService }): Promise<OrchestraService> {
  const sessionsOf = (run: OrchRun) => Object.values(run.nodes).flatMap((n) => n.sessionIds);
  let bridge: OrchImBridge;
  const notify = (run: OrchRun, nodeId: string, what: 'approval' | 'compare') => {
    const node = run.workflow.find((n) => n.id === nodeId);
    const title = node?.title || nodeId;
    if (what === 'approval') {
      const note = node?.kind === 'approval' && node.note ? `\n${node.note}` : '';
      void s.im.router.announce(sessionsOf(run), `编排「${run.name}」等你审批：${title}${note}`, { buttons: bridge.buttons(run.id, nodeId) });
    } else {
      void s.im.router.announce(sessionsOf(run), `编排「${run.name}」的比选「${title}」候选都跑完了，到 claude-web 的「编排」面板里选一个合并。`);
    }
  };
  const svc = new OrchestraService(orchestraDeps(s, { runs: path.join(dataDir(), 'orchestra'), worktrees: path.join(dataDir(), 'worktrees') }, notify));
  bridge = new OrchImBridge(svc);
  s.im.router.callbackHandlers.set('orch', (parts, ctx) => bridge.handle(parts, ctx.sessionId));
  await svc.init();
  return svc;
}

export async function handleOrchestra(o: OrchestraService, req: OrchestraRequest): Promise<unknown> {
  switch (req.kind) {
    case 'orchestra.templates': return o.templates();
    case 'orchestra.workflows.list': return o.workflows();
    case 'orchestra.workflows.save': return o.saveWorkflow(req.workflow);
    case 'orchestra.workflows.remove': await o.removeWorkflow(req.id); return null;
    case 'orchestra.run.start': return o.start(req.workflowId, req.input);
    case 'orchestra.runs.list': return o.list();
    case 'orchestra.run.get': return o.get(req.runId);
    case 'orchestra.run.cancel': return o.cancel(req.runId);
    case 'orchestra.run.resume': return o.resume(req.runId);
    case 'orchestra.run.remove': return o.remove(req.runId, !!req.cleanup);
    case 'orchestra.node.retry': return o.retry(req.runId, req.nodeId);
    case 'orchestra.node.approve': return o.approve(req.runId, req.nodeId, req.decision, req.comment);
    case 'orchestra.node.pick': return o.pick(req.runId, req.nodeId, req.winner);
    case 'orchestra.node.diff': return o.diff(req.runId, req.nodeId, req.agent);
  }
}
