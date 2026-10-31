/**
 * When each turn starts (ms): its user message's time, else its first item's. A turn without a time (or one that
 * reads earlier than the turn before it) keeps the previous start, so the list never goes backwards.
 */
export function turnStarts(turns: { user?: { ts?: string }; body: { ts?: string }[] }[]): number[] {
  let prev = 0;
  return turns.map((t) => {
    const ms = Date.parse(t.user?.ts ?? t.body[0]?.ts ?? '');
    if (Number.isFinite(ms) && ms > prev) prev = ms;
    return prev;
  });
}

/**
 * Places things that aren't part of a conversation (a 值班 Bot's cards) between its turns, by time.
 * `turnStarts[i]` is when turn i starts (its first item's ts, ms). Each group goes ahead of turn `before`;
 * `before === turnStarts.length` means after the last turn. An extra at the very moment a turn starts goes
 * after that turn. When older turns aren't loaded yet (`hasOlder`), extras before the first loaded turn are
 * dropped — they belong somewhere in the part that isn't shown. Groups are in order, items in time order.
 */
export function interleave<T extends { at: number }>(turnStarts: number[], extras: T[], hasOlder: boolean): { before: number; items: T[] }[] {
  if (!extras.length) return [];
  const sorted = extras.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i).map(({ e }) => e);
  const out: { before: number; items: T[] }[] = [];
  let t = 0;
  for (const e of sorted) {
    while (t < turnStarts.length && turnStarts[t]! <= e.at) t++;
    if (t === 0 && hasOlder && turnStarts.length) continue;
    const last = out[out.length - 1];
    if (last && last.before === t) last.items.push(e);
    else out.push({ before: t, items: [e] });
  }
  return out;
}
