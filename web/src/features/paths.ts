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
