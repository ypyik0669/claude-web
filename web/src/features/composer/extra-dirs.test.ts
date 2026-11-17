import { describe, expect, it } from 'vitest';
import { dirsOff, envFolders, sameDirPath, withDir, withoutDir } from './extra-dirs';

describe('添加文件夹: a conversation\'s own working directories', () => {
  it('paths compare like the server: either slash, no trailing one, Windows paths caseless (POSIX ones not)', () => {
    expect(sameDirPath('C:\\Work\\Big\\', 'c:/work/big')).toBe(true);
    expect(sameDirPath('\\\\nas\\Share', '//NAS/share')).toBe(true);
    expect(sameDirPath('/home/A', '/home/a')).toBe(false);
    expect(sameDirPath('', '')).toBe(false);
  });

  it('adding: once, never the conversation\'s folder or the project\'s; the same list back when nothing changes', () => {
    const list = ['D:\\big'];
    expect(withDir(list, 'E:\\docs')).toEqual(['D:\\big', 'E:\\docs']);
    expect(withDir(list, 'd:/BIG/')).toBe(list);
    expect(withDir(list, 'C:\\proj', ['C:\\proj', 'D:\\lib'])).toBe(list);
    expect(withDir(list, 'd:\\lib', ['C:\\proj', 'D:\\lib'])).toBe(list);
    expect(withDir(list, '   ')).toBe(list);
    expect(withoutDir(['D:\\big', 'E:\\docs'], 'd:/big')).toEqual(['E:\\docs']);
  });

  it('who can add one: Claude and Codex on this machine; not another machine\'s, a WSL one, 只聊天, or an ACP agent', () => {
    expect(dirsOff({ protocol: 'claude' })).toBeUndefined();
    expect(dirsOff({ protocol: 'codex' })).toBeUndefined();
    expect(dirsOff({})).toBeUndefined();
    for (const o of [{ remote: true, protocol: 'claude' as const }, { wsl: true }, { chatOnly: true }, { protocol: 'acp' as const, agentName: 'Gemini CLI' }]) expect(dirsOff(o)).toBeTruthy();
    expect(dirsOff({ protocol: 'acp', agentName: 'Gemini CLI' })).toContain('Gemini CLI');
  });

  it('the 环境 card: the project\'s folders, then the conversation\'s own — each once, never the main folder; one in both is the project\'s', () => {
    expect(envFolders('C:\\proj', ['D:\\lib'], ['E:\\big', 'd:\\LIB', 'c:/proj/', 'E:\\big'])).toEqual([
      { path: 'D:\\lib', from: 'project' },
      { path: 'E:\\big', from: 'conversation' },
    ]);
    expect(envFolders('/x', [], [])).toEqual([]);
  });
});
