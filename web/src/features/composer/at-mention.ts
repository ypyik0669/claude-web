// @ file completion (spec 2026-10-16 chat-input §4): the `@word` the caret is in, and what picking a file writes.

/** The `@…` being typed just before the caret (at the start or after a space), or null. */
export function atQueryAt(text: string, caret: number): { start: number; q: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@"]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, q: m[2] };
}

/** 添加到对话: `text` with `@path ` added at the end — relative to `cwd` when inside it, quoted when it has spaces. */
export function mentionText(text: string, file: string, cwd?: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(file), base = cwd ? norm(cwd) : '';
  const rel = base && f.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? f.slice(base.length + 1) : f;
  const ref = /\s/.test(rel) ? `@"${rel}" ` : `@${rel} `;
  return !text ? ref : /\s$/.test(text) ? text + ref : `${text} ${ref}`;
}

/** The text with the `@query` replaced by the picked path (quoted when it has spaces), and where the caret goes. */
export function pickAt(text: string, at: { start: number; q: string }, file: string): { text: string; caret: number } {
  const ref = /\s/.test(file) ? `@"${file}" ` : `@${file} `;
  const end = at.start + 1 + at.q.length;
  return { text: text.slice(0, at.start) + ref + text.slice(end), caret: at.start + ref.length };
}
