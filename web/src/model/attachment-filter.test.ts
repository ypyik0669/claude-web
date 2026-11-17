import { describe, expect, it } from 'vitest';
import { skipDirName } from './attachment-filter';

describe('attached folders skip dependencies, VCS internals and build output', () => {
  it('the directory names the drop walk skips', () => {
    for (const d of ['node_modules', '.git', 'dist', 'build', '.next', 'target']) expect(skipDirName(d)).toBe(true);
    for (const d of ['src', 'distance', '.github', 'builder']) expect(skipDirName(d)).toBe(false);
  });
});
