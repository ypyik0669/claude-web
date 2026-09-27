import { describe, expect, it } from 'vitest';
import { attachmentFolderPath, isWithin, joinPath } from './paths';

describe('joinPath', () => {
  it('keeps POSIX separators on macOS / Linux paths', () => {
    expect(joinPath('/Users/me/.claude/skills/foo', 'SKILL.md')).toBe('/Users/me/.claude/skills/foo/SKILL.md');
    expect(joinPath('/Users/me/foo/', 'SKILL.md')).toBe('/Users/me/foo/SKILL.md');
  });
  it('keeps backslashes on Windows paths', () => {
    expect(joinPath('C:\\Users\\me\\.claude\\skills\\foo', 'SKILL.md')).toBe('C:\\Users\\me\\.claude\\skills\\foo\\SKILL.md');
    expect(joinPath('C:\\x\\', 'a')).toBe('C:\\x\\a');
  });
});

describe('isWithin', () => {
  it('matches only at a segment boundary', () => {
    expect(isWithin('/proj/app', '/proj/app')).toBe(true);
    expect(isWithin('/proj/app/sub', '/proj/app')).toBe(true);
    expect(isWithin('/proj/app2', '/proj/app')).toBe(false);
    expect(isWithin('/proj/app/', '/proj/app/')).toBe(true);
  });
  it('ignores separator style and case on Windows paths', () => {
    expect(isWithin('c:/Proj/App/x', 'C:\\proj\\app')).toBe(true);
    expect(isWithin('C:\\proj\\app2', 'C:\\proj\\app')).toBe(false);
  });
  it('is case-sensitive for POSIX paths', () => {
    expect(isWithin('/Users/me/Proj', '/Users/me/proj')).toBe(false);
  });
  it('treats an empty parent / child as no match', () => {
    expect(isWithin('', '/a')).toBe(false);
    expect(isWithin('/a', '')).toBe(false);
  });
});

describe('attachmentFolderPath', () => {
  it('strips the rel suffix even when the folder name occurs earlier in the path', () => {
    // folder called "web" inside ~/.claude-web — indexOf("web") used to hit ".claude-web"
    expect(attachmentFolderPath('C:\\Users\\me\\.claude-web\\attachments\\abc\\web\\src\\a.ts', 'web/src/a.ts', 'web'))
      .toBe('C:\\Users\\me\\.claude-web\\attachments\\abc\\web');
    expect(attachmentFolderPath('/Users/me/.claude-web/attachments/abc/web/a.ts', 'web/a.ts', 'web'))
      .toBe('/Users/me/.claude-web/attachments/abc/web');
  });
  it('falls back to the last matching segment', () => {
    expect(attachmentFolderPath('/root/x/top/y/top/z', 'other', 'top')).toBe('/root/x/top/y/top');
  });
});
