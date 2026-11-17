// Which parts of an attached folder never go to the model: dependencies, VCS internals, build output — skipped by the
// walk of a dropped / pasted folder (attachments.ts `expandEntries`: entry by entry, at most 500 files). (+ → 添加文件夹
// no longer uploads a folder: it adds it to the conversation's working directories, extra-dirs.ts.)

export const SKIPPED_DIR = /^(node_modules|\.git|dist|build|\.next|target)$/;

/** A directory entry the folder walk skips. */
export const skipDirName = (name: string): boolean => SKIPPED_DIR.test(name);
