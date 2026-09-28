import { parsePeerId, type SessionPeer, type SessionSummary } from '@shared';

/**
 * Which machine a session lives on, decided by its id alone (`peer_<peer>~<id>`) — never by whether
 * the session list has arrived yet: right after a fork, or when a layout is restored before the
 * list, a remote session must not be mistaken for a local one (and have git / fs run on its path
 * here). The name comes from the list when it is there, else the peer id stands in.
 */
export function sessionPeer(sessionId: string | null | undefined, sessions: SessionSummary[]): SessionPeer | null {
  if (!sessionId) return null;
  const p = parsePeerId(sessionId);
  if (!p) return null;
  const listed = sessions.find((s) => s.sessionId === sessionId)?.peer ?? sessions.find((s) => s.peer?.id === p.peerId)?.peer;
  return listed ? { ...listed, id: p.peerId } : { id: p.peerId, name: p.peerId };
}
