import { EventEmitter } from 'node:events';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { AgentKind, ClientRequest, RemoteHost, ServerEvent, SessionSummary, TunnelInfo } from '../protocol.js';
import { PeerClient, type PeerClientOptions, type PeerEndpoint } from './peer-client.js';
import { inbound, outbound, planRoute, importList, rewriteEvent, type PeerRef } from './rewrite.js';
import { parsePeerId, type PeerInfo, type PeerRecord, type PeerRequest, type PeerState } from './types.js';

/** What the service needs from MetaStore (peers + serverId + ssh hosts). */
export interface FederationStore {
  peers(): PeerRecord[];
  setPeer(p: PeerRecord): Promise<void>;
  removePeer(id: string): Promise<void>;
  serverId(): Promise<string>;
  remoteHosts(): RemoteHost[];
}

export type PeerLike = Pick<PeerClient, 'state' | 'error' | 'latencyMs' | 'lastSeenAt' | 'remote' | 'start' | 'stop' | 'request' | 'on'>;

/** handOverImported's path (swap.ts `swapAgent` with an `imported` source): new local session + briefing. */
export type HandoverFn = (a: {
  sessionId: string;
  agent: AgentKind;
  model?: string;
  readAll: (id: string) => Promise<any[]>;
  imported: (id: string) => Promise<{ agent: AgentKind; cwd: string; title?: string } | null>;
}) => Promise<{ sessionId: string; info: unknown; history: unknown[]; briefing?: string }>;

export interface FederationDeps {
  store: FederationStore;
  secrets: { protect(plain: string, id: string): Promise<string>; reveal(v: string | undefined): Promise<string> };
  tunnels?: { open(host: RemoteHost): Promise<TunnelInfo>; close(hostId: string): Promise<void> };
  handover?: HandoverFn;
  version: string;
  /** shown to the other machine as the device name when pairing, and in our hello */
  name?: string;
  makeClient?: (o: PeerClientOptions) => PeerLike;
  fetch?: typeof fetch;
  listTimeoutMs?: number;
  listTtlMs?: number;
}

export interface RouteCtx {
  /** serverIds this request already passed through (it came from a peer when non-empty) */
  via?: string[];
  /** run a request through this machine's own hub (the original, or a rewritten one for split batches) */
  local: (req?: ClientRequest) => Promise<unknown>;
}

const LIST_TIMEOUT = 5_000;
const LIST_TTL = 30_000;
const OPEN_TIMEOUT = 120_000;

