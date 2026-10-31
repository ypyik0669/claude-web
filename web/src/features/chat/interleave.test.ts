import { describe, expect, it } from 'vitest';
import { interleave, turnStarts } from './interleave';

const x = (at: number, k = String(at)) => ({ at, k });

describe('interleave', () => {
  it('puts each extra ahead of the first turn that starts after it', () => {
    const out = interleave([100, 200, 300], [x(50), x(150), x(250), x(400)], false);
    expect(out).toEqual([
      { before: 0, items: [x(50)] },
      { before: 1, items: [x(150)] },
      { before: 2, items: [x(250)] },
      { before: 3, items: [x(400)] },
    ]);
  });

  it('keeps several extras in one gap in time order', () => {
    const out = interleave([100, 200], [x(180, 'b'), x(120, 'a')], false);
    expect(out).toEqual([{ before: 1, items: [x(120, 'a'), x(180, 'b')] }]);
  });

  it('a tie goes after the turn that starts at the same moment', () => {
    const out = interleave([100, 200], [x(100), x(200)], false);
    expect(out).toEqual([
      { before: 1, items: [x(100)] },
      { before: 2, items: [x(200)] },
    ]);
  });

  it('drops extras older than the first loaded turn when older turns are not loaded', () => {
    const out = interleave([100, 200], [x(10), x(150)], true);
    expect(out).toEqual([{ before: 1, items: [x(150)] }]);
  });

  it('keeps extras older than the first turn when the whole conversation is loaded', () => {
    expect(interleave([100], [x(10)], false)).toEqual([{ before: 0, items: [x(10)] }]);
  });

  it('an empty turn list puts everything at the end, even with hasOlder', () => {
    expect(interleave([], [x(2), x(1)], true)).toEqual([{ before: 0, items: [x(1), x(2)] }]);
  });

  it('no extras gives no groups', () => {
    expect(interleave([1, 2], [], false)).toEqual([]);
  });
});

describe('turnStarts', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  it('is the user message time, or the first item of a turn without one', () => {
    expect(turnStarts([{ user: { ts: iso(1000) }, body: [{ ts: iso(5) }] }, { body: [{ ts: iso(2000) }] }])).toEqual([1000, 2000]);
  });
  it('a turn without a time keeps the one before it (never goes backwards)', () => {
    expect(turnStarts([{ body: [] }, { user: { ts: iso(3000) }, body: [] }, { user: {}, body: [] }, { user: { ts: iso(1000) }, body: [] }])).toEqual([0, 3000, 3000, 3000]);
  });
});
