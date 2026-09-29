// gitAdapter against real temporary repositories: the orchestrator must never destroy the user's work.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitService } from '../git/service.js';
import { canonicalPath, gitAdapter } from './git.js';

let tmp: string;
let repo: string;
const g = gitAdapter(new GitService());
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (p: string, s: string) => fs.writeFileSync(p, s);
const exists = (p: string) => fs.existsSync(p);

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@e.x');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
}
/** a branch `side` that changes a.txt, plus main changing it differently → conflict when merged */
function conflictingBranch(dir: string, name = 'side') {
  git(dir, 'checkout', '-q', '-b', name);
  write(path.join(dir, 'a.txt'), 'side\n');
  git(dir, 'commit', '-q', '-am', 'side');
  git(dir, 'checkout', '-q', 'main');
  write(path.join(dir, 'a.txt'), 'main\n');
  git(dir, 'commit', '-q', '-am', 'main');
}
function cleanBranch(dir: string, name: string, file = 'b.txt') {
  git(dir, 'checkout', '-q', '-b', name);
  write(path.join(dir, file), 'b\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', name);
  git(dir, 'checkout', '-q', 'main');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-orch-git-'));
  repo = path.join(tmp, 'repo');
  initRepo(repo);
});
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* a git child may still hold it on Windows */ } });

// real git processes: slow on Windows under a parallel test run
const SLOW = { timeout: 60_000 };