/** `http://1.2.3.4:3091/` → `http://1.2.3.4:3091`; a bare `host:port` gets http://. */
export function normalizePeerUrl(raw: string): string {
  let s = (raw ?? '').trim();
  if (!s) throw new Error('需要地址，例如 http://192.168.1.20:3091');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) throw new Error(`只支持 http / https：${raw}`);
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try { u = new URL(s); } catch { throw new Error(`地址不对：${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`只支持 http / https：${raw}`);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * Cross-machine sessions. Every enabled peer is a PeerClient (outbound only: this machine exposes
 * nothing new). The hub asks `route()` about every request first: requests about `peer_…` sessions
 * are forwarded (ids stripped, reply ids prefixed), `sessions.list` / `sessions.search` are merged
 * with every online peer's (5s bound each, 30s cache, last cache greyed out when a peer is offline).
 * Peer broadcasts come back out as 'event' (already prefixed), for local, non-peer clients only.
 */
export class FederationService extends EventEmitter {
  serverId = '';
  readonly name: string;
  private clients = new Map<string, PeerLike>();
  private lists = new Map<string, { at: number; items: SessionSummary[]; stale?: boolean }>();
  private listing = new Map<string, Promise<SessionSummary[]>>();
  private readonly listTimeout: number;
  private readonly listTtl: number;
  private readonly fetchFn: typeof fetch;

  constructor(private d: FederationDeps) {
    super();
    this.name = d.name ?? os.hostname();
    this.listTimeout = d.listTimeoutMs ?? LIST_TIMEOUT;
    this.listTtl = d.listTtlMs ?? LIST_TTL;
    this.fetchFn = d.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async start() {
    this.serverId = await this.d.store.serverId();
    for (const p of this.d.store.peers()) this.spawn(p);
  }

  async close() {
    for (const [id, c] of this.clients) { c.stop(); const rec = this.rec(id); if (rec?.via === 'ssh' && rec.hostId) await this.d.tunnels?.close(rec.hostId).catch(() => {}); }
    this.clients.clear();
  }

  private rec(id: string) { return this.d.store.peers().find((p) => p.id === id); }
  private ref(id: string): PeerRef { return { id, name: this.rec(id)?.name ?? id }; }

  // ---------- peers ----------
  list(): PeerInfo[] {
    return this.d.store.peers().map((p) => {
      const c = this.clients.get(p.id);
      const host = p.via === 'ssh' ? this.d.store.remoteHosts().find((h) => h.id === p.hostId) : undefined;
      const state: PeerState = !p.enabled ? 'disabled' : c?.state ?? 'connecting';
      return {
        id: p.id, name: p.name, url: p.via === 'ssh' ? `ssh://${host?.target ?? '?'}` : p.url, via: p.via, hostId: p.hostId, enabled: p.enabled, addedAt: p.addedAt,
        state, error: p.enabled ? c?.error || undefined : undefined, latencyMs: c?.latencyMs, lastSeenAt: c?.lastSeenAt,
        sessions: this.lists.get(p.id)?.items.length, serverId: c?.remote.serverId ?? p.serverId, version: c?.remote.version,
      };
    });
  }

  private endpoint(p: PeerRecord): () => Promise<PeerEndpoint> {
    return async () => {
      const cur = this.rec(p.id) ?? p;
      if (cur.via === 'ssh') {
        const host = this.d.store.remoteHosts().find((h) => h.id === cur.hostId);
        if (!host) throw new Error('对应的 SSH 主机已被删除');
        if (!this.d.tunnels) throw new Error('SSH 隧道不可用');
        const t = await this.d.tunnels.open(host);
        if (t.state !== 'up') throw new Error(t.error || 'SSH 隧道没有连上');
        return { url: `http://127.0.0.1:${t.localPort}`, token: host.token ?? '' };
      }
      return { url: cur.url, token: await this.d.secrets.reveal(cur.token) };
    };
  }

  private spawn(p: PeerRecord) {
    this.clients.get(p.id)?.stop();
    const opts: PeerClientOptions = { selfId: this.serverId, resolve: this.endpoint(p), fetch: this.fetchFn };
    const c = this.d.makeClient ? this.d.makeClient(opts) : new PeerClient(opts);
    this.clients.set(p.id, c);
    c.on('event', (e: ServerEvent) => this.onPeerEvent(p.id, e));
    c.on('state', (st: PeerState) => {
      if (this.clients.get(p.id) !== c) return;
      // came (back) online: its list may have changed meanwhile; went away: rows grey out
      if (st === 'online') { const l = this.lists.get(p.id); if (l) l.stale = true; }
      this.emit('event', { kind: 'peers.changed' } satisfies ServerEvent);
      this.emit('event', { kind: 'sessions.changed' } satisfies ServerEvent);
    });
    c.on('hello', (h: { serverId?: string; name?: string }) => {
      const cur = this.rec(p.id);
      if (cur && h.serverId && cur.serverId !== h.serverId) void this.d.store.setPeer({ ...cur, serverId: h.serverId }).catch(() => {});
    });
    if (p.enabled) c.start();
    else c.stop('disabled');
  }

  private onPeerEvent(peerId: string, e: ServerEvent) {
    const r = rewriteEventSafe(e, this.ref(peerId));
    if (!r) return;
    if (r.invalidate) { const l = this.lists.get(peerId); if (l) l.stale = true; }
    if (r.event) this.emit('event', r.event);
  }

  /** Pair with a machine by address + 6-digit code (we redeem the code for a device token), or adopt an SSH host. */
  async add(o: { url?: string; code?: string; name?: string; hostId?: string }): Promise<PeerInfo> {
    let rec: PeerRecord;
    const id = randomBytes(5).toString('hex').replace(/[^a-z0-9]/g, '').slice(0, 10) || Date.now().toString(36);
    if (o.hostId) {
      const host = this.d.store.remoteHosts().find((h) => h.id === o.hostId);
      if (!host) throw new Error('SSH 主机不存在');
      const dup = this.d.store.peers().find((p) => p.via === 'ssh' && p.hostId === o.hostId);
      if (dup) throw new Error(`已经加入过（「${dup.name}」）`);
      rec = { id, name: (o.name ?? '').trim() || host.name || host.target, url: '', via: 'ssh', hostId: host.id, token: '', enabled: true, addedAt: Date.now() };
    } else {
      const url = normalizePeerUrl(o.url ?? '');
      const token = await this.pair(url, o.code ?? '');
      const dup = this.d.store.peers().find((p) => p.via === 'direct' && p.url === url);
      rec = dup
        ? { ...dup, token: await this.d.secrets.protect(token, `peer-${dup.id}`), enabled: true }
        : { id, name: (o.name ?? '').trim() || new URL(url).host, url, via: 'direct', token: await this.d.secrets.protect(token, `peer-${id}`), enabled: true, addedAt: Date.now() };
    }
    await this.d.store.setPeer(rec);
    this.spawn(rec);
    // give it a moment so the answer can say online / why not; a self-pairing is undone right away
    const c = this.clients.get(rec.id)!;
    await waitFor(() => c.state !== 'connecting', 8_000);
    if (c.state === 'offline' && c.error.includes('本机')) { await this.remove(rec.id); throw new Error('这个地址就是本机，不能把自己加为其它机器'); }
    if (!o.name && c.remote.name && rec.via === 'direct') { rec = { ...(this.rec(rec.id) ?? rec), name: c.remote.name }; await this.d.store.setPeer(rec); }
    this.emit('event', { kind: 'peers.changed' } satisfies ServerEvent);
    return this.list().find((x) => x.id === rec.id)!;
  }

  /** Redeem a pairing code on the other machine's /api/pair (the same endpoint a phone uses). */
  private async pair(url: string, code: string): Promise<string> {
    if (!/^\d{6}$/.test(code.trim())) throw new Error('配对码是 6 位数字（在那台机器的 设置 → 远程 / 手机 里生成）');
    let r: Response;
    try {
      r = await this.fetchFn(`${url}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.trim(), name: `${this.name}（Claude Web）` }), signal: AbortSignal.timeout(10_000) });
    } catch (e: any) {
      throw new Error(`连不上 ${url}：${e?.cause?.code ?? e?.message ?? e}（对方要打开「允许其它设备访问」）`);
    }
    let j: any = {};
    try { j = await r.json(); } catch { /* ignore */ }
    if (!r.ok || !j?.token) throw new Error(j?.error || `配对失败（HTTP ${r.status}）`);
    return String(j.token);
  }

  /** New pairing code for an existing (e.g. revoked) peer: same id, so its sessions keep their ids. */
  async repair(id: string, code: string): Promise<PeerInfo> {
    const cur = this.rec(id);
    if (!cur) throw new Error('没有这台机器');
    if (cur.via !== 'direct') throw new Error('SSH 方式的机器用主机配置里的令牌，改主机配置即可');
    const token = await this.pair(cur.url, code);
    const rec = { ...cur, token: await this.d.secrets.protect(token, `peer-${id}`), enabled: true };
    await this.d.store.setPeer(rec);
    this.spawn(rec);
    await waitFor(() => this.clients.get(id)?.state !== 'connecting', 8_000);
    this.emit('event', { kind: 'peers.changed' } satisfies ServerEvent);
    return this.list().find((x) => x.id === id)!;
  }

  async update(id: string, patch: { name?: string; enabled?: boolean }): Promise<PeerInfo[]> {
    const cur = this.rec(id);
    if (!cur) throw new Error('没有这台机器');
    const rec = { ...cur, ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 60) } : {}), ...(patch.enabled !== undefined ? { enabled: !!patch.enabled } : {}) };
    await this.d.store.setPeer(rec);
    if (patch.enabled !== undefined && patch.enabled !== cur.enabled) this.spawn(rec);
    this.emit('event', { kind: 'peers.changed' } satisfies ServerEvent);
    this.emit('event', { kind: 'sessions.changed' } satisfies ServerEvent);
    return this.list();
  }

  async remove(id: string): Promise<PeerInfo[]> {
    const cur = this.rec(id);
    this.clients.get(id)?.stop();
    this.clients.delete(id);
    this.lists.delete(id);
    if (cur?.via === 'ssh' && cur.hostId) await this.d.tunnels?.close(cur.hostId).catch(() => {});
    await this.d.store.removePeer(id);
    this.emit('event', { kind: 'peers.changed' } satisfies ServerEvent);
    this.emit('event', { kind: 'sessions.changed' } satisfies ServerEvent);
    return this.list();
  }

  // ---------- routing ----------
  private forward<T = unknown>(peerId: string, req: ClientRequest, via: string[]): Promise<T> {
    const rec = this.rec(peerId);
    const c = this.clients.get(peerId);
    if (!rec || !c) return Promise.reject(new Error('没有这台机器（已移除？）'));
    if (!rec.enabled) return Promise.reject(new Error(`机器「${rec.name}」已停用`));
    if (c.state !== 'online') return Promise.reject(new Error(c.state === 'unauthorized' ? `机器「${rec.name}」令牌失效，请重新配对` : `机器「${rec.name}」离线`));
    return c.request<T>(req, [...via, this.serverId], req.kind === 'session.open' ? OPEN_TIMEOUT : undefined);
  }

  /** undefined: not federation's business, the hub handles it as usual. */
  route(req: ClientRequest, ctx: RouteCtx): Promise<unknown> | undefined {
    const via = Array.isArray(ctx.via) ? ctx.via.filter((x): x is string => typeof x === 'string') : [];
    if (this.serverId && via.includes(this.serverId)) return Promise.reject(new Error('检测到跨机器转发环路，已拒绝'));
    const fromPeer = via.length > 0;
    switch (req.kind) {
      case 'peers.list': return Promise.resolve(this.list());
      case 'peers.add': return this.add(req);
      case 'peers.update': return this.update(req.id, req.patch);
      case 'peers.repair': return this.repair(req.id, req.code);
      case 'peers.remove': return this.remove(req.id);
      case 'peers.handover': return this.handover(req);
      // a peer asking for our list gets only ours (no multi-hop)
      case 'sessions.list': return fromPeer ? undefined : this.mergedList(ctx, req.limit);
      case 'sessions.search': return fromPeer ? undefined : this.mergedSearch(ctx, req.query, req.limit ?? 30);
    }
    const plan = planRoute(req);
    if (plan.kind === 'none' || plan.kind === 'local') return undefined;
    if (fromPeer) return Promise.reject(new Error('不支持多跳转发'));
    if (plan.kind === 'reject') return Promise.reject(new Error(plan.reason));
    if (plan.kind === 'forward') return this.forward(plan.peerId, outbound(req), via).then((d) => inbound(req.kind, d, this.ref(plan.peerId)));
    return this.split(req as Extract<ClientRequest, { kind: 'library.archive' | 'library.delete' }>, ctx);
  }

  /** archive / delete across machines: local ids here, each peer's to that peer; results merged. */
  private async split(req: Extract<ClientRequest, { kind: 'library.archive' | 'library.delete' }>, ctx: RouteCtx) {
    const groups = new Map<string, string[]>(); // '' = local
    for (const id of req.sessionIds) {
      const k = parsePeerId(id)?.peerId ?? '';
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(id);
    }
    const doneKey = req.kind === 'library.archive' ? 'done' : 'removed';
    const out: { done?: string[]; removed?: string[]; failed: { id: string; error: string }[] } = { [doneKey]: [], failed: [] };
    await Promise.all([...groups].map(async ([peerId, ids]) => {
      const sub = { ...req, sessionIds: ids } as ClientRequest;
      try {
        const r: any = peerId ? await this.forward(peerId, outbound(sub), ctx.via ?? []).then((d) => inbound(req.kind, d, this.ref(peerId))) : await ctx.local(sub);
        (out as any)[doneKey].push(...(r?.[doneKey] ?? []));
        out.failed.push(...(r?.failed ?? []));
      } catch (e: any) {
        for (const id of ids) out.failed.push({ id, error: e?.message ?? String(e) });
      }
    }));
    if (groups.size > 1 || !groups.has('')) this.emit('event', { kind: 'library.changed' } satisfies ServerEvent);
    return out;
  }

  /** One peer's list: fresh within the TTL, else refetched (bounded); offline → last cache, greyed. */
  private async peerList(p: PeerRecord): Promise<SessionSummary[]> {
    const c = this.clients.get(p.id);
    const hit = this.lists.get(p.id);
    const ref: PeerRef = { id: p.id, name: p.name };
    const offline = (items: SessionSummary[]) => items.map(({ live: _l, ...s }) => ({ ...s, peer: { id: p.id, name: p.name, offline: true } }));
    if (!c || c.state !== 'online') return offline(hit?.items ?? []);
    if (hit && !hit.stale && Date.now() - hit.at < this.listTtl) return hit.items.map((s) => ({ ...s, peer: { id: p.id, name: p.name } }));
    let late = false;
    let inflight = this.listing.get(p.id);
    if (!inflight) {
      inflight = this.forward<unknown>(p.id, { kind: 'sessions.list' }, []).then((raw) => {
        const items = importList(raw, ref);
        const before = this.lists.get(p.id);
        this.lists.set(p.id, { at: Date.now(), items });
        if (before?.items.length !== items.length) this.emit('event', { kind: 'peers.changed' } satisfies ServerEvent);
        return items;
      }).finally(() => this.listing.delete(p.id));
      this.listing.set(p.id, inflight);
      // outlived the bound below: tell clients to refetch when it lands
      inflight.then(() => { if (late) this.emit('event', { kind: 'sessions.changed' } satisfies ServerEvent); }, () => {});
    }
    const timeout = new Promise<null>((r) => { const t = setTimeout(() => { late = true; r(null); }, this.listTimeout); t.unref?.(); });
    const got = await Promise.race([inflight.catch(() => null), timeout]);
    if (got) return got;
    // slow or failed: last good list (not greyed — the peer is connected)
    return (hit?.items ?? []).map((s) => ({ ...s, peer: { id: p.id, name: p.name } }));
  }

  private async mergedList(ctx: RouteCtx, limit?: number) {
    const peers = this.d.store.peers().filter((p) => p.enabled);
    const [mine, ...theirs] = await Promise.all([ctx.local() as Promise<SessionSummary[]>, ...peers.map((p) => this.peerList(p).catch(() => []))]);
    if (!peers.length) return mine;
    const all = [...(mine ?? []), ...theirs.flat()].sort((a, b) => b.lastModified - a.lastModified);
    return limit ? all.slice(0, limit) : all;
  }

  private async mergedSearch(ctx: RouteCtx, query: string, limit: number) {
    const peers = this.d.store.peers().filter((p) => p.enabled && this.clients.get(p.id)?.state === 'online');
    const bound = <T>(p: Promise<T>, fallback: T) => Promise.race([p.catch(() => fallback), new Promise<T>((r) => { const t = setTimeout(() => r(fallback), this.listTimeout); t.unref?.(); })]);
    const [mine, ...theirs] = await Promise.all([
      ctx.local() as Promise<{ session: SessionSummary; snippet?: string }[]>,
      ...peers.map((p) => bound(this.forward(p.id, { kind: 'sessions.search', query, limit }, []).then((d) => inbound('sessions.search', d, { id: p.id, name: p.name }) as { session: SessionSummary; snippet?: string }[]), [])),
    ]);
    if (!peers.length) return mine;
    // no common score across machines: ours first, then each machine's (each already capped at `limit`)
    return [...(mine ?? []), ...theirs.flat()];
  }

  // ---------- hand-over ----------
  /** Every page of a remote session's history, oldest first (the peer's library.read pages newest first). */
  private async readAllRemote(peerId: string, remoteId: string): Promise<any[]> {
    const pages: any[][] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r: any = await this.forward(peerId, { kind: 'library.read', sessionId: remoteId, cursor, limit: 100 }, []);
      pages.push(Array.isArray(r?.messages) ? r.messages : []);
      if (!r?.next || seen.has(r.next)) break;
      seen.add(r.next);
      cursor = r.next;
    }
    return pages.reverse().flat();
  }

  async handover(req: Extract<PeerRequest, { kind: 'peers.handover' }>) {
    const p = parsePeerId(req.sessionId);
    if (!p) throw new Error('不是其它机器上的会话');
    if (!this.d.handover) throw new Error('交接不可用');
    if (!req.cwd?.trim()) throw new Error('需要本机的工作目录');
    const summary = this.lists.get(p.peerId)?.items.find((s) => s.sessionId === req.sessionId);
    const from = (summary?.agent ?? 'claude') as AgentKind;
    const title = summary?.title ? `${summary.title}（来自 ${this.ref(p.peerId).name}）` : undefined;
    const r = await this.d.handover({
      sessionId: req.sessionId,
      agent: req.agent,
      model: req.model,
      readAll: () => this.readAllRemote(p.peerId, p.remoteId),
      imported: async () => ({ agent: from, cwd: req.cwd.trim(), title }),
    });
    this.emit('event', { kind: 'sessions.changed' } satisfies ServerEvent);
    return r;
  }
}

function rewriteEventSafe(e: ServerEvent, peer: PeerRef) {
  try { return rewriteEvent(e, peer); } catch { return null; }
}

function waitFor(fn: () => boolean, ms: number): Promise<void> {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => { if (fn() || Date.now() - t0 > ms) res(); else setTimeout(tick, 50); };
    tick();
  });
}
