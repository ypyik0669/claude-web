import type { SlashCommandInfo } from '@shared';
import { normalizeCommands } from '../../../../server/src/runtime/slash-commands';

/**
 * The / menu (Composer): which commands, in which group, in which order, and what of each name matched. Pure — the
 * component is SlashMenu.tsx. Where the list comes from and why it used to miss skills: docs/notes/chat-input.md
 * 「斜杠菜单」.
 */

export type SlashGroupId = 'commands' | 'skills' | 'other';
export const GROUP_ORDER: readonly SlashGroupId[] = ['commands', 'skills', 'other'];

export interface SlashItem {
  cmd: SlashCommandInfo;
  group: SlashGroupId;
  /** 0 the name (or the part after `plugin:`, or an alias) starts with the query · 1 a word in it does · 2 anywhere */
  tier: number;
  /** what of the name matched, [start, end); null: only an alias matched */
  hit: [number, number] | null;
  /** the alias that matched when the name did not, and what of it */
  alias?: string;
  aliasHit?: [number, number];
}
export interface SlashGroup { id: SlashGroupId; items: SlashItem[] }
export interface SlashMenuModel { groups: SlashGroup[]; flat: SlashItem[] }
export const NO_MENU: SlashMenuModel = { groups: [], flat: [] };

/** Claude Code's own and ours → 命令; a skill of the user / project / a plugin → 技能; the rest (custom commands, MCP prompts, mods) → 其它. */
export function groupOf(c: SlashCommandInfo): SlashGroupId {
  switch (c.source) {
    case 'builtin': case 'bundled': case undefined: return 'commands';
    case 'user': case 'project': case 'plugin': return c.kind === 'command' ? 'other' : 'skills';
    default: return 'other';
  }
}

/**
 * The rows to offer: the running process's own list when it has one (it knows what it can run), else the disk's
 * (`slash.list`: the process is not running, or still starting); ours first. The disk's rows also say which of the
 * process's user / project / plugin rows are commands rather than skills (the process does not say).
 */
export function buildCommands(engine: readonly SlashCommandInfo[] | undefined, disk: readonly SlashCommandInfo[] | undefined, own: readonly SlashCommandInfo[]): SlashCommandInfo[] {
  const base = engine?.length ? normalizeCommands(engine) : disk?.length ? normalizeCommands(disk) : [];
  const kinds = new Map<string, 'skill' | 'command'>();
  if (engine?.length) for (const d of disk ?? []) if (d.kind) for (const n of [d.name, ...(d.aliases ?? [])]) kinds.set(n.toLowerCase(), d.kind);
  const ownNames = new Set(own.map((c) => c.name.toLowerCase()));
  const rest = base.filter((c) => !ownNames.has(c.name.toLowerCase())).map((c) => {
    if (c.kind || !(c.source === 'user' || c.source === 'project' || c.source === 'plugin')) return c;
    const k = kinds.get(c.name.toLowerCase());
    return k ? { ...c, kind: k } : c;
  });
  return [...own, ...rest];
}

const WORD = /[-_:/. ]/;

/** How `q` (lower case) matches one command; null: not at all. */
export function matchCommand(c: SlashCommandInfo, q: string): Omit<SlashItem, 'cmd' | 'group'> | null {
  if (!q) return { tier: 0, hit: null };
  const n = c.name.toLowerCase();
  const colon = n.lastIndexOf(':');
  if (n.startsWith(q)) return { tier: 0, hit: [0, q.length] };
  if (colon >= 0 && n.startsWith(q, colon + 1)) return { tier: 0, hit: [colon + 1, colon + 1 + q.length] };
  const alias = c.aliases?.find((a) => a.toLowerCase().startsWith(q));
  if (alias) return { tier: 0, hit: null, alias, aliasHit: [0, q.length] };
  let first = -1;
  for (let i = n.indexOf(q); i >= 0; i = n.indexOf(q, i + 1)) {
    if (first < 0) first = i;
    if (i > 0 && WORD.test(n[i - 1])) return { tier: 1, hit: [i, i + q.length] };
  }
  if (first >= 0) return { tier: 2, hit: [first, first + q.length] };
  const inAlias = c.aliases?.find((a) => a.toLowerCase().includes(q));
  if (!inAlias) return null;
  const at = inAlias.toLowerCase().indexOf(q);
  return { tier: 2, hit: null, alias: inAlias, aliasHit: [at, at + q.length] };
}

const byName = (a: SlashItem, b: SlashItem) => a.tier - b.tier || (a.cmd.name.toLowerCase() < b.cmd.name.toLowerCase() ? -1 : a.cmd.name.toLowerCase() > b.cmd.name.toLowerCase() ? 1 : 0);

/** The menu for `/query`: the groups in their order (an empty one left out), each sorted by how well it matched, then by name. */
export function slashMenu(commands: readonly SlashCommandInfo[], query: string): SlashMenuModel {
  const q = query.toLowerCase();
  const buckets = new Map<SlashGroupId, SlashItem[]>();
  for (const cmd of commands) {
    const m = matchCommand(cmd, q);
    if (!m) continue;
    const group = groupOf(cmd);
    const list = buckets.get(group) ?? [];
    list.push({ cmd, group, ...m });
    buckets.set(group, list);
  }
  const groups = GROUP_ORDER.filter((g) => buckets.get(g)?.length).map((id) => ({ id, items: buckets.get(id)!.sort(byName) }));
  return { groups, flat: groups.flatMap((g) => g.items) };
}

/** The name in pieces for drawing: the matched part marked. */
export function nameParts(name: string, hit: [number, number] | null): { text: string; hit: boolean }[] {
  if (!hit || hit[1] <= hit[0]) return [{ text: name, hit: false }];
  return [{ text: name.slice(0, hit[0]), hit: false }, { text: name.slice(hit[0], hit[1]), hit: true }, { text: name.slice(hit[1]), hit: false }].filter((p) => p.text);
}

/** Enter with this row selected sends the box as it is when what is typed already names it (`/compact` + Enter runs it). */
export function typedExactly(text: string, item: SlashItem | undefined): boolean {
  if (!item || !text.startsWith('/')) return false;
  const t = text.slice(1).toLowerCase();
  return t === item.cmd.name.toLowerCase() || !!item.cmd.aliases?.some((a) => a.toLowerCase() === t);
}
