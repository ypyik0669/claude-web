/** A palette command as far as filtering goes. */
export interface Filterable { label: string; group: string }

/** Commands a query shows at most when they only match by name (the session hits follow them). */
export const MAX_NAME_HITS = 8;

/**
 * The commands a query (lower-cased, without the leading `>`) shows, in their own order. No query: all of them.
 * Commands of a group the query names (「面板」, 「主题」, 「当前对话」…) all stay — searching 「面板」 lists every panel,
 * not the first five; commands that only match by name are cut to the first `MAX_NAME_HITS`.
 */
export function commandHits<T extends Filterable>(cmds: T[], ql: string): T[] {
  if (!ql) return cmds;
  let named = 0;
  return cmds.filter((c) => c.group.toLowerCase().includes(ql) || (c.label.toLowerCase().includes(ql) && named++ < MAX_NAME_HITS));
}
