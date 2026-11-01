import { describe, expect, it } from 'vitest';
import { DIFF, diffStat, TEST_OUTPUT, TURN_STEPS } from './samples';

describe('the samples on the scene', () => {
  it('the changed-file card says +6 −1 because the diff has six added lines and one removed', () => {
    expect(diffStat(DIFF)).toEqual({ add: 6, del: 1 });
    expect(DIFF.map((f) => f.file)).toEqual(['src/cart.ts', 'tests/cart.test.ts']);
  });
  it('the turn reads, edits and runs the tests', () => {
    expect(TURN_STEPS[0]).toMatch(/^Read /);
    expect(TURN_STEPS.at(-1)).toMatch(/^Bash npm test/);
    expect(TEST_OUTPUT).toContain('14 passed');
  });
});
