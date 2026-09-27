// Session library ids (Task 1). See constraints.md: Claude keeps its native UUID; every other
// source is `<agent>-<native id>` with no colons, so a custom ACP agent's `acp:<id>` kind maps to
// `acp_<id>-` (colon -> underscore) before the native id is appended.
import type { AgentKind } from '../protocol.js';

const PREFIXED: AgentKind[] = ['gemini', 'qwen', 'kimi'];

/** Build the library-wide session id for a source-native session id. Claude is returned as-is. */
export function libraryId(kind: AgentKind, nativeId: string): string {
  if (kind === 'codex') return `codex-${nativeId}`;
  if (kind === 'opencode') return `opencode-${nativeId}`;
  // built-in ACP agents get their own prefix too — otherwise their ids would parse back as Claude
  if (PREFIXED.includes(kind)) return `${kind}-${nativeId}`;
  // Escape '-' as '~' in the agent-id part only, so the first '-' after 'acp_' unambiguously
  // marks the boundary before nativeId (which may itself contain '-' unescaped).
  if (kind.startsWith('acp:')) return `acp_${kind.slice('acp:'.length).replace(/-/g, '~')}-${nativeId}`;
  // 'claude' passes through unchanged.
  return nativeId;
}

/** Inverse of libraryId. An id with no recognized prefix is assumed to be a native Claude id. */
export function parseLibraryId(id: string): { kind: AgentKind; nativeId: string } {
  if (id.startsWith('codex-')) return { kind: 'codex', nativeId: id.slice('codex-'.length) };
  if (id.startsWith('opencode-')) return { kind: 'opencode', nativeId: id.slice('opencode-'.length) };
  for (const k of PREFIXED) if (id.startsWith(`${k}-`)) return { kind: k, nativeId: id.slice(k.length + 1) };
  if (id.startsWith('acp_')) {
    const rest = id.slice('acp_'.length);
    const dash = rest.indexOf('-');
    if (dash >= 0) {
      return { kind: `acp:${rest.slice(0, dash).replace(/~/g, '-')}` as AgentKind, nativeId: rest.slice(dash + 1) };
    }
  }
  return { kind: 'claude', nativeId: id };
}
