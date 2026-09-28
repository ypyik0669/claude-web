import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { basename, clsx } from '@/util';
import { Icon } from '@/ui/icons';
import type { FsStat, GitStatus, SessionInfoSnapshot } from '@shared';
import { sessionPeer } from '@/features/peers';

/**
 * The line above the composer that answers "where am I typing into".
 *
 * Working directory, branch, and whether this is a worktree rather than the main checkout — the
 * three things that decide whether a message is safe to send, and the three that are invisible
 * otherwise. It is deliberately quiet: 11px, no borders, and it disappears outside a repo.
 */
export function ContextRow({ cwd, info, sessionId }: { cwd: string; info?: SessionInfoSnapshot; sessionId?: string }) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const [worktree, setWorktree] = useState<boolean | null>(null);
  const dispatch = useStore((s) => s.dispatchLayout);
  const sessions = useStore((s) => s.sessions);
  // a session on another machine: its path means nothing here — no git / fs probes, no local file panel
  const peer = sessionPeer(sessionId, sessions);

  useEffect(() => {
    if (!cwd || peer) { setGit(null); setWorktree(null); return; }
    let live = true;
    const load = async () => {
      const s = await ws.request<GitStatus>({ kind: 'git.status', cwd }).catch(() => null);
      if (!live) return;
      setGit(s);
      // a linked worktree's .git is a file, not a directory — cheapest reliable signal we have
      if (s?.root) {
        const st = await ws.request<FsStat | null>({ kind: 'fs.stat', path: `${s.root}/.git` }).catch(() => null);
        if (live) setWorktree(st ? !st.dir : null);
      } else setWorktree(null);
    };
    void load();
    const off = ws.on((e) => { if (e.kind === 'git.changed' && git?.root && e.cwd.toLowerCase() === git.root.toLowerCase()) void load(); });
    return () => { live = false; off(); };
  }, [cwd, git?.root, !!peer]);

  if (!cwd) return null;
  if (peer) {
    return (
      <div className="ctx-row">
        <span className="it" title={`${cwd}（在机器「${peer.name}」上）`}><Icon name="machine" size={11} /> {peer.name} · {basename(cwd) || cwd}</span>
        {info?.agent && info.agent !== 'claude' && <span className="it" title={`由 ${info.agentName ?? info.agent} 运行`}>{info.agentName ?? info.agent}</span>}
      </div>
    );
  }
  const dirty = git?.files.length ?? 0;
  return (
    <div className="ctx-row">
      <button className="it" title={cwd} onClick={() => dispatch({ t: 'dock.show', panel: 'files' })}>
        <Icon name="folder" size={11} /> {basename(cwd) || cwd}
      </button>
      {git?.branch && (
        <button className={clsx('it', git.state !== 'clean' && 'warn')} title={`${git.branch}${git.upstream ? ` → ${git.upstream}` : ' · 无上游'}${dirty ? ` · ${dirty} 处改动` : ' · 干净'}`} onClick={() => dispatch({ t: 'dock.show', panel: 'files' })}>
          <Icon name="branch" size={11} /> {git.branch}
          {git.ahead > 0 && <span className="n">↑{git.ahead}</span>}
          {git.behind > 0 && <span className="n">↓{git.behind}</span>}
          {dirty > 0 && <span className="n">•{dirty}</span>}
        </button>
      )}
      {worktree && <span className="it" title="这是一个 worktree，不是主检出">worktree</span>}
      {info?.agent && info.agent !== 'claude' && <span className="it" title={`由 ${info.agentName ?? info.agent} 运行`}>{info.agentName ?? info.agent}</span>}
    </div>
  );
}
