// What the toast stack shows (ui/Toasts.tsx), as pure functions: the store's toasts plus the ones that just left it
// (they stay for their exit animation), and how far back each one sits.

export interface ToastItem { id: number; text: string; ok?: boolean }
/** `out`: gone from the store, still on screen while it leaves. */
export interface ToastEntry extends ToastItem { out?: true }

/** At most this many toasts on screen (UI refresh §6); older ones wait behind them. */
export const MAX_TOASTS = 3;

/**
 * The list on screen after the store changed: its toasts in its order, new ones at the end; one that is gone from
 * the store stays where it was, marked `out`; one whose text the store rewrote (a keyed toast, `toast(…, key)`) shows
 * the new text where it is. The same list object when nothing changed (no re-render).
 */
export function mergeToasts(prev: readonly ToastEntry[], live: readonly ToastItem[]): ToastEntry[] {
  const alive = new Map(live.map((t) => [t.id, t]));
  const seen = new Set(prev.map((t) => t.id));
  let changed = false;
  const next: ToastEntry[] = prev.map((t) => {
    if (t.out) return t;
    const now = alive.get(t.id);
    if (now && now.text === t.text && now.ok === t.ok) return t;
    changed = true;
    return now ? { ...t, text: now.text, ok: now.ok } : { ...t, out: true as const };
  });
  for (const t of live) if (!seen.has(t.id)) { next.push({ ...t }); changed = true; }
  return changed ? next : (prev as ToastEntry[]);
}

/**
 * For each entry (oldest first, as listed): how many live toasts are newer than it — 0 is the front one, each step
 * back sits higher and a little smaller — and whether it is past the `max` shown. A leaving toast does not count,
 * so the ones behind it step forward (and a hidden one appears) while it is still fading.
 */
export function stackToasts(list: readonly ToastEntry[], max = MAX_TOASTS): { depth: number; hidden: boolean }[] {
  const out: { depth: number; hidden: boolean }[] = new Array(list.length);
  let newer = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    out[i] = { depth: newer, hidden: newer >= max };
    if (!list[i].out) newer++;
  }
  return out;
}
