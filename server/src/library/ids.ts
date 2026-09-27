// Session library ids (Task 1). See constraints.md: Claude keeps its native UUID; every other
// source is `<agent>-<native id>` with no colons, so a custom ACP agent's `acp:<id>` kind maps to
// `acp_<id>-` (colon -> underscore) before the native id is appended. The prefix list and the
// parser live in protocol.ts so the web client shares the one copy.
import { LIBRARY_ID_PREFIXED_KINDS, parseLibraryId, type AgentKind } from '../protocol.js';

export { parseLibraryId };

/** Build the library-wide session id for a source-native session id. Claude is returned as-is. */
export function libraryId(kind: AgentKind, nativeId: string): string {
  if ((LIBRARY_ID_PREFIXED_KINDS as readonly string[]).includes(kind)) return `${kind}-${nativeId}`;
  // Escape '-' as '~' in the agent-id part only, so the first '-' after 'acp_' unambiguously
  // marks the boundary before nativeId (which may itself contain '-' unescaped).
  if (kind.startsWith('acp:')) return `acp_${kind.slice('acp:'.length).replace(/-/g, '~')}-${nativeId}`;
  // 'claude' passes through unchanged.
  return nativeId;
}
