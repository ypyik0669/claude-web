import { describe, expect, it } from 'vitest';
import { parseRange } from './index.js';

describe('parseRange', () => {
  it('serves the whole file without a usable header', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
    expect(parseRange('bytes=0-10', 0)).toBeNull();
  });
  it('clamps an open or oversized end', () => {
    expect(parseRange('bytes=10-', 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange('bytes=10-500', 100)).toEqual({ start: 10, end: 99 });
  });
  it('treats bytes=-N as the last N bytes (not the first N)', () => {
    expect(parseRange('bytes=-20', 100)).toEqual({ start: 80, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });
  it('rejects ranges createReadStream would throw on', () => {
    expect(parseRange('bytes=50-10', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
  });
});
