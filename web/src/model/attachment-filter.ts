// Which parts of an attached folder never go to the model: dependencies, VCS internals, build output. One rule for
// a dropped folder (walked entry by entry) and a picked one (+ → 添加文件夹: a flat list with webkitRelativePath).

export const SKIPPED_DIR = /^(node_modules|\.git|dist|build|\.next|target)$/;

/** A directory entry the folder walk skips. */
export const skipDirName = (name: string): boolean => SKIPPED_DIR.test(name);

/** A file whose relative path (`folder/sub/file`, either slash) runs through a skipped directory. */
export function skippedPath(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.slice(0, -1).some(skipDirName);
}

/**
 * A picked folder's files as `{file, rel}` with forward slashes: skipped directories dropped FIRST, then capped —
 * otherwise `.git/objects/*` fills the 500 slots before the first source file.
 */
export function pickFolderFiles<F extends { name: string; webkitRelativePath?: string }>(list: readonly F[], max = 500): { files: { file: F; rel: string }[]; top: string; truncated: boolean; skipped: number } {
  const all = list.map((f) => ({ file: f, rel: (f.webkitRelativePath || f.name).replace(/\\/g, '/') }));
  const kept = all.filter((x) => !skippedPath(x.rel));
  return { files: kept.slice(0, max), top: all[0]?.rel.split('/')[0] ?? '', truncated: kept.length > max, skipped: all.length - kept.length };
}
