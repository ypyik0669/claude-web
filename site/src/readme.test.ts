import { describe, expect, it } from 'vitest';
import { copy } from './copy';
import { githubSlug, headings, readmeLink } from './readme';
import en from '../../README.md?raw';
import zh from '../../README.zh-CN.md?raw';

describe('githubSlug: the anchors GitHub gives README headings', () => {
  it('drops punctuation, keeps letters of any script, joins with -', () => {
    expect(githubSlug('4. Review changes, Git, files: the right panel')).toBe('4-review-changes-git-files-the-right-panel');
    expect(githubSlug('4. 审阅改动、Git、文件：右侧面板')).toBe('4-审阅改动git文件右侧面板');
    expect(githubSlug('11. Background: watch subagents work in the café')).toBe('11-background-watch-subagents-work-in-the-café');
    expect(githubSlug('6. Connect a third-party API / relay')).toBe('6-connect-a-third-party-api--relay');
  });
});

describe('readmeLink', () => {
  it('the two READMEs have their headings in the same order', () => {
    expect(headings(zh).length).toBe(headings(en).length);
  });
  it('points into the README of the page\'s language', () => {
    expect(readmeLink('en', '3. ')).toBe('https://github.com/ypyik0669/claude-web#3-permission-prompts-and-permission-modes');
    expect(readmeLink('zh', '3. ')).toBe('https://github.com/ypyik0669/claude-web/blob/main/README.zh-CN.md#3-权限审批与权限模式');
    expect(readmeLink('en', 'About the installer')).toBe('https://github.com/ypyik0669/claude-web#about-the-installer-warnings');
  });
  it('finds every chapter\'s step in both languages', () => {
    for (const locale of ['en', 'zh'] as const) for (const ch of copy(locale).chapters) expect(() => readmeLink(locale, ch.readme)).not.toThrow();
  });
  it('says which heading it could not find', () => {
    expect(() => readmeLink('en', '99. ')).toThrow(/99\. /);
  });
});
