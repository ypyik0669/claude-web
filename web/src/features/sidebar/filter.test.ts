import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import { families, filterSessions, filterSummary, machineCounts, renderedRows, sourceCounts } from './filter';

const s = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: id, cwd: '/w', lastModified: 0, ...o });

const all: SessionSummary[] = [
  s('c1', { title: 'fix login bug' }),
  s('c2', { title: 'untitled', firstPrompt: 'refactor the parser' }),
  s('codex-a', { agent: 'codex', title: 'codex work' }),
  s('codex-b', { agent: 'codex', title: 'codex child', parentId: 'codex-a' }),
  s('opencode-x', { agent: 'opencode', title: 'oc', archived: true }),
  s('c3', { title: 'archived in meta' }),
];
const base = { source: 'all' as const, query: '', showArchived: false, meta: { c3: { archived: true } } };
const ids = (arr: SessionSummary[]) => arr.map((x) => x.sessionId);

describe('filterSessions', () => {
  it('drops items that have a parentId (children are folded into their parent)', () => {
    expect(ids(filterSessions(all, { ...base, showArchived: true }))).not.toContain('codex-b');
  });

  it("source 'codex' keeps only codex sessions", () => {
    expect(ids(filterSessions(all, { ...base, source: 'codex' }))).toEqual(['codex-a']);
  });

  it("an item without `agent` counts as claude", () => {
    expect(ids(filterSessions(all, { ...base, source: 'claude' }))).toEqual(['c1', 'c2']);
  });

  it('query matches the title and the folder name — not the first prompt or the path above the folder', () => {
    expect(ids(filterSessions(all, { ...base, query: 'LOGIN' }))).toEqual(['c1']);
    expect(ids(filterSessions(all, { ...base, query: 'parser' }))).toEqual([]);
    const paths = [s('p1', { cwd: 'D:\\测试\\game' }), s('p2', { cwd: 'D:\\work\\测试新游戏\\' })];
    expect(ids(filterSessions(paths, { ...base, query: '测试' }))).toEqual(['p2']);
    expect(ids(filterSessions(paths, { ...base, query: 'game' }))).toEqual(['p1']);
  });

  it('archived (field or meta) is hidden unless showArchived', () => {
    const hidden = ids(filterSessions(all, base));
    expect(hidden).not.toContain('opencode-x');
    expect(hidden).not.toContain('c3');
    const shown = ids(filterSessions(all, { ...base, showArchived: true }));
    expect(shown).toContain('opencode-x');
    expect(shown).toContain('c3');
  });
  it('otherAgents off hides other agents’ conversations unless a source is picked', () => {
    const all = [{ sessionId: 'c', title: 'c', cwd: '', lastModified: 0 }, { sessionId: 'x', title: 'x', cwd: '', lastModified: 0, agent: 'codex' }] as any;
    expect(filterSessions(all, { source: 'all', query: '', showArchived: false, meta: {}, otherAgents: false }).map((s) => s.sessionId)).toEqual(['c']);
    expect(filterSessions(all, { source: 'codex', query: '', showArchived: false, meta: {}, otherAgents: false }).map((s) => s.sessionId)).toEqual(['x']);
  });
});

describe('sourceCounts', () => {
  it('counts per agent kind and never counts child items', () => {
    const c = sourceCounts(all);
    expect(c.codex).toBe(1);
    expect(c.claude).toBe(3);
    expect(c.opencode).toBe(1);
  });
});

describe('renderedRows', () => {
  const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => s(`${p}${i}`));
  it('covers only expanded groups, each cut at its page limit', () => {
    const rows = renderedRows([
      { key: 'a', items: many('a', 30), collapsed: false },
      { key: 'b', items: many('b', 5), collapsed: true },
      { key: 'c', items: many('c', 80), collapsed: false },
    ], { c: 75 }, 25);
    expect(rows.length).toBe(25 + 75);
    expect(rows.some((r) => r.sessionId.startsWith('b'))).toBe(false);
    expect(rows.map((r) => r.sessionId)).not.toContain('a25');
  });

  it('a session shown in two groups (pinned + workspace) counts once', () => {
    const x = s('x');
    expect(renderedRows([{ key: 'p', items: [x], collapsed: false }, { key: 'w', items: [x], collapsed: false }], {}).length).toBe(1);
  });

  it('rows kept in view beyond the cut (active / running) are on screen too', () => {
    const rows = renderedRows([{ key: 'a', items: many('a', 12), collapsed: false }], {}, 5, { keep: (x) => x.sessionId === 'a9' });
    expect(rows.map((r) => r.sessionId)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a9']);
  });

  it('an expanded parent brings its children, right after it', () => {
    const kids: Record<string, SessionSummary[]> = { a1: [s('k1', { parentId: 'a1' }), s('k2', { parentId: 'a1' })] };
    const rows = renderedRows([{ key: 'a', items: many('a', 3), collapsed: false }], {}, 5, { kids: (x) => kids[x.sessionId] ?? [] });
    expect(rows.map((r) => r.sessionId)).toEqual(['a0', 'a1', 'k1', 'k2', 'a2']);
  });
});

