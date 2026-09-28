/** Paths compared the way Windows does: separators unified, case folded, no trailing slash. */
export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const ACTIVE = new Set(['running', 'waiting', 'starting']);

export interface CheckoutUser { cwd: string; state?: string }

/**
 * Conversations working in this checkout right now — a branch switch changes the files under their feet. `root` is
 * the checkout's top level (git.status). A conversation counts when its directory is the root or below it, except
 * inside a worktree of Claude Code (`<root>/.claude/worktrees/…`: a separate checkout with its own branch).
 */
export function busyInCheckout(root: string | null | undefined, sessions: readonly CheckoutUser[]): number {
  if (!root) return 0;
  const r = normPath(root);
  return sessions.filter((s) => {
    if (!s.state || !ACTIVE.has(s.state) || !s.cwd) return false;
    const c = normPath(s.cwd);
    if (c !== r && !c.startsWith(`${r}/`)) return false;
    return !c.slice(r.length).startsWith('/.claude/worktrees/');
  }).length;
}

/**
 * Every conversation this server knows to be alive: the session list's `live` (runners started anywhere — another
 * window, IM, a schedule) overlaid with this window's open sessions (fresher; brand-new ones are not listed yet).
 * Sessions on another machine are left out — their paths are not this disk.
 */
export function liveSessions(
  list: readonly { sessionId: string; cwd: string; live?: string; peer?: unknown }[],
  open: Readonly<Record<string, { cwd: string; state: string }>>,
): CheckoutUser[] {
  const out = new Map<string, CheckoutUser>();
  for (const s of list) if (!s.peer) out.set(s.sessionId, { cwd: s.cwd, state: s.live });
  for (const [id, o] of Object.entries(open)) {
    if (id.startsWith('peer_')) continue;
    out.set(id, { cwd: o.cwd || out.get(id)?.cwd || '', state: o.state });
  }
  return [...out.values()];
}
