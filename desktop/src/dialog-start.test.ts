import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { START_MAX, START_UP, dialogStart, nearestDir, readLastPick, saveLastPick, startPath } from './dialog-start';

/** A fake disk with these folders; `asked` lists every path looked at. */
function disk(...folders: string[]) {
  const set = new Set(folders);
  const asked: string[] = [];
  return { asked, isDir: async (p: string) => { asked.push(p); return set.has(p); } };
}

describe('startPath: only a local absolute folder path of this system is taken from the page', () => {
  it('Windows: drive paths, normalised', () => {
    expect(startPath('C:\\Users\\me\\proj', 'win32')).toBe('C:\\Users\\me\\proj');
    expect(startPath('C:/Users/me/proj/', 'win32')).toBe('C:\\Users\\me\\proj');
    expect(startPath('D:\\a\\..\\b', 'win32')).toBe('D:\\b');
    expect(startPath('C:\\', 'win32')).toBe('C:\\');
  });
  it('Windows: network, device, root-relative, relative paths, addresses and junk are refused', () => {
    for (const p of ['\\\\host\\share\\x', '//host/share/x', '\\\\?\\C:\\x', '\\\\?\\UNC\\host\\s', '\\\\.\\pipe\\x', '/Users/me', '\\Users\\me', 'proj', '..\\x', 'C:x', '', 'https://a.b/', 'file:///C:/x', 'C:\\a\0b', `C:\\${'a'.repeat(START_MAX)}`, 42, null, undefined, {}, ['C:\\x']]) {
      expect(startPath(p, 'win32'), String(p)).toBeNull();
    }
  });
  it('macOS / Linux: /… paths, normalised; Windows-looking and relative ones are refused', () => {
    expect(startPath('/Users/me/proj/', 'darwin')).toBe('/Users/me/proj');
    expect(startPath('/home/me/a/../b', 'linux')).toBe('/home/me/b');
    for (const p of ['C:\\x', '//host/share', 'proj', '~/proj', '']) expect(startPath(p, 'linux'), p).toBeNull();
  });
});

describe('nearestDir', () => {
  it('the folder itself, or the nearest one above it that is still there', async () => {
    expect(await nearestDir('C:\\code\\proj', disk('C:\\code\\proj').isDir, 'win32')).toBe('C:\\code\\proj');
    expect(await nearestDir('C:\\code\\gone\\deeper', disk('C:\\code', 'C:\\').isDir, 'win32')).toBe('C:\\code');
    expect(await nearestDir('/home/me/gone', disk('/home/me', '/').isDir, 'linux')).toBe('/home/me');
  });
  it('nothing of it left (a drive that is gone): null, after the root', async () => {
    const d = disk();
    expect(await nearestDir('X:\\proj\\sub', d.isDir, 'win32')).toBeNull();
    expect(d.asked).toEqual(['X:\\proj\\sub', 'X:\\proj', 'X:\\']);
  });
  it('gives up after START_UP folders up', async () => {
    const d = disk('C:\\');
    const deep = `C:\\${Array.from({ length: START_UP + 10 }, (_, i) => `d${i}`).join('\\')}`;
    expect(await nearestDir(deep, d.isDir, 'win32')).toBeNull();
    expect(d.asked).toHaveLength(START_UP + 1);
  });
});

describe('dialogStart: where 打开文件夹… opens', () => {
  const home = 'C:\\Users\\me';
  it('the page’s start when it is a folder', async () => {
    expect(await dialogStart({ start: 'C:\\code', home, isDir: disk('C:\\code').isDir, platform: 'win32' })).toBe('C:\\code');
  });
  it('a start that is gone: the nearest folder above it; nothing of it left: home (never the remembered place)', async () => {
    expect(await dialogStart({ start: 'C:\\code\\deleted', home, isDir: disk('C:\\code').isDir, platform: 'win32' })).toBe('C:\\code');
    expect(await dialogStart({ start: 'X:\\stick\\proj', home, isDir: disk('C:\\code').isDir, platform: 'win32' })).toBe(home);
    // a start wins over the last pick
    expect(await dialogStart({ start: 'C:\\code', last: 'D:\\gone', home, isDir: disk('C:\\code').isDir, platform: 'win32' })).toBe('C:\\code');
  });
  it('a start not taken (a network path) is never looked at on the disk, and counts as none', async () => {
    const d = disk('C:\\code');
    expect(await dialogStart({ start: '\\\\evil\\share\\x', home, isDir: d.isDir, platform: 'win32' })).toBeUndefined();
    expect(d.asked).toEqual([]);
  });
  it('no start: the system’s own place while the last pick here is still there (or there was none)', async () => {
    expect(await dialogStart({ start: undefined, home, isDir: disk().isDir, platform: 'win32' })).toBeUndefined();
    expect(await dialogStart({ start: '', last: 'C:\\code\\proj', home, isDir: disk('C:\\code\\proj').isDir, platform: 'win32' })).toBeUndefined();
    expect(await dialogStart({ start: undefined, last: { junk: 1 }, home, isDir: disk().isDir, platform: 'win32' })).toBeUndefined();
  });
  it('no start and the last pick is gone (Windows would say 「Location is not available」): the nearest folder above it, else home', async () => {
    const d = disk('C:\\code');
    expect(await dialogStart({ start: undefined, last: 'C:\\code\\worktree\\gone', home, isDir: d.isDir, platform: 'win32' })).toBe('C:\\code');
    expect(await dialogStart({ start: undefined, last: 'X:\\proj', home, isDir: disk().isDir, platform: 'win32' })).toBe(home);
    expect(await dialogStart({ start: undefined, last: '/home/me/gone', home: '/home/me', isDir: disk('/home').isDir, platform: 'linux' })).toBe('/home');
  });
  it('a disk that hangs or throws: the system’s own place', async () => {
    const never = () => new Promise<boolean>(() => {});
    expect(await dialogStart({ start: 'Z:\\proj', home, isDir: never, platform: 'win32' }, 20)).toBeUndefined();
    const boom = async () => { throw new Error('EIO'); };
    expect(await dialogStart({ start: 'C:\\proj', home, isDir: boom, platform: 'win32' })).toBeUndefined();
  });
  it('the real disk: a temp folder is taken, a file in it opens its folder', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-dialog-'));
    try {
      const f = path.join(d, 'a.txt');
      fs.writeFileSync(f, 'x');
      expect(await dialogStart({ start: d, home: os.homedir() })).toBe(path.resolve(d));
      expect(await dialogStart({ start: f, home: os.homedir() })).toBe(path.resolve(d));
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('the last pick record', () => {
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  it('round-trips; a missing or broken file reads as nothing', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lastpick-'));
    made.push(d);
    const file = path.join(d, 'folder-dialog.json');
    expect(await readLastPick(file)).toBeUndefined();
    await saveLastPick(file, 'C:\\code\\proj');
    expect(await readLastPick(file)).toBe('C:\\code\\proj');
    fs.writeFileSync(file, '{ broken');
    expect(await readLastPick(file)).toBeUndefined();
    fs.writeFileSync(file, 'null');
    expect(await readLastPick(file)).toBeUndefined();
    // a folder that cannot be written: no throw
    await expect(saveLastPick(path.join(d, 'no', 'such', 'dir', 'f.json'), 'C:\\x')).resolves.toBeUndefined();
  });
});
