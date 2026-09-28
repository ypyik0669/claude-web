import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import type { FsStat, GitStatus } from '@shared';
import { sessionPeer } from '@/features/peers';

export interface RepoContext { git: GitStatus | null; worktree: boolean | null }

/**
 * Where a session types into: the repo's git status (branch, ahead / behind, changes) and whether the directory is
 * a linked worktree rather than the main checkout. Shown in the session header (it used to be the ContextRow
 * above the composer). A session on another machine gets nothing: its path means nothing here, so no git / fs probes.
 */
export function useRepoContext(cwd: string, sessionId?: string | null): RepoContext {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [worktree, setWorktree] = useState<boolean | null>(null);
  const sessions = useStore((s) => s.sessions);
  const peer = sessionPeer(sessionId ?? undefined, sessions);

  useEffect(() => {
    if (!cwd || peer) { setGit(null); setWorktree(null); return; }
    let live = true;
    let root: string | null = null;
    const load = async () => {
      const s = await ws.request<GitStatus>({ kind: 'git.status', cwd }).catch(() => null);
      if (!live) return;
      setGit(s);
      root = s?.root ?? null;
      // a linked worktree's .git is a file, not a directory — cheapest reliable signal we have
      if (s?.root) {
        const st = await ws.request<FsStat | null>({ kind: 'fs.stat', path: `${s.root}/.git` }).catch(() => null);
        if (live) setWorktree(st ? !st.dir : null);
      } else setWorktree(null);
    };
    void load();
    const off = ws.on((e) => { if (e.kind === 'git.changed' && root && e.cwd.toLowerCase() === root.toLowerCase()) void load(); });
    return () => { live = false; off(); };
  }, [cwd, !!peer]);

  return { git, worktree };
}
