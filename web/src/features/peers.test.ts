import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import { remoteFileNote, remoteOpenBlock, sessionPeer } from './peers';

const s = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: id, cwd: '/w', lastModified: 0, ...o });

describe('remoteFileNote', () => {
  it('names the machine (and the path when given) instead of opening anything here', () => {
    expect(remoteFileNote({ name: 'Box B' }, 'C:/w/a.ts')).toBe('文件在机器「Box B」上（C:/w/a.ts），请在那台机器上打开');
    expect(remoteFileNote({ name: 'Box B' })).toBe('文件在机器「Box B」上，请在那台机器上打开');
  });
});

describe('remoteOpenBlock (tool-card paths, attachments, artifacts, inspector)', () => {
  it('a local session opens files here', () => {
    expect(remoteOpenBlock('0b6f-uuid', [], 'C:/w/a.ts')).toBeNull();
    expect(remoteOpenBlock(null, [], 'C:/w/a.ts')).toBeNull();
  });
  it('a remote session never opens the same path on this disk — even before the list names the machine', () => {
    expect(remoteOpenBlock('peer_b1~x', [], 'C:/w/a.ts')).toBe('文件在机器「b1」上（C:/w/a.ts），请在那台机器上打开');
    expect(remoteOpenBlock('peer_b1~x', [s('peer_b1~x', { peer: { id: 'b1', name: 'Box B' } })], 'C:/w/a.ts')).toContain('Box B');
  });
});

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
