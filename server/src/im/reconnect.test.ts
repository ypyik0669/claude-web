import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { DiscordAdapter } from './discord.js';

// local stand-in for the Discord gateway: hello + READY, then the test drops the socket
function gateway() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const conns: any[] = [];
  wss.on('connection', (ws) => {
    conns.push(ws);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
    ws.on('message', (raw) => { if (JSON.parse(String(raw)).op === 2) ws.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { user: { id: '1', username: 'bot' } } })); });
  });
  const url = new Promise<string>((r) => wss.on('listening', () => r(`ws://127.0.0.1:${(wss.address() as any).port}`)));
  return { wss, conns, url };
}
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

describe('Discord adapter reconnect', () => {
  it('schedules a reconnect when the gateway drops, and stop() cancels it', async () => {
    const g = gateway();
    const url = await g.url;
    const a = new DiscordAdapter('t');
    (a as any).rest = async () => ({ url });
    try {
      await a.start();
      await until(() => a.state === 'running');
      g.conns[0].close();
      await until(() => a.state === 'error');
      expect((a as any).retry).not.toBeNull(); // previously the timer re-checked `running` (already false) and never reconnected
      await a.stop();
      expect((a as any).retry).toBeNull();
      expect(a.state).toBe('stopped');
    } finally {
      await a.stop();
      g.wss.close();
    }
  });
});
