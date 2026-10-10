import type http from 'node:http';
import type { WebService } from './service.js';

/**
 * `POST /api/web/tool` — where the `web` MCP processes (web/mcp.ts) bring their tool calls: `{sessionId, tool, args}`
 * in, MCP `{content, isError?}` out. Only for this machine and only for those processes: a request through the
 * remote-access listener (its sockets are marked `cwRemote`) or from another address gets 404 like any unknown path,
 * and the bearer must be this start's secret (which only the MCP processes are given).
 */
export const WEB_TOOL_PATH = '/api/web/tool';
/** A tool call is a few short strings; the largest is the text for browser_type. */
const BODY_LIMIT = 256 * 1024;

const isLoopback = (a: string | undefined) => !!a && (a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.'));

function bearer(req: http.IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '';
}

/** True: the request was this endpoint's (answered, or being answered). */
export function handleWebTool(web: WebService, req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
  if (url.pathname !== WEB_TOOL_PATH) return false;
  const reply = (status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
    res.end(text);
  };
  if ((req.socket as any).cwRemote || !isLoopback(req.socket.remoteAddress)) { res.writeHead(404).end(); return true; }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return true; }
  // a page in the user's browser must not be able to make this call for a site: no CORS answer, and a browser's
  // cross-site request cannot carry the secret anyway — the check comes before a byte of the body is read
  if (!web.tokenOk(bearer(req))) { reply(401, { error: 'unauthorized' }); return true; }
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) { reply(413, { error: 'too large' }); return true; }
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on('data', (c: Buffer) => {
    if (over) return;
    size += c.length;
    // answered now; what is still coming is read and dropped (destroying the request would take the answer with it)
    if (size > BODY_LIMIT) { over = true; chunks.length = 0; reply(413, { error: 'too large' }); return; }
    chunks.push(c);
  });
  req.on('error', () => { /* the caller went away */ });
  req.on('end', () => {
    if (over) return;
    let j: any;
    try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { error: 'not JSON' }); return; }
    if (!j || typeof j !== 'object' || typeof j.tool !== 'string') { reply(400, { error: 'tool required' }); return; }
    const args = j.args && typeof j.args === 'object' && !Array.isArray(j.args) ? j.args : {};
    // WebService.tool never throws: a failure is a tool result the model reads
    void web.tool(typeof j.sessionId === 'string' ? j.sessionId : '', j.tool, args).then((r) => reply(200, r), (e) => reply(500, { error: String(e?.message ?? e) }));
  });
  return true;
}
