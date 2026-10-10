// The numbers of a turn's summary line counting up from 0 when the turn ends in view (UI refresh §6: 520 ms, ease-out,
// tabular digits). Pure: the line is ChatView.tsx (`SumLine`). At rest the text is the summary's own string, untouched.

export const COUNT_UP_MS = 520;

/** A piece of a line: text as it is, or a whole number (`s`: as written) that counts up. */
export type CountPart = { text: string } | { to: number; s: string };

/** 「已处理 1 分 42 秒」 → 「已处理 」 · 1 · 「 分 」 · 42 · 「 秒」. Joined back, the parts are the text. */
export function splitNumbers(text: string): CountPart[] {
  const out: CountPart[] = [];
  let at = 0;
  for (const m of text.matchAll(/\d+/g)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ to: Number(m[0]), s: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

const easeOutCubic = (p: number): number => 1 - (1 - p) ** 3;

/**
 * What a number shows at progress `p` (0 → 1 over `COUNT_UP_MS`): 0 at the start, the number itself — as it was
 * written — from the end on, never more than it on the way.
 */
export function countAt(part: { to: number; s: string }, p: number): string {
  if (!(p < 1)) return part.s;
  if (!(p > 0)) return '0';
  return String(Math.min(part.to, Math.round(part.to * easeOutCubic(p))));
}

/** The line at progress `p`: at 1 (and after) exactly the text it was split from. */
export const countText = (parts: CountPart[], p: number): string => parts.map((x) => ('text' in x ? x.text : countAt(x, p))).join('');