describe('families: forks and side conversations one level under their root (redesign 2026-11 stage 3)', () => {
  const f = (meta: Record<string, object> = {}, extra: Partial<typeof base> = {}) => ({ ...base, meta, ...extra });
  const fam = (all: SessionSummary[], o: ReturnType<typeof f>) => families(all, filterSessions(all, o), o);
  it("a parent's child sessions, newest first; archived ones only when archived are shown", () => {
    const all = [s('p'), s('k1', { parentId: 'p', lastModified: 1 }), s('k2', { parentId: 'p', lastModified: 5 }), s('k3', { parentId: 'p', archived: true }), s('x', { parentId: 'q' })];
    expect(ids(fam(all, f()).kids.get('p') ?? [])).toEqual(['k2', 'k1']);
    expect(ids(fam(all, f({}, { showArchived: true })).kids.get('p') ?? [])).toContain('k3');
    // an orphan child (its parent is not listed) is nobody's kid — and never a row of its own (filterSessions)
    expect(fam(all, f()).rootOf.has('x')).toBe(false);
  });
  it('a sub-agent of a sub-agent sits under the root, one level in', () => {
    const all = [s('r'), s('a', { parentId: 'r', lastModified: 2 }), s('b', { parentId: 'a', lastModified: 3 })];
    const out = fam(all, f());
    expect(ids(out.kids.get('r') ?? [])).toEqual(['b', 'a']);
    expect(out.rootOf.get('b')).toBe('r');
  });
  it('a Claude conversation forked here: under the conversation its cache key names (a fork of a fork: the root)', () => {
    const all = [s('root'), s('fork1', { lastModified: 4 }), s('fork2', { lastModified: 6 }), s('alone')];
    const out = fam(all, f({ fork1: { cacheKey: 'root' }, fork2: { cacheKey: 'root' }, alone: { cacheKey: 'alone' } }));
    expect(ids(out.kids.get('root') ?? [])).toEqual(['fork2', 'fork1']);
    expect(out.rootOf.has('alone')).toBe(false); // its own key: not a fork
  });
  it('a fork whose root is filtered out stays a row of its own; a pinned fork stays in 置顶', () => {
    const all = [s('root', { title: 'zzz' }), s('fork', { title: 'login fix' })];
    const q = f({ fork: { cacheKey: 'root' } }, { query: 'login' });
    expect(fam(all, q).rootOf.has('fork')).toBe(false);
    expect(fam(all, f({ fork: { cacheKey: 'root', pinned: true } })).rootOf.has('fork')).toBe(false);
  });
  it('a kid must pass the filter itself (an archived fork under a listed root is hidden)', () => {
    const all = [s('root'), s('fork', { archived: true })];
    expect(fam(all, f({ fork: { cacheKey: 'root' } })).kids.has('root')).toBe(false);
  });
  it('a cycle stops where it started', () => {
    const all = [s('a', { parentId: 'b' }), s('b', { parentId: 'a' }), s('c')];
    expect(() => fam(all, f())).not.toThrow();
  });
});

describe('filterSummary: what the funnel is hiding, in words', () => {
  const names = (k: string) => ({ codex: 'Codex', claude: 'Claude Code' })[k] ?? k;
  const machineName = (id: string) => ({ b1: 'Box B', local: '本机' })[id] ?? id;
  it('nothing active → empty', () => {
    expect(filterSummary({ source: 'all', machine: 'all', query: '  ' }, names, machineName)).toEqual([]);
  });
  it('source, machine and the text query', () => {
    expect(filterSummary({ source: 'codex', machine: 'b1', query: ' login ' }, names, machineName)).toEqual(['Codex', 'Box B', '“login”']);
  });
  it('showing archived conversations is not a filter (it hides nothing)', () => {
    // the Sidebar passes its whole filter state; the archive toggle must not count as narrowing the list
    const withArchive = { source: 'all' as const, machine: 'all', query: '', showArchived: true };
    expect(filterSummary(withArchive, names, machineName)).toEqual([]);
  });
});

describe('machine dimension (federation)', () => {
  const peerB = { id: 'b1', name: 'Box B' };
  const mixed: SessionSummary[] = [
    s('c1'),
    s('peer_b1~x', { peer: peerB, title: 'remote one' }),
    s('peer_b1~y', { peer: peerB, agent: 'codex' }),
    s('peer_c2~z', { peer: { id: 'c2', name: 'Box C', offline: true } }),
    s('peer_b1~kid', { peer: peerB, parentId: 'peer_b1~x' }),
  ];
  const mbase = { ...base, meta: {} };

  it("machine 'local' keeps this machine's sessions only; a peer id keeps that machine's", () => {
    expect(ids(filterSessions(mixed, { ...mbase, machine: 'local' }))).toEqual(['c1']);
    expect(ids(filterSessions(mixed, { ...mbase, machine: 'b1' }))).toEqual(['peer_b1~x', 'peer_b1~y']);
    expect(ids(filterSessions(mixed, { ...mbase, machine: 'all' }))).toHaveLength(4);
    expect(ids(filterSessions(mixed, mbase))).toHaveLength(4);
  });

  it('source and machine combine', () => {
    expect(ids(filterSessions(mixed, { ...mbase, machine: 'b1', source: 'codex' }))).toEqual(['peer_b1~y']);
  });

  it('machineCounts: local + one entry per machine, with its name and offline flag; children excluded', () => {
    expect(machineCounts(mixed)).toEqual([
      { id: 'local', name: '本机', n: 1 },
      { id: 'b1', name: 'Box B', n: 2 },
      { id: 'c2', name: 'Box C', n: 1, offline: true },
    ]);
    expect(machineCounts([s('a')])).toEqual([{ id: 'local', name: '本机', n: 1 }]);
  });
});
