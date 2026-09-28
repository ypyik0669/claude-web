import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { ClientRequest, RemoteHost, ServerEvent, SessionSummary, TunnelInfo } from '../protocol.js';
import type { PeerClientOptions } from './peer-client.js';
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
  /** what the service's resolve() gave this client on start (url + token actually used to connect) */
  endpoint: { url: string; token: string } | null = null;
  resolveError = '';
  constructor(private opts?: PeerClientOptions) { super(); }
  start() {
    // like the real client: resolve the endpoint first (ssh: open the tunnel), then connect
    void (this.opts?.resolve() ?? Promise.resolve({ url: '', token: '' })).then(
      (ep) => { this.endpoint = ep; if (this.goOnline) this.set('online'); },
      (e) => { this.resolveError = e.message; this.set('offline', e.message); },
    );
  }
  stop(s: PeerState = 'disabled') { this.set(s); }
  set(s: PeerState, error = '') { this.state = s; this.error = error; this.emit('state', s); }
  request<T>(req: ClientRequest, via: string[]): Promise<T> {
    this.calls.push({ req, via });
    if (this.state !== 'online') return Promise.reject(new Error('offline'));
    return Promise.resolve(this.handler(req)) as Promise<T>;
  }
}

function setup(o: { self?: string; peers?: PeerRecord[]; health?: Record<string, unknown> } = {}) {
  const peers: PeerRecord[] = [...(o.peers ?? [])];
  const hosts: RemoteHost[] = [{ id: 'h1', name: 'Lab', target: 'me@lab', remotePort: 3090, token: 'tok' }];
  const tunnelOpens: string[] = [];
  let tunnelPort = 4567;
  const tunnels = {
    open: async (h: RemoteHost): Promise<TunnelInfo> => { tunnelOpens.push(h.id); return { hostId: h.id, localPort: tunnelPort++, url: '', state: 'up', error: '', since: 0 }; },
    close: async () => {},
  };
  const revoked: string[] = [];
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
    bootId: 'boot-a',
    listTimeoutMs: 150,
    tunnels,
    revokeDevice: async (id) => { revoked.push(id); },
    makeClient: (opts) => { const f = new FakePeer(opts); if (o.self) f.remote.serverId = o.self; fakes.push(f); return f as unknown as PeerLike; },
    fetch: (async (url: string, init: any) => {
      if (url.endsWith('/api/health')) return new Response(JSON.stringify({ ok: true, version: '1', ...(o.health ?? {}) }), { status: 200 });
      pairs.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ token: 'devtok', device: { id: 'dev1', name: 'x' } }), { status: 200 });
    }) as any,
    handover: async (a) => { handovers.push(a); return { sessionId: 'new-local', info: {}, history: [], native: await a.readAll(a.sessionId), src: await a.imported(a.sessionId) } as any; },
  });
  fed.on('event', (e) => events.push(e));
  return { fed, peers, fakes, pairs, events, handovers, hosts, tunnelOpens, revoked };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

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
    await fed.start(); await settle();
    const info = await fed.add({ url: '10.0.0.2:3091', code: '123456' });
    expect(pairs[0].url).toBe('http://10.0.0.2:3091/api/pair');
    expect(pairs[0].body).toMatchObject({ code: '123456' });
    expect(peers[0].token).toBe('enc:plain:devtok');
    expect(info).toMatchObject({ state: 'online', name: 'Box B', via: 'direct' });
    expect(JSON.stringify(fed.list())).not.toContain('devtok');
    expect(fakes).toHaveLength(1);
    await expect(fed.add({ url: '10.0.0.2:3091', code: '12' })).rejects.toThrow('6 位');
  });

  it('refuses to add itself BEFORE redeeming the code (no orphan device token)', async () => {
    const { fed, peers, pairs } = setup({ health: { serverId: 'srvA', bootId: 'boot-a' } });
    await fed.start(); await settle();
    expect(fed.ids()).toEqual({ serverId: 'srvA', bootId: 'boot-a' });
    await expect(fed.add({ url: 'http://127.0.0.1:3091', code: '123456' })).rejects.toThrow('本机');
    expect(pairs).toHaveLength(0);
    expect(peers).toHaveLength(0);
  });

  it('same serverId from a different process = a copied ~/.claude-web: explicit message, nothing redeemed', async () => {
    const { fed, peers, pairs } = setup({ health: { serverId: 'srvA', bootId: 'someone-else' } });
    await fed.start(); await settle();
    await expect(fed.add({ url: 'http://10.0.0.9:3091', code: '123456' })).rejects.toThrow('serverId');
    expect(pairs).toHaveLength(0);
    expect(peers).toHaveLength(0);
  });

  it('a self-pairing only noticed at hello (no serverId in health) revokes the device it just created', async () => {
    const { fed, peers, revoked } = setup({ self: 'srvA' });
    await fed.start(); await settle();
    const origStart = FakePeer.prototype.start;
    FakePeer.prototype.start = function (this: FakePeer) { this.set('offline', '这个地址就是本机'); };
    try {
      await expect(fed.add({ url: 'http://127.0.0.1:3091', code: '123456' })).rejects.toThrow('本机');
      expect(peers).toHaveLength(0);
      expect(revoked).toEqual(['dev1']);
    } finally { FakePeer.prototype.start = origStart; }
  });

  it('merges peer lists into sessions.list: prefixed, tagged, sorted, its peers dropped', async () => {
    const { fed, fakes } = setup({ peers: [{ id: 'b1', name: 'Box B', url: 'http://b', via: 'direct', token: 'enc:plain:t', enabled: true, addedAt: 1 }] });
    await fed.start(); await settle();
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
    await fed.start(); await settle();
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
    await fed.start(); await settle();
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
    await fed.start(); await settle();
    await expect(fed.route({ kind: 'sessions.list' }, { via: ['srvB', 'srvA'], local: local([]) })).rejects.toThrow('环路');
    expect(fed.route({ kind: 'sessions.list' }, { via: ['srvB'], local: local([]) })).toBeUndefined();
    await expect(fed.route({ kind: 'session.interrupt', sessionId: 'peer_b1~s' }, { via: ['srvC'], local: local([]) })).rejects.toThrow('多跳');
  });

  it('sessions.search: ours first, then each online peer\'s hits (prefixed); a peer asking gets only ours', async () => {
    const { fed, fakes } = setup({ peers: [{ id: 'b1', name: 'B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start(); await settle();
    fakes[0].handler = (r) => (r.kind === 'sessions.search' ? [{ session: sum('s1', 1), snippet: 'hit' }] : null);
    const mine = [{ session: sum('m', 2), snippet: 'x' }];
    const r = (await fed.route({ kind: 'sessions.search', query: 'q' }, { local: async () => mine })) as any[];
    expect(r.map((h) => h.session.sessionId)).toEqual(['m', 'peer_b1~s1']);
    expect(fakes[0].calls[0].req).toEqual({ kind: 'sessions.search', query: 'q', limit: 30 });
    expect(fed.route({ kind: 'sessions.search', query: 'q' }, { via: ['srvB'], local: async () => mine })).toBeUndefined();
  });

  it('re-emits peer events prefixed; unrelated ones dropped', async () => {
    const { fed, fakes, events } = setup({ peers: [{ id: 'b1', name: 'B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start(); await settle();
    events.length = 0;
    fakes[0].emit('event', { kind: 'permission.request', request: { requestId: 'r1', sessionId: 's1', toolName: 'Read', input: {} } });
    fakes[0].emit('event', { kind: 'fs.changed', path: '/x', type: 'change' });
    fakes[0].emit('event', { kind: 'session.state', sessionId: 'peer_q~s', state: 'idle' });
    expect(events).toEqual([{ kind: 'permission.request', request: { requestId: 'peer_b1~r1', sessionId: 'peer_b1~s1', toolName: 'Read', input: {} } }]);
  });

  it('splits batch deletes across machines and merges the results', async () => {
    const { fed, fakes } = setup({ peers: [{ id: 'b1', name: 'B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start(); await settle();
    fakes[0].handler = (r: any) => ({ removed: r.sessionIds, failed: [] });
    const localCalls: any[] = [];
    const r: any = await fed.route({ kind: 'library.delete', sessionIds: ['mine', 'peer_b1~s1'] }, { local: async (req) => { localCalls.push(req); return { removed: ['mine'], failed: [] }; } });
    expect(localCalls[0]).toEqual({ kind: 'library.delete', sessionIds: ['mine'] });
    expect(fakes[0].calls[0].req).toEqual({ kind: 'library.delete', sessionIds: ['s1'] });
    expect(r.removed.sort()).toEqual(['mine', 'peer_b1~s1']);
  });

  it('hands a remote session over to a local agent: reads every page, cwd from the caller', async () => {
    const { fed, fakes, handovers } = setup({ peers: [{ id: 'b1', name: 'Box B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start(); await settle();
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

  it('hand-over looks the source agent up on the peer when the list cache has not got it (never guesses claude)', async () => {
    const { fed, fakes } = setup({ peers: [{ id: 'b1', name: 'Box B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start(); await settle();
    fakes[0].handler = (r: any) => (r.kind === 'sessions.list' ? [sum('s1', 1, { agent: 'codex', title: 'T' })] : r.kind === 'library.read' ? { messages: [{ n: 1 }] } : null);
    const r: any = await fed.route({ kind: 'peers.handover', sessionId: 'peer_b1~s1', agent: 'claude', cwd: '/w' }, { local: local([]) });
    expect(r.src.agent).toBe('codex');
    expect(fakes[0].calls.some((c) => c.req.kind === 'sessions.list')).toBe(true);
    await expect(fed.route({ kind: 'peers.handover', sessionId: 'peer_b1~gone', agent: 'claude', cwd: '/w' }, { local: local([]) })).rejects.toThrow('找不到');
  });

  it('ssh peers: the endpoint is the tunnel\'s local port + the host token; a host edit or 重试 reconnects', async () => {
    const { fed, fakes, peers, hosts, tunnelOpens } = setup();
    await fed.start(); await settle();
    const info = await fed.add({ hostId: 'h1' });
    expect(info).toMatchObject({ via: 'ssh', url: 'ssh://me@lab', name: 'Lab', state: 'online' });
    expect(peers[0].token).toBe('');
    expect(tunnelOpens).toEqual(['h1']);
    expect(fakes[0].endpoint).toEqual({ url: 'http://127.0.0.1:4567', token: 'tok' });
    await expect(fed.add({ hostId: 'h1' })).rejects.toThrow('已经加入');
    // token rejected → unauthorized; the user fixes the host's token → the peer reconnects with it
    fakes[0].set('unauthorized', '令牌失效，请重新配对');
    hosts[0] = { ...hosts[0], token: 'tok2' };
    await fed.hostChanged('h1'); await settle();
    const now = fakes[fakes.length - 1];
    expect(now).not.toBe(fakes[0]);
    expect(now.endpoint).toEqual({ url: 'http://127.0.0.1:4568', token: 'tok2' });
    expect(fed.list()[0].state).toBe('online');
    // an explicit retry does the same
    now.set('unauthorized', 'x');
    await fed.retry(info.id); await settle();
    expect(fed.list()[0].state).toBe('online');
    // a host that is gone: offline with a reason, not a crash
    hosts.splice(0, 1);
    await fed.retry(info.id); await settle();
    expect(fed.list()[0]).toMatchObject({ state: 'offline', error: '对应的 SSH 主机已被删除' });
    await fed.update(info.id, { enabled: false });
    expect(fed.list()[0].state).toBe('disabled');
    await fed.remove(info.id);
    expect(fed.list()).toEqual([]);
  });

  it('peers.* are for local clients only; a peer connection counts as a peer even without via', async () => {
    const { fed } = setup({ peers: [{ id: 'b1', name: 'B', url: 'http://b', via: 'direct', token: 'x', enabled: true, addedAt: 1 }] });
    await fed.start(); await settle();
    await expect(fed.route({ kind: 'peers.list' }, { via: ['srvB'], local: local([]) })!).rejects.toThrow();
    await expect(fed.route({ kind: 'peers.remove', id: 'b1' }, { peerConn: true, local: local([]) })!).rejects.toThrow();
    expect(fed.list()).toHaveLength(1);
    // a peer connection gets only our own list, and can't reach our peers
    expect(fed.route({ kind: 'sessions.list' }, { peerConn: true, local: local([]) })).toBeUndefined();
    await expect(fed.route({ kind: 'session.interrupt', sessionId: 'peer_b1~s' }, { peerConn: true, local: local([]) })!).rejects.toThrow('多跳');
    expect(await fed.route({ kind: 'peers.list' }, { local: local([]) })).toHaveLength(1);
  });
});
