// The 审阅 tab's pure half: which files a scope lists, how each one's diff is fetched, the bulk actions, the commit
// button, and splitting a commit's patch per file.
import { describe, expect, it } from 'vitest';
import type { GitFileStatus, GitStatus } from '@shared';
import { DEFAULT_LINE_MODE, FILE_ACTION_LABEL, FILE_ACTION_TITLE, LINE_MODES, bulkTargets, commitFold, commitPlan, diffRequest, discardConfirm, fileActions, joinPath, relToRoot, reviewRows, scopeCounts, splitPath, splitUnifiedByFile, stageAllConfirm, unifiedStat } from './review-model';

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

  // polish P4: a folder that is not a git repo shows the conversation's files relative to its folder, not absolute
  // (the full path stays in `abs`, the row's tooltip); a file outside the folder keeps its full path
  it('outside a repo the conversation scope is relative to the conversation folder', () => {
    const none = status([], null);
    const rows = reviewRows('session', { status: none, cwd: 'C:\\Users\\me\\todo-api', changed: ['C:\\Users\\me\\todo-api\\src\\index.ts', 'c:\\users\\me\\todo-api\\README.md', 'C:\\Users\\me\\other\\x.txt'] });
    expect(rows.map((r) => r.rel)).toEqual(['src/index.ts', 'README.md', 'C:\\Users\\me\\other\\x.txt']);
    expect(rows.map((r) => r.abs)).toEqual(['C:\\Users\\me\\todo-api\\src\\index.ts', 'c:\\users\\me\\todo-api\\README.md', 'C:\\Users\\me\\other\\x.txt']);
    // the key stays the absolute path (stable when the folder changes)
    expect(rows[0].key).toBe('C:\\Users\\me\\todo-api\\src\\index.ts');
    expect(splitPath(rows[0].rel)).toEqual({ dir: 'src/', name: 'index.ts' });
    // a trailing separator on the folder and / paths
    expect(reviewRows('session', { status: none, cwd: '/home/me/app/', changed: ['/home/me/app/lib/a.js'] })[0].rel).toBe('lib/a.js');
  });

  it('in a repo a changed file outside the repo but inside the conversation folder is relative to the folder', () => {
    const rows = reviewRows('session', { status: st, cwd: 'D:\\scratch', changed: ['C:\\w\\repo\\b.ts', 'D:\\scratch\\notes\\x.md'] });
    expect(rows.map((r) => r.rel)).toEqual(['b.ts', 'notes/x.md']);
    expect(rows[1].git).toBeUndefined();
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

describe('one file’s actions (the header’s icons; spelled out on a phone)', () => {
  const row = (g: GitFileStatus, scope: 'uncommitted' | 'staged' = 'uncommitted') => reviewRows(scope, { status: status([g]) })[0];

  it('暂存 or 取消暂存 (never both), 还原 where a checkout can put the file back, 打开 unless it is deleted', () => {
    expect(fileActions(row(f('m.ts')), 'uncommitted', true)).toEqual(['stage', 'discard', 'open']);
    expect(fileActions(row(f('n.ts', { status: 'untracked' })), 'uncommitted', true)).toEqual(['stage', 'discard', 'open']);
    expect(fileActions(row(f('s.ts', { staged: true, unstaged: false })), 'uncommitted', true)).toEqual(['unstage', 'discard', 'open']);
    // staged and changed again: what is left to stage comes first
    expect(fileActions(row(f('b.ts', { staged: true, unstaged: true })), 'uncommitted', true)).toEqual(['stage', 'discard', 'open']);
    // a deleted file has nothing to open
    expect(fileActions(row(f('gone.ts', { status: 'deleted' })), 'uncommitted', true)).toEqual(['stage', 'discard']);
  });

  it('nothing is loosened: a conflict is only opened; a new file in the index and a staged rename are never 还原d', () => {
    expect(fileActions(row(f('c.ts', { status: 'conflict' })), 'uncommitted', true)).toEqual(['open']);
    expect(fileActions(row(f('add.ts', { status: 'added', staged: true, unstaged: false })), 'uncommitted', true)).toEqual(['unstage', 'open']);
    expect(fileActions(row(f('new.ts', { status: 'renamed', from: 'old.ts', staged: true, unstaged: false })), 'uncommitted', true)).toEqual(['unstage', 'open']);
  });

  it('已暂存 has no 还原; 某次提交 and files outside a repo are only opened', () => {
    expect(fileActions(row(f('s.ts', { staged: true, unstaged: false }), 'staged'), 'staged', true)).toEqual(['unstage', 'open']);
    const patches = reviewRows('commit', { status: status([]), patches: splitUnifiedByFile(COMMIT) });
    expect(fileActions(patches[0], 'commit', true)).toEqual(['open']);
    expect(fileActions(patches[4], 'commit', true)).toEqual([]); // deleted by the commit
    // 本次对话改动: a file committed since (no git state) and a folder that is not a repo
    const clean = reviewRows('session', { status: status([]), changed: ['C:\\w\\repo\\done.ts'] })[0];
    expect(fileActions(clean, 'session', true)).toEqual(['open']);
    const loose = reviewRows('session', { status: status([], null), changed: ['/tmp/x.txt'] })[0];
    expect(fileActions(loose, 'session', false)).toEqual(['open']);
  });

  it('every action is one the bulk buttons would take for that file (the same lists)', () => {
    const files = [f('m.ts'), f('s.ts', { staged: true, unstaged: false }), f('u.ts', { status: 'untracked' }), f('add.ts', { status: 'added', staged: true, unstaged: false }), f('c.ts', { status: 'conflict' }), f('r.ts', { status: 'renamed', staged: true, unstaged: false })];
    for (const r of reviewRows('uncommitted', { status: status(files) })) {
      const acts = fileActions(r, 'uncommitted', true);
      const one = bulkTargets([r]);
      expect(acts.includes('stage')).toBe(one.stage.length > 0);
      expect(acts.includes('unstage')).toBe(!one.stage.length && one.unstage.length > 0);
      expect(acts.includes('discard')).toBe(one.discard.length > 0);
    }
  });

  it('the words a phone writes on them, and the tooltip that says what each does', () => {
    expect(FILE_ACTION_LABEL).toEqual({ stage: '暂存', unstage: '取消暂存', discard: '还原', open: '打开' });
    // (the desktop icons' tooltips, word for word)
    expect(FILE_ACTION_TITLE).toEqual({ stage: '暂存（加入下一次提交）', unstage: '取消暂存', discard: '还原（丢弃这个文件的改动）', open: '在编辑器打开' });
  });
});

describe('on a phone (UI refresh §8)', () => {
  it('long lines: 换行 / 横滚, wrapping by default', () => {
    expect(LINE_MODES.map((m) => [m.value, m.label])).toEqual([['wrap', '换行'], ['scroll', '横滚']]);
    expect(DEFAULT_LINE_MODE).toBe('wrap');
  });

  it('the commit area folds into 「提交 N 个文件」: what 提交 would take', () => {
    const phone = { phone: true, open: false };
    // 2 files staged (a third only changed): the commit takes the index
    expect(commitFold(commitPlan(status([f('a.ts', { staged: true, unstaged: false }), f('b.ts', { staged: true, unstaged: true }), f('m.ts')])), phone)).toBe('提交 2 个文件');
    // nothing staged: 提交 offers to stage 全部暂存's files first — those are the N
    expect(commitFold(commitPlan(status([f('m.ts'), f('new.ts', { status: 'untracked' }), f('x.ts')])), phone)).toBe('提交 3 个文件');
    expect(commitFold(commitPlan(status([f('m.ts')])), phone)).toBe('提交 1 个文件');
  });

  it('nothing to commit, or a conflict: not folded — the phone shows what the desktop shows', () => {
    const phone = { phone: true, open: false };
    expect(commitFold(commitPlan(status([])), phone)).toBeNull();
    expect(commitFold(commitPlan(null), phone)).toBeNull();
    expect(commitFold(commitPlan(status([f('c.ts', { status: 'conflict' }), f('s.ts', { staged: true, unstaged: false })])), phone)).toBeNull();
  });

  it('opened (tapped) it stays the full box; a desktop never folds', () => {
    const plan = commitPlan(status([f('s.ts', { staged: true, unstaged: false })]));
    expect(commitFold(plan, { phone: true, open: true })).toBeNull();
    expect(commitFold(plan, { phone: false, open: false })).toBeNull();
    expect(commitFold(plan, { phone: false, open: true })).toBeNull();
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

  it('bulk: a consequence is only written when it applies (no staged / no new files → no such line)', () => {
    const plain = discardConfirm(rows([f('a.ts'), f('b.ts'), f('c.ts')]), 'uncommitted');
    expect(plain.message).not.toMatch(/已暂存/);
    expect(plain.message).not.toMatch(/永久删除/);
    expect(plain.message).toMatch(/不只是这个对话做的改动/);
    const some = discardConfirm(rows([f('a.ts', { staged: true }), f('n.ts', { status: 'untracked' })]), 'uncommitted');
    expect(some.message).toMatch(/包括已暂存的改动（1 个文件有）/);
    expect(some.message).toMatch(/永久删除（不进回收站）：1 个/);
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