describe('merge preflight (C1)', SLOW, () => {
  it("refuses while the user has their own merge in progress — and leaves that merge alone", async () => {
    conflictingBranch(repo, 'theirs');
    cleanBranch(repo, 'cw/x');
    // the user merges, resolves and stages but hasn't committed yet
    expect(() => git(repo, 'merge', 'theirs')).toThrow();
    write(path.join(repo, 'a.txt'), 'resolved\n');
    git(repo, 'add', 'a.txt');
    const r = await g.merge(repo, 'cw/x', 'orchestra merge');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe('busy');
    expect(exists(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('resolved\n');
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('a.txt');
  });

  it('refuses during a rebase / cherry-pick too', async () => {
    cleanBranch(repo, 'cw/x');
    fs.mkdirSync(path.join(repo, '.git', 'rebase-merge'));
    expect(await g.merge(repo, 'cw/x', 'm')).toMatchObject({ ok: false, kind: 'busy' });
    fs.rmSync(path.join(repo, '.git', 'rebase-merge'), { recursive: true });
    write(path.join(repo, '.git', 'CHERRY_PICK_HEAD'), git(repo, 'rev-parse', 'HEAD'));
    expect(await g.merge(repo, 'cw/x', 'm')).toMatchObject({ ok: false, kind: 'busy' });
  });

  it('refuses when the index has staged changes (they would be swept into the merge commit)', async () => {
    cleanBranch(repo, 'cw/x');
    write(path.join(repo, 'staged.txt'), 's\n');
    git(repo, 'add', 'staged.txt');
    expect(await g.merge(repo, 'cw/x', 'm')).toMatchObject({ ok: false, kind: 'dirty' });
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('staged.txt');
  });

  it('a conflict it caused is aborted: no MERGE_HEAD, working tree back to main', async () => {
    conflictingBranch(repo, 'cw/x');
    const r = await g.merge(repo, 'cw/x', 'm');
    expect(r).toMatchObject({ ok: false, kind: 'conflict' });
    expect(exists(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('main\n');
  });

  it("a dirty base working tree the merge would overwrite: refused, the user's edit survives", async () => {
    git(repo, 'checkout', '-q', '-b', 'cw/x');
    write(path.join(repo, 'a.txt'), 'branch\n');
    git(repo, 'commit', '-q', '-am', 'x');
    git(repo, 'checkout', '-q', 'main');
    write(path.join(repo, 'a.txt'), 'my unsaved edit\n');
    const r = await g.merge(repo, 'cw/x', 'm');
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('my unsaved edit\n');
  });

  it('unrelated unstaged edits in the base do not block a clean merge (and survive it)', async () => {
    cleanBranch(repo, 'cw/x');
    write(path.join(repo, 'a.txt'), 'wip\n');
    expect(await g.merge(repo, 'cw/x', 'm')).toEqual({ ok: true });
    expect(git(repo, 'log', '--merges', '--oneline').split('\n').filter(Boolean)).toHaveLength(1);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('wip\n');
  });

  it('works from a subdirectory and from a linked worktree (--git-path)', async () => {
    fs.mkdirSync(path.join(repo, 'sub'));
    cleanBranch(repo, 'cw/x');
    conflictingBranch(repo, 'theirs');
    expect(() => git(repo, 'merge', 'theirs')).toThrow();
    expect(await g.merge(path.join(repo, 'sub'), 'cw/x', 'm')).toMatchObject({ ok: false, kind: 'busy' });
    git(repo, 'merge', '--abort');
    // a linked worktree keeps MERGE_HEAD in .git/worktrees/<name>/, not in the main .git
    const linked = path.join(tmp, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'lk', linked, 'main~1');
    write(path.join(linked, 'a.txt'), 'linked\n');
    git(linked, 'commit', '-q', '-am', 'lk');
    expect(() => git(linked, 'merge', 'theirs')).toThrow();
    expect(await g.merge(linked, 'cw/x', 'm')).toMatchObject({ ok: false, kind: 'busy' });
    expect(git(linked, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')).not.toBe('');
  });
});

describe('worktrees are never deleted behind the user’s back (C2 / I1)', SLOW, () => {
  it('worktreeAdd refuses an existing directory or branch instead of deleting it', async () => {
    const dir = path.join(tmp, 'wt', 'one');
    await g.worktreeAdd(repo, dir, 'cw/r/one', 'main');
    write(path.join(dir, 'keep.txt'), 'precious\n');
    expect(await g.free(repo, dir, 'cw/r/other')).toBe(false);
    expect(await g.free(repo, path.join(tmp, 'wt', 'two'), 'cw/r/one')).toBe(false);
    expect(await g.free(repo, path.join(tmp, 'wt', 'two'), 'cw/r/two')).toBe(true);
    await expect(g.worktreeAdd(repo, dir, 'cw/r/one', 'main')).rejects.toThrow();
    await expect(g.worktreeAdd(repo, path.join(tmp, 'wt', 'three'), 'cw/r/one', 'main')).rejects.toThrow();
    expect(fs.readFileSync(path.join(dir, 'keep.txt'), 'utf8')).toBe('precious\n');
  });

  it('inspect reports dirty worktrees, unmerged commits and the branch tip', async () => {
    const dir = path.join(tmp, 'wt', 'one');
    await g.worktreeAdd(repo, dir, 'cw/r/one', 'main');
    expect(await g.inspect(repo, dir, 'cw/r/one', 'main')).toMatchObject({ exists: true, dirty: false, branchExists: true, unmerged: 0 });
    write(path.join(dir, 'new.txt'), 'x\n');
    expect((await g.inspect(repo, dir, 'cw/r/one', 'main')).dirty).toBe(true);
    expect(await g.commitAll(dir, 'c')).toBe(true);
    const info = await g.inspect(repo, dir, 'cw/r/one', 'main');
    expect(info).toMatchObject({ dirty: false, unmerged: 1 });
    expect(info.tip).toBe(await g.head(dir));
    expect(await g.inspect(repo, path.join(tmp, 'nope'), 'cw/none', 'main')).toMatchObject({ exists: false, branchExists: false, unmerged: 0 });
  });

  it('worktreeRemove refuses a dirty worktree and keeps its files', async () => {
    const dir = path.join(tmp, 'wt', 'one');
    await g.worktreeAdd(repo, dir, 'cw/r/one', 'main');
    write(path.join(dir, 'wip.txt'), 'wip\n');
    await expect(g.worktreeRemove(repo, dir)).rejects.toThrow();
    expect(fs.readFileSync(path.join(dir, 'wip.txt'), 'utf8')).toBe('wip\n');
    fs.rmSync(path.join(dir, 'wip.txt'));
    await g.worktreeRemove(repo, dir);
    expect(exists(dir)).toBe(false);
  });

  it('deleteBranch without force keeps a branch with unmerged commits', async () => {
    cleanBranch(repo, 'cw/x');
    await expect(g.deleteBranch(repo, 'cw/x', false)).rejects.toThrow();
    expect(git(repo, 'branch', '--list', 'cw/x')).toContain('cw/x');
  });

  it('a failed worktree add removes the branch it just created (still at base) and its directory (N6)', async () => {
    const hooks = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    write(path.join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(hooks, 'post-checkout'), 0o755);
    const dir = path.join(tmp, 'wt', 'fails');
    await expect(g.worktreeAdd(repo, dir, 'cw/r/fails', 'main')).rejects.toThrow();
    expect(git(repo, 'branch', '--list', 'cw/r/fails')).toBe('');
    expect(exists(dir)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('fails');
  });

  it('inspect tells a broken git link from a dirty worktree, and repairs a moved repo first (N2)', async () => {
    const dir = path.join(tmp, 'wt', 'one');
    await g.worktreeAdd(repo, dir, 'cw/r/one', 'main');
    // the repo is moved: the worktree's back-link is stale until `git worktree repair`
    const moved = path.join(tmp, 'moved');
    fs.renameSync(repo, moved);
    const info = await g.inspect(moved, dir, 'cw/r/one', 'main');
    expect(info).toMatchObject({ exists: true, linked: true, dirty: false });
    // a directory git doesn't know at all (registration pruned away): broken, not "dirty"
    const stray = path.join(tmp, 'wt', 'stray');
    fs.mkdirSync(stray, { recursive: true });
    write(path.join(stray, '.git'), 'gitdir: /nowhere/.git/worktrees/stray\n');
    expect(await g.inspect(moved, stray, 'cw/r/stray', 'main')).toMatchObject({ exists: true, linked: false });
  });

  it('orphan: reports the owning repo / dirty state, or a broken link it cannot vouch for (N2)', async () => {
    const dir = path.join(tmp, 'wt', 'orph');
    await g.worktreeAdd(repo, dir, 'cw/r/orph', 'main');
    const o = await g.orphan(dir);
    expect(o).toMatchObject({ broken: false, dirty: false, branch: 'cw/r/orph' });
    // git reports the repo resolved (macOS: /private/var/folders/… for a /var/folders/… temp dir; Windows: an 8.3
    // short name like RUNNER~1 expanded — only the native realpath does that, the JS fs.realpathSync keeps it)
    expect(path.resolve(o.root!).toLowerCase()).toBe(fs.realpathSync.native(repo).toLowerCase());
    write(path.join(dir, 'x.txt'), 'x\n');
    expect((await g.orphan(dir)).dirty).toBe(true);
    const stray = path.join(tmp, 'wt', 'stray');
    fs.mkdirSync(stray, { recursive: true });
    write(path.join(stray, '.git'), 'gitdir: /nowhere/.git/worktrees/stray\n');
    expect((await g.orphan(stray)).broken).toBe(true);
  });

  // macOS: os.tmpdir() is /var/folders/…, a symlink to /private/var/folders/…, and git lists worktrees resolved
  it('a worktree reached through a symlinked path is still linked, and its dirty state is seen', async () => {
    const link = path.join(os.tmpdir(), `cw-orch-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(tmp, link, 'junction');
    try {
      const viaRepo = path.join(link, 'repo');
      const dir = path.join(link, 'wt', 'one');
      expect(await g.free(viaRepo, dir, 'cw/r/one')).toBe(true);
      await g.worktreeAdd(viaRepo, dir, 'cw/r/one', 'main');
      expect(await g.free(viaRepo, dir, 'cw/r/one')).toBe(false);
      expect(await g.inspect(viaRepo, dir, 'cw/r/one', 'main')).toMatchObject({ exists: true, linked: true, dirty: false });
      write(path.join(dir, 'new.txt'), 'x\n');
      expect(await g.inspect(viaRepo, dir, 'cw/r/one', 'main')).toMatchObject({ linked: true, dirty: true });
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('canonicalPath resolves the existing part of a path and keeps a missing tail', async () => {
    const link = path.join(os.tmpdir(), `cw-orch-canon-${process.pid}-${Date.now()}`);
    fs.symlinkSync(tmp, link, 'junction');
    try {
      const real = fs.realpathSync.native(tmp); // what canonicalPath's fs.promises.realpath gives (8.3 names expanded)
      expect((await canonicalPath(path.join(link, 'repo'))).toLowerCase()).toBe(path.join(real, 'repo').toLowerCase());
      expect((await canonicalPath(path.join(link, 'no', 'such'))).toLowerCase()).toBe(path.join(real, 'no', 'such').toLowerCase());
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('diffStat / diff compare the branch with the base (three-dot)', async () => {
    cleanBranch(repo, 'cw/x');
    const st = await g.diffStat(repo, 'main', 'cw/x');
    expect(st.files).toBe(1);
    expect(st.stat).toContain('b.txt');
    expect(await g.diff(repo, 'main', 'cw/x')).toContain('+b');
  });
});
