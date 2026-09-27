import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ClientRequest, RemoteHost, ServerEvent, SessionSummary } from '../protocol.js';
import { FederationService, normalizePeerUrl, type FederationStore, type PeerLike } from './service.js';
import type { PeerRecord, PeerState } from './types.js';

class FakePeer extends EventEmitter {
  state: PeerState = 'connecting';
  error = '';
  latencyMs: number | undefined;
  lastSeenAt: number | undefined;
  remote: { serverId?: string; name?: string; version?: string } = { serverId: 'srvB', name: 'Box B', version: '1' };
  calls: { req: ClientRequest; via: string[] }[] = [];
  handler: (req: ClientRequest) => unknown = () => null;
  goOnline = true;
  start() { if (this.goOnline) this.set('online'); }
  stop(s: PeerState = 'disabled') { this.set(s); }
  set(s: PeerState, error = '') { this.state = s; this.error = error; this.emit('state', s); }
  request<T>(req: ClientRequest, via: string[]): Promise<T> {
    this.calls.push({ req, via });
    if (this.state !== 'online') return Promise.reject(new Error('offline'));
    return Promise.resolve(this.handler(req)) as Promise<T>;
  }
}

function setup(o: { self?: string; peers?: PeerRecord[] } = {}) {
  const peers: PeerRecord[] = [...(o.peers ?? [])];
  const hosts: RemoteHost[] = [{ id: 'h1', name: 'Lab', target: 'me@lab', remotePort: 3090, token: 'tok' }];
  const store: FederationStore = {
    peers: () => peers,
    setPeer: async (p) => { const i = peers.findIndex((x) => x.id === p.id); if (i >= 0) peers[i] = p; else peers.push(p); },
    removePeer: async (id) => { const i = peers.findIndex((x) => x.id === id); if (i >= 0) peers.splice(i, 1); },
    serverId: async () => 'srvA',
    remoteHosts: () => hosts,
  };
  const fakes: FakePeer[] = [];
  const pairs: any[] = [];
  const events: ServerEvent[] = [];
  const handovers: any[] = [];
  const fed = new FederationService({
    store,
    secrets: { protect: async (p) => `enc:plain:${p}`, reveal: async (v) => (v ?? '').replace(/^enc:plain:/, '') },
    version: '1',
    name: 'box-a',
    listTimeoutMs: 150,
    makeClient: () => { const f = new FakePeer(); if (o.self) f.remote.serverId = o.self; fakes.push(f); return f as unknown as PeerLike; },
    fetch: (async (url: string, init: any) => { pairs.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ token: 'devtok' }), { status: 200 }); }) as any,
    handover: async (a) => { handovers.push(a); return { sessionId: 'new-local', info: {}, history: [], native: await a.readAll(a.sessionId), src: await a.imported(a.sessionId) } as any; },
  });
  fed.on('event', (e) => events.push(e));
  return { fed, peers, fakes, pairs, events, handovers };
}

const sum = (id: string, t: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: id, cwd: '/r', lastModified: t, ...extra });
const local = (list: SessionSummary[]) => async () => list;

