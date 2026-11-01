// Upload endpoints without an app token (local browser mode trusts loopback): a page on some other website could still
// POST to 127.0.0.1 from the user's browser. Those requests carry `Sec-Fetch-Site: cross-site` (or an `Origin` that is
// not this server), so only same-origin ones — or ones with neither header (curl, the desktop shell) — get through.
import type http from 'node:http';

export function sameOriginRequest(req: Pick<http.IncomingMessage, 'headers'>): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  try {
    return new URL(String(origin)).host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}

/**
 * The Host header names this machine's loopback: 127.x.x.x, localhost or [::1], with or without a port. Without an app
 * token the main listener only answers requests addressed this way — DNS rebinding (evil.example resolving to
 * 127.0.0.1) still sends `Host: evil.example:3090`, so it is turned away before it reaches /ws or /api/file (SEC-01).
 */
export function loopbackHost(host: string | undefined): boolean {
  const h = String(host ?? '').toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.replace(/:\d*$/, '');
  if (h.length > name.length && !/^:\d{1,5}$/.test(h.slice(name.length))) return false;
  return name === 'localhost' || name === '[::1]' || /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(name);
}

/**
 * A WebSocket upgrade's Origin: none (Node clients, federation peers) or the page this server served itself — the
 * Origin's host is the request's Host. A page on another local port (another dev server, Jupyter) is refused (SEC-11).
 */
export function wsOriginOk(req: Pick<http.IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === '') return true;
  try {
    const u = new URL(String(origin));
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.toLowerCase() === String(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}
