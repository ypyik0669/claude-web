import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { assertUsablePort, badPort, freePort, listenSafe } from './safe-port.js';

describe('listenSafe: never a port a browser or fetch refuses', () => {
  it('knows the Fetch standard\'s bad ports (the ones above 1024 a widened ephemeral range can hand out)', () => {
    for (const p of [1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6669, 6679, 6697, 10080]) expect(badPort(p)).toBe(true);
    for (const p of [1024, 3090, 8080, 49152, 61697, 65535]) expect(badPort(p)).toBe(false);
  });

  it('port 0: a bad port the system picked is given back and another one taken', async () => {
    const server = net.createServer();
    const real = server.listen.bind(server);
    let calls = 0;
    // the first listen lands on 6000 (as a widened range can make it); the second on a free one
    (server as any).listen = (port: number, host?: string) => {
      calls++;
      if (calls === 1) {
        return real(0, host, () => { (server as any).address = () => ({ port: 6000, address: '127.0.0.1', family: 'IPv4' }); });
      }
      delete (server as any).address;
      return real(port, host);
    };
    const port = await listenSafe(server, 0, '127.0.0.1');
    expect(calls).toBe(2);
    expect(badPort(port)).toBe(false);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('a port asked for by number is used as it is', async () => {
    const probe = net.createServer();
    const free = await listenSafe(probe, 0, '127.0.0.1');
    await new Promise<void>((r) => probe.close(() => r()));
    const server = net.createServer();
    expect(await listenSafe(server, free, '127.0.0.1')).toBe(free);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('a listen that fails rejects (the port is taken)', async () => {
    const a = net.createServer();
    const port = await listenSafe(a, 0, '127.0.0.1');
    const b = net.createServer();
    await expect(listenSafe(b, port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);
    await new Promise<void>((r) => a.close(() => r()));
  });

  it('freePort: a free port that is not a bad one (given back, so it can be bound)', async () => {
    const port = await freePort();
    expect(badPort(port)).toBe(false);
    const s = net.createServer();
    expect(await listenSafe(s, port, '127.0.0.1')).toBe(port);
    await new Promise<void>((r) => s.close(() => r()));
  });

  it('a port the user typed that browsers refuse is turned down, saying so', () => {
    expect(() => assertUsablePort(6000)).toThrow('6000');
    expect(() => assertUsablePort(5060)).toThrow('5060');
    expect(() => assertUsablePort(3091)).not.toThrow();
  });
});
