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

describe('GitService.status process count', () => {
  it('reads the stash count from `status --show-stash` (no separate `stash list`)', () => {
    const st: any = { branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [] };
    parseStatusV2z(['# branch.head main', '# stash 3', ''].join('\0'), st);
    expect(st.stashes).toBe(3);
  });

  it('one git process per status once the root is known; the answer matches a fresh service', async () => {
    const { execFileSync } = await import('node:child_process');
    const { GitService } = await import('./service.js');
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-gitst-'));
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: base, windowsHide: true, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
      git('init', '-q');
      await fs.writeFile(path.join(base, 'a.txt'), '1\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      await fs.writeFile(path.join(base, 'a.txt'), '2\n');
      git('stash', '-q');
      await fs.writeFile(path.join(base, 'b.txt'), 'new\n');
      const svc = new GitService();
      const runs: string[][] = [];
      const run = svc.run.bind(svc);
      svc.run = (cwd, args, opts) => { runs.push(args); return run(cwd, args, opts); };
      const first = await svc.status(base);
      expect(first).toMatchObject({ stashes: 1, files: [{ path: 'b.txt', status: 'untracked' }] });
      runs.length = 0;
      const again = await svc.status(path.join(base, '.')); // same repo, root cached
      expect(runs.map((a) => a[0])).toEqual(['status']);
      expect(again).toEqual(first);
      expect(await new GitService().status(base)).toEqual(first);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
