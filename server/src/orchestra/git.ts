// The git seam of the orchestrator. Rule of thumb for everything here: never destroy the user's work.
// No `--force`, no `-D` unless the caller proved the branch holds nothing but what it created, no
// `merge --abort` of a merge that isn't ours.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { GitService } from '../git/service.js';

export type MergeResult = { ok: true } | { ok: false; kind: 'busy' | 'dirty' | 'conflict' | 'failed'; error: string };
/** `linked`: git still knows the directory as a worktree of this repo (after prune + repair). */
export interface WorktreeInfo { exists: boolean; linked: boolean; dirty: boolean; branchExists: boolean; tip?: string; unmerged: number }
/** A directory under the worktree root that no run record references any more. */
export interface OrphanInfo { broken: boolean; root?: string; dirty?: boolean; branch?: string }

export interface OrchGit {
  root(cwd: string): Promise<string | null>;
  currentBranch(cwd: string): Promise<string | null>;
  /** neither the directory nor the branch exists yet */
  free(root: string, dir: string, branch: string): Promise<boolean>;
  /** add `dir` on a new `branch` from `from`; throws when either already exists — it never deletes anything */
  worktreeAdd(root: string, dir: string, branch: string, from: string): Promise<void>;
  /** commit everything in `dir`; false when there was nothing to commit */
  commitAll(dir: string, message: string): Promise<boolean>;
  head(dir: string): Promise<string>;
  diffStat(root: string, base: string, branch: string): Promise<{ stat: string; files: number }>;
  diff(root: string, base: string, branch: string): Promise<string>;
  /**
   * `merge --no-ff` into whatever `cwd` has checked out. Refused (kind `busy`) while a merge / rebase /
   * cherry-pick / revert of the user's is in progress and (kind `dirty`) while the index has staged changes;
   * a conflict this merge caused is aborted — nothing else ever is.
   */
  merge(cwd: string, branch: string, message: string): Promise<MergeResult>;
  /** prunes stale registrations and repairs links (moved repo) before looking */
  inspect(root: string, dir: string, branch: string, base: string): Promise<WorktreeInfo>;
  orphan(dir: string): Promise<OrphanInfo>;
  /** plain `git worktree remove` (no --force): refuses a dirty worktree */
  worktreeRemove(root: string, dir: string): Promise<void>;
  /** `branch -d` (refuses unmerged commits), or `-D` when `force` */
  deleteBranch(root: string, branch: string, force: boolean): Promise<void>;
}

const FALLBACK_IDENTITY = ['-c', 'user.name=claude-web', '-c', 'user.email=claude-web@localhost'];
const IN_PROGRESS: [string, string][] = [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert'], ['rebase-merge', 'rebase'], ['rebase-apply', 'rebase / am']];

const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const errText = (e: any) => String(e?.info?.message ?? e?.message ?? e).split('\n').filter(Boolean).slice(0, 6).join('\n');

/**
 * `p` with symlinks resolved as far as it exists (a missing tail is kept as written). git prints worktree
 * paths resolved — on macOS a `/var/folders/…` or `/tmp/…` directory is listed as `/private/var/folders/…`
 * — so a path we hold is only comparable to git's after this. Exported for tests.
 */
export async function canonicalPath(p: string): Promise<string> {
  let head = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(head), ...tail); } catch { /* missing: resolve the parent */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail.unshift(path.basename(head));
    head = up;
  }
}

