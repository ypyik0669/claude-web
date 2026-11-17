import { describe, expect, it } from 'vitest';
import { addPathRefs, isPathRef, planPaste, readable, resolvePaste, snapshotPaste, splitDropped, suspectFolder, type ClipPath, type ClipboardDataLike, type EntryLike, type PasteShell, type PastedItem } from './paste-files';

const file = (name: string, body = 'x', type = '') => new File([body], name, { type });
/** a directory entry with these files in it (enough of the FileSystem API for expandEntries) */
const dirEntry = (name: string, children: { name: string; body?: string }[]): EntryLike & Record<string, unknown> => ({
  isFile: false, isDirectory: true, name,
  createReader: () => {
    let done = false;
    return { readEntries: (res: (l: unknown[]) => void) => { const l = done ? [] : children.map((c) => ({ isFile: true, isDirectory: false, name: c.name, file: (ok: (f: File) => void) => ok(file(c.name, c.body ?? 'y')) })); done = true; res(l); } };
  },
});
const fileEntry = (name: string): EntryLike => ({ isFile: true, isDirectory: false, name });

/** a clipboardData: items of kind 'file' (with an entry or not) plus text */
const clip = (o: { text?: string; files?: { f: File | null; entry?: unknown }[]; html?: boolean }): ClipboardDataLike => ({
  items: [
    ...(o.text !== undefined ? [{ kind: 'string', getAsFile: () => null }] : []),
    ...(o.files ?? []).map((x) => ({ kind: 'file', getAsFile: () => x.f, webkitGetAsEntry: () => x.entry ?? null })),
  ],
  files: (o.files ?? []).map((x) => x.f).filter((f): f is File => !!f),
  getData: (t: string) => (t === 'text/plain' ? o.text ?? '' : ''),
});

describe('snapshotPaste', () => {
  it('takes text, each file with its entry and (desktop) its path', () => {
    const md = file('notes.md');
    const shell: PasteShell = { pathForFile: (f) => (f === md ? 'C:\\d\\notes.md' : '') };
    const s = snapshotPaste(clip({ files: [{ f: md, entry: fileEntry('notes.md') }] }), shell);
    expect(s.text).toBe('');
    expect(s.items).toEqual([{ file: md, entry: fileEntry('notes.md'), path: 'C:\\d\\notes.md' }]);
  });
  it('a pathForFile that throws, a webkitGetAsEntry that throws: just no path / entry', () => {
    const f = file('a.txt');
    const dt: ClipboardDataLike = { items: [{ kind: 'file', getAsFile: () => f, webkitGetAsEntry: () => { throw new Error('x'); } }], getData: () => '' };
    expect(snapshotPaste(dt, { pathForFile: () => { throw new Error('not a File'); } }).items).toEqual([{ file: f, entry: null, path: '' }]);
  });
  it('no items list (an old browser): the files', () => {
    const f = file('a.png', 'p', 'image/png');
    expect(snapshotPaste({ files: [f], getData: () => '' }).items).toEqual([{ file: f, entry: null, path: '' }]);
  });
});

describe('planPaste', () => {
  const s = (text: string, items: PastedItem[]) => ({ text, items });
  const shot: PastedItem = { file: file('image.png', 'p', 'image/png'), entry: null, path: '' };
  it("Explorer's file list: files, even with text beside it", () => {
    expect(planPaste(s('', [{ file: file('a.md'), entry: null, path: 'C:\\a.md' }]), true)).toBe('files');
    expect(planPaste(s('C:\\a.md', [{ file: file('a.md'), entry: fileEntry('a.md'), path: '' }]), false)).toBe('files');
  });
  it('a screenshot alone: files (it goes in as a picture)', () => {
    expect(planPaste(s('', [shot]), true)).toBe('files');
    expect(planPaste(s('', [shot]), false)).toBe('files');
  });
  it('Office: words and a picture of them — the words win', () => {
    expect(planPaste(s('a\tb\nc\td', [shot]), true)).toBe('text');
  });
  it('plain text, whitespace too', () => {
    expect(planPaste(s('hello', []), true)).toBe('text');
    expect(planPaste(s('  ', []), true)).toBe('text');
  });
  it('nothing the page can see: the desktop app asks the shell; a browser leaves it', () => {
    expect(planPaste(s('', []), true)).toBe('ask');
    expect(planPaste(s('', []), false)).toBe('none');
  });
});

describe('suspectFolder / readable', () => {
  it('no size, no type, no extension: what Chromium hands for a pasted folder', () => {
    expect(suspectFolder(new File([], '安装包与工具'))).toBe(true);
    expect(suspectFolder(new File([], 'empty.txt'))).toBe(false);
    expect(suspectFolder(file('Makefile'))).toBe(false);
  });
  it('a file whose first byte reads is readable; one that throws is not', async () => {
    expect(await readable(file('a.md', 'hello'))).toBe(true);
    const broken = file('b.md', 'hello');
    (broken as any).slice = () => ({ arrayBuffer: () => Promise.reject(new Error('NotReadableError')) });
    expect(await readable(broken)).toBe(false);
    expect(await readable(new File([], 'folder'))).toBe(false);
  });
});

