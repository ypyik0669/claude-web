import { describe, expect, it } from 'vitest';
import { extLabel, shortPath, textWidth } from './attach-card';

describe('extLabel', () => {
  it('the extension in capitals, up to five letters / digits', () => {
    expect(extLabel('release-notes.md')).toBe('MD');
    expect(extLabel('report.final.PDF')).toBe('PDF');
    expect(extLabel('book.xlsx')).toBe('XLSX');
    expect(extLabel('a.mp3')).toBe('MP3');
  });
  it('none: no dot, a dotfile, a long or odd extension', () => {
    expect(extLabel('Makefile')).toBe('');
    expect(extLabel('.gitignore')).toBe('');
    expect(extLabel('x.verylongext')).toBe('');
    expect(extLabel('x.tar-gz')).toBe('');
    expect(extLabel('x.')).toBe('');
  });
});

describe('textWidth', () => {
  it('CJK counts two', () => {
    expect(textWidth('abc')).toBe(3);
    expect(textWidth('安装包')).toBe(6);
    expect(textWidth('C:\\安装')).toBe(7);
  });
});

describe('shortPath', () => {
  it('a path that fits is left whole', () => {
    expect(shortPath('C:\\Users\\YPY\\Desktop\\安装包与工具')).toBe('C:\\Users\\YPY\\Desktop\\安装包与工具');
  });
  it('a long one keeps its root and its end', () => {
    const p = 'C:\\Users\\YPY\\Documents\\projects\\clients\\acme\\2026\\deliverables\\final-report';
    const s = shortPath(p);
    expect(s.startsWith('C:\\…\\')).toBe(true);
    expect(s.endsWith('\\deliverables\\final-report')).toBe(true);
    expect(textWidth(s)).toBeLessThanOrEqual(44);
  });
  it('POSIX paths, CJK counted wide', () => {
    expect(shortPath('/Users/a/工作/客户资料/二〇二六年/最终交付的报告文件夹', 30)).toBe('/…/最终交付的报告文件夹');
  });
  it('a last part longer than the room still shows (the card clamps it)', () => {
    expect(shortPath('C:\\aa\\bb\\' + 'x'.repeat(60), 20)).toBe('C:\\…\\' + 'x'.repeat(60));
    // shortening that saves nothing: the path as it is
    expect(shortPath('C:\\a\\' + 'x'.repeat(60), 20)).toBe('C:\\a\\' + 'x'.repeat(60));
  });
});
