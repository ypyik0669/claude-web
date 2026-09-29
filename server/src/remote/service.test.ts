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
