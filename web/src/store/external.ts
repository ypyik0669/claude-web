// A conversation written by something other than this app — the Claude CLI in a terminal, Codex's own CLI or desktop
// app (user report: the open view froze at whatever was on disk when it was clicked, a CLI turn's closing report never
// showed, later turns never came; only restarting the app caught up). The server names the conversations whose
// record changed (`transcripts.changed`); these decide which open ones re-read and how often. Pure — the store wires it.
import type { LayoutState } from '@/model/layout';

/** After an outside write, the last turn counts as still running this long (its tool keeps its spinner, it stays unfolded). */
export const EXTERNAL_LIVE_MS = 20_000;
/** Re-reads of one conversation at most this often… */
export const EXTERNAL_MIN_GAP_MS = 2_000;
/** …and never more than this share of the time: a 60 MB transcript takes a second to load (server + parse). */
export const EXTERNAL_LOAD_SHARE = 4;

/** Not running here: the only way it changes is from outside, so an outside write means re-read. */
export const readsFromOutside = (o: { state: string }) => o.state === 'history' || o.state === 'closed' || o.state === 'error';

/** The outside write is recent enough that its turn may still be going. */
export const externalLive = (o: { externalAt?: number } | undefined, now = Date.now()) => !!o?.externalAt && now - o.externalAt < EXTERNAL_LIVE_MS;

/** Conversations on screen: the front tab of every pane in the group being shown. */
export function shownSessions(layout: LayoutState): Set<string> {
  const out = new Set<string>();
  const g = layout.groups.find((x) => x.id === layout.activeGroupId);
  for (const p of Object.values(g?.panes ?? {})) {
    const t = p.tiles.find((x) => x.id === p.activeTileId) ?? p.tiles[0];
    if (t?.kind === 'chat' && t.sessionId) out.add(t.sessionId);
  }
  return out;
}

/** When the next re-read may start: `EXTERNAL_MIN_GAP_MS` after the last, longer when loading it is slow. */
export const nextReadAt = (lastStart: number, lastMs: number) => lastStart + Math.max(EXTERNAL_MIN_GAP_MS, lastMs * EXTERNAL_LOAD_SHARE);
