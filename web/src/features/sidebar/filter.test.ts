import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import { filterSessions, renderedRows, sourceCounts } from './filter';

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
});
