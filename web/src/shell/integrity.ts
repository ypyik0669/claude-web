// The shell's own files come from Cache Storage (sw.ts precaches them), and Cache Storage can be written by any script
// on this origin: the app of every paired PC runs on it too (in the frame). A tampered PC could rewrite the shell's
// cached files and keep the shell tampered until the next release. So the build writes the sha256 of every precached
// file into sw.js — the worker's own script, kept in the browser's service-worker script storage, which no page can
// write — and the worker checks a cached copy against it before serving it: a mismatch drops the copy and goes to the
// network. Network answers are not checked: the hosted site is the trust root (spec §8). Pure; sw.ts wires it.

/** Each precached file's sha256 (lower-case hex), by its path under the shell's folder; `./` is the page itself. */
export type ShellHashes = Readonly<Record<string, string>>;

/** The page itself: the shell's folder (and its index.html), one cache entry under the folder's own address. */
export const PAGE_KEY = './';

/**
 * The hash table key of a request for a shell file: its path under the scope (`assets/shell-….js`), PAGE_KEY for the
 * page, or null for anything outside the scope.
 */
export function shellKey(url: URL, scope: string, page: boolean): string | null {
  if (page) return PAGE_KEY;
  let base: URL;
  try {
    base = new URL(scope, url);
  } catch {
    return null;
  }
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
  const rest = url.pathname.slice(base.pathname.length);
  return rest ? rest : PAGE_KEY;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

export interface ShellFileSource {
  /** The request's key in `hashes` (shellKey); null or absent from the table: not one of this build's files. */
  key: string | null;
  hashes: ShellHashes;
  /** The copy in the shell's cache, if any. */
  cached: () => Promise<Response | undefined>;
  /** Removes that copy (it did not match). */
  drop: () => Promise<unknown>;
  network: () => Promise<Response>;
}

/**
 * A shell file: the cached copy when its bytes are the ones this build hashed; else (a copy that differs, none, or a
 * file the build did not precache) the network. A copy that differs is dropped first, so it is never served again.
 */
export async function verifiedShellFile(o: ShellFileSource): Promise<Response> {
  const want = o.key !== null && Object.prototype.hasOwnProperty.call(o.hashes, o.key) ? o.hashes[o.key] : undefined;
  // not a file of this build: whatever the cache holds under that address was not put there by the precache
  if (!want) return o.network();
  const hit = await o.cached();
  if (!hit) return o.network();
  let got = '';
  try {
    got = await sha256Hex(await hit.clone().arrayBuffer());
  } catch {
    // a body that cannot be read is as good as a wrong one
  }
  if (got === want) return hit;
  await o.drop().catch(() => false);
  return o.network();
}
