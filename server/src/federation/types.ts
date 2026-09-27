// Cross-machine sessions (federation): wire types shared with the web client through protocol.ts.
// A remote machine's session is shown here as `peer_<peerId>~<remote id>`: `~` separates, no colons,
// and the peer id is `[a-z0-9]` only, so the first `~` always ends it (a remote id may contain `~`).

import type { AgentKind } from '../protocol.js';

export const PEER_ID_PREFIX = 'peer_';
const PEER_ID_RE = /^[a-z0-9]{1,32}$/;

export function isValidPeerId(id: string): boolean {
  return PEER_ID_RE.test(id);
}

/** The id a remote session (or a remote permission request) has on this machine. */
export function peerSessionId(peerId: string, remoteId: string): string {
  if (!isValidPeerId(peerId)) throw new Error(`invalid peer id: ${peerId}`);
  return `${PEER_ID_PREFIX}${peerId}~${remoteId}`;
}

/** Inverse of `peerSessionId`; null for anything that is not a (well-formed) peer id. */
export function parsePeerId(id: string): { peerId: string; remoteId: string } | null {
  if (typeof id !== 'string' || !id.startsWith(PEER_ID_PREFIX)) return null;
  const rest = id.slice(PEER_ID_PREFIX.length);
  const cut = rest.indexOf('~');
  if (cut <= 0) return null;
  const peerId = rest.slice(0, cut);
  const remoteId = rest.slice(cut + 1);
  if (!isValidPeerId(peerId) || !remoteId) return null;
  return { peerId, remoteId };
}

export function isPeerId(id: unknown): id is string {
  return typeof id === 'string' && parsePeerId(id) !== null;
}

/** online: connected · connecting: first attempt / reconnecting · offline: unreachable (retrying) ·
 *  unauthorized: the remote rejects our device token (revoked) — re-pair · disabled: switched off here. */
export type PeerState = 'online' | 'connecting' | 'offline' | 'unauthorized' | 'disabled';

/** What the client sees of a peer. The device token never leaves the server. */
export interface PeerInfo {
  id: string;
  name: string;
  url: string;
  via: 'direct' | 'ssh';
  hostId?: string;
  enabled: boolean;
  addedAt: number;
  state: PeerState;
  error?: string;
  latencyMs?: number;
  /** sessions in the last list fetched from it */
  sessions?: number;
  lastSeenAt?: number;
  /** the remote claude-web's own serverId (from its hello) */
  serverId?: string;
  version?: string;
}

/** Stored in meta.json (`peers`). `token` is `enc:` (SecretService) — empty for ssh peers, which use the host's token. */
export interface PeerRecord {
  id: string;
  name: string;
  url: string;
  via: 'direct' | 'ssh';
  hostId?: string;
  token: string;
  enabled: boolean;
  addedAt: number;
  serverId?: string;
}

/** Marks a SessionSummary that lives on another machine. `offline`: from the last cached list (read-only). */
export interface SessionPeer { id: string; name: string; offline?: boolean }

export type PeerRequest =
  | { kind: 'peers.list' }
  | { kind: 'peers.add'; url?: string; code?: string; name?: string; hostId?: string }
  | { kind: 'peers.update'; id: string; patch: { name?: string; enabled?: boolean } }
  | { kind: 'peers.repair'; id: string; code: string }
  | { kind: 'peers.remove'; id: string }
  /** 「交给本机 agent 继续」: read the remote transcript, start a NEW local session seeded with a briefing */
  | { kind: 'peers.handover'; sessionId: string; agent: AgentKind; model?: string; cwd: string };

export type PeerEvent = { kind: 'peers.changed' };
