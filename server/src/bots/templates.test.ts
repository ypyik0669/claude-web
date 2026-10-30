import { describe, it, expect } from 'vitest';
import { BOT_TEMPLATES, dailyUsdFor, fromTemplate } from './templates.js';
describe('templates', () => {
  it('has the 14 scenes, each with a charter and at least one routine', () => {
    expect(BOT_TEMPLATES.map((t) => t.id)).toEqual(['morning', 'pr', 'inbox', 'watch', 'bills', 'shopping', 'sales', 'dev', 'rpa', 'content', 'home', 'jobs', 'finance', 'team']);
    for (const t of BOT_TEMPLATES) { expect(t.bot.charter.role.length).toBeGreaterThan(5); expect(t.bot.routines.length).toBeGreaterThan(0); expect(t.bot.policy.signOff).toBe(true); }
    expect(BOT_TEMPLATES.find((t) => t.id === 'content')!.risk).toBeTruthy();
  });
  it('fromTemplate copies with fresh routine ids and the cwd', () => {
    const a = fromTemplate('pr', '/p')!; const b = fromTemplate('pr', '/q')!;
    expect(a.cwd).toBe('/p'); expect(a.routines[0].id).not.toBe(b.routines[0].id);
    a.routines[0].name = 'changed'; expect(BOT_TEMPLATES.find((t) => t.id === 'pr')!.bot.routines[0].name).not.toBe('changed');
    expect(fromTemplate('nope', '/p')).toBeUndefined();
  });
});
describe('template budgets', () => {
  it('dailyUsdFor sizes the budget from the cadence: runs/day × $0.40 × 1.25, whole dollars, $2 … $15', () => {
    expect(dailyUsdFor([{ everyMinutes: 60 }])).toBe(12);
    expect(dailyUsdFor([{ everyMinutes: 30 }])).toBe(15);
    expect(dailyUsdFor([{ cron: '30 7 * * 1-5' }])).toBe(2);
    expect(dailyUsdFor([{ cron: '0 9,15 * * 1-5' }])).toBe(2);
    expect(dailyUsdFor([{ cron: '0 8-17 * * *' }])).toBe(5);
    expect(dailyUsdFor([{ cron: '0 10 1 * *' }])).toBe(2);
    expect(dailyUsdFor([{ cron: 'nonsense' }])).toBe(2);
    expect(dailyUsdFor([{ everyMinutes: 60 }, { cron: '0 9 * * *' }])).toBe(13);
  });
  it('each template carries its own sized budget (the hourly PR bot lasts the day)', () => {
    for (const t of BOT_TEMPLATES) expect(t.bot.budget.dailyUsd).toBe(dailyUsdFor(t.bot.routines));
    expect(BOT_TEMPLATES.find((t) => t.id === 'pr')!.bot.budget.dailyUsd).toBe(12);
  });
});
