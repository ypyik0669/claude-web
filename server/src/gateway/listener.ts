// The LAN listener: a second http.Server with the data plane only (`/v1`, `/v1beta`, `/healthz`) — never the
// admin surface, the app's websocket or the app. Bind address and allowlist are the user's decision; this only
// serves. The one upgrade it takes is the data plane's own (`/v1/responses` / `/v1/ws`, ws-relay.ts).
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { listenSafe } from '../net/safe-port.js';

export type UpgradeHandler = (req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL) => boolean;

export class GatewayListener {
  private srv: http.Server | null = null;
  private _port = 0;

  constructor(
    private onRequest: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void,
    private onUpgrade?: UpgradeHandler,
  ) {}

  get running() { return !!this.srv; }
  get port() { return this._port; }

  async start(bind: string, port: number): Promise<number> {
    await this.stop();
    const srv = http.createServer((req, res) => {
      let url: URL;
      try { url = new URL(req.url ?? '/', `http://${bind}`); } catch { res.writeHead(400).end(); return; }
      this.onRequest(req, res, url);
    });
    srv.on('upgrade', (req, socket, head) => {
      let url: URL;
      try { url = new URL(req.url ?? '/', `http://${bind}`); } catch { socket.destroy(); return; }
      if (!this.onUpgrade?.(req, socket, head, url)) socket.destroy();
    });
    // port 0: never one a client's fetch refuses (net/safe-port.ts)
    this._port = await listenSafe(srv, port, bind);
    this.srv = srv;
    return this._port;
  }

  async stop(): Promise<void> {
    const srv = this.srv;
    if (!srv) return;
    this.srv = null;
    this._port = 0;
    await new Promise<void>((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  }
}
