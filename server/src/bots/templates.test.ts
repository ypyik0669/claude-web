import { describe, it, expect } from 'vitest';
import { BOT_TEMPLATES, fromTemplate } from './templates.js';
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
