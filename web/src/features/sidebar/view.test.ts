import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@shared';
import { addAllToSection, addSection, addToSection, pruneSections, dateBucket, DEFAULT_VIEW, deleteSection, groupSessions, perGroupLimit, readSections, readView, removeFromSection, renameSection, sortSessions } from './view';

const s = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: id, title: id, cwd: 'C:\\a', lastModified: 0, ...o });
const now = new Date(2026, 9, 24, 15, 0).getTime();
const at = (d: number, h = 12) => new Date(2026, 9, d, h).getTime();

describe('readView', () => {
  it('defaults for nothing / junk, keeps what is valid', () => {
    expect(readView(undefined)).toEqual(DEFAULT_VIEW);
    expect(readView({ groupBy: 'zzz', sortBy: 'name', show: { archived: true, perGroup: 10, otherAgents: false } })).toEqual({ groupBy: 'project', sortBy: 'name', show: { archived: true, perGroup: 10 } });
    expect(readView({ show: { perGroup: 7 } }).show.perGroup).toBe(5);
  });
  it('perGroupLimit', () => {
    expect(perGroupLimit(DEFAULT_VIEW)).toBe(5);
    expect(perGroupLimit({ ...DEFAULT_VIEW, show: { ...DEFAULT_VIEW.show, perGroup: 'all' } })).toBe(Infinity);
  });
});

describe('sortSessions', () => {
  const list = [s('b', { title: 'Beta', lastModified: 3, createdAt: 1 }), s('a', { title: 'alpha', lastModified: 1, createdAt: 3 }), s('c', { title: 'Gamma', lastModified: 2 })];
  it('updated: newest first', () => expect(sortSessions(list, 'updated').map((x) => x.sessionId)).toEqual(['b', 'c', 'a']));
  it('created: newest first, no createdAt → lastModified', () => expect(sortSessions(list, 'created').map((x) => x.sessionId)).toEqual(['a', 'c', 'b']));
  it('name: case-insensitive', () => expect(sortSessions(list, 'name').map((x) => x.sessionId)).toEqual(['a', 'b', 'c']));
  it('does not touch the input', () => { sortSessions(list, 'name'); expect(list[0].sessionId).toBe('b'); });
});

describe('dateBucket', () => {
  it('today / yesterday / this week / this month / older, by local calendar days', () => {
    expect(dateBucket(at(24, 1), now)).toBe('today');
    expect(dateBucket(at(23, 23), now)).toBe('yesterday');
    expect(dateBucket(at(19), now)).toBe('week');
    expect(dateBucket(at(1), now)).toBe('month');
    expect(dateBucket(new Date(2026, 7, 1).getTime(), now)).toBe('older');
  });
});

describe('groupSessions', () => {
  const workspaces = [{ id: 'w1', path: 'C:\\proj' }];
  const list = [
    s('p1', { cwd: 'C:\\proj', lastModified: at(24) }),
    s('f1', { cwd: 'C:\\x', lastModified: at(23) }),
    s('f2', { cwd: 'C:\\y', lastModified: at(10) }),
    s('pin', { cwd: 'C:\\x', lastModified: at(24, 14) }),
    s('r1', { cwd: '/srv', lastModified: at(24), peer: { id: 'box', name: 'Box' } as any }),
  ];
  const meta = { pin: { pinned: true } };
  const g = (v = DEFAULT_VIEW) => groupSessions(list, v, { workspaces, meta, now });
  it('project: every project (even empty), then folders newest first, then other machines; pinned left out', () => {
    expect(g().map((x) => [x.kind, x.key, x.items.map((i) => i.sessionId)])).toEqual([
      ['project', 'w1', ['p1']], ['folder', 'C:\\x', ['f1']], ['folder', 'C:\\y', ['f2']], ['peer', 'peer:box', ['r1']],
    ]);
  });
  it('folder: every folder its own group, the project folder too', () => {
    expect(g({ ...DEFAULT_VIEW, groupBy: 'folder' }).map((x) => x.key)).toEqual(['C:\\proj', 'C:\\x', 'C:\\y', 'peer:box']);
  });
  it('date: buckets in order, only the ones with conversations', () => {
    expect(g({ ...DEFAULT_VIEW, groupBy: 'date' }).map((x) => [x.key, x.items.map((i) => i.sessionId)])).toEqual([
      ['date:today', ['p1']], ['date:yesterday', ['f1']], ['date:month', ['f2']], ['peer:box', ['r1']],
    ]);
  });
  it('none: one list in the chosen order', () => {
    expect(g({ ...DEFAULT_VIEW, groupBy: 'none', sortBy: 'name' }).map((x) => [x.key, x.items.map((i) => i.sessionId)])).toEqual([['__all', ['f1', 'f2', 'p1']], ['peer:box', ['r1']]]);
  });
  it('orchestration worktrees group under their run (meta.groupCwd)', () => {
    const r = groupSessions([s('wt', { cwd: 'C:\\tmp\\wt' })], DEFAULT_VIEW, { workspaces, meta: { wt: { groupCwd: 'C:\\proj' } }, now });
    expect(r[0]).toMatchObject({ kind: 'project', key: 'w1' });
  });
});

describe('custom sections', () => {
  it('read tolerates junk; add / rename / put in / take out / delete', () => {
    expect(readSections([{ id: 'a', name: 'A', ids: ['x', 3] }, { name: 'no id' }, null])).toEqual([{ id: 'a', name: 'A', ids: ['x'] }]);
    let l = addSection([], 's1', '本周要交');
    l = addToSection(l, 's1', 'x');
    l = addToSection(l, 's1', 'x');
    l = addToSection(l, 's1', 'y');
    expect(l).toEqual([{ id: 's1', name: '本周要交', ids: ['x', 'y'] }]);
    l = renameSection(removeFromSection(l, 's1', 'x'), 's1', '下周');
    expect(l).toEqual([{ id: 's1', name: '下周', ids: ['y'] }]);
    expect(deleteSection(l, 's1')).toEqual([]);
  });
  it('several at once (the multi-select bar), each once', () => {
    const l = addAllToSection([{ id: 's1', name: 'A', ids: ['x'] }, { id: 's2', name: 'B', ids: [] }], 's1', ['x', 'y', 'z']);
    expect(l).toEqual([{ id: 's1', name: 'A', ids: ['x', 'y', 'z'] }, { id: 's2', name: 'B', ids: [] }]);
  });
  it('pruned when written (C-U4): ids of conversations that are gone go; another machine’s stay (it may be offline); an empty list prunes nothing', () => {
    const l = [{ id: 's1', name: 'A', ids: ['x', 'gone', 'peer_box~abc'] }];
    expect(pruneSections(l, new Set(['x']))).toEqual([{ id: 's1', name: 'A', ids: ['x', 'peer_box~abc'] }]);
    expect(pruneSections(l, new Set())).toEqual(l);
  });
});
