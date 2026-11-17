import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { extraDirsChange, normFolders, ownDirs, projectFolders, sameDir, workDirs } from './workspace-folders.js';

const id = (p: string) => p;
describe('normFolders', () => {
  it('old data (no folders) → []', () => {
    expect(normFolders('C:\\a', undefined, { resolve: id })).toEqual([]);
    expect(normFolders('C:\\a', 'C:\\b', { resolve: id })).toEqual([]);
  });
  it('drops non-strings, the main folder and duplicates (caseless on Windows), keeps order', () => {
    expect(normFolders('C:\\a', ['C:\\B', 3, null, 'c:\\a\\', 'C:\\b', 'D:\\x'], { caseless: true, resolve: id })).toEqual(['C:\\B', 'D:\\x']);
  });
  it('case matters off Windows', () => {
    expect(normFolders('/a', ['/B', '/b'], { caseless: false, resolve: id })).toEqual(['/B', '/b']);
  });
  it('resolves relative paths with the given resolver', () => {
    expect(normFolders('/a', ['x'], { caseless: false, resolve: (p) => path.posix.resolve('/root', p) })).toEqual(['/root/x']);
  });
});

describe('projectFolders', () => {
  const ws = [{ path: 'C:\\proj', folders: ['D:\\lib', 'E:\\docs'] }, { path: 'C:\\other' }];
  it('a conversation in the project folder gets its extra folders', () => {
    expect(projectFolders('c:\\proj\\', ws, true)).toEqual(['D:\\lib', 'E:\\docs']);
  });
  it('a subfolder of the project, an unknown folder, or a project without folders → []', () => {
    expect(projectFolders('C:\\proj\\sub', ws, true)).toEqual([]);
    expect(projectFolders('C:\\nowhere', ws, true)).toEqual([]);
    expect(projectFolders('C:\\other', ws, true)).toEqual([]);
    expect(projectFolders('', ws, true)).toEqual([]);
  });
  it('sameDir ignores separators and a trailing slash', () => {
    expect(sameDir('C:/proj/', 'c:\\proj', true)).toBe(true);
    expect(sameDir('/a', '/A', false)).toBe(false);
  });
});

// 添加文件夹 (+ menu): a conversation's own extra folders, and every folder it works in
describe('ownDirs / workDirs', () => {
  it('own folders: absolute paths only, each once, never the conversation\'s folder, kept as the user picked them', () => {
    expect(ownDirs('C:\\proj', ['D:\\big', 'relative\\x', 7, '', 'd:/big/', 'c:\\proj\\', 'E:\\docs'], true)).toEqual(['D:\\big', 'E:\\docs']);
    expect(ownDirs('C:\\proj', undefined, true)).toEqual([]);
    expect(ownDirs('C:\\proj', 'D:\\big', true)).toEqual([]);
  });
  it('work dirs: the project\'s, then the conversation\'s own, then the rest — each once, never cwd', () => {
    expect(workDirs('C:\\proj', [['D:\\lib'], ['d:\\LIB', 'E:\\big', 'C:\\proj'], ['F:\\files']], true)).toEqual(['D:\\lib', 'E:\\big', 'F:\\files']);
    expect(workDirs('/a', [[], []], false)).toEqual([]);
  });
  it('a change: what will be stored, and only what is new gets checked (a folder deleted since can still be removed)', () => {
    // removing E: nothing new to check, even if D: is gone from the disk by now
    expect(extraDirsChange('C:\\proj', ['D:\\big', 'E:\\docs'], ['D:\\big'], true)).toEqual({ dirs: ['D:\\big'], added: [] });
    // adding F: (the same D: in another spelling is not new); junk counts as new, so the disk check refuses it
    expect(extraDirsChange('C:\\proj', ['D:\\big'], ['d:/big/', 'F:\\x', 5], true)).toEqual({ dirs: ['d:/big/', 'F:\\x'], added: ['F:\\x', 5] });
    expect(extraDirsChange('C:\\proj', undefined, [], true)).toEqual({ dirs: [], added: [] });
  });
});
