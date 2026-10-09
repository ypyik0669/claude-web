import { describe, expect, it } from 'vitest';
import { blankMessage, blankProblem, browserOf, invisibleColor, nextStep, type CodeProbe } from './code-blank';

const ok: CodeProbe = { textLen: 120, rendered: true, height: 230, lineHeight: 19.4, color: 'rgb(30, 30, 30)', background: 'rgb(248, 248, 247)' };

describe('blankProblem', () => {
  it('is nothing when the block shows its text', () => {
    expect(blankProblem('a\nb\nc', ok, 3)).toBeNull();
  });

  it('is nothing for a block with nothing to show', () => {
    expect(blankProblem('  \n\n ', { ...ok, textLen: 0, height: 0 }, 3)).toBeNull();
  });

  it('sees text that never reached the page', () => {
    expect(blankProblem('const a = 1;\nconst b = 2;', { ...ok, textLen: 0 }, 2)).toBe('empty');
  });

  it('sees text that is there but takes no room', () => {
    expect(blankProblem('a\nb\nc\nd', { ...ok, height: 0 }, 4)).toBe('collapsed');
  });

  it('does not measure a block that is not on screen (a folded turn, a hidden tab)', () => {
    expect(blankProblem('a\nb\nc\nd', { ...ok, rendered: false, height: 0, color: 'rgba(0, 0, 0, 0)' }, 4)).toBeNull();
  });

  it('does not call one short line collapsed', () => {
    expect(blankProblem('x', { ...ok, height: 6 }, 1)).toBeNull();
  });

  it('sees text drawn in the colour of its background', () => {
    expect(blankProblem('a\nb', { ...ok, color: 'rgb(248, 248, 247)' }, 2)).toBe('invisible');
    expect(blankProblem('a\nb', { ...ok, color: 'rgba(30, 30, 30, 0)' }, 2)).toBe('invisible');
  });
});

describe('invisibleColor', () => {
  it('passes ordinary text', () => {
    expect(invisibleColor('rgb(30, 30, 30)', 'rgb(255, 255, 255)')).toBe(false);
    expect(invisibleColor('rgb(220, 220, 215)', 'rgb(26, 26, 25)')).toBe(false);
    expect(invisibleColor('rgb(118, 118, 113)', 'rgb(26, 26, 25)')).toBe(false); // the faintest ink on dark
  });

  it('catches a transparent colour and one that matches the background', () => {
    expect(invisibleColor('rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)')).toBe(true);
    expect(invisibleColor('transparent', 'rgb(255, 255, 255)')).toBe(true);
    expect(invisibleColor('rgb(250, 250, 250)', 'rgb(255, 255, 255)')).toBe(true);
  });

  it('cannot judge against a transparent background or a colour it cannot read', () => {
    expect(invisibleColor('rgb(255, 255, 255)', 'rgba(0, 0, 0, 0)')).toBe(false);
    expect(invisibleColor('color(display-p3 1 1 1)', 'rgb(255, 255, 255)')).toBe(false);
  });
});

describe('nextStep', () => {
  it('redraws first, then falls back to plain text, then gives up and reports', () => {
    expect(nextStep(0, 'empty')).toEqual({ fix: 1 });
    expect(nextStep(1, 'empty')).toEqual({ fix: 2 });
    expect(nextStep(2, 'empty')).toEqual({ report: 'still' });
  });

  it('reports how it came back once a redraw or plain text worked', () => {
    expect(nextStep(0, null)).toBeNull();
    expect(nextStep(1, null)).toEqual({ report: 'redrawn' });
    expect(nextStep(2, null)).toEqual({ report: 'plain' });
  });
});

describe('browserOf', () => {
  it('names the browser and its major version', () => {
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36')).toBe('Chrome 130');
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68')).toBe('Edge 130');
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) claude-web/0.1.8 Chrome/140.0.0.0 Electron/44.1.0 Safari/537.36')).toBe('Electron 44');
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox 131');
    expect(browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15')).toBe('Safari 18');
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 QQBrowser/13.0')).toBe('QQBrowser 13');
    expect(browserOf('something else')).toBe('未知浏览器');
  });
});

describe('blankMessage', () => {
  it('is one line with what broke, what fixed it and what was around it, never the code itself', () => {
    const m = blankMessage({
      problem: 'empty', outcome: 'redrawn', lang: undefined, lines: 12, chars: 340, streaming: false,
      translated: 'Google 翻译', foreignTags: ['font'], foreignAttrs: ['_msthash'], forcedColors: false, desktop: false, browser: 'Chrome 130',
    });
    expect(m).toBe('代码块有内容却显示为空，重画一次后恢复 · 语言 自动识别 · 12 行 · 340 字 · 已完成 · 页面被 Google 翻译 改过 · 外来标签 font · 外来属性 _msthash · Chrome 130 · 浏览器');
    expect(m).not.toContain('\n');
  });

  it('says when nothing helped, in the desktop app, mid-stream, with forced colours', () => {
    const m = blankMessage({
      problem: 'invisible', outcome: 'still', lang: 'python', lines: 3, chars: 40, streaming: true,
      translated: null, foreignTags: [], foreignAttrs: [], forcedColors: true, desktop: true, browser: 'Electron 44',
    });
    expect(m).toBe('代码块的字和底色一样、看不见，重画和改成纯文本都没用 · 语言 python · 3 行 · 40 字 · 正在输出 · 系统高对比度 · Electron 44 · 桌面版');
  });

  it('caps the lists it was given', () => {
    const m = blankMessage({
      problem: 'collapsed', outcome: 'plain', lang: 'ts', lines: 4, chars: 9, streaming: false,
      translated: null, foreignTags: ['font', 'a', 'b', 'c', 'd'], foreignAttrs: ['x1', 'x2', 'x3', 'x4'], forcedColors: false, desktop: false, browser: 'Firefox 131',
    });
    expect(m).toContain('代码块有内容却不占位置，改成纯文本后恢复');
    expect(m).toContain('外来标签 font、a、b 等 5 种');
    expect(m).toContain('外来属性 x1、x2、x3 等 4 种');
  });
});
