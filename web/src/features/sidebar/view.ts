// The sidebar's 显示 menu (stage C3): how the list is grouped and ordered, what it shows, the user's own sections.
// Stored in meta.json (ui.sidebar.view / ui.sidebar.sections), read tolerantly. Pure.
import type { SessionMeta, SessionSummary } from '@shared';
import { projectFor } from '@/features/paths';

export type GroupBy = 'project' | 'folder' | 'date' | 'none';
export type SortBy = 'updated' | 'created' | 'name';
export type PerGroup = 5 | 10 | 'all';
export interface SidebarView { groupBy: GroupBy; sortBy: SortBy; show: { archived: boolean; perGroup: PerGroup } }
export const VIEW_KEY = 'ui.sidebar.view';
export const SECTIONS_KEY = 'ui.sidebar.sections';
export const DEFAULT_VIEW: SidebarView = { groupBy: 'project', sortBy: 'updated', show: { archived: false, perGroup: 5 } };

const GROUPS: readonly GroupBy[] = ['project', 'folder', 'date', 'none'];
const SORTS: readonly SortBy[] = ['updated', 'created', 'name'];

export function readView(raw: unknown): SidebarView {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const sh = (r.show && typeof r.show === 'object' ? r.show : {}) as Record<string, any>;
  return {
    groupBy: GROUPS.includes(r.groupBy) ? r.groupBy : DEFAULT_VIEW.groupBy,
    sortBy: SORTS.includes(r.sortBy) ? r.sortBy : DEFAULT_VIEW.sortBy,
    show: { archived: sh.archived === true, perGroup: sh.perGroup === 10 || sh.perGroup === 'all' ? sh.perGroup : 5 },
  };
}
export const perGroupLimit = (v: SidebarView): number => (v.show.perGroup === 'all' ? Infinity : v.show.perGroup);
/** The view differs from the default (the 显示 button's dot). */
export const isDefaultView = (v: SidebarView): boolean => v.groupBy === DEFAULT_VIEW.groupBy && v.sortBy === DEFAULT_VIEW.sortBy && v.show.perGroup === DEFAULT_VIEW.show.perGroup;

const titleOf = (s: SessionSummary) => (s.customTitle || s.title || '').toLocaleLowerCase();
const timeOf = (s: SessionSummary, by: SortBy) => (by === 'created' ? s.createdAt ?? s.lastModified : s.lastModified);

export function sortSessions(list: readonly SessionSummary[], by: SortBy): SessionSummary[] {
  const a = [...list];
  if (by === 'name') return a.sort((x, y) => titleOf(x).localeCompare(titleOf(y), undefined, { numeric: true }) || y.lastModified - x.lastModified);
  return a.sort((x, y) => timeOf(y, by) - timeOf(x, by));
}

export type DateBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older';
const BUCKETS: readonly DateBucket[] = ['today', 'yesterday', 'week', 'month', 'older'];
export function dateBucket(ts: number, now: number): DateBucket {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  const day = 86_400_000;
  if (ts >= today) return 'today';
  if (ts >= today - day) return 'yesterday';
  if (ts >= today - 6 * day) return 'week';
  if (ts >= today - 29 * day) return 'month';
  return 'older';
}

export interface ViewGroup { key: string; kind: 'project' | 'folder' | 'date' | 'all' | 'peer'; workspaceId?: string; cwd?: string; bucket?: DateBucket; peerId?: string; items: SessionSummary[] }

const push = <K>(m: Map<K, SessionSummary[]>, k: K, s: SessionSummary) => { const a = m.get(k); if (a) a.push(s); else m.set(k, [s]); };
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

