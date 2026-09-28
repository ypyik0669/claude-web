import type { PermissionMode } from '@shared';
import { PERMISSION_MODE_ORDER } from '@/ui/terms';

/**
 * 「新对话默认权限」 (settings `ui.defaultMode`) for a brand-new conversation opened without an explicit mode — the
 * sidebar's 新建 / worktree, the Git view, the board. Anything with a sessionId (resume, fork, reopen) keeps its
 * own mode, and an explicit permissionMode always wins (the welcome page passes the one on its chip).
 */
export function withDefaultMode<P extends { sessionId?: string; permissionMode?: PermissionMode }>(p: P, settings: Record<string, unknown>): P {
  if (p.sessionId || p.permissionMode) return p;
  const m = settings['ui.defaultMode'];
  return typeof m === 'string' && (PERMISSION_MODE_ORDER as readonly string[]).includes(m) ? { ...p, permissionMode: m as PermissionMode } : p;
}
