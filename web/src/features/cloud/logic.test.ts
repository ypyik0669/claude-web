import { describe, it, expect } from 'vitest';
import type { SessionSummary } from '@shared';
import { canHandOffToPeer, expiryText, projectSessions, publishLinks } from './logic';

const row = (sessionId: string, cwd: string, lastModified: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId, cwd, title: sessionId, lastModified, ...extra });

describe('project page', () => {
  it('lists the project\'s conversations: meta.workspaceId, else its main folder; not other machines\'; newest first', () => {
    const w = { id: 'w1', path: 'C:\\code\\app' };
    const list = [row('a', 'c:/code/app/', 1), row('b', 'C:\\code\\site', 5), row('c', 'C:\\wt\\x', 3), row('d', 'C:\\code\\app', 9, { peer: { id: 'p', name: 'P' } }), row('e', 'C:\\code\\app', 4)];
    const meta = { c: { workspaceId: 'w1' }, e: { workspaceId: 'w2' } };
    expect(projectSessions(list, w, meta, true).map((s) => s.sessionId)).toEqual(['c', 'a']);
  });
});

describe('publish links', () => {
  const base = { id: 'x'.repeat(32), name: 'p.html', source: '/p.html', entry: 'p.html', createdAt: 0, updatedAt: 0, expiresAt: null, files: 1, bytes: 1 };
  it('here + LAN only when remote listening gave one; the peer\'s own link', () => {
    expect(publishLinks({ ...base, localUrl: 'http://127.0.0.1:3090/p/x/', lanUrl: null })).toEqual({ local: 'http://127.0.0.1:3090/p/x/', lan: null, peer: null });
    expect(publishLinks({ ...base, localUrl: 'l', lanUrl: 'http://192.168.1.2:3091/p/x/' }).lan).toBe('http://192.168.1.2:3091/p/x/');
    expect(publishLinks({ ...base, peerId: 'p1', url: 'http://box:3090/p/y/' })).toEqual({ local: null, lan: null, peer: 'http://box:3090/p/y/' });
  });
  it('expiry in words', () => {
    expect(expiryText(null)).toBe('永久');
    expect(expiryText(1000, 2000)).toBe('已过期');
    expect(expiryText(3_600_000 * 5, 0)).toBe('5 小时后过期');
    expect(expiryText(3_600_000 * 24 * 7, 0)).toBe('7 天后过期');
  });
});

describe('交给常开机器继续', () => {
  it('only this machine\'s own Claude conversations that were not handed off yet', () => {
    expect(canHandOffToPeer({ sessionId: '11111111-1111-1111-1111-111111111111' })).toBe(true);
    expect(canHandOffToPeer({ sessionId: 'peer_p~x', peer: { id: 'p', name: 'P' } })).toBe(false);
    expect(canHandOffToPeer({ sessionId: 'claudeai-abc', agent: 'claudeai' })).toBe(false);
    expect(canHandOffToPeer({ sessionId: 'abc' }, { handedOff: { id: 'i', peerId: 'p', peerName: 'P', remote: 'origin', branch: 'cw/handoff-i', commit: 'c', base: 'b', at: 0 } })).toBe(false);
  });
});
