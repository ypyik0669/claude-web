import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyGitError, parseStatusV2z, resolveGitDir } from './service.js';

describe('classifyGitError', () => {
  const cases: [string, string][] = [
    ['fatal: not a git repository (or any of the parent directories): .git', 'not_repo'],
    ['fatal: The current branch feature has no upstream branch.\nTo push the current branch and set the remote as upstream, use', 'no_upstream'],
    ['remote: Invalid username or password.\nfatal: Authentication failed for https://github.com/x/y.git', 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ['! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', 'rejected'],
    ['CONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.', 'conflict'],
    ['error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches.', 'dirty'],
    ['nothing to commit, working tree clean', 'nothing_to_commit'],
    ['Author identity unknown\n*** Please tell me who you are.', 'identity'],
    ["fatal: Unable to create 'C:/x/.git/index.lock': File exists.", 'lock'],
    ['fatal: refusing to merge unrelated histories', 'unrelated'],
    ["fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com", 'network'],
    ["fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.", 'unknown_rev'],
    ["fatal: a branch named 'feature' already exists", 'exists'],
    ['something completely different', 'unknown'],
  ];
  for (const [stderr, kind] of cases) it(`${kind}`, () => expect(classifyGitError(stderr).kind).toBe(kind));
  it('keeps the tail of the message and adds a hint', () => {
    const e = classifyGitError('line1\nline2\nfatal: The current branch x has no upstream branch.');
    expect(e.message).toContain('no upstream');
    expect(e.hint).toContain('push -u');
  });
});

describe('porcelain v2 -z', () => {
  it('parses branch headers, renames (origPath is its own field), conflicts, untracked and odd names', () => {
    const out = [
      '# branch.oid 0123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb dir/with space.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts', 'old\tname.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? quote"and\slash.txt',
      '',
    ].join('\0');
    const st: any = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [] };
    parseStatusV2z(out, st);
    expect(st).toMatchObject({ branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, detached: false });
    expect(st.files).toEqual([
      { path: 'dir/with space.ts', from: undefined, status: 'modified', staged: false, unstaged: true },
      { path: 'new name.ts', from: 'old\tname.ts', status: 'renamed', staged: true, unstaged: false },
      { path: 'conflict.ts', status: 'conflict', staged: false, unstaged: true },
      { path: 'quote"and\slash.txt', status: 'untracked', staged: false, unstaged: true },
    ]);
  });

  it('detached head', () => {
    const st: any = { branch: 'x', upstream: null, ahead: 0, behind: 0, detached: false, files: [] };
    parseStatusV2z('# branch.head (detached)\0', st);
    expect(st.branch).toBeNull();
    expect(st.detached).toBe(true);
  });
});

describe('resolveGitDir', () => {
  it('follows a relative `gitdir:` file (submodules) relative to the worktree, not process.cwd()', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-gitdir-'));
    try {
      const wt = path.join(base, 'sub');
      await fs.mkdir(wt, { recursive: true });
      await fs.writeFile(path.join(wt, '.git'), 'gitdir: ../.git/modules/sub\n');
      expect(await resolveGitDir(wt)).toBe(path.join(base, '.git', 'modules', 'sub'));
      expect(await resolveGitDir(base)).toBe(path.join(base, '.git'));
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

describe('GitService.status process count and stash count', () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const setup = async () => {
    const { execFileSync } = await import('node:child_process');
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-gitst-')));
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, windowsHide: true, stdio: 'ignore', env });
    git(base, 'init', '-q');
    await fs.writeFile(path.join(base, 'a.txt'), '1\n');
    git(base, 'add', '-A');
    git(base, 'commit', '-q', '-m', 'init');
    const stash = async (n: number) => { for (let i = 0; i < n; i++) { await fs.writeFile(path.join(base, 'a.txt'), `s${i}\n`); git(base, 'stash', '-q'); } };
    return { base, git, stash };
  };
  const counting = async () => {
    const { GitService } = await import('./service.js');
    const svc = new GitService();
    const runs: string[][] = [];
    const run = svc.run.bind(svc);
    svc.run = (cwd, args, opts) => { runs.push(args); return run(cwd, args, opts); };
    return { svc, runs };
  };

  it('never asks git for --show-stash: git 2.14–2.34 accepts it but prints no `# stash` line, older git rejects it', async () => {
    const { base, stash } = await setup();
    try {
      await stash(1);
      const { svc, runs } = await counting();
      await svc.status(base);
      expect(runs.flat()).not.toContain('--show-stash');
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  it('counts stashes from the stash reflog: 0, 2, after a drop, after a clear', async () => {
    const { base, git, stash } = await setup();
    try {
      const { svc } = await counting();
      expect((await svc.status(base)).stashes).toBe(0);
      await stash(2);
      expect((await svc.status(base)).stashes).toBe(2);
      git(base, 'stash', 'drop', '-q');
      expect((await svc.status(base)).stashes).toBe(1);
      git(base, 'stash', 'clear');
      expect((await svc.status(base)).stashes).toBe(0);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });

  it('a linked worktree sees the stashes of the common dir', async () => {
    const { base, git, stash } = await setup();
    const wt = `${base}-wt`;
    try {
      await stash(2);
      git(base, 'worktree', 'add', '-q', wt, '-b', 'wt');
      const { svc } = await counting();
      expect((await svc.status(wt)).stashes).toBe(2);
    } finally {
      await fs.rm(wt, { recursive: true, force: true });
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('one git process per status once the root is known; the answer matches a fresh service', async () => {
    const { base, stash } = await setup();
    try {
      await stash(1);
      await fs.writeFile(path.join(base, 'b.txt'), 'new\n');
      const { svc, runs } = await counting();
      const first = await svc.status(base);
      expect(first).toMatchObject({ stashes: 1, files: [{ path: 'b.txt', status: 'untracked' }] });
      runs.length = 0;
      const again = await svc.status(path.join(base, '.')); // same repo, root cached
      expect(runs.map((a) => a[0])).toEqual(['status']);
      expect(again).toEqual(first);
      const { GitService } = await import('./service.js');
      expect(await new GitService().status(base)).toEqual(first);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
});

describe('stash count in a reftable repository (no .git/logs)', () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const reftableOk = (() => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const d = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'cw-rt-probe-'));
    const r = spawnSync('git', ['init', '-q', '--ref-format=reftable', d], { windowsHide: true });
    require('node:fs').rmSync(d, { recursive: true, force: true });
    return r.status === 0; // git ≥ 2.45
  })();

  it.skipIf(!reftableOk)('asks git (rev-list --walk-reflogs) instead of reading a reflog file that does not exist', async () => {
    const { execFileSync } = await import('node:child_process');
    const { GitService } = await import('./service.js');
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-reftable-')));
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: base, windowsHide: true, stdio: 'ignore', env });
      git('init', '-q', '--ref-format=reftable');
      await fs.writeFile(path.join(base, 'a.txt'), '1\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      const svc = new GitService();
      expect((await svc.status(base)).stashes).toBe(0);
      for (const v of ['2', '3']) { await fs.writeFile(path.join(base, 'a.txt'), `${v}\n`); git('stash', '-q'); }
      expect((await svc.status(base)).stashes).toBe(2);
      git('stash', 'drop', '-q');
      expect((await svc.status(base)).stashes).toBe(1);
      git('stash', 'clear');
      expect((await svc.status(base)).stashes).toBe(0);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  });
});
