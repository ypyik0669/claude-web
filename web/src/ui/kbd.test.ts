import { describe, expect, it } from 'vitest';
import { hasKbd, isKeyCombo, noKbd } from './kbd';

describe('keyboard hints on a phone (ui/kbd.ts)', () => {
  it('knows a key combination from words', () => {
    for (const k of ['Ctrl+K', 'Ctrl K', '⌘ ,', 'Ctrl+1..9', 'Ctrl+Shift+Tab', 'Alt+J', 'F2', 'Enter / Shift+Enter', 'Ctrl+Alt+→ / Alt+]', 'Ctrl I']) expect(isKeyCombo(k), k).toBe(true);
    for (const w of ['命令面板', '2 分钟前', '3 / 5', '', undefined, 'Sonnet 5.5', '/ 然后 Tab 补全']) expect(isKeyCombo(w), String(w)).toBe(false);
  });

  it('drops bracketed hints, key parts of a · list and key clauses', () => {
    expect(noKbd('对话 ⇄ 步骤视图（Alt+J）')).toBe('对话 ⇄ 步骤视图');
    expect(noKbd('发送 (Enter)')).toBe('发送');
    expect(noKbd('Enter 排到这一轮之后，Ctrl+Enter 马上插话 · Esc 中断')).toBe('');
    expect(noKbd('每轮结束后猜你下一句想说什么，按 Tab 采用。')).toBe('每轮结束后猜你下一句想说什么');
    expect(noKbd('↑↓ 选择 · 点一下执行')).toBe('点一下执行');
    expect(noKbd('回复…')).toBe('回复…');
    // a table / tab in words is not a key
    expect(hasKbd('标签行')).toBe(false);
    expect(hasKbd('Tabs')).toBe(false);
  });

  it('leaves everything as it is off a phone', () => {
    expect(noKbd('发送 (Enter)', false)).toBe('发送 (Enter)');
  });
});
