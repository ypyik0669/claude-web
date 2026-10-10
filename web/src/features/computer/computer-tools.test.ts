import { describe, expect, it } from 'vitest';
import { ACCESS_NOTE, COMPUTER_TOOLS, accessAsk, accessTitle, computerToolLabel, computerToolOf, isAccessRequest } from './computer-tools';

describe('操控电脑: which tools are ours', () => {
  it('only the `computer` server\'s own tools — not another server\'s of the same name, not a bare name', () => {
    expect(computerToolOf('mcp__computer__left_click')).toBe('left_click');
    expect(computerToolOf('mcp__computer__request_access')).toBe('request_access');
    expect(computerToolOf('mcp__computer__no_such_tool')).toBeNull();
    expect(computerToolOf('mcp__computer-use__left_click')).toBeNull(); // another host's server
    expect(computerToolOf('mcp__web__browser_computer')).toBeNull(); // the built-in browser's own
    expect(computerToolOf('left_click')).toBeNull();
    expect(isAccessRequest('mcp__computer__request_access')).toBe(true);
    expect(isAccessRequest('mcp__computer__screenshot')).toBe(false);
    expect(isAccessRequest('request_access')).toBe(false);
  });

  it('the same tools the server offers', () => {
    expect(COMPUTER_TOOLS).toHaveLength(23);
    expect(new Set(COMPUTER_TOOLS).size).toBe(23);
  });
});

describe('操控电脑: a step in words', () => {
  it('every tool has a verb in Chinese and an icon — none reads as its raw name', () => {
    for (const t of COMPUTER_TOOLS) {
      const l = computerToolLabel(t, {});
      expect(l.verb, t).toMatch(/[一-鿿]/);
      expect(l.verb, t).not.toContain(t);
      expect(l.icon, t).toBeTruthy();
    }
  });

  it('says where and what', () => {
    expect(computerToolLabel('left_click', { coordinate: [120.4, 88.6] })).toMatchObject({ verb: '点击屏幕:', arg: '(120, 89)' });
    expect(computerToolLabel('double_click', { coordinate: [1, 2] }).verb).toBe('双击屏幕:');
    expect(computerToolLabel('left_click_drag', { start_coordinate: [10, 20], coordinate: [300, 400] }).arg).toBe('(10, 20) → (300, 400)');
    expect(computerToolLabel('scroll', { coordinate: [5, 6], scroll_direction: 'down' })).toMatchObject({ verb: '向下滚动屏幕:', arg: '(5, 6)' });
    expect(computerToolLabel('scroll', { coordinate: [5, 6] }).verb).toBe('滚动屏幕:');
    expect(computerToolLabel('type', { text: '你好' })).toMatchObject({ verb: '用键盘输入:', arg: '你好' });
    expect(computerToolLabel('type', { text: 'x'.repeat(200) }).arg).toHaveLength(81); // cut, with an ellipsis
    expect(computerToolLabel('key', { text: 'ctrl+s' }).arg).toBe('ctrl+s');
    expect(computerToolLabel('key', { text: 'Down', repeat: 3 }).arg).toBe('Down × 3');
    expect(computerToolLabel('hold_key', { text: 'shift', duration: 2 }).arg).toBe('shift 2 秒');
    expect(computerToolLabel('wait', { duration: 1.5 }).arg).toBe('1.5 秒');
    expect(computerToolLabel('open_application', { app: '记事本' })).toMatchObject({ verb: '切到应用:', arg: '记事本' });
    expect(computerToolLabel('computer_batch', { actions: [{}, {}, {}] }).arg).toBe('3 步');
    expect(computerToolLabel('request_access', { apps: ['记事本', ' 画图 '] }).arg).toBe('记事本、画图');
    expect(computerToolLabel('screenshot', undefined)).toMatchObject({ verb: '看屏幕', arg: '' });
  });

  it('a malformed input never throws and never invents a position', () => {
    expect(computerToolLabel('left_click', { coordinate: 'here' }).arg).toBe('');
    expect(computerToolLabel('left_click', { coordinate: [1] }).arg).toBe('');
    expect(computerToolLabel('left_click_drag', { coordinate: [3, 4] }).arg).toBe('(3, 4)');
    expect(computerToolLabel('type', { text: 12 }).arg).toBe('');
    expect(computerToolLabel('computer_batch', { actions: 'all of them' }).arg).toBe('');
  });
});

describe('操控电脑: the access request as the card shows it', () => {
  it('the applications, the reason, and what else was asked for', () => {
    expect(accessAsk({ apps: ['记事本', '', 3, '  画图 '], reason: '  把这段话贴进记事本  ', clipboardWrite: true })).toEqual({
      apps: ['记事本', '画图'],
      reason: '把这段话贴进记事本',
      extras: ['写剪贴板（会替换你复制的内容）'],
    });
    expect(accessAsk({ apps: ['a'], clipboardRead: true, systemKeyCombos: true }).extras).toEqual(['读剪贴板', '按系统快捷键（比如 Alt+Tab、Win 键）']);
    // only a real `true` counts: a string from a careless caller is not a yes to the clipboard
    expect(accessAsk({ apps: ['a'], clipboardRead: 'true', clipboardWrite: 1 }).extras).toEqual([]);
    expect(accessAsk(undefined)).toEqual({ apps: [], reason: '', extras: [] });
    expect(accessAsk({ apps: 'everything' }).apps).toEqual([]);
  });

  it('the title names the one application, or how many', () => {
    expect(accessTitle({ apps: ['记事本'] })).toBe('Claude 想操控这台电脑上的 记事本');
    expect(accessTitle({ apps: ['记事本', '画图', '计算器'] }, 'Claude')).toBe('Claude 想操控这台电脑上的 3 个应用');
    expect(accessTitle({}, 'Claude')).toBe('Claude 想操控这台电脑上的应用'); // (the server never asks with none)
  });

  it('what a yes means is spelled out: screenshots of the whole screen, input only to these applications, this conversation only', () => {
    expect(ACCESS_NOTE).toMatch(/整个屏幕的截图/);
    expect(ACCESS_NOTE).toMatch(/这些应用位于最前面时/);
    expect(ACCESS_NOTE).toMatch(/只对这一个对话有效/);
  });
});
