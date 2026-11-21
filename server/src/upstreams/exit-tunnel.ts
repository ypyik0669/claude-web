/**
 * A loopback HTTP proxy that tunnels to one residential exit. Chrome's --proxy-server cannot carry credentials,
 * and an exit usually has them, so the sign-in window talks to this (no auth, loopback only) and this opens the
 * CONNECT tunnel upstream. Only CONNECT is handled — the sign-in page is all HTTPS.
 *
 * The plaintext exit URL stays in the server: the window only ever learns this loopback port.
 */
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { tr } from '../i18n/index.js';
import { listenSafe } from '../net/safe-port.js';

const CONNECT_TIMEOUT_MS = 20_000;

/** Reads exactly what the handshake needs, then hands the socket back to the pipe untouched. */
class Reader {
  private buf = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private ended = false;
  constructor(private sock: net.Socket) {
    sock.on('data', this.onData);
    sock.on('close', this.onEnd);
    sock.on('error', this.onEnd);
  }
  private onData = (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.waiter?.(); };
  private onEnd = () => { this.ended = true; this.waiter?.(); };
  private wait(): Promise<void> { return new Promise<void>((r) => { this.waiter = r; }); }

  async take(n: number): Promise<Buffer> {
    while (this.buf.length < n && !this.ended) await this.wait();
    this.waiter = null;
    if (this.buf.length < n) throw new Error(tr('代理提前断开了连接'));
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  async until(marker: string): Promise<string> {
    const m = Buffer.from(marker, 'latin1');
    while (!this.ended) {
      const at = this.buf.indexOf(m);
      if (at >= 0) {
        const out = this.buf.subarray(0, at + m.length).toString('latin1');
        this.buf = this.buf.subarray(at + m.length);
        return out;
      }
      await this.wait();
    }
    throw new Error(tr('代理提前断开了连接'));
  }

  /** stop consuming; whatever arrived after the handshake goes back into the socket for the pipe */
  release(): void {
    this.sock.pause();
    this.sock.off('data', this.onData);
    if (this.buf.length) this.sock.unshift(this.buf);
    this.sock.resume();
  }
}

function withTimeout(sock: net.Socket): net.Socket {
  sock.setTimeout(CONNECT_TIMEOUT_MS, () => sock.destroy(new Error(tr('出口连接超时'))));
  return sock;
}

/** CONNECT through an http(s) proxy, with Proxy-Authorization when the URL carries a user. */
async function viaHttp(url: URL, host: string, port: number): Promise<net.Socket> {
  const secure = url.protocol === 'https:';
  const at = Number(url.port || (secure ? 443 : 80));
  const sock = withTimeout(secure
    ? tls.connect({ host: url.hostname, port: at, servername: url.hostname })
    : net.connect({ host: url.hostname, port: at }));
  await once(sock, secure ? 'secureConnect' : 'connect');
  const auth = url.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}\r\n`
    : '';
  sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
  const reader = new Reader(sock);
  const head = await reader.until('\r\n\r\n');
  if (!/^HTTP\/1\.[01] 2\d\d/.test(head)) {
    sock.destroy();
    throw new Error(head.split('\r\n')[0] || tr('代理拒绝了连接'));
  }
  reader.release();
  return sock;
}

/** CONNECT through a SOCKS5 proxy (user/password auth when the URL carries one; host names go upstream as-is). */
async function viaSocks(url: URL, host: string, port: number): Promise<net.Socket> {
  const sock = withTimeout(net.connect({ host: url.hostname, port: Number(url.port || 1080) }));
  await once(sock, 'connect');
  const reader = new Reader(sock);
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  sock.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
  const [ver, method] = await reader.take(2);
  if (ver !== 5) { sock.destroy(); throw new Error(tr('这个出口不是 SOCKS5')); }
  if (method === 2) {
    const u = Buffer.from(user);
    const p = Buffer.from(pass);
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const [, status] = await reader.take(2);
    if (status !== 0) { sock.destroy(); throw new Error(tr('出口的用户名或密码不对')); }
  } else if (method !== 0) {
    sock.destroy();
    throw new Error(tr('出口不接受这种认证方式'));
  }
  const name = Buffer.from(host);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 255])]));
  const [v, reply, , atyp] = await reader.take(4);
  if (v !== 5 || reply !== 0) { sock.destroy(); throw new Error(tr('出口拒绝连接（{code}）', { code: reply })); }
  if (atyp === 1) await reader.take(4 + 2);
  else if (atyp === 4) await reader.take(16 + 2);
  else {
    const [len] = await reader.take(1);
    await reader.take(len + 2);
  }
  reader.release();
  return sock;
}

const open = (url: URL, host: string, port: number): Promise<net.Socket> =>
  /^socks/i.test(url.protocol) ? viaSocks(url, host, port) : viaHttp(url, host, port);

export interface ExitTunnel {
  port: number;
  close(): Promise<void>;
}

/** Start the loopback proxy; it only listens on 127.0.0.1 and is meant to live as long as one sign-in. */
export async function startExitTunnel(upstreamUrl: string): Promise<ExitTunnel> {
  const upstream = new URL(upstreamUrl);
  const server = http.createServer((_req, res) => { res.writeHead(405).end(); });
  server.on('connect', (req, client, head) => {
    const [host, portText] = (req.url ?? '').split(':');
    const port = Number(portText || 443);
    if (!host || !Number.isFinite(port)) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    open(upstream, host, port).then((up) => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
      const done = () => { up.destroy(); client.destroy(); };
      up.on('error', done);
      up.on('close', done);
      client.on('error', done);
      client.on('close', done);
    }).catch(() => { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
  });
  // Chrome is pointed at this proxy: never a port it refuses
  const port = await listenSafe(server, 0, '127.0.0.1');
  return { port, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

/** Does this exit actually carry traffic to Google? Checked before opening a window, so a dead exit never falls back to direct. */
export async function probeExit(upstreamUrl: string, host = 'accounts.google.com', port = 443): Promise<void> {
  const sock = await open(new URL(upstreamUrl), host, port);
  sock.destroy();
}