export function gitAdapter(git: GitService): OrchGit {
  const identityRetry = async <T>(fn: (pre: string[]) => Promise<T>): Promise<T> => {
    try { return await fn([]); } catch (e: any) {
      if (e?.info?.kind !== 'identity') throw e;
      return fn(FALLBACK_IDENTITY);
    }
  };
  /** `$GIT_DIR/<name>` for this checkout (linked worktrees have their own), resolved against cwd */
  const gitPath = async (cwd: string, name: string) => path.resolve(cwd, (await git.run(cwd, ['rev-parse', '--git-path', name])).stdout.trim());
  const inProgress = async (cwd: string): Promise<string | null> => {
    for (const [name, label] of IN_PROGRESS) if (await exists(await gitPath(cwd, name))) return label;
    return null;
  };
  const branchExists = (root: string, branch: string) => git.run(root, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).then((r) => r.stdout.trim() || undefined, () => undefined);
  // compared resolved: with a symlinked prefix (macOS /var → /private/var) every worktree would otherwise read
  // as "not linked" — inspect() never looks at its dirty state and cleanup keeps it as a broken git link
  const registered = async (root: string, dir: string) => {
    const want = (await canonicalPath(dir)).toLowerCase();
    for (const w of await git.worktrees(root).catch(() => [])) if ((await canonicalPath(w.path)).toLowerCase() === want) return true;
    return false;
  };

  return {
    root: (cwd) => git.root(cwd),
    async currentBranch(cwd) {
      const r = await git.run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null);
      return r?.stdout.trim() || null;
    },
    async free(root, dir, branch) {
      return !(await exists(dir)) && !(await branchExists(root, branch)) && !(await registered(root, dir));
    },
    async worktreeAdd(root, dir, branch, from) {
      if (await exists(dir)) throw new Error(`目录已存在，不会覆盖：${dir}`);
      if (await branchExists(root, branch)) throw new Error(`分支已存在，不会覆盖：${branch}`);
      const base = (await git.run(root, ['rev-parse', '--verify', `${from}^{commit}`])).stdout.trim();
      await fs.mkdir(path.dirname(dir), { recursive: true });
      try {
        await git.run(root, [...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []), 'worktree', 'add', '-b', branch, dir, from]);
      } catch (e) {
        // `-b` creates the branch before the checkout: a failure after that leaves it (and a half-made
        // directory) behind. Both were just created by this call (checked above), so they can go —
        // the branch only while it still points at the base it was made from.
        if (await registered(root, dir)) await git.run(root, ['worktree', 'remove', '--force', dir]).catch(() => {});
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
        await git.run(root, ['worktree', 'prune']).catch(() => {});
        if ((await branchExists(root, branch)) === base) await git.run(root, ['branch', '-D', branch]).catch(() => {});
        throw e;
      }
      git.emit('changed', root);
    },
    async commitAll(dir, message) {
      await git.run(dir, ['add', '-A']);
      const { stdout } = await git.run(dir, ['status', '--porcelain']);
      if (!stdout.trim()) return false;
      await identityRetry((pre) => git.run(dir, [...pre, 'commit', '-q', '-F', '-'], { input: message }));
      return true;
    },
    async head(dir) { return (await git.run(dir, ['rev-parse', 'HEAD'])).stdout.trim(); },
    async diffStat(root, base, branch) {
      const range = `${base}...${branch}`;
      const { stdout: stat } = await git.run(root, ['diff', '--stat', range]);
      const { stdout: names } = await git.run(root, ['diff', '--name-only', range]);
      return { stat: stat.trimEnd(), files: names.split('\n').filter(Boolean).length };
    },
    async diff(root, base, branch) { return (await git.run(root, ['diff', `${base}...${branch}`])).stdout; },
    async merge(cwd, branch, message) {
      const busy = await inProgress(cwd);
      if (busy) return { ok: false, kind: 'busy', error: `工作目录里有你自己进行中的 ${busy}：先完成（或放弃）它，再回来合并` };
      const staged = (await git.run(cwd, ['diff', '--cached', '--name-only'])).stdout.trim();
      if (staged) return { ok: false, kind: 'dirty', error: `暂存区里有未提交的改动（${staged.split('\n').slice(0, 3).join('、')}…）：先提交或取消暂存，再回来合并` };
      try {
        await identityRetry((pre) => git.run(cwd, [...pre, 'merge', '--no-ff', '-q', '-m', message, branch]));
        git.emit('changed', cwd);
        return { ok: true };
      } catch (e: any) {
        // there was no merge in progress before (checked above): a MERGE_HEAD now is ours to undo
        if (await exists(await gitPath(cwd, 'MERGE_HEAD'))) {
          await git.run(cwd, ['merge', '--abort']).catch(() => {});
          git.emit('changed', cwd);
          return { ok: false, kind: 'conflict', error: `合并冲突，已撤销这次合并：${errText(e)}` };
        }
        return { ok: false, kind: 'failed', error: errText(e) };
      }
    },
    async inspect(root, dir, branch, base) {
      await git.run(root, ['worktree', 'prune']).catch(() => {});
      const there = await exists(dir);
      const ok = async () => (await registered(root, dir)) && (await git.run(dir, ['rev-parse', '--git-dir']).then(() => true, () => false));
      let linked = there && (await ok());
      if (there && !linked) {
        // the repo (or the worktree) was moved: repair re-points both links, then look again
        await git.run(root, ['worktree', 'repair', dir]).catch(() => {});
        linked = await ok();
      }
      const dirty = there && linked ? !!(await git.run(dir, ['status', '--porcelain']).then((r) => r.stdout.trim(), () => 'unknown')) : false;
      const tip = await branchExists(root, branch);
      const unmerged = tip ? Number((await git.run(root, ['rev-list', '--count', `${base}..${branch}`]).catch(() => ({ stdout: '1' }))).stdout.trim()) || 0 : 0;
      return { exists: there, linked, dirty, branchExists: !!tip, tip, unmerged };
    },
    async orphan(dir) {
      const common = await git.run(dir, ['rev-parse', '--git-common-dir']).then((r) => r.stdout.trim(), () => null);
      const status = common ? await git.run(dir, ['status', '--porcelain']).then((r) => r.stdout, () => null) : null;
      if (!common || status === null) return { broken: true };
      const branch = await git.run(dir, ['symbolic-ref', '--short', '-q', 'HEAD']).then((r) => r.stdout.trim() || undefined, () => undefined);
      return { broken: false, root: path.dirname(path.resolve(dir, common)), dirty: !!status.trim(), branch };
    },
    async worktreeRemove(root, dir) {
      await git.run(root, ['worktree', 'remove', dir]);
      // git has unregistered it; a just-closed agent process may still hold the directory on Windows
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
      git.emit('changed', root);
    },
    async deleteBranch(root, branch, force) { await git.run(root, ['branch', force ? '-D' : '-d', branch]); },
  };
}
