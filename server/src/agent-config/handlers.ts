// WS dispatch for `agentConfig.*` — the hub forwards every request with that prefix here.
import type { AgentConfigKind, AgentConfigRequest } from './types.js';
import { AGENT_CONFIG_KINDS, type AgentConfigService } from './service.js';

const kindOk = (k: unknown): AgentConfigKind => {
  if (!AGENT_CONFIG_KINDS.includes(k as AgentConfigKind)) throw new Error(`不支持的 agent：${String(k)}`);
  return k as AgentConfigKind;
};

export function isAgentConfigRequest(req: { kind: string }): req is AgentConfigRequest {
  return req.kind.startsWith('agentConfig.');
}

export async function handleAgentConfig(svc: AgentConfigService, req: AgentConfigRequest): Promise<unknown> {
  switch (req.kind) {
    case 'agentConfig.list': return svc.list(req.cwd);
    case 'agentConfig.get': return svc.get(kindOk(req.agent), req.cwd);
    case 'agentConfig.claudeMcp': return svc.claudeMcp(req.cwd);
    case 'agentConfig.mcp.add': return svc.mcpAdd(kindOk(req.agent), req.spec, !!req.overwrite);
    case 'agentConfig.mcp.remove': return svc.mcpRemove(kindOk(req.agent), req.name);
    case 'agentConfig.mcp.sync': return svc.sync(req.source, (req.targets ?? []).map(kindOk), !!req.overwrite);
    case 'agentConfig.set': return svc.set(kindOk(req.agent), req.key, req.value ?? null);
    case 'agentConfig.createFile': return svc.createFile(kindOk(req.agent), req.path, req.cwd);
    case 'agentConfig.backups': return svc.listBackups(req.agent ? kindOk(req.agent) : undefined);
    case 'agentConfig.restore': return svc.restore(req.id);
  }
  throw new Error(`unknown request ${(req as { kind: string }).kind}`);
}
