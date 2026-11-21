// Ports a browser or Node's fetch refuses to connect to (2026-11-21). The Fetch standard's "bad ports": Chromium
// shows ERR_UNSAFE_PORT and undici throws "bad port". Windows hands out ephemeral ports from 49152 by default, which
// never meets this list — but software can widen the range (this development machine's starts at 1024), and then a
// listen on port 0 now and then lands on 5060 or 6000: the desktop window would stay blank on its own server's address,
// and a fetch to a sidecar would fail ("bad port" in a test of the conversation library found it).
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tr } from '../i18n/index.js';

export const BAD_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export const badPort = (port: number): boolean => BAD_PORTS.has(port);

/** A port the user typed (the local gateway's, the LAN listener's, remote access's): a bad one is refused with why. */
export function assertUsablePort(port: number): void {
  if (badPort(port)) throw new Error(tr('端口 {port} 会被浏览器拒绝连接，换一个', { port: String(port) }));
}

/** How many times a listen on port 0 is tried again when the system picked a bad port. */
const TRIES = 20;

const listenOnce = (server: net.Server, port: number, host?: string) =>
  new Promise<void>((resolve, reject) => {
    const fail = (e: Error) => { server.off('listening', ok); reject(e); };
    const ok = () => { server.off('error', fail); resolve(); };
    server.once('error', fail);
    server.once('listening', ok);
    server.listen(port, host);
  });

/**
 * `server.listen(port, host)` as a promise of the port it got. With port 0 (any free one) a bad port the system picked
 * is given back and another one taken; a port asked for by number is used as it is (the caller chose it).
 */
export async function listenSafe(server: net.Server, port: number, host?: string): Promise<number> {
  for (let i = 0; ; i++) {
    await listenOnce(server, port, host);
    const got = (server.address() as AddressInfo).port;
    if (port !== 0 || !badPort(got) || i >= TRIES) return got;
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** A port nobody holds right now and no browser or fetch refuses (listened on and given back; the caller binds it next). */
export async function freePort(host = '127.0.0.1'): Promise<number> {
  const srv = net.createServer();
  const port = await listenSafe(srv, 0, host);
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}
