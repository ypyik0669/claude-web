// 搜索 finds Artifacts too (redesign 2026-11 stage 3; the plan's 搜索 = Ctrl K: 对话、Artifacts、命令、设置): the same
// list the Artifacts page shows (`artifacts.list`: what Claude wrote in the recent conversations here, still on disk).
// The server reads the recent transcripts for it every time, so one answer serves the palette for a minute.
import type { ArtifactRef } from '@shared';
import { ws } from '@/ws/client';

const TTL_MS = 60_000;
let cache: { at: number; items: ArtifactRef[] } | null = null;
let inflight: Promise<ArtifactRef[]> | null = null;

/** The Artifacts list, from the last minute's answer when there is one (one request at a time). */
export function loadArtifacts(now = Date.now()): Promise<ArtifactRef[]> {
  if (cache && now - cache.at < TTL_MS) return Promise.resolve(cache.items);
  inflight ??= ws.request<{ items: ArtifactRef[] }>({ kind: 'artifacts.list' })
    .then((r) => { const items = r?.items ?? []; cache = { at: Date.now(), items }; return items; })
    .finally(() => { inflight = null; });
  return inflight;
}

const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

/**
 * The Artifacts a query (lower-cased) finds: by the file's name first, then the conversation it came from, then the
 * folder it is in (its last two parts — the whole path would match every file under a folder named like the query);
 * newest first within each. No query: none (the palette lists commands and recent conversations then).
 */
export function artifactHits(items: readonly ArtifactRef[], ql: string, max = 8): ArtifactRef[] {
  const q = ql.trim().toLowerCase();
  if (!q) return [];
  const rank = (a: ArtifactRef) => {
    if (base(a.path).toLowerCase().includes(q)) return 0;
    if ((a.title ?? '').toLowerCase().includes(q)) return 1;
    return a.path.replace(/\\/g, '/').split('/').slice(-3, -1).join('/').toLowerCase().includes(q) ? 2 : 3;
  };
  return items.map((a) => ({ a, r: rank(a) })).filter((x) => x.r < 3).sort((x, y) => x.r - y.r || y.a.at - x.a.at).slice(0, max).map((x) => x.a);
}
