import { describe, expect, it } from 'vitest';
import { ago } from './ui';

describe('ago (the device list’s 上次连接)', () => {
  const now = 1_000_000_000_000;
  it('says it in minutes, hours, days', () => {
    expect(ago(now - 5_000, now)).toBe('刚刚');
    expect(ago(now - 3 * 60_000, now)).toBe('3 分钟前');
    expect(ago(now - 2 * 3_600_000 - 1, now)).toBe('2 小时前');
    expect(ago(now - 9 * 86_400_000, now)).toBe('9 天前');
  });
  it('a clock that went back is 刚刚, not a negative time', () => {
    expect(ago(now + 60_000, now)).toBe('刚刚');
  });
});
