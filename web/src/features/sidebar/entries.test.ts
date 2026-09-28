import { describe, expect, it } from 'vitest';
import { ADDED, LEGACY, PLACES, resolves } from './entries';

describe('sidebar entry points: nothing of the old sidebar is lost', () => {
  it('every old entry point maps to at least one place that exists', () => {
    for (const e of LEGACY) {
      expect(e.now.length, e.old).toBeGreaterThan(0);
      for (const ref of e.now) expect(resolves(ref), `${e.old} → ${ref}`).toBe(true);
    }
  });

  it('the new entries of the spec exist too', () => {
    for (const ref of ADDED) expect(resolves(ref), ref).toBe(true);
  });

  it('every id is accounted for: it is where an old entry went, or a new one of the spec', () => {
    const used = new Set([...LEGACY.flatMap((e) => e.now), ...ADDED]);
    for (const [place, ids] of Object.entries(PLACES)) for (const id of ids) expect(used.has(`${place}:${id}` as never), `${place}:${id}`).toBe(true);
  });

  it('ids are unique within a place', () => {
    for (const [place, ids] of Object.entries(PLACES)) expect(new Set(ids).size, place).toBe(ids.length);
  });

  it('the session menu keeps every session action (spec: rename, pin, archive, delete, fork, hand-over, reference, native CLI…)', () => {
    for (const id of ['rename', 'pin', 'archive', 'delete', 'fork', 'handoff', 'reference', 'native-cli']) expect(resolves(`rowMenu:${id}`), id).toBe(true);
  });
});
