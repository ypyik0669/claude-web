// Path helpers for feature panels. Paths come from the server verbatim, so they are Windows-style
// (`C:\a\b`) on Windows and POSIX (`/a/b`) on macOS / Linux — never assume one separator.

/** Append `name` to `dir` using the separator `dir` already uses (`/` when it has none). */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name.replace(/^[\\/]+/, '');
}

const norm = (p: string, caseless: boolean) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return caseless ? s.toLowerCase() : s;
};

/**
 * Is `child` the same directory as `parent` or somewhere below it? Separator-agnostic and bounded
 * at a path segment (`/proj/app` does not contain `/proj/app2`). Case-insensitive only for
 * Windows-looking paths (drive letter or UNC), since macOS / Linux paths can differ only in case.
 */
export function isWithin(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const caseless = /^[A-Za-z]:|^\\\\/.test(parent) || /^[A-Za-z]:|^\\\\/.test(child);
  const c = norm(child, caseless);
  const p = norm(parent, caseless);
  if (!p) return c.startsWith('/'); // parent was the filesystem root
  return c === p || c.startsWith(p + '/');
}

/** The same directory (separators, a trailing slash and — for Windows paths — case aside). */
export const samePath = (a: string, b: string) => isWithin(a, b) && isWithin(b, a);

/**
 * The project a conversation in `cwd` is listed under: the one whose folder it ran in — not one of its parent folders
 * (user report: with the home folder as a project, every conversation in a folder under it was listed there, where
 * Claude's own app lists each folder on its own). Conversations in a subfolder are that folder's.
 */
export function projectFor<W extends { path: string }>(cwd: string, workspaces: readonly W[]): W | undefined {
  return cwd ? workspaces.find((w) => samePath(cwd, w.path)) : undefined;
}

/** The folders a conversation in `cwd` works in: its own, then — in a project's folder — the project's extra folders (stage C2). */
export function projectRoots(cwd: string, workspaces: readonly { path: string; folders?: string[] }[]): string[] {
  if (!cwd) return [];
  const w = projectFor(cwd, workspaces);
  return [cwd, ...(w?.folders ?? []).filter((f) => !samePath(f, cwd))];
}

/**
 * The folder `p` is in, in `p`'s own separators; a root (`C:\`, `/`, `\\host\share`) is its own parent, '' gives ''.
 * As a folder dialog's start (ui/pick-folder.ts) it lists `p` among the folders beside it: a sibling of `p` is one
 * click away, `p` itself and its subfolders one more.
 */
export function parentDir(p: string): string {
  const s = p.trim();
  const root = /^(?:[A-Za-z]:[\\/]?|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?|[\\/])/.exec(s)?.[0] ?? '';
  const rest = s.slice(root.length).replace(/[\\/]+$/, '');
  const cut = Math.max(rest.lastIndexOf('/'), rest.lastIndexOf('\\'));
  return cut < 0 ? root : root + rest.slice(0, cut).replace(/[\\/]+$/, '');
}

/**
 * Where an uploaded folder attachment lives on disk. The server stores `<root>/<rel>` (rel with its
 * separators normalised to the platform's), so the folder is `dest` minus the rel suffix plus the
 * folder's own top-level name. Falls back to the last `/<top>/` segment if the suffix does not match.
 */
export function attachmentFolderPath(dest: string, rel: string, top: string): string {
  const cleanRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const d = dest.replace(/\\/g, '/');
  if (cleanRel && d.endsWith('/' + cleanRel)) return dest.slice(0, dest.length - cleanRel.length) + top;
  const i = d.lastIndexOf('/' + top + '/');
  return i >= 0 ? dest.slice(0, i + 1 + top.length) : dest;
}
