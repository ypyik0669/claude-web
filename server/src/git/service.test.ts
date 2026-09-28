import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARGV_PATHS_BUDGET, argvBatches, classifyGitError, parseStatusV2z, pathspecFileSupported, resolveGitDir } from './service.js';

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

describe('which git takes paths on stdin, and command-line batches for the ones that do not', () => {
  it('--pathspec-from-file from git 2.25 on', () => {
    expect(pathspecFileSupported('git version 2.17.1\n')).toBe(false); // Ubuntu 18.04
    expect(pathspecFileSupported('git version 2.20.1')).toBe(false); // Debian 10
    expect(pathspecFileSupported('git version 2.24.4')).toBe(false);
    expect(pathspecFileSupported('git version 2.25.0')).toBe(true);
    expect(pathspecFileSupported('git version 2.53.0.windows.1')).toBe(true);
    expect(pathspecFileSupported('git version 3.0.0')).toBe(true);
    expect(pathspecFileSupported('')).toBe(false); // unknown: the command line always works
  });
  it('batches keep every path once, in order, each batch within the budget (a longer path goes alone)', () => {
    const files = Array.from({ length: 50 }, (_, i) => `dir/${'x'.repeat(i % 7 === 0 ? 400 : 20)}-${i}.txt`);
    const batches = argvBatches(files, 1000);
    expect(batches.flat()).toEqual(files);
    for (const b of batches) expect(b.length === 1 || b.reduce((n, f) => n + f.length + 3, 0) <= 1000).toBe(true);
    expect(argvBatches(['y'.repeat(2000), 'a'], 1000)).toEqual([['y'.repeat(2000)], ['a']]);
    expect(argvBatches([])).toEqual([]);
    expect(ARGV_PATHS_BUDGET).toBeLessThanOrEqual(24_000);
  });
});

