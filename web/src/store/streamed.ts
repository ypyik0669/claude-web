// What changed between two snapshots of an open session (pure; the store's hooks use it — store/index.ts).

/** The two counters a streamed frame moves (`renderStreamed`); a whole message or any other change bumps `version` alone. */
interface Versioned { version: number; streamed?: number }

/**
 * prev → next was nothing but frames of streamed deltas: only `version` / `streamed` moved, and by the same amount,
 * every other top-level field is the same reference. Whatever does not draw the streaming text has nothing new to show.
 */
export function onlyStreamed<T extends Versioned>(a: T | undefined, b: T | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const dv = b.version - a.version;
  if (dv <= 0 || dv !== (b.streamed ?? 0) - (a.streamed ?? 0)) return false;
  for (const k in b) if (k !== 'version' && k !== 'streamed' && (a as any)[k] !== (b as any)[k]) return false;
  for (const k in a) if (!(k in b)) return false;
  return true;
}

/** `version - streamed`: moves for whole messages and other changes, not for streamed frames. -1 for none. */
export const settledVersion = (o: Versioned | undefined): number => (o ? o.version - (o.streamed ?? 0) : -1);
