import { useMemo } from 'react';
import { settledVersion, useSettledSession, useStore } from '@/store';
import { basename } from '@/util';
import { walkTools } from '@/model/conversation';
import { blockRemoteOpen } from '@/features/remote-guard';
import { Icon } from '@/ui/icons';
import { EmptyState } from '@/ui/EmptyState';
import { EMPTY } from '@/ui/terms';

/** Files a session produced: Artifact tool outputs and Write-created files, newest first. */
export function useArtifacts(sessionId: string | null | undefined): { path: string; via: string }[] {
  // settled: a written file shows when its tool call finishes, not with each frame of a stream (it walked every tool
  // call of the conversation 60 times a second while a turn streamed)
  const active = useSettledSession(sessionId);
  return useMemo(() => {
    if (!active) return [];
    const seen = new Map<string, { path: string; via: string }>();
    for (const { tool } of walkTools(active.conv.items)) {
      const inp = tool.input as any;
      const p: string | undefined = tool.name === 'Write' ? inp.file_path : tool.name === 'Artifact' ? inp.path ?? inp.file_path ?? (tool.result?.structured as any)?.path : undefined;
      if (p && tool.status === 'done') seen.set(p, { path: p, via: tool.name });
    }
    return [...seen.values()].reverse();
  }, [settledVersion(active), active?.conv]);
}

/** The 生成的文件 list (the in-place view, and the group at the top of the right panel's 文件 tab). */
export function Artifacts({ sessionId, compact }: { sessionId: string; compact?: boolean }) {
  const items = useArtifacts(sessionId);
  const openTile = useStore((s) => s.openTile);
  if (!items.length) return compact ? null : <EmptyState e={EMPTY.artifacts} />;
  return (
    <div className="list">
      {items.map((a) => (
        <div key={a.path} className="row clickable" onClick={() => { if (!blockRemoteOpen(sessionId, a.path)) openTile({ id: `d${Date.now()}`, kind: 'doc', path: a.path }, 'tab'); }} title={a.path}>
          <span><Icon name="read" size={13} /></span>
          <div className="grow"><div>{basename(a.path)}</div><div className="sub">{a.path}</div></div>
          <span className="badge">{a.via}</span>
        </div>
      ))}
    </div>
  );
}
