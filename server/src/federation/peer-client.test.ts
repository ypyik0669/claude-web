import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { PeerClient } from './peer-client.js';

/** A stand-in for another machine's claude-web: /api/health, token-guarded /api/file and /ws. */
async function fakeRemote(o: { serverId?: string; port?: number } = {}) {
  const seen: any[] = [];
  const sockets = new Set<WebSocket>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/health') { res.writeHead(200).end('{"ok":true}'); return; }
    if (url.pathname === '/api/file') { res.writeHead(url.searchParams.get('token') === 'good' ? 400 : 403).end(); return; }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.searchParams.get('token') !== 'good') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      seen.push({ peer: url.searchParams.get('peer') });
      ws.send(JSON.stringify({ type: 'event', event: { kind: 'hello', version: '9.9.9', serverId: o.serverId ?? 'remote1', name: 'Box B' } }));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        seen.push(m.request);
        if (m.request.req.kind === 'boom') ws.send(JSON.stringify({ type: 'reply', reply: { id: m.request.id, ok: false, error: 'nope' } }));
        else ws.send(JSON.stringify({ type: 'reply', reply: { id: m.request.id, ok: true, data: { echo: m.request.req } } }));
      });
    });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    seen,
    broadcast: (event: unknown) => { for (const s of sockets) s.send(JSON.stringify({ type: 'event', event })); },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.terminate(); wss.close(); server.close(() => r()); server.closeAllConnections(); }),
  };
}

const until = async (fn: () => boolean, ms = 5000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };
const clients: PeerClient[] = [];
const remotes: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const c of clients.splice(0)) c.stop(); for (const r of remotes.splice(0)) await r.close(); });
const mk = (url: string, token = 'good', selfId = 'me1') => { const c = new PeerClient({ selfId, resolve: async () => ({ url, token }), backoffMinMs: 50, backoffMaxMs: 200 }); clients.push(c); return c; };

describe('PeerClient', () => {
  it('connects, reads the hello, round-trips requests with the via chain', async () => {
    const r = await fakeRemote(); remotes.push(r);
    const c = mk(r.url);
    c.start();
    await until(() => c.state === 'online');
    expect(c.remote).toEqual({ serverId: 'remote1', name: 'Box B', version: '9.9.9' });
    expect(r.seen[0]).toEqual({ peer: 'me1' });
    const d = await c.request<any>({ kind: 'sessions.list' }, ['me1']);
    expect(d.echo).toEqual({ kind: 'sessions.list' });
    expect(r.seen[1].via).toEqual(['me1']);
    await expect(c.request({ kind: 'boom' } as any, ['me1'])).rejects.toThrow('nope');
    await until(() => c.latencyMs !== undefined);
  });

  it('re-emits broadcasts', async () => {
    const r = await fakeRemote(); remotes.push(r);
    const c = mk(r.url);
    const got: any[] = [];
    c.on('event', (e) => got.push(e));
    c.start();
    await until(() => c.state === 'online');
    r.broadcast({ kind: 'sessions.changed' });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ kind: 'sessions.changed' });
  });

  it('a rejected token is "unauthorized" and stops retrying', async () => {
    const r = await fakeRemote(); remotes.push(r);
    const c = mk(r.url, 'revoked');
    c.start();
    await until(() => c.state === 'unauthorized');
    expect(c.error).toContain('重新配对');
    await expect(c.request({ kind: 'sessions.list' }, [])).rejects.toThrow();
  });

  it('goes offline when the remote dies and reconnects when it is back', async () => {
    const r = await fakeRemote();
    const c = mk(r.url);
    c.start();
    await until(() => c.state === 'online');
    const port = r.port;
    await r.close();
    await until(() => c.state === 'offline');
    const r2 = await fakeRemote({ port }); remotes.push(r2);
    await until(() => c.state === 'online', 8000);
  });

  it('refuses to peer with itself', async () => {
    const r = await fakeRemote({ serverId: 'me1' }); remotes.push(r);
    const c = mk(r.url);
    c.start();
    await until(() => c.state === 'offline' && c.error.includes('本机'));
  });

  it('an unreachable address is offline with an error, not a crash', async () => {
    const c = mk('http://127.0.0.1:1');
    c.start();
    await until(() => c.state === 'offline');
    expect(c.error).toBeTruthy();
  });
});
