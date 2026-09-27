import { describe, expect, it } from 'vitest';
import type { ClientRequest, ServerEvent, SessionSummary } from '../protocol.js';
import { importList, inbound, outbound, planRoute, rewriteEvent } from './rewrite.js';

const P = { id: 'b1', name: 'Box B' };
const sum = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: id, cwd: '/r', lastModified: 1, ...extra });

describe('planRoute', () => {
  it('leaves requests without peer ids alone', () => {
    expect(planRoute({ kind: 'session.send', params: { sessionId: 'abc', text: 'x' } })).toEqual({ kind: 'none' });
    expect(planRoute({ kind: 'fs.list', path: '/' })).toEqual({ kind: 'none' });
  });
  it('forwards session operations to the owning peer', () => {
    for (const req of [
      { kind: 'session.open', params: { sessionId: 'peer_b1~s1', cwd: '/r' } },
      { kind: 'session.send', params: { sessionId: 'peer_b1~s1', text: 'hi' } },
      { kind: 'session.interrupt', sessionId: 'peer_b1~s1' },
      { kind: 'permission.respond', requestId: 'peer_b1~r9', response: { behavior: 'allow' } },
      { kind: 'transcript.load', sessionId: 'peer_b1~s1' },
      { kind: 'library.rename', sessionId: 'peer_b1~s1', title: 't' },
    ] as ClientRequest[]) expect(planRoute(req)).toEqual({ kind: 'forward', peerId: 'b1' });
  });
  it('splits batches, keeps local UI state here, rejects the rest', () => {
    expect(planRoute({ kind: 'library.delete', sessionIds: ['a', 'peer_b1~s1'] })).toEqual({ kind: 'split' });
    expect(planRoute({ kind: 'session.setMeta', sessionId: 'peer_b1~s1', patch: { pinned: true } })).toEqual({ kind: 'local' });
    expect(planRoute({ kind: 'session.setProvider', sessionId: 'peer_b1~s1' }).kind).toBe('reject');
    expect(planRoute({ kind: 'session.switchAgent', sessionId: 'peer_b1~s1', agent: 'codex' }).kind).toBe('reject');
  });
});

describe('outbound / inbound', () => {
  it('strips prefixes on the way out', () => {
    expect(outbound({ kind: 'session.open', params: { sessionId: 'peer_b1~s1', cwd: '/r', fork: true } })).toEqual({ kind: 'session.open', params: { sessionId: 's1', cwd: '/r', fork: true } });
    expect(outbound({ kind: 'permission.respond', requestId: 'peer_b1~r9', response: { behavior: 'allow' } })).toMatchObject({ requestId: 'r9' });
    expect(outbound({ kind: 'library.archive', sessionIds: ['peer_b1~s1', 'peer_b1~codex-x'], archived: true })).toMatchObject({ sessionIds: ['s1', 'codex-x'] });
  });
  it('does not mutate the caller\'s request', () => {
    const req: ClientRequest = { kind: 'session.send', params: { sessionId: 'peer_b1~s1', text: 'x' } };
    outbound(req);
    expect((req as any).params.sessionId).toBe('peer_b1~s1');
  });
  it('prefixes ids in replies', () => {
    const open = inbound('session.open', { sessionId: 's2', info: { sessionId: 's2', state: 'idle' }, history: [1], pending: [{ requestId: 'r1', sessionId: 's2', toolName: 'Bash' }] }, P);
    expect(open.sessionId).toBe('peer_b1~s2');
    expect(open.info.sessionId).toBe('peer_b1~s2');
    expect(open.pending[0]).toMatchObject({ requestId: 'peer_b1~r1', sessionId: 'peer_b1~s2' });
    expect(inbound('library.fork', { sessionId: 'f' }, P)).toEqual({ sessionId: 'peer_b1~f' });
    expect(inbound('library.delete', { removed: ['a'], failed: [{ id: 'b', error: 'x' }] }, P)).toEqual({ removed: ['peer_b1~a'], failed: [{ id: 'peer_b1~b', error: 'x' }] });
    expect(inbound('session.interrupt', null, P)).toBeNull();
  });
  it('imports a peer list: prefixed, tagged, parents rewritten, its own peers dropped (no multi-hop)', () => {
    const out = importList([sum('s1', { live: 'running' }), sum('c1', { parentId: 's1', mergedFrom: 'codex-x' }), sum('peer_zz~q', { peer: { id: 'zz', name: 'C' } })], P);
    expect(out.map((s) => s.sessionId)).toEqual(['peer_b1~s1', 'peer_b1~c1']);
    expect(out[0]).toMatchObject({ peer: { id: 'b1', name: 'Box B' }, live: 'running' });
    expect(out[1]).toMatchObject({ parentId: 'peer_b1~s1', mergedFrom: 'peer_b1~codex-x' });
    expect(importList('nope', P)).toEqual([]);
  });
  it('search hits are prefixed too', () => {
    const r = inbound('sessions.search', [{ session: sum('s1'), snippet: 'x' }, { session: sum('peer_q~z', { peer: { id: 'q', name: 'q' } }) }], P);
    expect(r).toHaveLength(1);
    expect(r[0].session.sessionId).toBe('peer_b1~s1');
  });
});

describe('rewriteEvent', () => {
  it('prefixes session and permission events', () => {
    expect(rewriteEvent({ kind: 'session.state', sessionId: 's1', state: 'running' }, P)?.event).toEqual({ kind: 'session.state', sessionId: 'peer_b1~s1', state: 'running' });
    expect((rewriteEvent({ kind: 'session.event', sessionId: 's1', message: { type: 'result' } }, P)?.event as any).sessionId).toBe('peer_b1~s1');
    expect((rewriteEvent({ kind: 'session.info', info: { sessionId: 's1', state: 'idle', cwd: '/r' } }, P)?.event as any).info.sessionId).toBe('peer_b1~s1');
    const pr = rewriteEvent({ kind: 'permission.request', request: { requestId: 'r1', sessionId: 's1', toolName: 'Read', input: {} } }, P)?.event as any;
    expect(pr.request).toMatchObject({ requestId: 'peer_b1~r1', sessionId: 'peer_b1~s1' });
    expect(rewriteEvent({ kind: 'permission.resolved', requestId: 'r1' }, P)?.event).toEqual({ kind: 'permission.resolved', requestId: 'peer_b1~r1' });
  });
  it('turns list changes into invalidations', () => {
    expect(rewriteEvent({ kind: 'sessions.changed' }, P)).toEqual({ invalidate: true, event: { kind: 'sessions.changed' } });
    expect(rewriteEvent({ kind: 'library.changed' }, P)?.invalidate).toBe(true);
  });
  it('drops machine-local events and anything already about a peer (no echo, no multi-hop)', () => {
    for (const e of [
      { kind: 'meta.changed' }, { kind: 'fs.changed', path: '/x', type: 'change' }, { kind: 'terminal.data', termId: 't', data: 'x' }, { kind: 'hello', version: '1' }, { kind: 'peers.changed' },
      { kind: 'session.state', sessionId: 'peer_a1~s', state: 'idle' },
      { kind: 'permission.resolved', requestId: 'peer_a1~r' },
    ] as ServerEvent[]) expect(rewriteEvent(e, P)).toBeNull();
  });
});
