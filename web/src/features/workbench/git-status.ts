import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import type { GitStatus } from '@shared';
import { coalesce, gitEventConcerns } from './git-refresh';

/**
 * git status for a cwd (the file tree's badges). Refreshed only by events about THIS repo (`gitEventConcerns`:
 * its resolved root or the cwd form, which differ behind a junction / symlink) and coalesced — 400 ms of
 * quiet, but at least every 2 s during a steady stream: a status is a git process on the server.
 */
export function useGitStatus(cwd: string, enabled: boolean): GitStatus | null {
  const [st, setSt] = useState<GitStatus | null>(null);
  useEffect(() => {
    if (!enabled || !cwd) return;
    let alive = true;
    let root: string | null = null;
    const load = () => ws.request<GitStatus>({ kind: 'git.status', cwd }).then((s) => { if (alive) { root = s.root; setSt(s); } }).catch(() => alive && setSt(null));
    const soon = coalesce(load, 400, 2000);
    load();
    void ws.request({ kind: 'git.watch', cwd }).catch(() => {});
    const off = ws.on((e) => { if (gitEventConcerns(e, { cwd, root })) soon.trigger(); });
    return () => { alive = false; soon.cancel(); off(); };
  }, [cwd, enabled]);
  return st;
}