describe('FederationService', () => {
  it('normalizes addresses', () => {
    expect(normalizePeerUrl('192.168.1.20:3091/')).toBe('http://192.168.1.20:3091');
    expect(normalizePeerUrl(' https://box.local:3091 ')).toBe('https://box.local:3091');
    expect(() => normalizePeerUrl('')).toThrow();
    expect(() => normalizePeerUrl('ftp://x')).toThrow();
  });

  it('pairs by address + code, stores the token protected, never lists it', async () => {
    const { fed, peers, pairs, fakes } = setup();
    await fed.start();
    const info = await fed.add({ url: '10.0.0.2:3091', code: '123456' });
    expect(pairs[0].url).toBe('http://10.0.0.2:3091/api/pair');
    expect(pairs[0].body).toMatchObject({ code: '123456' });
    expect(peers[0].token).toBe('enc:plain:devtok');
    expect(info).toMatchObject({ state: 'online', name: 'Box B', via: 'direct' });
    expect(JSON.stringify(fed.list())).not.toContain('devtok');
    expect(fakes).toHaveLength(1);
    await expect(fed.add({ url: '10.0.0.2:3091', code: '12' })).rejects.toThrow('6 位');
  });

  it('refuses to add itself', async () => {
    const { fed, peers } = setup({ self: 'srvA' });
    await fed.start();
    const origStart = FakePeer.prototype.start;
    FakePeer.prototype.start = function (this: FakePeer) { this.set('offline', '这个地址就是本机'); };
    try {
      await expect(fed.add({ url: 'http://127.0.0.1:3091', code: '123456' })).rejects.toThrow('本机');
      expect(peers).toHaveLength(0);
    } finally { FakePeer.prototype.start = origStart; }
  });

  it('merges peer lists into sessions.list: prefixed, tagged, sorted, its peers dropped', async () => {
    const { fed, fakes } = setup({ peers: [{ id: 'b1', name: 'Box B', url: 'http://b', via: 'direct', token: 'enc:plain:t', enabled: true, addedAt: 1 }] });
    await fed.start();
    fakes[0].handler = (r) => (r.kind === 'sessions.list' ? [sum('s1', 5, { live: 'running' }), sum('peer_c~x', 9, { peer: { id: 'c', name: 'C' } })] : null);
    const out = (await fed.route({ kind: 'sessions.list' }, { local: local([sum('mine', 7), sum('old', 1)]) })) as SessionSummary[];
    expect(out.map((s) => s.sessionId)).toEqual(['mine', 'peer_b1~s1', 'old']);
    expect(out[1].peer).toEqual({ id: 'b1', name: 'Box B' });
    expect(fakes[0].calls[0].via).toEqual(['srvA']);
    // cached for 30s: no second fetch
    await fed.route({ kind: 'sessions.list' }, { local: local([]) });
    expect(fakes[0].calls.filter((c) => c.req.kind === 'sessions.list')).toHaveLength(1);
    // a peer sessions.changed invalidates the cache
    fakes[0].emit('event', { kind: 'sessions.changed' });
    await fed.route({ kind: 'sessions.list' }, { local: local([]) });
    expect(fakes[0].calls.filter((c) => c.req.kind === 'sessions.list')).toHaveLength(2);
    const limited = (await fed.route({ kind: 'sessions.list', limit: 1 }, { local: local([sum('mine', 7)]) })) as SessionSummary[];
    expect(limited).toHaveLength(1);
  });

  it('offline peer: last cache greyed out, local list unaffected; slow peer does not block', async () => {
    const { fed, fakes } = setup({ peers: [{ id: 'b1', name: 'Box B', url: 'http://b', via: 'direct', token: 'enc:plain:t', enabled: true, addedAt: 1 }] });
    await fed.start();
    fakes[0].handler = () => [sum('s1', 5, { live: 'idle' })];
    await fed.route({ kind: 'sessions.list' }, { local: local([]) });
    fakes[0].set('offline', '连不上');
    const out = (await fed.route({ kind: 'sessions.list' }, { local: local([sum('mine', 7)]) })) as SessionSummary[];
    expect(out.map((s) => s.sessionId)).toEqual(['mine', 'peer_b1~s1']);
    expect(out[1].peer?.offline).toBe(true);
    expect(out[1].live).toBeUndefined();
    // online again but hanging: bounded by listTimeout, serves the cache
    fakes[0].set('online');
    fakes[0].handler = () => new Promise(() => {});
    const t0 = Date.now();
    const out2 = (await fed.route({ kind: 'sessions.list' }, { local: local([sum('mine', 7)]) })) as SessionSummary[];
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out2.map((s) => s.sessionId)).toEqual(['mine', 'peer_b1~s1']);
    expect(out2[1].peer?.offline).toBeUndefined();
  });

  it('forwards session requests with ids stripped and replies prefixed', async () => {
    const { fed, fakes } = setup({ peers: [{ id: 'b1', name: 'Box B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start();
    fakes[0].handler = (r) => (r.kind === 'session.open' ? { sessionId: 's1', info: { sessionId: 's1', state: 'idle' }, history: [], pending: [{ requestId: 'r1', sessionId: 's1' }] } : null);
    const o: any = await fed.route({ kind: 'session.open', params: { sessionId: 'peer_b1~s1', cwd: '/r' } }, { local: local([]) });
    expect(fakes[0].calls[0].req).toEqual({ kind: 'session.open', params: { sessionId: 's1', cwd: '/r' } });
    expect(o.sessionId).toBe('peer_b1~s1');
    expect(o.pending[0].requestId).toBe('peer_b1~r1');
    await fed.route({ kind: 'permission.respond', requestId: 'peer_b1~r1', response: { behavior: 'allow' } }, { local: local([]) });
    expect(fakes[0].calls[1].req).toMatchObject({ requestId: 'r1' });
    // not federation's: local requests pass through untouched
    expect(fed.route({ kind: 'session.send', params: { sessionId: 'abc', text: 'x' } }, { local: local([]) })).toBeUndefined();
    expect(fed.route({ kind: 'session.setMeta', sessionId: 'peer_b1~s1', patch: { pinned: true } }, { local: local([]) })).toBeUndefined();
    await expect(fed.route({ kind: 'session.setProvider', sessionId: 'peer_b1~s1' }, { local: local([]) })).rejects.toThrow();
    await expect(fed.route({ kind: 'session.interrupt', sessionId: 'peer_zz~s1' }, { local: local([]) })).rejects.toThrow('没有这台机器');
    fakes[0].set('offline');
    await expect(fed.route({ kind: 'session.interrupt', sessionId: 'peer_b1~s1' }, { local: local([]) })).rejects.toThrow('离线');
  });

  it('loop guard: own id in via rejects; a peer gets only our own list; no multi-hop', async () => {
    const { fed } = setup({ peers: [{ id: 'b1', name: 'B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start();
    await expect(fed.route({ kind: 'sessions.list' }, { via: ['srvB', 'srvA'], local: local([]) })).rejects.toThrow('环路');
    expect(fed.route({ kind: 'sessions.list' }, { via: ['srvB'], local: local([]) })).toBeUndefined();
    await expect(fed.route({ kind: 'session.interrupt', sessionId: 'peer_b1~s' }, { via: ['srvC'], local: local([]) })).rejects.toThrow('多跳');
  });

  it('re-emits peer events prefixed; unrelated ones dropped', async () => {
    const { fed, fakes, events } = setup({ peers: [{ id: 'b1', name: 'B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start();
    events.length = 0;
    fakes[0].emit('event', { kind: 'permission.request', request: { requestId: 'r1', sessionId: 's1', toolName: 'Read', input: {} } });
    fakes[0].emit('event', { kind: 'fs.changed', path: '/x', type: 'change' });
    fakes[0].emit('event', { kind: 'session.state', sessionId: 'peer_q~s', state: 'idle' });
    expect(events).toEqual([{ kind: 'permission.request', request: { requestId: 'peer_b1~r1', sessionId: 'peer_b1~s1', toolName: 'Read', input: {} } }]);
  });

  it('splits batch deletes across machines and merges the results', async () => {
    const { fed, fakes } = setup({ peers: [{ id: 'b1', name: 'B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start();
    fakes[0].handler = (r: any) => ({ removed: r.sessionIds, failed: [] });
    const localCalls: any[] = [];
    const r: any = await fed.route({ kind: 'library.delete', sessionIds: ['mine', 'peer_b1~s1'] }, { local: async (req) => { localCalls.push(req); return { removed: ['mine'], failed: [] }; } });
    expect(localCalls[0]).toEqual({ kind: 'library.delete', sessionIds: ['mine'] });
    expect(fakes[0].calls[0].req).toEqual({ kind: 'library.delete', sessionIds: ['s1'] });
    expect(r.removed.sort()).toEqual(['mine', 'peer_b1~s1']);
  });

  it('hands a remote session over to a local agent: reads every page, cwd from the caller', async () => {
    const { fed, fakes, handovers } = setup({ peers: [{ id: 'b1', name: 'Box B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start();
    fakes[0].handler = (r: any) => {
      if (r.kind === 'sessions.list') return [sum('s1', 1, { agent: 'acp:mock', title: 'Fix it' })];
      if (r.kind === 'library.read') return r.cursor ? { messages: [{ n: 1 }] } : { messages: [{ n: 2 }], next: 'c1' };
      return null;
    };
    await fed.route({ kind: 'sessions.list' }, { local: local([]) });
    const r: any = await fed.route({ kind: 'peers.handover', sessionId: 'peer_b1~s1', agent: 'claude', cwd: 'C:/work' }, { local: local([]) });
    expect(r.sessionId).toBe('new-local');
    expect(r.native).toEqual([{ n: 1 }, { n: 2 }]);
    expect(r.src).toEqual({ agent: 'acp:mock', cwd: 'C:/work', title: 'Fix it（来自 Box B）' });
    expect(handovers[0]).toMatchObject({ sessionId: 'peer_b1~s1', agent: 'claude' });
    await expect(fed.route({ kind: 'peers.handover', sessionId: 'peer_b1~s1', agent: 'claude', cwd: ' ' }, { local: local([]) })).rejects.toThrow('工作目录');
  });

  it('ssh peers resolve through the tunnel with the host token; disable / remove stop the client', async () => {
    const { fed, fakes, peers } = setup();
    await fed.start();
    const info = await fed.add({ hostId: 'h1' });
    expect(info).toMatchObject({ via: 'ssh', url: 'ssh://me@lab', name: 'Lab' });
    expect(peers[0].token).toBe('');
    await expect(fed.add({ hostId: 'h1' })).rejects.toThrow('已经加入');
    await fed.update(info.id, { enabled: false });
    expect(fed.list()[0].state).toBe('disabled');
    await fed.remove(info.id);
    expect(fed.list()).toEqual([]);
    expect(fakes.length).toBeGreaterThan(0);
  });
});
