import { useStore } from '@/store';
import { desktop } from '@/desktop';
import { blockRemoteOpen } from '@/features/remote-guard';
import { openInBrowser } from '@/features/workbench/right-panel';
import { previewFile } from '@/features/workbench/right-panel';

/**
 * Where a link in a reply goes (spec 2026-10-24 A1). Every link in a reply is decided here: a page → the browser,
 * a file Claude made → the in-app preview, mail / tel → the system, anything else → nothing. Left to Electron, a
 * relative link resolved against the app's own address and took the whole window off the app (the mac white screen).
 */
export type LinkRoute =
  | { to: 'web'; url: string }
  | { to: 'file'; path: string; line?: number }
  | { to: 'external'; url: string }
  | { to: 'anchor' }
  | { to: 'none' };

const DRIVE = /^[a-zA-Z]:[\\/]/;

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/**
 * `#L12` / `#L12-L20` → line 12; any other `#…` and a `?…` are a web page's, not part of a file's path (review M1: they
 * stayed in it → a 「not found」 tab). Cut on the raw, still-encoded href: a `%23` is a `#` in a name.
 */
function cut(raw: string): { rest: string; line?: number } {
  const at = raw.search(/[?#]/);
  if (at < 0) return { rest: raw };
  const hash = raw.indexOf('#');
  const m = hash < 0 ? null : /^#L(\d+)(?:-L?\d+)?$/.exec(raw.slice(hash));
  return m ? { rest: raw.slice(0, at), line: Number(m[1]) } : { rest: raw.slice(0, at) };
}

/** `path:12` → line 12 (unless `line` came from a `#L12`). */
function withLine(path: string, line?: number): { path: string; line?: number } {
  if (line !== undefined) return { path, line };
  const colon = /^(.*[^:\\/]):(\d+)$/.exec(path);
  if (colon && !DRIVE.test(path.slice(-3))) return { path: colon[1], line: Number(colon[2]) };
  return { path };
}

function join(base: string, rel: string): string {
  const parts = base.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length > 1) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

function file(path: string, hashLine?: number): LinkRoute {
  const { path: p, line } = withLine(path, hashLine);
  return line === undefined ? { to: 'file', path: p } : { to: 'file', path: p, line };
}

/**
 * `//host/share`, `\\host\share`: a network path. Opening one makes Windows connect to that machine over SMB and hand
 * it the user's NTLM credentials — from one click on a link the model wrote (prompt-injectable), so they open nothing.
 */
const UNC = /^[\\/]{2}/;

/** An absolute local path (already decoded); `/C:/x` → `C:/x`. */
function local(p: string, line?: number): LinkRoute {
  if (UNC.test(p)) return { to: 'none' };
  return file(/^\/[a-zA-Z]:[\\/]/.test(p) ? p.slice(1) : p, line);
}

export function routeLink(href: string, cwd: string | undefined): LinkRoute {
  const h = href.trim();
  if (!h) return { to: 'none' };
  if (h.startsWith('#')) return { to: 'anchor' };
  // the markdown pipeline percent-encodes what it hands over (`C:\x` → `C:%5Cx`, `\\h\s` → `%5C%5Ch%5Cs`)
  const d = decode(h);
  if (UNC.test(h) || UNC.test(d)) return { to: 'none' };
  if (/^https?:/i.test(h)) return { to: 'web', url: h };
  if (/^(mailto|tel):/i.test(h)) return { to: 'external', url: h };
  if (/^file:/i.test(h)) {
    // file://host/x names another machine; only file:///x and file://localhost/x are this one
    const m = /^file:(?:\/\/([^/\\]*))?(.*)$/is.exec(h)!;
    if (m[1] && m[1].toLowerCase() !== 'localhost') return { to: 'none' };
    const c = cut(m[2]);
    return local(decode(c.rest), c.line);
  }
  if (DRIVE.test(d)) { const c = cut(h); return file(decode(c.rest), c.line); }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return { to: 'none' };
  const c = cut(h);
  if (h.startsWith('/')) return local(decode(c.rest), c.line);
  if (!cwd) return { to: 'none' };
  return file(join(cwd, decode(c.rest)), c.line);
}

export function openExternal(url: string): void {
  if (desktop) void desktop.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * Acts on a route. `sessionId`: the conversation the link is in (a remote one's files are on that machine).
 * A web page opens in the built-in browser (stage B) — in the desktop app only, with `web.browser.openLinks` not off;
 * the web version has no built-in browser that can show most sites (they refuse to be framed): a new tab there.
 * `external` (Ctrl / Cmd held): the system browser.
 */
export function followLink(r: LinkRoute, sessionId: string | null | undefined, opts: { external?: boolean } = {}): void {
  if (r.to === 'web') {
    if (!opts.external && desktop && useStore.getState().settings?.['web.browser.openLinks'] !== false) return openInBrowser(r.url);
    return openExternal(r.url);
  }
  if (r.to === 'external') return openExternal(r.url);
  if (r.to !== 'file') return;
  if (blockRemoteOpen(sessionId, r.path)) return;
  previewFile(r.path, r.line);
}
