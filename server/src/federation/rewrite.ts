import type { ClientRequest, ServerEvent, SessionSummary } from '../protocol.js';
import { isPeerId, parsePeerId, peerSessionId } from './types.js';
import { tr } from '../i18n/index.js';
import { cloudRefusedFromPeer } from '../cloud/handlers.js';

/**
 * Pure id rewriting between this machine and one peer. Outbound: a request about
 * `peer_<id>~<remote id>` loses its prefix before it goes to that peer. Inbound: every session id /
 * permission request id in a reply or event gains it. Everything here is unit-tested; the service
 * only moves data through it.
 */

/** Requests about a remote session that are answered by the machine the session lives on. */
const FORWARD = new Set<ClientRequest['kind']>([
  'session.open', 'session.info', 'session.send', 'session.interrupt', 'session.side', 'session.close',
  'session.setModel', 'session.setPermissionMode', 'session.resumeMode', 'session.setEffort', 'session.setUltracode', 'session.setSubagentModel', 'session.setFeatures',
  'session.contextUsage', 'session.stopTask', 'session.fastMode', 'session.toggleMcp', 'session.canonical',
  'permission.respond',
  'transcript.load', 'transcript.subagents', 'transcript.subagent',
  'library.read', 'library.catchUp', 'library.rename', 'library.fork',
  'session.rename', 'session.delete',
  // read on the machine that has the transcript / the files
  'usage.session', 'files.changed', 'files.diff',
  // 后台: a remote conversation's finished runs and sub-agent transcripts are on that machine's disk
  'background.history', 'background.run', 'background.transcript',
]);
// Not here on purpose (stage F1): handoff.check / handoff.start / handoff.fetchBack take only this machine's own
// conversations — planRoute rejects them for another machine's (rewrite.test.ts 'stage F requests').
/** Batch requests: split per machine (local ids stay here, each peer gets its own), results merged. */
const SPLIT = new Set<ClientRequest['kind']>(['library.archive', 'library.delete']);
/** This machine's own state keyed by a session id (ratings, pin / archive meta, the ledger, the memory store — there a session id is just a scope key). */
const LOCAL = new Set<ClientRequest['kind']>([
  'session.setMeta', 'feedback.set', 'feedback.list', 'ledger.list', 'memory.search', 'memory.write',
  'vcs.autoLease', // stage E fix: which window of this machine acts for the PR bar
]);

/**
 * 联网 (web.* / browser.*) is each machine's own: none of these requests names a session, so none is ever forwarded.
 * The two below are more: they speak for this machine's built-in browser, which only a window on this machine has —
 * another machine (a peer connection, a request that came through one) is refused outright.
 */
const OWN_WINDOW_ONLY = new Set<ClientRequest['kind']>(['browser.host', 'browser.result']);

/** Why a request from another machine is refused whatever it is about; null = judged like any other. */
export function refusedFromPeer(req: ClientRequest): string | null {
  if (req.kind.startsWith('peers.')) return tr('其它机器不能管理本机的机器列表');
  if (OWN_WINDOW_ONLY.has(req.kind)) return tr('只有本机的桌面窗口才能提供内置浏览器');
  // stage E: GitHub / GitLab tokens stay on the machine that has them
  // stage E5: this computer's WSL distros and its SSH logins are its own
  if (req.kind.startsWith('wsl.') || req.kind === 'remote.hosts.test') return tr('其它机器不能使用本机的 WSL 或 SSH');
  if ((req.kind === 'session.open' && req.params?.env?.kind === 'wsl') || (req.kind === 'terminal.open' && req.wsl)) return tr('其它机器不能使用本机的 WSL 或 SSH');
  if (req.kind.startsWith('vcs.tokens.')) return tr('其它机器不能查看或修改本机的 GitHub / GitLab 令牌');
  // stage F: only the receiving side of a hand-off / publish, and a 派活 run here (cloud/handlers.ts)
  if (cloudRefusedFromPeer(req)) return tr('其它机器不能在本机做这件事');
  return null;
}