describe('stage / unstage / discard over many files (paths on stdin, not the command line)', () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  // 1400 names of ~90 characters: ~126 000 characters of arguments, far over Windows' 32 767 (spawn ENAMETOOLONG)
  const N = 1400;
  const name = (i: number) => `deep/${'long-directory-name-'.repeat(3)}/file-number-${String(i).padStart(4, '0')}-with-a-long-tail.txt`;

  it('1400 long paths: stage, unstage and discard each run as one git command', async () => {
    const { execFileSync } = await import('node:child_process');
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-gitmany-')));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: base, windowsHide: true, stdio: 'ignore', env });
    try {
      git('init', '-q');
      await fs.mkdir(path.join(base, path.dirname(name(0))), { recursive: true });
      const files = Array.from({ length: N }, (_, i) => name(i));
      for (const f of files) await fs.writeFile(path.join(base, f), 'v1\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      for (const f of files) await fs.writeFile(path.join(base, f), 'v2\n');
      expect(files.join(' ').length).toBeGreaterThan(32_767);

      const { GitService } = await import('./service.js');
      const svc = new GitService();
      const runs: string[][] = [];
      const run = svc.run.bind(svc);
      svc.run = (cwd, args, opts) => { runs.push(args); return run(cwd, args, opts); };

      await svc.stage(base, files);
      let st = await svc.status(base);
      expect(st.files.filter((f) => f.staged && !f.unstaged)).toHaveLength(N);
      await svc.unstage(base, files);
      st = await svc.status(base);
      expect(st.files.filter((f) => !f.staged && f.unstaged)).toHaveLength(N);
      await svc.stage(base, files.slice(0, 10)); // a staged change is thrown away too (checkout HEAD)
      await svc.discard(base, files);
      expect((await svc.status(base)).files).toEqual([]);
      expect((await fs.readFile(path.join(base, files[N - 1]), 'utf8')).trim()).toBe('v1'); // (core.autocrlf may add \r)
      // no command carried the paths as arguments
      for (const a of runs) expect(a.join(' ').length).toBeLessThan(1000);
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  }, 120_000);

  it('git older than 2.25 (no --pathspec-from-file): the paths go on the command line again, in batches of ≤ 24k characters', async () => {
    const { execFileSync } = await import('node:child_process');
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-gitold-')));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: base, windowsHide: true, stdio: 'ignore', env });
    const { GitService, resetGitVersionCache, ARGV_PATHS_BUDGET } = await import('./service.js');
    resetGitVersionCache();
    try {
      git('init', '-q');
      await fs.mkdir(path.join(base, path.dirname(name(0))), { recursive: true });
      const files = Array.from({ length: N }, (_, i) => name(i));
      for (const f of files) await fs.writeFile(path.join(base, f), 'v1\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      for (const f of files) await fs.writeFile(path.join(base, f), 'v2\n');

      const svc = new GitService();
      const runs: string[][] = [];
      const run = svc.run.bind(svc);
      // Debian 10's git: the real git runs every other command
      svc.run = (cwd, args, opts) => { runs.push(args); return args[0] === '--version' ? Promise.resolve({ stdout: 'git version 2.20.1\n', stderr: '' }) : run(cwd, args, opts); };

      await svc.stage(base, files);
      expect((await svc.status(base)).files.filter((f) => f.staged && !f.unstaged)).toHaveLength(N);
      const adds = runs.filter((a) => a.includes('add'));
      expect(adds.length).toBeGreaterThan(1); // batched
      expect(adds.flatMap((a) => a.slice(a.indexOf('--') + 1))).toEqual(files); // every path once, in order
      await svc.unstage(base, files);
      expect((await svc.status(base)).files.filter((f) => !f.staged && f.unstaged)).toHaveLength(N);
      await svc.stage(base, files.slice(0, 10));
      await svc.discard(base, files);
      expect((await svc.status(base)).files).toEqual([]);
      expect((await fs.readFile(path.join(base, files[0]), 'utf8')).trim()).toBe('v1');
      // never the option, never a command line over the budget; --version asked once for the whole process
      expect(runs.some((a) => a.includes('--pathspec-from-file=-'))).toBe(false);
      for (const a of runs) expect(a.join(' ').length).toBeLessThan(ARGV_PATHS_BUDGET + 200);
      expect(runs.filter((a) => a[0] === '--version')).toHaveLength(1);
      const again = new GitService();
      const runs2: string[][] = [];
      again.run = (cwd, args, opts) => { runs2.push(args); return run(cwd, args, opts); };
      await again.unstage(base, files.slice(0, 1));
      expect(runs2.some((a) => a[0] === '--version')).toBe(false);
    } finally {
      resetGitVersionCache();
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 180_000);

  it('a git that refuses the option after all (unknown option): the same command again on the command line, and that sticks', async () => {
    const { execFileSync } = await import('node:child_process');
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-gitrefuse-')));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: base, windowsHide: true, stdio: 'ignore', env });
    const { GitService, GitCommandError, classifyGitError: classify, resetGitVersionCache } = await import('./service.js');
    resetGitVersionCache();
    try {
      git('init', '-q');
      for (const f of ['a.txt', 'b.txt']) await fs.writeFile(path.join(base, f), 'x\n');
      const svc = new GitService();
      const runs: string[][] = [];
      const run = svc.run.bind(svc);
      // the error line comes first; git then dumps its usage, so the last lines (info.message) do not name the option
      const stderr = "error: unknown option `pathspec-from-file=-'\nusage: git add [<options>] [--] <pathspec>...\n\n    -n, --dry-run         dry run\n    -v, --verbose         be verbose\n";
      svc.run = (cwd, args, opts) => {
        runs.push(args);
        if (args[0] === '--version') return Promise.resolve({ stdout: 'git version 2.30.0\n', stderr: '' });
        if (args.includes('--pathspec-from-file=-')) return Promise.reject(new GitCommandError(classify(stderr, 129), stderr));
        return run(cwd, args, opts);
      };
      await svc.stage(base, ['a.txt']);
      await svc.stage(base, ['b.txt']);
      expect((await svc.status(base)).files.filter((f) => f.staged).map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
      expect(runs.filter((a) => a.includes('--pathspec-from-file=-'))).toHaveLength(1); // tried once, then remembered
      expect(runs.filter((a) => a.includes('add') && a.includes('--'))).toHaveLength(2);
      // any other failure is the caller's (not retried on the command line)
      const other = new GitService();
      other.run = (cwd, args, opts) => args.includes('--pathspec-from-file=-') ? Promise.reject(new GitCommandError(classify("fatal: Unable to create 'x/.git/index.lock': File exists."), "fatal: Unable to create 'x/.git/index.lock': File exists.")) : run(cwd, args, opts);
      resetGitVersionCache();
      other.pathspecFromFile = () => Promise.resolve(true);
      await expect(other.stage(base, ['a.txt'])).rejects.toMatchObject({ info: { kind: 'lock' } });
    } finally {
      resetGitVersionCache();
      await fs.rm(base, { recursive: true, force: true });
    }
  }, 60_000);

  it('paths are literal: staging `glob[1].txt` does not also stage `glob1.txt`; an empty list stages nothing', async () => {
    const { execFileSync } = await import('node:child_process');
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-gitlit-')));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: base, windowsHide: true, stdio: 'ignore', env });
    try {
      git('init', '-q');
      for (const f of ['glob[1].txt', 'glob1.txt', 'with space.txt']) await fs.writeFile(path.join(base, f), 'x\n');
      const { GitService } = await import('./service.js');
      const svc = new GitService();
      await svc.stage(base, []);
      expect((await svc.status(base)).files.every((f) => !f.staged)).toBe(true);
      await svc.stage(base, ['glob[1].txt', 'with space.txt']);
      const st = await svc.status(base);
      expect(st.files.filter((f) => f.staged).map((f) => f.path).sort()).toEqual(['glob[1].txt', 'with space.txt']);
      expect(st.files.find((f) => f.path === 'glob1.txt')).toMatchObject({ status: 'untracked' });
    } finally { await fs.rm(base, { recursive: true, force: true }); }
  }, 60_000);
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
