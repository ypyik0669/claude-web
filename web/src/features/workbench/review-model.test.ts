// The 审阅 tab's pure half: which files a scope lists, how each one's diff is fetched, the bulk actions, the commit
// button, and splitting a commit's patch per file.
import { describe, expect, it } from 'vitest';
import type { GitFileStatus, GitStatus } from '@shared';
import { bulkTargets, commitPlan, diffRequest, discardConfirm, joinPath, relToRoot, reviewRows, scopeCounts, splitPath, splitUnifiedByFile, stageAllConfirm, unifiedStat } from './review-model';

const f = (path: string, patch: Partial<GitFileStatus> = {}): GitFileStatus => ({ path, status: 'modified', staged: false, unstaged: true, ...patch });
const status = (files: GitFileStatus[], root: string | null = 'C:\\w\\repo'): GitStatus => ({ root, branch: 'main', upstream: null, ahead: 0, behind: 0, detached: false, files, stashes: 0, state: 'clean' });

const COMMIT = [
  'diff --git a/src/todos.js b/src/todos.js',
  'index 1111111..2222222 100644',
  '--- a/src/todos.js',
  '+++ b/src/todos.js',
  '@@ -9,6 +9,9 @@',
  ' export function completeTodo(id) {',
  '-  todo.done = true;',
  '+  if (!todo) {',
  '+    throw new Error("--- not a header");',
  '+  }',
  'diff --git a/test/new.test.js b/test/new.test.js',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/test/new.test.js',
  '@@ -0,0 +1,2 @@',
  '+import test from "node:test";',
  '+test("x", () => {});',
  'diff --git a/old name.txt b/new name.txt',
  'similarity index 90%',
  'rename from old name.txt',
  'rename to new name.txt',
  'diff --git a/logo.png b/logo.png',
  'index 4444444..5555555 100644',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git a/gone.md b/gone.md',
  'deleted file mode 100644',
  '--- a/gone.md',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n');

describe('paths', () => {
  it('relative to the repo root, whatever the separators and drive-letter case', () => {
    expect(relToRoot('C:\\w\\repo\\src\\a.ts', 'C:\\w\\repo')).toBe('src/a.ts');
    expect(relToRoot('c:/w/repo/src/a.ts', 'C:\\w\\repo')).toBe('src/a.ts');
    expect(relToRoot('/home/u/repo/a.ts', '/home/u/repo/')).toBe('a.ts');
    expect(relToRoot('C:\\w\\repo2\\a.ts', 'C:\\w\\repo')).toBeNull(); // a sibling with the same prefix is outside
    expect(relToRoot('C:\\other\\a.ts', 'C:\\w\\repo')).toBeNull();
  });

  it('joins with the root’s own separator; splits into a grey directory and a name', () => {
    expect(joinPath('C:\\w\\repo', 'src/a.ts')).toBe('C:\\w\\repo\\src\\a.ts');
    expect(joinPath('/r/', 'src/a.ts')).toBe('/r/src/a.ts');
    expect(splitPath('src/deep/a.ts')).toEqual({ dir: 'src/deep/', name: 'a.ts' });
    expect(splitPath('a.ts')).toEqual({ dir: '', name: 'a.ts' });
  });
});

describe('diff numbers', () => {
  it('counts + / − lines but not the --- / +++ file headers', () => {
    expect(unifiedStat(COMMIT.split('diff --git').slice(0, 2).join('diff --git'))).toEqual({ added: 3, removed: 1 });
    expect(unifiedStat('')).toEqual({ added: 0, removed: 0 });
  });

  it('splits a commit’s patch per file (modified / added / renamed / binary / deleted)', () => {
    const files = splitUnifiedByFile(COMMIT);
    expect(files.map((x) => [x.path, x.status, x.added, x.removed, x.binary])).toEqual([
      ['src/todos.js', 'modified', 3, 1, false],
      ['test/new.test.js', 'added', 2, 0, false],
      ['new name.txt', 'renamed', 0, 0, false],
      ['logo.png', 'modified', 0, 0, true],
      ['gone.md', 'deleted', 0, 1, false],
    ]);
    expect(files[2].from).toBe('old name.txt');
    expect(files[0].text.startsWith('diff --git a/src/todos.js')).toBe(true);
    expect(files[0].text).toContain('--- not a header');
    expect(splitUnifiedByFile('')).toEqual([]);
  });
});

describe('rows per scope', () => {
  const st = status([f('b.ts'), f('a.ts', { staged: true, unstaged: false }), f('new.ts', { status: 'untracked' }), f('both.ts', { staged: true, unstaged: true })]);

  it('未提交的改动: every changed file, sorted; 已暂存: the staged ones', () => {
    expect(reviewRows('uncommitted', { status: st }).map((r) => r.rel)).toEqual(['a.ts', 'b.ts', 'both.ts', 'new.ts']);
    expect(reviewRows('staged', { status: st }).map((r) => r.rel)).toEqual(['a.ts', 'both.ts']);
    expect(reviewRows('uncommitted', { status: st })[0].abs).toBe('C:\\w\\repo\\a.ts');
  });

  it('本次对话改动: the files the conversation touched, with their git state when they still differ', () => {
    const rows = reviewRows('session', { status: st, changed: ['C:\\w\\repo\\b.ts', 'C:\\w\\repo\\docs\\done.md', 'D:\\elsewhere\\x.txt'] });
    expect(rows.map((r) => [r.rel, r.git?.status ?? null])).toEqual([['b.ts', 'modified'], ['docs/done.md', null], ['D:\\elsewhere\\x.txt', null]]);
    expect(rows[2].abs).toBe('D:\\elsewhere\\x.txt');
  });

  it('某次提交: one row per file of the commit, numbers known up front', () => {
    const rows = reviewRows('commit', { status: st, patches: splitUnifiedByFile(COMMIT) });
    expect(rows.map((r) => r.rel)).toEqual(['src/todos.js', 'test/new.test.js', 'new name.txt', 'logo.png', 'gone.md']);
    expect(rows[0]).toMatchObject({ abs: 'C:\\w\\repo\\src\\todos.js', patch: { added: 3, removed: 1 } });
  });

  it('outside a repo only the conversation scope has anything', () => {
    const none = status([], null);
    expect(reviewRows('uncommitted', { status: none })).toEqual([]);
    expect(reviewRows('session', { status: none, changed: ['/tmp/x.txt'] }).map((r) => r.rel)).toEqual(['/tmp/x.txt']);
  });

  it('counts for the scope menu', () => {
    expect(scopeCounts(st, 5)).toEqual({ uncommitted: 4, staged: 2, session: 5 });
    expect(scopeCounts(null, 0)).toEqual({ uncommitted: 0, staged: 0, session: 0 });
  });
});

describe('how each file’s diff is fetched', () => {
  const ctx = { root: 'C:\\w\\repo', sessionId: 's1' };
  const row = (g: GitFileStatus) => reviewRows('uncommitted', { status: status([g]) })[0];

  it('unstaged / untracked → the working tree diff; staged only → the index diff; both → HEAD vs working tree', () => {
    expect(diffRequest(row(f('a.ts')), 'uncommitted', ctx)).toEqual({ kind: 'git.diff', cwd: 'C:\\w\\repo', path: 'a.ts', staged: false });
    expect(diffRequest(row(f('n.ts', { status: 'untracked' })), 'uncommitted', ctx)).toEqual({ kind: 'git.diff', cwd: 'C:\\w\\repo', path: 'n.ts', staged: false });
    expect(diffRequest(row(f('a.ts', { staged: true, unstaged: false })), 'uncommitted', ctx)).toEqual({ kind: 'git.diff', cwd: 'C:\\w\\repo', path: 'a.ts', staged: true });
    expect(diffRequest(row(f('a.ts', { staged: true, unstaged: true })), 'uncommitted', ctx)).toEqual({ kind: 'files.diff', sessionId: 's1', path: 'C:\\w\\repo\\a.ts' });
  });

  it('已暂存 → the index diff; 本次对话 → HEAD vs working tree of that file; 某次提交 → nothing to fetch', () => {
    expect(diffRequest(row(f('a.ts', { staged: true, unstaged: true })), 'staged', ctx)).toEqual({ kind: 'git.diff', cwd: 'C:\\w\\repo', path: 'a.ts', staged: true });
    const s = reviewRows('session', { status: status([]), changed: ['C:\\w\\repo\\x.ts'] })[0];
    expect(diffRequest(s, 'session', ctx)).toEqual({ kind: 'files.diff', sessionId: 's1', path: 'C:\\w\\repo\\x.ts' });
    const c = reviewRows('commit', { status: status([]), patches: splitUnifiedByFile(COMMIT) })[0];
    expect(diffRequest(c, 'commit', ctx)).toBeNull();
  });
});

describe('bulk actions and the commit button', () => {
  const st = status([f('m.ts'), f('s.ts', { staged: true, unstaged: false }), f('u.ts', { status: 'untracked' }), f('add.ts', { status: 'added', staged: true, unstaged: false }), f('c.ts', { status: 'conflict' })]);

  it('全部暂存 takes what is not staged yet; 全部还原 takes what a checkout can put back (never a conflict)', () => {
    const t = bulkTargets(reviewRows('uncommitted', { status: st }));
    // a conflicted file is left alone by both: staging it would mark the conflict resolved, a checkout would drop one side
    expect(t.stage.sort()).toEqual(['m.ts', 'u.ts']);
    expect(t.discard.sort()).toEqual(['m.ts', 's.ts', 'u.ts']);
    expect(t.unstage.sort()).toEqual(['add.ts', 's.ts']);
  });

  it('the conversation scope only acts on its own files that still differ', () => {
    const rows = reviewRows('session', { status: st, changed: ['C:\\w\\repo\\m.ts', 'C:\\w\\repo\\clean.ts'] });
    expect(bulkTargets(rows)).toEqual({ stage: ['m.ts'], discard: ['m.ts'], unstage: [] });
  });

  it('a staged rename / copy is only unstaged, never 还原d (checkout HEAD finds nothing at the new path)', () => {
    const rows = reviewRows('uncommitted', { status: status([f('new.ts', { status: 'renamed', from: 'old.ts', staged: true, unstaged: false }), f('cp.ts', { status: 'copied', staged: true, unstaged: true })]) });
    const t = bulkTargets(rows);
    expect(t.discard).toEqual([]);
    expect(t.unstage.sort()).toEqual(['cp.ts', 'new.ts']);
    for (const r of rows) expect(bulkTargets([r]).discard).toEqual([]);
  });

  it('提交: commits what is staged; with nothing staged it offers to stage 全部暂存’s files first', () => {
    expect(commitPlan(status([f('m.ts'), f('s.ts', { staged: true, unstaged: false })]))).toMatchObject({ kind: 'commit', staged: 1 });
    expect(commitPlan(status([f('m.ts')]))).toMatchObject({ kind: 'stageAll', stage: ['m.ts'], untracked: 0 });
    expect(commitPlan(status([]))).toMatchObject({ kind: 'none' });
    expect(commitPlan(null)).toMatchObject({ kind: 'none' });
  });

  it('提交 with untracked files around: they are staged too, and counted for the question', () => {
    const plan = commitPlan(status([f('m.ts'), f('new.ts', { status: 'untracked' }), f('tmp.log', { status: 'untracked' })]));
    expect(plan).toMatchObject({ kind: 'stageAll', untracked: 2 });
    expect(plan.stage.sort()).toEqual(['m.ts', 'new.ts', 'tmp.log']);
    const q = stageAllConfirm(plan);
    expect(q.message).toMatch(/3 个文件/);
    expect(q.message).toMatch(/2 个是没有提交过的新文件/);
    expect(q.items?.sort()).toEqual(['m.ts', 'new.ts', 'tmp.log']);
  });

  it('提交 with a conflicted file: nothing is offered (git add would mark it resolved with its markers in it)', () => {
    // a cherry-pick / stash pop stopped on a conflict: nothing staged, only the conflict (+ an untracked file)
    const plan = commitPlan(status([f('c.ts', { status: 'conflict' }), f('u.ts', { status: 'untracked' })]));
    expect(plan).toMatchObject({ kind: 'conflicts', conflicts: 1, stage: [] });
    // staged files alongside a conflict: still not committable (git refuses unmerged files)
    expect(commitPlan(st)).toMatchObject({ kind: 'conflicts', conflicts: 1, staged: 2 });
  });
});

describe('the 还原 confirmation says what is lost', () => {
  const rows = (files: GitFileStatus[]) => reviewRows('uncommitted', { status: status(files) });

  it('bulk: names the files (8 at most + a count), staged changes, changes not made by this conversation, permanent deletion', () => {
    const many = rows(Array.from({ length: 11 }, (_, i) => f(`f${String(i).padStart(2, '0')}.ts`, i === 0 ? { staged: true } : i === 1 ? { status: 'untracked' } : {})));
    const c = discardConfirm(many, 'uncommitted');
    expect(c.title).toBe('还原 11 个文件？');
    expect(c.items).toHaveLength(9);
    expect(c.items![0]).toBe('f00.ts');
    expect(c.items![8]).toBe('…等 11 个文件');
    expect(c.message).toMatch(/包括已暂存的改动/);
    expect(c.message).toMatch(/不只是这个对话做的改动/);
    expect(c.message).toMatch(/永久删除（不进回收站）/);
    expect(c.message).toMatch(/不能撤销/);
  });

  it('one file: a new file is deleted for good; a staged one loses its staged changes; the conversation scope warns about other changes', () => {
    expect(discardConfirm(rows([f('n.ts', { status: 'untracked' })]), 'uncommitted').message).toMatch(/永久删除（不进回收站）/);
    const staged = discardConfirm(rows([f('s.ts', { staged: true, unstaged: true })]), 'uncommitted');
    expect(staged.title).toBe('还原 s.ts？');
    expect(staged.message).toMatch(/已暂存的改动也会一起丢掉/);
    expect(discardConfirm(rows([f('m.ts')]), 'session').message).toMatch(/不只是这个对话做的/);
    expect(discardConfirm(rows([f('m.ts')]), 'uncommitted').message).not.toMatch(/已暂存/);
  });
});
