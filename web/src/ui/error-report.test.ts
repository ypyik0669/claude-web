import { describe, expect, it } from 'vitest';
import { crashTargets, formatErrorReport, toReport } from './error-report';

describe('error boundary reports', () => {
  it('turns anything thrown into a message', () => {
    const e = new TypeError('x is undefined');
    const r = toReport('设置 · 模型', e, '\n    at ModelsSection');
    expect(r.message).toBe('TypeError: x is undefined');
    expect(r.stack).toContain('x is undefined');
    expect(r.componentStack).toContain('ModelsSection');
    expect(toReport('a', new Error('plain')).message).toBe('plain'); // no "Error: " prefix for the common case
    expect(toReport('a', 'just a string').message).toBe('just a string');
    expect(toReport('a', { code: 7 }).message).toBe('[object Object]');
    expect(toReport('a', new Error('')).message).toBe('（没有错误信息）');
  });

  it('formats the text 复制错误信息 copies', () => {
    const text = formatErrorReport({ area: '停靠面板 · 终端', message: 'boom', stack: 'Error: boom\n  at X', componentStack: '\n  at TerminalPanel' }, { version: 'ccb 2.8.4', url: '/' });
    expect(text.split('\n').slice(0, 4)).toEqual(['区域：停靠面板 · 终端', '错误：boom', '运行内核：ccb 2.8.4', '页面：/']);
    expect(text).toContain('堆栈：\nError: boom');
    expect(text).toContain('组件栈：\n  at TerminalPanel');
  });

  it('__cwCrash filters by area substring ("" = every boundary)', () => {
    expect(crashTargets('', '模型菜单')).toBe(true);
    expect(crashTargets('设置 · 模型', '设置 · 模型')).toBe(true);
    expect(crashTargets('设置 · 模型', '设置 · 模型网关')).toBe(true);
    expect(crashTargets('终端', '设置 · 模型')).toBe(false);
  });
});
