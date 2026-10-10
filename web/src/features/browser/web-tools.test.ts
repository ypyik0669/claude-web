import { describe, expect, it } from 'vitest';
import { WEB_TOOLS, shortAddress, webToolAsk, webToolLabel, webToolOf } from './web-tools';
import { permissionTitle } from '@/features/chat/permission-dock';

describe('the web tools by name', () => {
  it('Claude\'s names, other agents\' forms, and nobody else\'s tools', () => {
    expect(webToolOf('mcp__web__browser_open')).toBe('browser_open');
    expect(webToolOf('mcp__web__web_search')).toBe('web_search');
    expect(webToolOf('web__browser_click')).toBe('browser_click');
    expect(webToolOf('web.web_search')).toBe('web_search');
    expect(webToolOf('browser_type')).toBe('browser_type');
    // a bare web_search is the model's own tool; another server's browser tool is not ours
    expect(webToolOf('web_search')).toBeNull();
    expect(webToolOf('mcp__playwright__browser_open')).toBeNull();
    expect(webToolOf('mcp__web__something_else')).toBeNull();
    expect(webToolOf('Read')).toBeNull();
  });
});

describe('a step\'s verb and target', () => {
  it('every tool has words (no raw tool name on a row)', () => {
    for (const t of WEB_TOOLS) {
      const l = webToolLabel(t, {});
      expect(l.verb).toBeTruthy();
      expect(l.verb).not.toMatch(/browser_|web_/);
    }
  });
  it('says what was searched, opened, typed', () => {
    expect(webToolLabel('web_search', { query: 'vite proxy' })).toEqual({ icon: 'search', verb: '搜索网页:', arg: 'vite proxy' });
    expect(webToolLabel('browser_open', { url: 'https://www.github.com/a/b?x=1' }).arg).toBe('github.com/a/b?…');
    expect(webToolLabel('browser_click', { ref: '[kqz12]' }).arg).toBe('[kqz12]');
    expect(webToolLabel('browser_click', { ref: 7 }).arg).toBe('[7]');
    expect(webToolLabel('browser_type', { ref: 'a1', text: 'hello', submit: true }).arg).toBe('hello ↵');
    expect(webToolLabel('browser_read', { offset: 12000 }).arg).toBe('从第 12000 个字符');
    expect(webToolLabel('browser_read', {}).arg).toBe('');
    expect(webToolLabel('browser_scroll', { direction: 'up' }).verb).toBe('向上滚动网页');
    expect(shortAddress('not a url')).toBe('not a url');
    expect(shortAddress('https://a.com/')).toBe('a.com');
  });
  it('browser_computer says what is done and where, in words', () => {
    expect(WEB_TOOLS).toContain('browser_computer');
    expect(webToolOf('mcp__web__browser_computer')).toBe('browser_computer');
    expect(webToolLabel('browser_computer', { action: 'left_click', coordinate: [640.4, 299.6] })).toEqual({ icon: 'cursor', verb: '点击网页:', arg: '(640, 300)' });
    expect(webToolLabel('browser_computer', { action: 'double_click', coordinate: [1, 2] }).verb).toBe('双击网页:');
    expect(webToolLabel('browser_computer', { action: 'right_click', coordinate: [1, 2] }).verb).toBe('右键点击网页:');
    expect(webToolLabel('browser_computer', { action: 'left_click_drag', start_coordinate: [10, 20], coordinate: [300, 20] })).toEqual({ icon: 'cursor', verb: '在网页上拖动:', arg: '(10, 20) → (300, 20)' });
    expect(webToolLabel('browser_computer', { action: 'scroll', coordinate: [1, 2], scroll_direction: 'down' })).toEqual({ icon: 'web', verb: '向下滚动网页', arg: '' });
    expect(webToolLabel('browser_computer', { action: 'type', text: 'x'.repeat(200) }).arg).toHaveLength(80);
    expect(webToolLabel('browser_computer', { action: 'key', text: 'ctrl+a' })).toEqual({ icon: 'keyboard', verb: '按键:', arg: 'ctrl+a' });
    expect(webToolLabel('browser_computer', { action: 'screenshot' })).toEqual({ icon: 'image', verb: '给网页截图', arg: '' });
    expect(webToolLabel('browser_computer', { action: 'wait' }).verb).toBe('等网页一会儿');
    // a position that is not one, an action nobody knows: still words, no junk
    expect(webToolLabel('browser_computer', { action: 'left_click', coordinate: 'here' }).arg).toBe('');
    expect(webToolLabel('browser_computer', { action: 'fly' })).toEqual({ icon: 'cursor', verb: '操作网页', arg: '' });
    expect(webToolLabel('browser_computer', {}).verb).toBe('操作网页');
  });
});

describe('what a permission card asks', () => {
  it('in words, with the site for an address', () => {
    expect(webToolAsk('browser_open', { url: 'https://www.example.com/x' }, 'Claude')).toBe('Claude 想在浏览器里打开 example.com');
    expect(webToolAsk('browser_open', {}, 'Codex')).toBe('Codex 想在浏览器里打开一个网页');
    expect(webToolAsk('browser_type', { submit: true }, 'Claude')).toBe('Claude 想在网页上输入并提交');
    for (const t of WEB_TOOLS) expect(webToolAsk(t, {}, 'Claude')).toMatch(/^Claude 想/);
    expect(webToolAsk('browser_computer', { action: 'left_click', coordinate: [1, 2] }, 'Claude')).toBe('Claude 想用鼠标点网页上的一个位置');
    expect(webToolAsk('browser_computer', { action: 'type', text: 'secret words' }, 'Codex')).toBe('Codex 想在网页上输入文字');
    expect(webToolAsk('browser_computer', { action: 'key', text: 'Enter' }, 'Claude')).toBe('Claude 想在网页上按键');
    expect(webToolAsk('browser_computer', { action: 'left_click_drag' }, 'Claude')).toBe('Claude 想在网页上拖动鼠标');
    expect(webToolAsk('browser_computer', { action: 'screenshot' }, 'Claude')).toBe('Claude 想给网页截图');
  });
  it('permissionTitle uses them', () => {
    expect(permissionTitle({ toolName: 'mcp__web__browser_click', input: { ref: 'a1' } })).toBe('Claude 想在网页上点一下');
    expect(permissionTitle({ toolName: 'mcp__web__browser_open', input: { url: 'https://docs.python.org/3/' } }, 'Gemini')).toBe('Gemini 想在浏览器里打开 docs.python.org');
    // other MCP tools keep their generic sentence
    expect(permissionTitle({ toolName: 'mcp__github__create_issue', input: {} })).toBe('Claude 想使用 github 的 create_issue');
  });
});
