import { describe, expect, it } from 'vitest';
import { tileArea } from './tile-area';

describe('tileArea (error boundary area names, which go to server.log)', () => {
  it('a chat tile is named by its session id, never its title (titles are the user\'s prompts)', () => {
    const a = tileArea({ id: 't1', kind: 'chat', sessionId: '0f1e2d3c-aaaa-bbbb-cccc-123456789abc', view: 'chat', wb: 'live', title: '帮我改一下 secret-project 的登录逻辑' });
    expect(a).toBe('会话 · 0f1e2d3c');
    expect(a).not.toContain('secret');
    expect(tileArea({ id: 't2', kind: 'chat', sessionId: null, view: 'chat', wb: 'live' })).toBe('会话 · 新会话');
  });

  it('other tiles: kind + file name / panel title, no custom tab titles', () => {
    expect(tileArea({ id: 'd', kind: 'doc', path: 'C:\\repo\\src\\index.ts', title: 'renamed by user' })).toBe('文档 · index.ts');
    expect(tileArea({ id: 'f', kind: 'diff', sessionId: 's', path: 'src/a.ts' })).toBe('差异 · a.ts');
    expect(tileArea({ id: 'p', kind: 'panel', panel: 'terminal' })).toBe('面板 · 终端');
    expect(tileArea({ id: 'b', kind: 'browser', url: 'https://example.com/?q=secret' })).toBe('浏览器');
    expect(tileArea({ id: 'x', kind: 'term', cwd: 'C:\\repo', title: 'my shell' })).toBe('终端');
  });
});
