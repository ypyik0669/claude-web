import { describe, expect, it } from 'vitest';
import { isPeerId, parsePeerId, peerSessionId } from './types.js';
import { parsePeerId as fromProtocol } from '../protocol.js';

describe('peer session ids', () => {
  it('round-trips a Claude UUID and library ids', () => {
    for (const remote of ['0b7c1c4e-2f1a-4c55-9e57-1d2b3c4d5e6f', 'codex-thr-a', 'acp_my~agent-s1']) {
      const id = peerSessionId('ab12', remote);
      expect(id).toBe(`peer_ab12~${remote}`);
      expect(parsePeerId(id)).toEqual({ peerId: 'ab12', remoteId: remote });
      expect(id).not.toContain(':');
    }
  });

  it('the first ~ ends the peer id (remote ids may contain ~)', () => {
    expect(parsePeerId('peer_x1~acp_a~b-c')).toEqual({ peerId: 'x1', remoteId: 'acp_a~b-c' });
  });

  it('rejects malformed ids', () => {
    for (const bad of ['', 'peer_', 'peer_~x', 'peer_AB~x', 'peer_a-b~x', 'peer_ab~', 'peerab~x', 'codex-thr', '0b7c1c4e']) expect(parsePeerId(bad)).toBeNull();
    expect(isPeerId(undefined)).toBe(false);
    expect(isPeerId('peer_ab~x')).toBe(true);
  });

  it('refuses to mint an id from an invalid peer id', () => {
    expect(() => peerSessionId('A-B', 'x')).toThrow();
  });

  it('is exported through protocol.ts (web uses it via @shared)', () => {
    expect(fromProtocol('peer_z9~s')).toEqual({ peerId: 'z9', remoteId: 's' });
  });
});
