import { describe, expect, it } from 'vitest';
import { MAX_CLIP_PATHS, baseName, clipboardPaths, describePaths, parseFileNameW, parseFileUrls, parseFilenamesPlist, pastedFiles, rawFormatName, type ClipboardReader } from './clipboard-files';

const utf16 = (s: string) => Buffer.from(s, 'utf16le');

describe('parseFileNameW (Windows FileNameW)', () => {
  it('UTF-16LE, NUL-terminated, Chinese names intact', () => {
    expect(parseFileNameW(utf16('C:\\Users\\YPY\\Desktop\\安装包与工具\0'))).toEqual(['C:\\Users\\YPY\\Desktop\\安装包与工具']);
  });
  it('several NUL-separated names; empty / missing buffers', () => {
    expect(parseFileNameW(utf16('C:\\a.md\0D:\\b\0\0'))).toEqual(['C:\\a.md', 'D:\\b']);
    expect(parseFileNameW(Buffer.alloc(0))).toEqual([]);
    expect(parseFileNameW(undefined)).toEqual([]);
  });
});

describe('parseFilenamesPlist (macOS NSFilenamesPboardType)', () => {
  it('every <string> of the array, entities decoded', () => {
    const xml = '<?xml version="1.0"?><plist version="1.0"><array>\n\t<string>/Users/a/Desktop/安装包</string>\n\t<string>/Users/a/R&amp;D &#x41;.md</string>\n</array></plist>';
    expect(parseFilenamesPlist(xml)).toEqual(['/Users/a/Desktop/安装包', '/Users/a/R&D A.md']);
  });
  it('nothing there', () => {
    expect(parseFilenamesPlist('')).toEqual([]);
    expect(parseFilenamesPlist(undefined)).toEqual([]);
  });
});

describe('parseFileUrls (public.file-url / text/uri-list)', () => {
  it('posix: percent-decoded, a folder loses its trailing slash', () => {
    expect(parseFileUrls('file:///Users/a/My%20Dir/\n', 'darwin')).toEqual(['/Users/a/My Dir']);
    expect(parseFileUrls('file:///Users/a/%E5%AE%89%E8%A3%85.md', 'darwin')).toEqual(['/Users/a/安装.md']);
  });
  it('windows: a drive path with backslashes', () => {
    expect(parseFileUrls('file:///C:/Users/YPY/a.md', 'win32')).toEqual(['C:\\Users\\YPY\\a.md']);
  });
  it("comments, gnome's copy / cut line and non-file URLs are skipped", () => {
    expect(parseFileUrls('# a comment\r\ncopy\nfile:///home/a/x\r\nhttps://example.com/\n', 'linux')).toEqual(['/home/a/x']);
  });
  it('a root keeps its slash', () => {
    expect(parseFileUrls('file:///', 'linux')).toEqual(['/']);
  });
});

describe('rawFormatName', () => {
  it("Electron's raw platform format types; MIME types are not", () => {
    expect(rawFormatName('electron application/osclipboard;format="FileNameW"')).toBe('FileNameW');
    expect(rawFormatName('Electron Application/OSClipboard; format=public.file-url')).toBe('public.file-url');
    expect(rawFormatName('text/uri-list')).toBeNull();
  });
});

describe('clipboardPaths (Electron 44: read() → ClipboardItem[])', () => {
  const raw = (f: string) => `electron application/osclipboard;format="${f}"`;
  /** one item; values as Blobs (what getType gives), types = its keys; getType rejects any other type */
  const reader = (data: Record<string, string | Buffer>): ClipboardReader => ({
    read: async () => [{
      types: Object.keys(data),
      getType: async (t: string) => { if (!(t in data)) throw new Error('not present'); return new Blob([data[t]]); },
    }],
  });
  it('text/uri-list first: every file of the copy, on any system', async () => {
    const r = reader({ 'text/uri-list': 'file:///C:/a/one.md\r\nfile:///C:/a/two', [raw('FileNameW')]: utf16('C:\\a\\one.md\0') });
    expect(await clipboardPaths(r, 'win32')).toEqual(['C:\\a\\one.md', 'C:\\a\\two']);
  });
  it('Windows: else FileNameW (the first file)', async () => {
    expect(await clipboardPaths(reader({ [raw('FileNameW')]: utf16('C:\\x\\安装包与工具\0') }), 'win32')).toEqual(['C:\\x\\安装包与工具']);
  });
  it('macOS: the plist (every file), else the one file URL', async () => {
    expect(await clipboardPaths(reader({ [raw('NSFilenamesPboardType')]: '<array><string>/a</string><string>/b</string></array>', [raw('public.file-url')]: 'file:///a' }), 'darwin')).toEqual(['/a', '/b']);
    expect(await clipboardPaths(reader({ [raw('public.file-url')]: 'file:///Users/a/x/' }), 'darwin')).toEqual(['/Users/a/x']);
  });
  it('Linux: uri-list, else gnome', async () => {
    expect(await clipboardPaths(reader({ [raw('text/uri-list')]: 'file:///home/a/b' }), 'linux')).toEqual(['/home/a/b']);
    expect(await clipboardPaths(reader({ [raw('x-special/gnome-copied-files')]: 'copy\nfile:///home/a/c' }), 'linux')).toEqual(['/home/a/c']);
  });
  it("text, a picture, another system's format: nothing", async () => {
    expect(await clipboardPaths(reader({ 'text/plain': 'C:\\not\\a\\file\\list', 'image/png': Buffer.from([1, 2]) }), 'win32')).toEqual([]);
    expect(await clipboardPaths(reader({ [raw('FileNameW')]: utf16('C:\\x\0') }), 'darwin')).toEqual([]);
  });
  it('a clipboard that throws, or an item whose read fails, is just empty', async () => {
    expect(await clipboardPaths({ read: async () => { throw new Error('x'); } }, 'win32')).toEqual([]);
    expect(await clipboardPaths({ read: async () => [{ types: ['text/uri-list'], getType: async () => { throw new Error('gone'); } }] }, 'win32')).toEqual([]);
  });
});

