// 深链接 in the page (2026-11-27, issue #18): a `claude-web://new?folder=…&q=…` or `claude-web://session/<id>` link in a
// reply opens here, the same way one from the system does (App.tsx) — not handed to the system, which would only send
// it back to this app (and the web version has no system handler at all). The rules are desktop/src/deep-link.ts's
// parseDeepLink, kept in step by deep-link.test.ts: a link in a reply is the model's words, as untrusted as one on any
// web page. A new conversation is only filled in, never sent.
// Tests that import link-route.ts mock the socket, the commands and the composer (the socket needs `location`).
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { runCommand } from '@/features/workbench/commands';
import { fillComposer } from '@/features/composer/fill';
import type { FsStat } from '@shared';

export const SCHEME = 'claude-web';
const MAX_Q = 10_000;

export type AppLink =
  | { kind: 'new'; folder?: string; q?: string; peer?: string }
  | { kind: 'session'; id: string };

/**
 * A folder a link may name: an absolute path on a local disk. Never a network path (`\\host\share`, `//host/share`):
 * only asking whether one exists makes Windows log in to that host over SMB and hand it the user's NTLM hash.
 */
export function localFolder(p: string): boolean {
  if (p.length >= 4096 || /[\0\r\n]/.test(p)) return false;
  if (/^[\\/]{2}/.test(p)) return false;
  return /^[a-zA-Z]:[\\/]/.test(p) || (p.startsWith('/') && !p.startsWith('//'));
}

/** A `claude-web:` link, checked (desktop parseDeepLink's rules; whether the folder exists is openAppLink's to ask). */
export function parseAppLink(raw: string): AppLink | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== `${SCHEME}:`) return null;
  // claude-web://new?… parses with `new` as the host; claude-web:new?… as the path
  const route = (u.host || u.pathname.replace(/^\/+/, '').split('/')[0]).toLowerCase();
  const rest = u.host ? u.pathname.replace(/^\/+/, '') : u.pathname.replace(/^\/+/, '').split('/').slice(1).join('/');
  if (route === 'session') {
    let id: string;
    try { id = decodeURIComponent(rest); } catch { return null; }
    return /^[\w~.-]{1,200}$/.test(id) ? { kind: 'session', id } : null;
  }
  if (route !== 'new') return null;
  const out: AppLink = { kind: 'new' };
  const folder = u.searchParams.get('folder');
  if (folder && localFolder(folder)) out.folder = folder;
  const q = u.searchParams.get('q');
  if (q) out.q = q.slice(0, MAX_Q);
  const peer = u.searchParams.get('peer');
  if (peer && /^[\w.-]{1,100}$/.test(peer)) out.peer = peer;
  return out;
}

/** Whether a folder is there (a folder that is not is dropped, as the desktop shell does before handing a link over). */
async function isDir(p: string): Promise<boolean> {
  const st = await ws.request<FsStat | null>({ kind: 'fs.stat', path: p }).catch(() => null);
  return !!st?.dir;
}

/**
 * Opens a link: a conversation by id, or the new-conversation page filled in (folder, text — never sent).
 * `checked`: the folder was already checked (the desktop shell does it for a link from the system).
 */
export async function openAppLink(l: AppLink, checked = false): Promise<void> {
  const st = useStore.getState();
  if (l.kind === 'session') { if (st.open[l.id]) st.setActive(l.id); else void st.loadHistory(l.id); return; }
  const folder = l.folder && (checked || (await isDir(l.folder))) ? l.folder : undefined;
  runCommand('new');
  requestAnimationFrame(() => fillComposer({ cwd: folder, text: l.q, focus: true }));
}