export function groupSessions(list: readonly SessionSummary[], v: SidebarView, c: { workspaces: readonly { id: string; path: string }[]; meta: Record<string, SessionMeta>; now: number }): ViewGroup[] {
  const sorted = sortSessions(list.filter((s) => !c.meta[s.sessionId]?.pinned), v.sortBy);
  const peers = new Map<string, SessionSummary[]>();
  const local: SessionSummary[] = [];
  for (const s of sorted) { if (s.peer) push(peers, s.peer.id, s); else local.push(s); }
  const peerGroups: ViewGroup[] = [...peers].map(([id, items]) => ({ key: `peer:${id}`, kind: 'peer', peerId: id, items }));
  const cwdOf = (s: SessionSummary) => c.meta[s.sessionId]?.groupCwd ?? s.cwd ?? '';
  let out: ViewGroup[];
  if (v.groupBy === 'none') out = local.length ? [{ key: '__all', kind: 'all', items: local }] : [];
  else if (v.groupBy === 'date') {
    const m = new Map<DateBucket, SessionSummary[]>();
    for (const s of local) push(m, dateBucket(timeOf(s, v.sortBy === 'created' ? 'created' : 'updated'), c.now), s);
    out = BUCKETS.filter((b) => m.has(b)).map((b) => ({ key: `date:${b}`, kind: 'date', bucket: b, items: m.get(b)! }));
  } else {
    const byWs = new Map<string, SessionSummary[]>();
    const byCwd = new Map<string, SessionSummary[]>();
    for (const s of local) {
      const cwd = cwdOf(s);
      const w = v.groupBy === 'project' ? projectFor(cwd, c.workspaces) : undefined;
      if (w) push(byWs, w.id, s); else push(byCwd, cwd, s);
    }
    const projects: ViewGroup[] = v.groupBy === 'project' ? c.workspaces.map((w) => ({ key: w.id, kind: 'project', workspaceId: w.id, items: byWs.get(w.id) ?? [] })) : [];
    let folders: ViewGroup[] = [...byCwd].map(([cwd, items]) => ({ key: cwd || '__unknown', kind: 'folder', cwd, items }));
    if (v.sortBy === 'name') folders = folders.sort((a, b) => base(a.cwd ?? '').localeCompare(base(b.cwd ?? ''), undefined, { numeric: true }));
    out = [...projects, ...folders];
  }
  return [...out, ...peerGroups];
}

export interface CustomSection { id: string; name: string; ids: string[] }
export function readSections(raw: unknown): CustomSection[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is Record<string, any> => !!x && typeof x.id === 'string' && typeof x.name === 'string')
    .map((x) => ({ id: x.id, name: x.name, ids: Array.isArray(x.ids) ? x.ids.filter((i: unknown): i is string => typeof i === 'string') : [] }));
}
export const addSection = (l: CustomSection[], id: string, name: string): CustomSection[] => [...l, { id, name, ids: [] }];
export const renameSection = (l: CustomSection[], id: string, name: string): CustomSection[] => l.map((x) => (x.id === id ? { ...x, name } : x));
export const deleteSection = (l: CustomSection[], id: string): CustomSection[] => l.filter((x) => x.id !== id);
export const addToSection = (l: CustomSection[], id: string, sid: string): CustomSection[] => l.map((x) => (x.id === id && !x.ids.includes(sid) ? { ...x, ids: [...x.ids, sid] } : x));
export const removeFromSection = (l: CustomSection[], id: string, sid: string): CustomSection[] => l.map((x) => (x.id === id ? { ...x, ids: x.ids.filter((i) => i !== sid) } : x));
/** The multi-select bar's 加入分区 (C-U3): every picked conversation, each once. */
export const addAllToSection = (l: CustomSection[], id: string, sids: readonly string[]): CustomSection[] => sids.reduce((acc, sid) => addToSection(acc, id, sid), l);
/**
 * What is written drops the ids of conversations that are no longer there (deleted, or gone with their folder:
 * C-U4) — but never another machine's (`peer_…`: that machine may just be offline) and nothing at all while the list
 * of conversations is empty (not loaded yet).
 */
export function pruneSections(l: CustomSection[], known: ReadonlySet<string>): CustomSection[] {
  if (!known.size) return l;
  return l.map((x) => ({ ...x, ids: x.ids.filter((i) => known.has(i) || i.startsWith('peer_')) }));
}
