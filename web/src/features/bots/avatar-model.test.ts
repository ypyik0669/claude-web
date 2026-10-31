import { describe, expect, it } from 'vitest';
import { avatarOf, avatarString, COLORS, SHAPES } from './avatar-model';

describe('bot avatars from the name', () => {
  it('the same name gives the same face', () => {
    expect(avatarOf('小助手')).toEqual(avatarOf('小助手'));
    expect(avatarOf('Inbox triage')).toEqual(avatarOf('Inbox triage'));
  });

  it('twenty names spread over at least 8 shape × colour pairs', () => {
    const names = ['小助手', '邮件管家', '日报', '财务', 'Inbox triage', 'Release bot', 'CI 看门', '周报', '客服', 'PR 审阅',
      'Ops', '记账', '翻译', '日程', 'Alice', 'Bob', '新闻摘要', '备份', '监控', '提醒'];
    const pairs = new Set(names.map((n) => { const a = avatarOf(n); return `${a.shape}:${a.color}`; }));
    expect(pairs.size).toBeGreaterThanOrEqual(8);
    for (const n of names) {
      const a = avatarOf(n);
      expect(a.shape).toBeGreaterThanOrEqual(0); expect(a.shape).toBeLessThan(SHAPES.length);
      expect(a.color).toBeGreaterThanOrEqual(0); expect(a.color).toBeLessThan(COLORS.length);
    }
  });

  it('a stored string wins, and round-trips', () => {
    expect(avatarOf('小助手', 'shape:3|color:7|seed:42')).toEqual({ shape: 3, color: 7, seed: 42 });
    const a = avatarOf('任何名字');
    expect(avatarOf('别的名字', avatarString(a))).toEqual(a);
  });

  it('a stored string that is not ours (a char:, junk, out of range) falls back to the name', () => {
    expect(avatarOf('小助手', 'char:abc')).toEqual(avatarOf('小助手'));
    expect(avatarOf('小助手', 'shape:99|color:1|seed:1')).toEqual(avatarOf('小助手'));
    expect(avatarOf('小助手', '')).toEqual(avatarOf('小助手'));
  });

  it('12 shapes and 10 colours from the agent tokens', () => {
    expect(SHAPES).toHaveLength(12);
    expect(COLORS).toEqual(Array.from({ length: 10 }, (_, i) => `var(--agent-${i + 1})`));
  });
});
