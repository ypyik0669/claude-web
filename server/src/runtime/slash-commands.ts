import type { SlashCommandInfo, SlashSource } from '../protocol.js';

/**
 * The engine's slash command list, made the same whichever engine reported it (no node imports: the web imports this
 * too, for rows from an older server). What the two engines send (2026-11-17, this machine, `supportedCommands()`):
 *
 * - official binary: `builtin: true` on its own commands; plugin skills as `superpowers:brainstorming` with the short
 *   name in `aliases`; user / project ones with ` (user)` / ` (project)` at the end of the description, a plugin's with
 *   `(superpowers) ` in front; MCP prompts as `rea:trace_crash (MCP)`.
 * - claude-web-engine (ccb): no `builtin` field at all — its own commands carry no marker, bundled skills end in
 *   ` (bundled)`; a plugin SKILL comes under its SKILL.md `name` alone (`brainstorming`, `(superpowers) …`), so two
 *   plugins' (or a plugin's and the user's) `brand-guidelines` were two rows of one name and only the first could be
 *   picked. Both engines run the namespaced name (`superpowers:brainstorming`), so that is the name here and the short
 *   one an alias.
 */

const MCP_SUFFIX = / \(MCP\)$/;
/** `(superpowers) …`: Claude Code's formatDescriptionWithSource for a plugin's command / skill */
const PLUGIN_PREFIX = /^\(([\w.@-]+)\) /;
/** bracketed words an engine's own description may start with (the official `agents`: 「(removed) Ask Claude …」) */
const NOT_A_PLUGIN = new Set(['removed', 'deprecated', 'beta', 'alpha', 'experimental', 'preview', 'internal', 'legacy', 'new']);
/** `… (user)`, `… (project)`, `… (project:frontend)`, `… (bundled)`, `… (managed)` … */
const SOURCE_SUFFIX = / \((user|project|local|managed|policy|bundled|plugin)(?:[,:;][^()]*)?\)$/;

const SUFFIX_SOURCE: Record<string, SlashSource> = { user: 'user', project: 'project', local: 'project', bundled: 'bundled', plugin: 'plugin', managed: 'other', policy: 'other' };

type Row = { name: string; description?: unknown; argumentHint?: unknown; argument_hint?: unknown; aliases?: unknown; builtin?: unknown; source?: unknown; owner?: unknown; kind?: unknown };
const isRow = (r: unknown): r is Row => !!r && typeof r === 'object' && typeof (r as Row).name === 'string';
const SOURCES = new Set<SlashSource>(['builtin', 'bundled', 'user', 'project', 'plugin', 'mcp', 'other']);

/** One row per name (the first wins, case-insensitive); internal names (`__remote-workflow`) left out. */
export function normalizeCommands(rows: readonly unknown[] | null | undefined): SlashCommandInfo[] {
  const list = Array.isArray(rows) ? rows.filter(isRow) : [];
  // an engine that marks its own commands: a row it does not mark and that says nothing else is not its own
  const flagged = list.some((r) => typeof r.builtin === 'boolean');
  const out: SlashCommandInfo[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    let name = r.name.trim();
    if (!name || name.startsWith('__')) continue;
    let description = typeof r.description === 'string' ? r.description : '';
    const argumentHint = typeof r.argumentHint === 'string' ? r.argumentHint : typeof r.argument_hint === 'string' ? r.argument_hint : '';
    const aliases = Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === 'string' && !!a.trim()) : [];
    let source: SlashSource;
    let owner: string | undefined;
    if (typeof r.source === 'string' && SOURCES.has(r.source as SlashSource)) {
      // already ours (a row that went through here once)
      source = r.source as SlashSource;
      if (typeof r.owner === 'string') owner = r.owner;
    } else if (r.builtin === true) {
      source = 'builtin';
    } else if (MCP_SUFFIX.test(name)) {
      source = 'mcp';
      const i = name.indexOf(':');
      if (i > 0) owner = name.slice(0, i);
    } else {
      // the suffix first: a plugin's description never ends in one, a user's may start with a bracket
      const suf = SOURCE_SUFFIX.exec(description);
      const pre0 = suf ? null : PLUGIN_PREFIX.exec(description);
      const pre = pre0 && !NOT_A_PLUGIN.has(pre0[1].toLowerCase()) ? pre0 : null;
      if (suf) {
        source = SUFFIX_SOURCE[suf[1]] ?? 'other';
        description = description.slice(0, suf.index);
      } else if (pre) {
        source = 'plugin';
        owner = pre[1];
        description = description.slice(pre[0].length);
        if (!name.includes(':')) { aliases.unshift(name); name = `${owner}:${name}`; }
      } else source = flagged ? 'other' : 'builtin';
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const al = [...new Set(aliases)].filter((a) => a.toLowerCase() !== key);
    const row: SlashCommandInfo = { name, description: description.trim(), argumentHint, source };
    if (al.length) row.aliases = al;
    if (owner) row.owner = owner;
    if (r.kind === 'skill' || r.kind === 'command') row.kind = r.kind;
    out.push(row);
  }
  return out;
}

/** What is the engine's own (the same in every folder): kept for the menu of a conversation that is not running. */
export function engineOwnRows(list: readonly SlashCommandInfo[]): SlashCommandInfo[] {
  return list.filter((c) => c.source === 'builtin' || c.source === 'bundled');
}
