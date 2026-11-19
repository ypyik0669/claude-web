import { describe, expect, it } from 'vitest';
import type { ClientRequest, ServerEvent, SessionSummary } from '../protocol.js';
import { importList, inbound, outbound, planRoute, refusedFromPeer, rewriteEvent } from './rewrite.js';

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
  it('新对话选机器: a new conversation with `peer` starts on that machine, which never sees the field', () => {
    const req = { kind: 'session.open', params: { cwd: '/r', peer: 'b1', model: 'opus' } } as ClientRequest;
    expect(planRoute(req)).toEqual({ kind: 'forward', peerId: 'b1' });
    expect((outbound(req) as any).params).toEqual({ cwd: '/r', model: 'opus' });
    expect(inbound('session.open', { sessionId: 's9', info: { sessionId: 's9' } }, P)).toMatchObject({ sessionId: 'peer_b1~s9', info: { sessionId: 'peer_b1~s9' } });
    // a resume names its machine by the id; a `peer` that says otherwise is refused
    expect(planRoute({ kind: 'session.open', params: { sessionId: 'local-1', cwd: '/r', peer: 'b1' } } as any).kind).toBe('reject');
    expect(planRoute({ kind: 'session.open', params: { cwd: '/r', peer: '' } } as any)).toEqual({ kind: 'none' });
  });
  it('the memory store is this machine\'s: a remote session id is only a scope key', () => {
    expect(planRoute({ kind: 'memory.search', sessionId: 'peer_b1~s1', cwd: '/r' })).toEqual({ kind: 'local' });
    expect(planRoute({ kind: 'memory.write', text: 'x', sessionId: 'peer_b1~s1' })).toEqual({ kind: 'local' });
    expect(planRoute({ kind: 'vcs.autoLease', sessionId: 'peer_b1~s1', holder: 'w' })).toEqual({ kind: 'local' }); // fix E-I3
    expect(planRoute({ kind: 'memory.harvest', sessionId: 'peer_b1~s1' }).kind).toBe('reject');
  });
  it('per-session reads that live with the session are forwarded (usage, touched files, their diffs)', () => {
    for (const req of [
      { kind: 'usage.session', sessionId: 'peer_b1~s1' },
      { kind: 'files.changed', sessionId: 'peer_b1~s1' },
      { kind: 'files.diff', sessionId: 'peer_b1~s1', path: '/r/a.ts' },
      // the mode a conversation there resumes in is that machine's record (the chip of one not running)
      { kind: 'session.resumeMode', sessionId: 'peer_b1~s1' },
      // a conversation's own folders are recorded on (and checked against) the machine it runs on
      { kind: 'session.setExtraDirs', sessionId: 'peer_b1~s1', dirs: ['/data'] },
    ] as ClientRequest[]) expect(planRoute(req)).toEqual({ kind: 'forward', peerId: 'b1' });
  });
  it('every sessionId-carrying request the web client sends is routed somewhere (no surprise "不支持")', () => {
    // kept in sync with `grep sessionId` over web/src ws.request calls; switchAgent / setProvider / harvest are hidden in the UI
    const routed: ClientRequest[] = [
      { kind: 'feedback.list', sessionId: 'peer_b1~s' }, { kind: 'feedback.set', sessionId: 'peer_b1~s', messageId: 'm', rating: 'up' },
      { kind: 'ledger.list', sessionId: 'peer_b1~s' }, { kind: 'session.setMeta', sessionId: 'peer_b1~s', patch: {} },
      { kind: 'library.read', sessionId: 'peer_b1~s' }, { kind: 'session.contextUsage', sessionId: 'peer_b1~s' },
      { kind: 'session.stopTask', sessionId: 'peer_b1~s', taskId: 't' }, { kind: 'transcript.subagent', sessionId: 'peer_b1~s', agentId: 'a' },
      { kind: 'session.setEffort', sessionId: 'peer_b1~s', effort: 'high' }, { kind: 'session.setUltracode', sessionId: 'peer_b1~s', on: true },
      { kind: 'background.history', sessionId: 'peer_b1~s' }, { kind: 'background.run', sessionId: 'peer_b1~s', runId: 'wf_1' },
      { kind: 'background.transcript', sessionId: 'peer_b1~s', agentId: 'a1b2c3d4' },
    ];
    for (const r of routed) expect(planRoute(r).kind, r.kind).not.toBe('reject');
  });
  it('联网 requests name no session: never forwarded, whatever a command was about', () => {
    // (the BrowserCommand a window answers may be about a remote conversation; the answer still goes to this machine)
    for (const req of [
      { kind: 'web.status' }, { kind: 'web.search', query: 'q', count: 3 },
      { kind: 'browser.host', on: true }, { kind: 'browser.result', id: 'peer_b1~c1', ok: true, answer: { page: { url: 'https://x', title: '', text: '' } } },
    ] as ClientRequest[]) expect(planRoute(req), req.kind).toEqual({ kind: 'none' });
  });
  it('another machine cannot manage this one\'s machines, nor host / answer for its built-in browser', () => {
    expect(refusedFromPeer({ kind: 'peers.list' })).toContain('机器列表');
    expect(refusedFromPeer({ kind: 'browser.host', on: true })).toContain('内置浏览器');
    expect(refusedFromPeer({ kind: 'browser.result', id: 'c1', ok: false, error: 'x' })).toContain('内置浏览器');
    for (const req of [{ kind: 'web.status' }, { kind: 'web.search', query: 'q' }, { kind: 'sessions.list' }, { kind: 'session.send', params: { sessionId: 's', text: 'x' } }] as ClientRequest[]) {
      expect(refusedFromPeer(req), req.kind).toBeNull();
    }
  });
  it('stage F (fix wave F5): another machine only gets the receiving side of a hand-off / publish and a 派活 run here', () => {
    for (const req of [
      { kind: 'handoff.check', sessionId: 's' }, { kind: 'handoff.start', sessionId: 's', peerId: 'p' }, { kind: 'handoff.fetchBack', sessionId: 's' },
      { kind: 'publish.create', path: '/x', expiry: '1d' }, { kind: 'publish.list' }, { kind: 'publish.toPeer', path: '/x', expiry: '1d', peerId: 'p' },
      { kind: 'publish.inline', path: '/x' }, { kind: 'publish.files', path: '/x' },
      { kind: 'claudeai.scan', path: '/x' }, { kind: 'claudeai.import', path: '/x' },
      { kind: 'projects.files.list', workspaceId: 'w' }, { kind: 'projects.files.remove', workspaceId: 'w', name: 'a' },
      { kind: 'dispatch.start', prompt: 'x', peer: 'other' }, { kind: 'dispatch.defaults', peer: 'other' },
    ] as ClientRequest[]) expect(refusedFromPeer(req), req.kind).toBeTruthy();
    for (const req of [
      { kind: 'handoff.receive', id: 'a', url: 'u', branch: 'cw/handoff-a', events: [], from: 'x' }, { kind: 'handoff.publish', branch: 'cw/handoff-a' },
      { kind: 'publish.receive', name: 'n', entry: 'i.html', source: 's', expiry: '1d', files: [] }, { kind: 'publish.revoke', id: 'a' },
      { kind: 'dispatch.start', prompt: 'x' }, { kind: 'dispatch.defaults' },
    ] as ClientRequest[]) expect(refusedFromPeer(req), req.kind).toBeNull();
  });
  it('stage E5: a WSL conversation cannot go to another machine; WSL and SSH tests belong to this machine', () => {
    expect(planRoute({ kind: 'session.open', params: { cwd: '/x', peer: 'peer_b1', env: { kind: 'wsl', distro: 'U' } } } as ClientRequest).kind).toBe('reject');
    expect(refusedFromPeer({ kind: 'wsl.install', distro: 'U', confirmed: true })).toBeTruthy();
    expect(refusedFromPeer({ kind: 'wsl.list' })).toBeTruthy();
    expect(refusedFromPeer({ kind: 'remote.hosts.test', target: 'me@box' })).toBeTruthy();
    // E-minor: another machine cannot open a conversation or a terminal in this computer's WSL
    expect(refusedFromPeer({ kind: 'session.open', params: { cwd: '/home/x', env: { kind: 'wsl', distro: 'U' } } } as ClientRequest)).toBeTruthy();
    expect(refusedFromPeer({ kind: 'terminal.open', cwd: '/x', cols: 80, rows: 24, wsl: { distro: 'U' } })).toBeTruthy();
    expect(refusedFromPeer({ kind: 'session.open', params: { cwd: '/x', env: { kind: 'local' } } } as ClientRequest)).toBeNull();
    expect(refusedFromPeer({ kind: 'terminal.open', cwd: '/x', cols: 80, rows: 24 })).toBeNull();
  });
  it('stage E: forge tokens stay on this machine; the PR comment requests are routed nowhere (cwd-based, local)', () => {
    expect(refusedFromPeer({ kind: 'vcs.tokens.list' })).toBeTruthy();
    expect(refusedFromPeer({ kind: 'vcs.tokens.set', host: 'gitlab.com', token: 'x' })).toBeTruthy();
    for (const req of [
      { kind: 'vcs.prComments', cwd: '/r', number: 1 }, { kind: 'vcs.failureLog', cwd: '/r', jobId: 1 },
      { kind: 'vcs.replyComment', cwd: '/r', number: 1, comment: { id: 'a', kind: 'general' }, body: 'x' },
      { kind: 'vcs.resolveComment', cwd: '/r', number: 1, comment: { id: 'a', kind: 'thread', threadId: 't' } },
    ] as ClientRequest[]) expect(planRoute(req), req.kind).toEqual({ kind: 'none' });
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
  it('跑过的: a remote conversation\'s rows go to its machine and come back as its (the cursor untouched)', () => {
    expect(planRoute({ kind: 'background.historyAll', sessionId: 'peer_b1~s1', limit: 10 })).toEqual({ kind: 'forward', peerId: 'b1' });
    // every conversation's: this machine's own (other machines are merged later, per machine)
    expect(planRoute({ kind: 'background.historyAll' })).toEqual({ kind: 'none' });
    expect(outbound({ kind: 'background.historyAll', sessionId: 'peer_b1~s1', before: '5:s1|agent|a1' })).toEqual({ kind: 'background.historyAll', sessionId: 's1', before: '5:s1|agent|a1' });
    const page = inbound('background.historyAll', { items: [{ id: 's1|agent|a1', sessionId: 's1', kind: 'agent', title: 't', status: 'completed', startedAt: 5 }], next: '5:s1|agent|a1' }, P);
    expect(page).toEqual({ items: [{ id: 'peer_b1~s1|agent|a1', sessionId: 'peer_b1~s1', kind: 'agent', title: 't', status: 'completed', startedAt: 5 }], next: '5:s1|agent|a1' });
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
      // another machine's 联网 state and browser commands are its own
      { kind: 'web.changed' }, { kind: 'browser.command', command: { id: 'c', sessionId: 's', op: 'read', args: {} } },
      { kind: 'session.state', sessionId: 'peer_a1~s', state: 'idle' },
      { kind: 'permission.resolved', requestId: 'peer_a1~r' },
    ] as ServerEvent[]) expect(rewriteEvent(e, P)).toBeNull();
  });
});

describe('stage F requests', () => {
  it('交接 / 取回 are about this machine\'s own conversations: another machine\'s conversation is refused, a local one is not federation\'s business', () => {
    for (const kind of ['handoff.check', 'handoff.start', 'handoff.fetchBack'] as const) {
      const req = { kind, sessionId: 'peer_b1~s1', peerId: 'b1' } as unknown as ClientRequest;
      expect(planRoute(req).kind, kind).toBe('reject');
      expect(planRoute({ ...req, sessionId: 's1' } as ClientRequest).kind, kind).toBe('none');
    }
    // 派活 / 发布 name no conversation: never routed by id
    expect(planRoute({ kind: 'dispatch.start', prompt: 'x', peer: 'b1' } as ClientRequest).kind).toBe('none');
    expect(planRoute({ kind: 'publish.list' } as ClientRequest).kind).toBe('none');
  });
});