describe('baseName', () => {
  it('either slash, trailing ones ignored, a root kept', () => {
    expect(baseName('C:\\Users\\YPY\\Desktop\\安装包与工具')).toBe('安装包与工具');
    expect(baseName('/Users/a/x/')).toBe('x');
    expect(baseName('C:\\')).toBe('C:');
    expect(baseName('/')).toBe('/');
  });
});

describe('describePaths', () => {
  const fs: Record<string, { dir: boolean; size: number }> = {
    'C:\\a\\folder': { dir: true, size: 0 },
    'C:\\a\\notes.md': { dir: false, size: 67_481 },
    '/Users/a/x': { dir: true, size: 4096 },
  };
  const stat = (p: string) => {
    const e = fs[p];
    if (!e) throw new Error('ENOENT');
    return { isDirectory: () => e.dir, size: e.size };
  };
  it('folders without a size, files with theirs', () => {
    expect(describePaths(['C:\\a\\folder', 'C:\\a\\notes.md', '/Users/a/x'], stat)).toEqual([
      { path: 'C:\\a\\folder', name: 'folder', dir: true },
      { path: 'C:\\a\\notes.md', name: 'notes.md', dir: false, size: 67_481 },
      { path: '/Users/a/x', name: 'x', dir: true },
    ]);
  });
  it('network paths, relative paths, non-strings, repeats and missing files are left out', () => {
    let asked: string[] = [];
    const spy = (p: string) => { asked.push(p); return stat(p); };
    expect(describePaths(['\\\\host\\share\\x', '//host/x', 'rel\\x', 42, null, 'C:\\a\\folder', 'C:\\a\\folder', 'C:\\gone'], spy)).toEqual([{ path: 'C:\\a\\folder', name: 'folder', dir: true }]);
    // a network path is never even stat'ed (that alone would make Windows connect)
    expect(asked).toEqual(['C:\\a\\folder', 'C:\\gone']);
    asked = [];
  });
  it(`at most ${MAX_CLIP_PATHS} looked at`, () => {
    const many = Array.from({ length: MAX_CLIP_PATHS + 20 }, (_, i) => `C:\\f${i}`);
    let n = 0;
    describePaths(many, () => { n++; return { isDirectory: () => false, size: 1 }; });
    expect(n).toBe(MAX_CLIP_PATHS);
  });
});

describe('pastedFiles', () => {
  const stat = (p: string) => ({ isDirectory: () => p.endsWith('dir'), size: 5 });
  let reads = 0;
  const cb: ClipboardReader = {
    read: async () => { reads++; return [{ types: ['electron application/osclipboard;format="FileNameW"'], getType: async () => new Blob([utf16('C:\\clip\\dir\0')]) }]; },
  };
  it("the page's paths win (they are the whole list); the clipboard is not read", async () => {
    reads = 0;
    expect(await pastedFiles(['C:\\p\\a.md', 'C:\\p\\dir'], cb, 'win32', stat)).toEqual([
      { path: 'C:\\p\\a.md', name: 'a.md', dir: false, size: 5 },
      { path: 'C:\\p\\dir', name: 'dir', dir: true },
    ]);
    expect(reads).toBe(0);
  });
  it("none given (or junk): the clipboard's own list", async () => {
    expect(await pastedFiles(undefined, cb, 'win32', stat)).toEqual([{ path: 'C:\\clip\\dir', name: 'dir', dir: true }]);
    expect(await pastedFiles([1, ''], cb, 'win32', stat)).toEqual([{ path: 'C:\\clip\\dir', name: 'dir', dir: true }]);
  });
});
