import http from 'node:http';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { MetaStore } from '../meta/store.js';
import { RemoteService } from './service.js';

const freePort = () => new Promise<number>((res) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); });
});

describe('RemoteService', () => {
  // Ctrl+C / SIGTERM on macOS and Linux runs the graceful shutdown, which awaits remote.stop(): with a phone or
  // another machine connected over WebSocket it used to wait until that client left by itself
  it('stop() closes a connected WebSocket client instead of waiting for it to leave', async () => {
    const port = await freePort();
    const meta = { settings: () => ({ 'remote.enabled': true, 'remote.port': port }), devices: () => [] } as unknown as MetaStore;
    const wss = new WebSocketServer({ noServer: true });
    const remote = new RemoteService(meta, () => {
      const s = http.createServer((_req, res) => res.end('ok'));
      s.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req)));
      return s;
    }, '127.0.0.1');
    await remote.start();
    expect(remote.status().running).toBe(true);

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((res, rej) => { client.once('open', res); client.once('error', rej); });
    const closed = new Promise((res) => client.once('close', res));

    const t0 = Date.now();
    await remote.stop();
    expect(Date.now() - t0).toBeLessThan(3000);
    await closed;
    expect(remote.status().running).toBe(false);
    wss.close();
  }, 15_000);
});

// SEC-07: "another computer" is a property of the token, set when it pairs (or first connects) as one, never lifted
describe('RemoteService peer devices', () => {
  const fakeMeta = () => {
    const devices: any[] = [];
    return {
      settings: () => ({}),
      devices: () => devices,
      addDevice: async (d: any) => { devices.push(d); },
      markDevicePeer: async (id: string) => { const d = devices.find((x) => x.id === id); if (d) d.kind = 'peer'; },
      touchDevice: async () => {},
    } as unknown as MetaStore;
  };
  const req = { headers: { 'user-agent': 'x' }, socket: { remoteAddress: '192.168.1.9' } } as unknown as http.IncomingMessage;

  it('a token redeemed as a peer is a peer; a phone token is not until it connects as one', async () => {
    const remote = new RemoteService(fakeMeta(), () => http.createServer(), '127.0.0.1');
    const c1 = await remote.newPairCode();
    const peer = await remote.redeem(c1.code, 'B', req, 'peer');
    if ('error' in peer) throw new Error(peer.error);
    expect(remote.isPeer(remote.authenticate(peer.token))).toBe(true);
    expect(peer.device.kind).toBe('peer');

    const c2 = await remote.newPairCode();
    const phone = await remote.redeem(c2.code, 'P', req);
    if ('error' in phone) throw new Error(phone.error);
    const id = remote.authenticate(phone.token)!;
    expect(remote.isPeer(id)).toBe(false);
    await remote.markPeer(id);
    expect(remote.isPeer(id)).toBe(true);
    expect(remote.isPeer(null)).toBe(false);
  });
});
