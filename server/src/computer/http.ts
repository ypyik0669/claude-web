import type http from 'node:http';
import { cleanRequest, type ComputerAccess } from './access.js';

/**
 * `POST /api/computer/ask` — where a `computer` MCP process (computer/mcp.ts) brings its `request_access`:
 * `{sessionId, apps, reason, clipboardRead?, clipboardWrite?, systemKeyCombos?}` in, `{granted, message?}` out once
 * the user answered the card (computer/access.ts). Like /api/web/tool it is only for this machine and only for those
 * processes: 404 through the remote-access listener or from another address, and the bearer must be this start's
 * secret.
 */
export const COMPUTER_ASK_PATH = '/api/computer/ask';
const BODY_LIMIT = 16 * 1024;

const isLoopback = (a: string | undefined) => !!a && (a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.'));

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
}

/** True: the request was this endpoint's (answered, or being answered). */
export function handleComputerAsk(access: ComputerAccess, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (url.pathname !== COMPUTER_ASK_PATH) return false;
  let sent = false;
  const reply = (status: number, body: unknown) => {
    if (sent || res.destroyed) return;
    sent = true;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
  };
  if ((req.socket as any).cwRemote || !isLoopback(req.socket.remoteAddress)) { res.writeHead(404).end(); return true; }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return true; }
  // the check comes before a byte of the body is read (a page in a browser cannot carry the secret)
  if (!access.tokenOk(bearer(req))) { reply(401, { error: 'unauthorized' }); return true; }
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) { reply(413, { error: 'too large' }); return true; }
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on('data', (c: Buffer) => {
    if (over) return;
    size += c.length;
    if (size > BODY_LIMIT) { over = true; chunks.length = 0; reply(413, { error: 'too large' }); return; }
    chunks.push(c);
  });
  req.on('error', () => { /* the caller went away */ });
  req.on('end', () => {
    if (over) return;
    let j: any;
    try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { error: 'not JSON' }); return; }
    const request = cleanRequest(j);
    if (!request) { reply(400, { error: 'apps required' }); return; }
    // the MCP process going away (its conversation closed) withdraws the card
    const gone = new AbortController();
    res.on('close', () => { if (!sent) gone.abort(); });
    void access.ask(typeof j.sessionId === 'string' ? j.sessionId : '', request, gone.signal).then((a) => reply(200, a), (e) => reply(500, { error: String(e?.message ?? e) }));
  });
  return true;
}
