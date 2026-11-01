import type { IconName } from '@/ui/icons';
import type { AgentKind } from '@shared';

/** Display name of a node's agent (runs saved before 2026-11-01 may name another agent). */
export function agentLabel(kind: AgentKind | string): string {
  return kind === 'claude' ? 'Claude Code' : String(kind).replace(/^acp:/, '');
}

export function agentIcon(kind: AgentKind | string): IconName {
  return kind === 'claude' ? 'claude' : 'agent';
}
