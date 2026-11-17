import { useEffect, useState } from 'react';
import type { SlashCommandInfo } from '@shared';
import { ws } from '@/ws/client';

/**
 * `slash.list` for the / menu: what Claude Code would offer in this folder, read from the disk by the server — for a
 * conversation whose process is not running (yet). Asked each time the menu opens (the server keeps it 5 s); the last
 * answer per folder is shown meanwhile. `cwd === null`: not asked (another agent, another machine, WSL, menu closed).
 */
const last = new Map<string, SlashCommandInfo[]>();
const NONE: SlashCommandInfo[] = [];

export function useSlashFallback(cwd: string | null): SlashCommandInfo[] {
  const [list, setList] = useState<SlashCommandInfo[]>(() => (cwd !== null ? last.get(cwd) ?? NONE : NONE));
  useEffect(() => {
    if (cwd === null) return;
    setList(last.get(cwd) ?? NONE);
    let live = true;
    ws.request<SlashCommandInfo[]>({ kind: 'slash.list', ...(cwd ? { cwd } : {}) })
      .then((r) => {
        if (!Array.isArray(r)) return;
        last.set(cwd, r);
        if (live) setList(r);
      })
      .catch(() => { /* an older server: the process's own list only */ });
    return () => { live = false; };
  }, [cwd]);
  return cwd === null ? NONE : list;
}
