/** A palette command as far as filtering goes. */
export interface Filterable { label: string; group: string }

/** Commands a query shows at most when they only match by name (the session hits follow them). */
export const MAX_NAME_HITS = 8;

/**
 * The commands a query (lower-cased, without the leading `>`) shows, in their own order.
 *  - `named`: the first `MAX_NAME_HITS` whose label contains the query — listed first, as before;
 *  - `grouped`: the rest of a group the query names (「面板」 → every panel, 「主题」 → every theme), uncut, listed
 *    after the conversation hits. A group is named by 2 characters or more, or by its whole name: a single 「对」
 *    typed on the way to 「对话」 must not bury the conversation search under two groups of commands.
 * No query: every command is `named`.
 */
export function commandHits<T extends Filterable>(cmds: T[], ql: string): { named: T[]; grouped: T[] } {
  if (!ql) return { named: cmds, grouped: [] };
  const named = cmds.filter((c) => c.label.toLowerCase().includes(ql)).slice(0, MAX_NAME_HITS);
  const byGroup = (c: T) => { const g = c.group.toLowerCase(); return g === ql || ([...ql].length >= 2 && g.includes(ql)); };
  const grouped = cmds.filter((c) => !named.includes(c) && byGroup(c));
  return { named, grouped };
}
