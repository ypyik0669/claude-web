import { describe, expect, it } from 'vitest';
import { describeCron, nextCron, parseCron } from './cron.js';

const at = (s: string) => new Date(s);

describe('cron', () => {
  it('every 30 minutes', () => {
    expect(nextCron('*/30 * * * *', at('2026-09-03T10:05:00')).toISOString()).toBe(at('2026-09-03T10:30:00').toISOString());
    expect(nextCron('*/30 * * * *', at('2026-09-03T10:30:00')).toISOString()).toBe(at('2026-09-03T11:00:00').toISOString());
  });
  it('weekdays at 9', () => {
    // 2026-09-04 is a Friday → next is Fri 09:00 when asked Thu 10:00? no: Thu 03 10:00 → Fri 04 09:00
    expect(nextCron('0 9 * * 1-5', at('2026-09-03T10:00:00')).toISOString()).toBe(at('2026-09-04T09:00:00').toISOString());
    // Friday after 9 → Monday 07
    expect(nextCron('0 9 * * 1-5', at('2026-09-04T10:00:00')).toISOString()).toBe(at('2026-09-07T09:00:00').toISOString());
  });
  it('monthly on the 1st and names', () => {
    expect(nextCron('0 0 1 * *', at('2026-09-03T00:00:00')).toISOString()).toBe(at('2026-10-01T00:00:00').toISOString());
    expect(nextCron('0 12 * jan mon', at('2026-09-03T00:00:00')).getMonth()).toBe(0);
    expect(nextCron('@hourly', at('2026-09-03T10:20:00')).toISOString()).toBe(at('2026-09-03T11:00:00').toISOString());
  });
  it('rejects garbage', () => {
    expect(() => parseCron('a b')).toThrow();
    expect(() => parseCron('61 * * * *')).toThrow();
  });
  it('describes', () => {
    expect(describeCron('0 9 * * 1-5')).toContain('工作日');
    expect(describeCron('*/15 * * * *')).toContain('15 分钟');
  });
});
