import { describe, expect, it } from 'vitest';
import { cronText, nextRunText, scheduleText } from './schedule-text';

// a Wednesday, 10:26 local time
const NOW = new Date(2026, 8, 30, 10, 26, 0).getTime();
const at = (days: number, h: number, m: number) => new Date(2026, 8, 30 + days, h, m, 0).getTime();
const min = 60_000;

describe('nextRunText', () => {
  it('minutes, then whole hours rounded down (never up)', () => {
    expect(nextRunText(NOW + 30_000, NOW)).toBe('1 分钟后');
    expect(nextRunText(NOW + 59.9 * min, NOW)).toBe('59 分钟后');
    expect(nextRunText(NOW + 90 * min, NOW)).toBe('1 小时后');
    expect(nextRunText(NOW + 179 * min, NOW)).toBe('2 小时后');
    expect(nextRunText(NOW - min, NOW)).toBe('1 分钟后');
  });
  it('later today, tomorrow, this week, further out', () => {
    expect(nextRunText(NOW + 274 * min, NOW)).toBe('今天 15:00');
    expect(nextRunText(at(1, 9, 0), NOW)).toBe('明天 09:00');
    expect(nextRunText(at(5, 9, 0), NOW)).toBe('周一 09:00');
    expect(nextRunText(at(6, 18, 30), NOW)).toBe('周二 18:30');
    expect(nextRunText(at(7, 9, 0), NOW)).toBe('10/7 09:00');
  });
  it('tomorrow early in the morning is 明天, even when it is under 3 hours away', () => {
    const late = new Date(2026, 8, 30, 23, 50).getTime();
    expect(nextRunText(new Date(2026, 9, 1, 1, 0).getTime(), late)).toBe('1 小时后');
    expect(nextRunText(new Date(2026, 9, 1, 9, 0).getTime(), late)).toBe('明天 09:00');
  });
});

describe('cronText', () => {
  it('the common shapes', () => {
    expect(cronText('*/30 * * * *')).toBe('每 30 分钟');
    expect(cronText('* * * * *')).toBe('每分钟');
    expect(cronText('0 * * * *')).toBe('每小时');
    expect(cronText('15 * * * *')).toBe('每小时第 15 分');
    expect(cronText('0 */2 * * *')).toBe('每 2 小时');
    expect(cronText('0 9 * * *')).toBe('每天 09:00');
    expect(cronText('0 9 * * 1-5')).toBe('工作日 09:00');
    expect(cronText('0 9 * * mon-fri')).toBe('工作日 09:00');
    expect(cronText('30 10 * * 0,6')).toBe('周末 10:30');
    expect(cronText('0 9 * * 6,7')).toBe('周末 09:00');
    expect(cronText('0 9 * * 1')).toBe('每周一 09:00');
    expect(cronText('0 9 * * 5,1,3')).toBe('每周一、三、五 09:00');
    expect(cronText('0 9 * * 0')).toBe('每周日 09:00');
    expect(cronText('0 18 1 * *')).toBe('每月 1 日 18:00');
    expect(cronText('@daily')).toBe('每天 00:00');
    expect(cronText('@hourly')).toBe('每小时');
    expect(cronText('@weekly')).toBe('每周日 00:00');
  });
  it('anything else is not guessed (the caller shows the expression)', () => {
    expect(cronText('0 9 1 * 1')).toBeNull();
    expect(cronText('0 9 * 1 *')).toBeNull();
    expect(cronText('0 9,18 * * *')).toBeNull();
    expect(cronText('*/5 9-17 * * 1-5')).toBeNull();
    expect(cronText('nonsense')).toBeNull();
  });
});

describe('scheduleText', () => {
  it('words for the period; the raw cron goes in the tooltip', () => {
    expect(scheduleText({ cron: '0 9 * * 1-5', everyMinutes: 60 })).toEqual({ text: '工作日 09:00', title: 'cron：0 9 * * 1-5' });
    expect(scheduleText({ cron: '0 9,18 * * *', everyMinutes: 60 })).toEqual({ text: '0 9,18 * * *', title: 'cron：0 9,18 * * *' });
    expect(scheduleText({ cron: '', everyMinutes: 45 })).toEqual({ text: '每 45 分钟' });
  });
});