export type RoutePlan =
  | { kind: 'none' } // no peer id in it: not federation's business
  | { kind: 'local' }
  | { kind: 'forward'; peerId: string }
  | { kind: 'split' }
  | { kind: 'reject'; reason: string };

/** Every session / request id a request refers to. */
export function idsOf(req: ClientRequest): string[] {
  const r = req as any;
  const out: string[] = [];
  if (typeof r.sessionId === 'string') out.push(r.sessionId);
  if (typeof r.params?.sessionId === 'string') out.push(r.params.sessionId);
  if (typeof r.requestId === 'string') out.push(r.requestId);
  if (Array.isArray(r.sessionIds)) for (const x of r.sessionIds) if (typeof x === 'string') out.push(x);
  return out;
}

export function planRoute(req: ClientRequest): RoutePlan {
  // 新对话选机器 (spec 2026-10-16 sessions-env §3): a new conversation names its machine; a resume names it by its id
  const open = req.kind === 'session.open' ? req.params : undefined;
  const want = typeof open?.peer === 'string' ? open.peer : '';
  if (want) {
    // stage E5: a WSL distro is this computer's; another machine's conversation cannot run in it
    if (open!.env?.kind === 'wsl') return { kind: 'reject', reason: tr('WSL 对话只能开在本机') };
    const sid = open!.sessionId;
    if (sid && parsePeerId(sid)?.peerId !== want) return { kind: 'reject', reason: tr('一个请求不能同时涉及多台机器') };
    return { kind: 'forward', peerId: want };
  }
  const ids = idsOf(req);
  const peers = new Set(ids.filter(isPeerId).map((id) => parsePeerId(id)!.peerId));
  if (!peers.size) return { kind: 'none' };
  if (SPLIT.has(req.kind)) return { kind: 'split' };
  if (LOCAL.has(req.kind)) return { kind: 'local' };
  if (req.kind === 'session.switchAgent') return { kind: 'reject', reason: tr('其它机器上的对话请用「交给本机的 Agent 继续」') };
  if (!FORWARD.has(req.kind)) return { kind: 'reject', reason: tr('其它机器上的对话不支持「{kind}」', { kind: req.kind }) };
  // a forwarded request goes to exactly one machine, and only concerns that machine's sessions
  if (peers.size > 1 || ids.some((id) => !isPeerId(id))) return { kind: 'reject', reason: tr('一个请求不能同时涉及多台机器') };
  return { kind: 'forward', peerId: [...peers][0] };
}

const strip = (id: string) => parsePeerId(id)?.remoteId ?? id;

/** The request as the peer must see it: every `peer_<id>~` prefix removed (deep enough for our request shapes). */
export function outbound<T extends ClientRequest>(req: T): T {
  const r: any = { ...req };
  if (typeof r.sessionId === 'string') r.sessionId = strip(r.sessionId);
  if (typeof r.requestId === 'string') r.requestId = strip(r.requestId);
  if (Array.isArray(r.sessionIds)) r.sessionIds = r.sessionIds.map(strip);
  if (r.params && typeof r.params === 'object') {
    r.params = { ...r.params };
    if (typeof r.params.sessionId === 'string') r.params.sessionId = strip(r.params.sessionId);
    delete r.params.peer; // the machine it was sent to is that machine
  }
  return r;
}

export interface PeerRef { id: string; name: string }

const pre = (peerId: string, id: unknown) => (typeof id === 'string' && id && !isPeerId(id) ? peerSessionId(peerId, id) : id);

/** A remote list row as shown here. Rows that are the remote's own peers' sessions are dropped earlier (no multi-hop). */
export function prefixSummary(s: SessionSummary, peer: PeerRef, offline = false): SessionSummary {
  const out: SessionSummary = { ...s, sessionId: pre(peer.id, s.sessionId) as string, peer: offline ? { id: peer.id, name: peer.name, offline: true } : { id: peer.id, name: peer.name } };
  if (s.parentId) out.parentId = pre(peer.id, s.parentId) as string;
  if (s.mergedFrom) out.mergedFrom = pre(peer.id, s.mergedFrom) as string;
  if (offline) delete out.live;
  return out;
}

