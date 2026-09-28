/** A palette command as far as filtering goes. */
export interface Filterable { label: string; group: string }

/** Commands a query shows at most when they only match by name (the session hits follow them). */
export const MAX_NAME_HITS = 8;

/** The same list with each group's commands together, groups in the order they first appear (a title shows once). */
export function clusterByGroup<T extends Filterable>(list: T[]): T[] {
  const order: string[] = [];
  const by = new Map<string, T[]>();
  for (const c of list) {
    if (!by.has(c.group)) { by.set(c.group, []); order.push(c.group); }
    by.get(c.group)!.push(c);
  }
  return order.flatMap((g) => by.get(g)!);
}

/**
 * The commands a query (lower-cased, without the leading `>`) shows. The palette lists `named`, then the
 * conversation hits, then `grouped`; every group title shows once.
 *  - `grouped`: every command of a group the query names (「面板」 → every panel, 「主题」 → every theme), uncut and
 *    in one block — including the ones whose label matches too: a group the query names is not split into a few name
 *    hits above the conversations and the rest below them. A group is named by 2 characters or more, or by its whole
 *    name: a single 「对」 typed on the way to 「对话」 must not bury the conversation search under two groups.
 *  - `named`: the first `MAX_NAME_HITS` other commands whose label contains the query, gathered by group.
 * No query: every command is `named` (gathered by group).
 */
export function commandHits<T extends Filterable>(cmds: T[], ql: string): { named: T[]; grouped: T[] } {
  if (!ql) return { named: clusterByGroup(cmds), grouped: [] };
  const byGroup = (c: T) => { const g = c.group.toLowerCase(); return g === ql || ([...ql].length >= 2 && g.includes(ql)); };
  const grouped = clusterByGroup(cmds.filter(byGroup));
  const named = clusterByGroup(cmds.filter((c) => !byGroup(c) && c.label.toLowerCase().includes(ql)).slice(0, MAX_NAME_HITS));
  return { named, grouped };
}
