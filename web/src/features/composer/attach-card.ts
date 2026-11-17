// 附件卡片 (2026-11-17): what a file / folder card over the composer's text says (AttachmentCard.tsx draws it).

/** A file card's type label: its extension in capitals (MD, PDF, XLSX); '' when it has none worth showing. */
export function extLabel(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0) return ''; // no dot, or a dotfile (.env, .gitignore)
  const ext = name.slice(i + 1);
  return /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : '';
}

/** How wide text is in half-width columns: CJK and other full-width characters count two. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u.test(ch) ? 2 : 1;
  return w;
}

/**
 * A path for a card's two lines: whole when it fits `max` columns, else its root, `…`, and as many of its last parts
 * as fit — the end (the folder's / file's own name) is what tells two apart; the card's hover shows the whole path.
 */
export function shortPath(p: string, max = 44): string {
  if (textWidth(p) <= max) return p;
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(/[\\/]/);
  if (parts.length < 3) return p;
  const head = parts[0] + sep; // `C:\`, or `/` for a POSIX path
  let tail = parts[parts.length - 1];
  for (let i = parts.length - 2; i > 0; i--) {
    const next = parts[i] + sep + tail;
    if (textWidth(head) + 2 + textWidth(next) > max) break;
    tail = next;
  }
  const out = `${head}…${sep}${tail}`;
  return out.length < p.length ? out : p;
}
