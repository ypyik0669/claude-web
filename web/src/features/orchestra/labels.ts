import { useStore } from '@/store';
import type { IconName } from '@/ui/icons';
import type { AgentKind } from '@shared';

const BUILTIN_ICONS: Record<string, IconName> = { claude: 'claude', codex: 'codex', gemini: 'gemini', qwen: 'qwen', kimi: 'kimi', opencode: 'opencode' };

/** Display name from the agent registry the store already has (falls back to the kind). */
export function agentLabel(kind: AgentKind | string): string {
  const a = useStore.getState().agents.find((x) => x.kind === kind);
  return a?.name ?? (kind === 'claude' ? 'Claude Code' : String(kind).replace(/^acp:/, ''));
}

export function agentIcon(kind: AgentKind | string): IconName {
  return BUILTIN_ICONS[kind] ?? 'agent';
}
