// Hub glue for orchestration: builds the service from the server's services, routes `orchestra.*`
// requests, and wires approvals into IM. hub.ts only dispatches here.
import path from 'node:path';
import { dataDir } from '../files/service.js';
import type { ImService } from '../im/service.js';
import { OrchestraService } from './service.js';
import { orchestraDeps, type RuntimeServices } from './runtime.js';
import type { OrchestraRequest, OrchRun } from './types.js';

export function isOrchestraRequest(req: { kind: string }): req is OrchestraRequest {
  return req.kind.startsWith('orchestra.');
}

export async function createOrchestra(s: RuntimeServices & { im: ImService }): Promise<OrchestraService> {
  const sessionsOf = (run: OrchRun) => Object.values(run.nodes).flatMap((n) => n.sessionIds);
  let svc: OrchestraService;
  const notify = (run: OrchRun, nodeId: string, what: 'approval' | 'compare') => {
    const node = run.workflow.find((n) => n.id === nodeId);
    const title = node?.title || nodeId;
    if (what === 'approval') {
      const note = node?.kind === 'approval' && node.note ? `\n${node.note}` : '';
      void s.im.router.announce(sessionsOf(run), `编排「${run.name}」等你审批：${title}${note}`, { buttons: [{ id: `orch:${run.id}:${nodeId}:approve`, label: '通过' }, { id: `orch:${run.id}:${nodeId}:reject`, label: '驳回', danger: true }] });
    } else {
      void s.im.router.announce(sessionsOf(run), `编排「${run.name}」的比选「${title}」候选都跑完了，到 claude-web 的「编排」面板里选一个合并。`);
    }
  };
  svc = new OrchestraService(orchestraDeps(s, path.join(dataDir(), 'orchestra'), notify));
  s.im.router.callbackHandlers.set('orch', async ([runId, nodeId, decision]) => {
    const run = await svc.approve(runId, nodeId, decision === 'reject' ? 'reject' : 'approve', decision === 'reject' ? '在 IM 上驳回' : undefined);
    return `${decision === 'reject' ? '已驳回' : '已通过'}：${run.name}`;
  });
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
    case 'orchestra.run.remove': await o.remove(req.runId); return null;
    case 'orchestra.node.retry': return o.retry(req.runId, req.nodeId);
    case 'orchestra.node.approve': return o.approve(req.runId, req.nodeId, req.decision, req.comment);
    case 'orchestra.node.pick': return o.pick(req.runId, req.nodeId, req.winner);
    case 'orchestra.node.diff': return o.diff(req.runId, req.nodeId, req.agent);
  }
}
