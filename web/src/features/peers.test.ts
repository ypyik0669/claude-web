import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import { sessionPeer } from './peers';

const s = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: id, cwd: '/w', lastModified: 0, ...o });

describe('sessionPeer', () => {
  it('local ids are local, whatever the list says', () => {
    expect(sessionPeer('0b6f-uuid', [])).toBeNull();
    expect(sessionPeer('codex-t1', [])).toBeNull();
    expect(sessionPeer(null, [])).toBeNull();
  });
  it('a peer id is remote even before the list arrives (fork, restored layout): the peer id stands in for the name', () => {
    expect(sessionPeer('peer_b1~new-fork', [])).toEqual({ id: 'b1', name: 'b1' });
  });
  it('the name (and offline flag) come from the list: the row itself, else any row of that machine', () => {
    const list = [s('peer_b1~x', { peer: { id: 'b1', name: 'Box B', offline: true } })];
    expect(sessionPeer('peer_b1~x', list)).toEqual({ id: 'b1', name: 'Box B', offline: true });
    expect(sessionPeer('peer_b1~fresh-fork', list)).toEqual({ id: 'b1', name: 'Box B', offline: true });
  });
});