/** A peer's `sessions.list`, as merged into ours: its own peers' rows dropped, ids prefixed. */
export function importList(list: unknown, peer: PeerRef): SessionSummary[] {
  if (!Array.isArray(list)) return [];
  return list.filter((s: any) => s && typeof s.sessionId === 'string' && !s.peer && !isPeerId(s.sessionId)).map((s) => prefixSummary(s, peer));
}

function prefixPending(peerId: string, list: unknown) {
  return Array.isArray(list) ? list.map((p: any) => ({ ...p, requestId: pre(peerId, p.requestId), sessionId: pre(peerId, p.sessionId) })) : list;
}

/** A forwarded reply, with the peer's ids made local. */
export function inbound(kind: ClientRequest['kind'], data: any, peer: PeerRef): any {
  if (!data || typeof data !== 'object') return data;
  switch (kind) {
    case 'session.open':
    case 'session.info':
      return {
        ...data,
        ...(data.sessionId ? { sessionId: pre(peer.id, data.sessionId) } : {}),
        ...(data.info ? { info: { ...data.info, sessionId: pre(peer.id, data.info.sessionId) } } : {}),
        ...(data.pending ? { pending: prefixPending(peer.id, data.pending) } : {}),
      };
    case 'library.fork':
      return { ...data, sessionId: pre(peer.id, data.sessionId) };
    case 'library.archive':
      return { ...data, done: (data.done ?? []).map((id: string) => pre(peer.id, id)), failed: (data.failed ?? []).map((f: any) => ({ ...f, id: pre(peer.id, f.id) })) };
    case 'library.delete':
      return { ...data, removed: (data.removed ?? []).map((id: string) => pre(peer.id, id)), failed: (data.failed ?? []).map((f: any) => ({ ...f, id: pre(peer.id, f.id) })) };
    case 'sessions.list':
      return importList(data, peer);
    case 'sessions.search':
      return Array.isArray(data) ? data.filter((h: any) => h?.session && !h.session.peer && !isPeerId(h.session.sessionId)).map((h: any) => ({ ...h, session: prefixSummary(h.session, peer) })) : data;
    default:
      return data;
  }
}

/**
 * A peer's broadcast, as re-broadcast here. `invalidate`: its session list changed (drop our cache).
 * Null: not ours to show — other machine-local events (fs / git / terminal / meta …), and anything
 * already about a peer's peer (`peer_` ids): no multi-hop, and no echo between two machines that
 * have each added the other.
 */
export function rewriteEvent(e: ServerEvent, peer: PeerRef): { event?: ServerEvent; invalidate?: boolean } | null {
  switch (e.kind) {
    case 'session.event':
    case 'session.state':
      if (isPeerId(e.sessionId)) return null;
      return { event: { ...e, sessionId: peerSessionId(peer.id, e.sessionId) } as ServerEvent };
    case 'session.info':
      if (!e.info?.sessionId || isPeerId(e.info.sessionId)) return null;
      return { event: { ...e, info: { ...e.info, sessionId: peerSessionId(peer.id, e.info.sessionId) } } };
    case 'permission.request':
      if (!e.request || isPeerId(e.request.sessionId) || isPeerId(e.request.requestId)) return null;
      return { event: { ...e, request: { ...e.request, sessionId: peerSessionId(peer.id, e.request.sessionId), requestId: peerSessionId(peer.id, e.request.requestId) } } };
    case 'gateway.routed':
      // 智能路由 on that machine: its conversation's 「自动 → 实际」 shows here under the prefixed id
      if (isPeerId(e.sessionId)) return null;
      return { event: { ...e, sessionId: peerSessionId(peer.id, e.sessionId) } };
    case 'permission.resolved':
      if (isPeerId(e.requestId)) return null;
      return { event: { ...e, requestId: peerSessionId(peer.id, e.requestId) } };
    case 'sessions.changed':
      return { invalidate: true, event: { kind: 'sessions.changed' } };
    case 'library.changed':
      return { invalidate: true, event: { kind: 'library.changed' } };
    default:
      return null;
  }
}
