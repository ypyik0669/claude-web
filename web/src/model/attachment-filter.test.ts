import { describe, expect, it } from 'vitest';
import { pickFolderFiles, skipDirName, skippedPath } from './attachment-filter';

const f = (rel: string) => ({ name: rel.split('/').pop()!, webkitRelativePath: rel });

describe('attached folders skip dependencies, VCS internals and build output', () => {
  it('the same directory names the drop walk skips', () => {
    for (const d of ['node_modules', '.git', 'dist', 'build', '.next', 'target']) expect(skipDirName(d)).toBe(true);
    for (const d of ['src', 'distance', '.github', 'builder']) expect(skipDirName(d)).toBe(false);
  });
  it('any segment of the path, either slash; a FILE named like a skipped dir is kept', () => {
    expect(skippedPath('app/.git/objects/ab/cd')).toBe(true);
    expect(skippedPath('app\\packages\\x\\node_modules\\y\\index.js')).toBe(true);
    expect(skippedPath('app/src/dist.ts')).toBe(false);
    expect(skippedPath('app/build')).toBe(false); // a file called build
  });
  it('+ → 添加文件夹: filter first, then cap — .git objects cannot eat the 500 slots', () => {
    const git = Array.from({ length: 800 }, (_, i) => f(`app/.git/objects/${i}`));
    const src = [f('app/src/a.ts'), f('app/README.md'), f('app/node_modules/x/i.js')];
    const r = pickFolderFiles([...git, ...src]);
    expect(r.files.map((x) => x.rel)).toEqual(['app/src/a.ts', 'app/README.md']);
    expect(r).toMatchObject({ top: 'app', truncated: false, skipped: 801 });
  });
  it('caps after filtering and says so; backslashes become slashes', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, webkitRelativePath: `app\\src\\f${i}` }));
    const r = pickFolderFiles(many, 5);
    expect(r.files).toHaveLength(5);
    expect(r.truncated).toBe(true);
    expect(r.files[0].rel).toBe('app/src/f0');
  });
  it('no relative path (a plain file input) → the file name', () => {
    expect(pickFolderFiles([{ name: 'x.txt' }]).files[0].rel).toBe('x.txt');
  });
});