describe('resolvePaste — the desktop app', () => {
  const stat: Record<string, ClipPath> = {
    'C:\\Users\\YPY\\Desktop\\安装包与工具': { path: 'C:\\Users\\YPY\\Desktop\\安装包与工具', name: '安装包与工具', dir: true },
    'C:\\d\\notes.md': { path: 'C:\\d\\notes.md', name: 'notes.md', dir: false, size: 5 },
    'C:\\d\\shot.png': { path: 'C:\\d\\shot.png', name: 'shot.png', dir: false, size: 1 },
  };
  const asked: (string[] | undefined)[] = [];
  const shell = (clipboard: ClipPath[] = []): PasteShell => ({
    clipboardFiles: async (paths) => { asked.push(paths); return paths ? paths.map((p) => stat[p]).filter(Boolean) : clipboard; },
  });
  it('a folder goes by its path; a file is uploaded like a dropped one', async () => {
    asked.length = 0;
    const md = file('notes.md', 'hello');
    const r = await resolvePaste([
      { file: new File([], '安装包与工具'), entry: null, path: 'C:\\Users\\YPY\\Desktop\\安装包与工具' },
      { file: md, entry: null, path: 'C:\\d\\notes.md' },
    ], shell());
    expect(asked).toEqual([['C:\\Users\\YPY\\Desktop\\安装包与工具', 'C:\\d\\notes.md']]);
    expect(r.refs).toEqual([stat['C:\\Users\\YPY\\Desktop\\安装包与工具']]);
    expect(r.dropped).toEqual({ files: [{ file: md, rel: 'notes.md' }], folders: [], truncated: false });
    expect(r.unreadable).toEqual([]);
  });
  it('the page was handed nothing: the clipboard list, every one by its path', async () => {
    asked.length = 0;
    const r = await resolvePaste([], shell([stat['C:\\Users\\YPY\\Desktop\\安装包与工具'], stat['C:\\d\\notes.md'], stat['C:\\d\\notes.md']]));
    expect(asked).toEqual([undefined]);
    expect(r.refs.map((c) => c.path)).toEqual(['C:\\Users\\YPY\\Desktop\\安装包与工具', 'C:\\d\\notes.md']);
    expect(r.dropped.files).toEqual([]);
  });
  it('a screenshot (no path) is not asked about; a shell that fails leaves files to upload', async () => {
    asked.length = 0;
    const png = file('image.png', 'p', 'image/png');
    expect((await resolvePaste([{ file: png, entry: null, path: '' }], shell())).dropped.files).toEqual([{ file: png, rel: 'image.png' }]);
    expect(asked).toEqual([]);
    const md = file('a.md', 'hi');
    const r = await resolvePaste([{ file: md, entry: null, path: 'C:\\x\\a.md' }], { clipboardFiles: () => Promise.reject(new Error('gone')) });
    expect(r.dropped.files).toEqual([{ file: md, rel: 'a.md' }]);
  });
  it('a network folder the shell will not look at: walked like a dropped one', async () => {
    const r = await resolvePaste([{ file: new File([], 'share'), entry: dirEntry('share', [{ name: 'r.txt' }]), path: '\\\\nas\\share' }], shell());
    expect(r.refs).toEqual([]);
    expect(r.dropped.folders).toEqual(['share']);
    expect(r.dropped.files.map((d) => d.rel)).toEqual(['share/r.txt']);
  });
});

describe('resolvePaste — a browser', () => {
  it('a folder with a file system entry is expanded like a dropped one; files beside it are uploaded', async () => {
    const md = file('a.md');
    const r = await resolvePaste([
      { file: new File([], 'proj'), entry: dirEntry('proj', [{ name: 'x.ts' }, { name: 'y.ts' }]), path: '' },
      { file: md, entry: fileEntry('a.md'), path: '' },
    ]);
    expect(r.dropped.folders).toEqual(['proj']);
    expect(r.dropped.files.map((d) => d.rel)).toEqual(['a.md', 'proj/x.ts', 'proj/y.ts']);
    expect(r.refs).toEqual([]);
  });
  it('a folder with no entry cannot be read: named, nothing attached', async () => {
    const r = await resolvePaste([{ file: new File([], '安装包与工具'), entry: null, path: '' }]);
    expect(r.unreadable).toEqual(['安装包与工具']);
    expect(r.dropped.files).toEqual([]);
  });
  it('at most `max` files, folders counted in', async () => {
    const r = await resolvePaste([
      { file: file('a.md'), entry: null, path: '' },
      { file: null, entry: dirEntry('big', [{ name: '1' }, { name: '2' }, { name: '3' }]), path: '' },
    ], undefined, 2);
    expect(r.dropped.files.map((d) => d.rel)).toEqual(['a.md', 'big/1']);
    expect(r.dropped.truncated).toBe(true);
  });
});

describe('splitDropped', () => {
  it('lone pictures go as pictures; a picture inside a folder and other files are uploaded', () => {
    const png = { file: file('a.png', 'p', 'image/png'), rel: 'a.png' };
    const inDir = { file: file('b.png', 'p', 'image/png'), rel: 'd/b.png' };
    const md = { file: file('c.md'), rel: 'c.md' };
    expect(splitDropped([png, inDir, md])).toEqual({ images: [png], rest: [inDir, md] });
  });
});

describe('addPathRefs / isPathRef', () => {
  it('folder / file references, one already in the box not added again; a long paste is not a path reference', () => {
    const paste = { kind: 'text' as const, name: 'paste.txt', size: 4000, text: '…' };
    const dir: ClipPath = { path: 'C:\\x\\dir', name: 'dir', dir: true };
    const md: ClipPath = { path: 'C:\\x\\a.md', name: 'a.md', dir: false, size: 9 };
    const once = addPathRefs([paste], [dir, md]);
    expect(once).toEqual([paste, { kind: 'folder', name: 'dir', path: 'C:\\x\\dir' }, { kind: 'file', name: 'a.md', path: 'C:\\x\\a.md', size: 9 }]);
    expect(addPathRefs(once, [dir])).toEqual(once);
    expect(once.map(isPathRef)).toEqual([false, true, true]);
  });
});
