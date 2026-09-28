import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import { childrenOf, filterSessions, filterSummary, machineCounts, renderedRows, sourceCounts } from './filter';

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

  it('query matches the title and the first prompt', () => {
    expect(ids(filterSessions(all, { ...base, query: 'LOGIN' }))).toEqual(['c1']);
    expect(ids(filterSessions(all, { ...base, query: 'parser' }))).toEqual(['c2']);
  });

  it('archived (field or meta) is hidden unless showArchived', () => {
    const hidden = ids(filterSessions(all, base));
    expect(hidden).not.toContain('opencode-x');
    expect(hidden).not.toContain('c3');
    const shown = ids(filterSessions(all, { ...base, showArchived: true }));
    expect(shown).toContain('opencode-x');
    expect(shown).toContain('c3');
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

describe('childrenOf', () => {
  it("a parent's child sessions, newest first; archived ones only when archived are shown", () => {
    const all = [s('p'), s('k1', { parentId: 'p', lastModified: 1 }), s('k2', { parentId: 'p', lastModified: 5 }), s('k3', { parentId: 'p', archived: true }), s('x', { parentId: 'q' })];
    expect(ids(childrenOf(all, 'p', { showArchived: false, meta: {} }))).toEqual(['k2', 'k1']);
    expect(ids(childrenOf(all, 'p', { showArchived: true, meta: {} }))).toContain('k3');
  });
});

describe('filterSummary: what the funnel is hiding, in words', () => {
  const names = (k: string) => ({ codex: 'Codex', claude: 'Claude Code' })[k] ?? k;
  const machineName = (id: string) => ({ b1: 'Box B', local: '本机' })[id] ?? id;
  it('nothing active → empty', () => {
    expect(filterSummary({ source: 'all', machine: 'all', query: '  ', showArchived: false }, names, machineName)).toEqual([]);
  });
  it('source, machine, archived and the text query', () => {
    expect(filterSummary({ source: 'codex', machine: 'b1', query: ' login ', showArchived: true }, names, machineName)).toEqual(['Codex', 'Box B', '含已归档', '“login”']);
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
