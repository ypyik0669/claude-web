import { describe, expect, it } from 'vitest';
import { attachmentFolderPath, isWithin, joinPath, parentDir, projectRoots } from './paths';

describe('parentDir (where a folder dialog opens to list a folder with the ones beside it)', () => {
  it('Windows paths, either slash, a trailing one ignored', () => {
    expect(parentDir('C:\\Users\\me\\code\\proj')).toBe('C:\\Users\\me\\code');
    expect(parentDir('C:\\Users\\me\\code\\proj\\')).toBe('C:\\Users\\me\\code');
    expect(parentDir('C:/work/shop')).toBe('C:/work');
    expect(parentDir('C:\\code\\\\proj')).toBe('C:\\code');
  });
  it('POSIX paths', () => {
    expect(parentDir('/Users/me/proj')).toBe('/Users/me');
    expect(parentDir('/home/')).toBe('/');
  });
  it('a root is its own parent; a share root stays whole', () => {
    expect(parentDir('C:\\code')).toBe('C:\\');
    expect(parentDir('C:\\')).toBe('C:\\');
    expect(parentDir('/')).toBe('/');
    expect(parentDir('\\\\nas\\share\\proj')).toBe('\\\\nas\\share\\');
    expect(parentDir('\\\\nas\\share')).toBe('\\\\nas\\share');
  });
  it('nothing → nothing', () => {
    expect(parentDir('')).toBe('');
    expect(parentDir('   ')).toBe('');
  });
});

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

describe('projectFor (a conversation is listed under the folder it ran in)', () => {
  const ws = [{ id: 'home', path: 'C:\\Users\\me' }, { id: 'app', path: '/proj/app' }];
  it('the same folder, whatever the separators, trailing slash or (Windows) case', async () => {
    const { projectFor } = await import('./paths');
    expect(projectFor('c:/users/ME/', ws)?.id).toBe('home');
    expect(projectFor('/proj/app', ws)?.id).toBe('app');
  });
  it('a folder under a project is not that project (each folder on its own, like Claude’s app)', async () => {
    const { projectFor } = await import('./paths');
    expect(projectFor('C:\\Users\\me\\dashboard', ws)).toBeUndefined();
    expect(projectFor('/proj/app2', ws)).toBeUndefined();
    expect(projectFor('', ws)).toBeUndefined();
  });
  it('projectRoots: a project folder lists its extra folders after it; anything else is just itself', () => {
    const ws2 = [{ path: 'C:\\proj', folders: ['D:\\lib'] }];
    expect(projectRoots('c:\\proj', ws2)).toEqual(['c:\\proj', 'D:\\lib']);
    expect(projectRoots('C:\\proj\\sub', ws2)).toEqual(['C:\\proj\\sub']);
    expect(projectRoots('', ws2)).toEqual([]);
  });
});
