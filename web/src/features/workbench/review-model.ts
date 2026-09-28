// The 审阅 tab's pure half (redesign phase 2, spec §5.6): which files each scope lists, how a file's diff is fetched,
// what the bulk buttons act on, what 提交 does, and a commit's patch split per file. No DOM, no store — unit tested.
import type { GitFileStatus, GitStatus } from '@shared';

export type ReviewScope = 'uncommitted' | 'staged' | 'session' | 'commit';
export const SCOPE_LABEL: Record<ReviewScope, string> = { uncommitted: '未提交的改动', staged: '已暂存', session: '本次对话改动', commit: '某次提交' };

/** What the server returns for one file (`git.diff` / `files.diff`), plus our own `error`. */
export type DiffResult =
  | { kind: 'diff' | 'new' | 'content'; text: string }
  | { kind: 'unchanged' | 'clean' | 'binary'; text?: string }
  | { kind: 'error'; text: string };

/** One file in the review list. */
export interface ReviewRow {
  /** stable id within a scope: the repo-relative path, or the absolute one outside the repo */
  key: string;
  /** what is shown: repo-relative with `/`, or the absolute path outside the repo */
  rel: string;
  /** absolute path (editor, `files.diff`) */
  abs: string;
  /** its git status while it differs from HEAD */
  git?: GitFileStatus;
  /** 某次提交: the file's slice of the commit's patch and its numbers */
  patch?: FilePatch;
}

export interface FilePatch { path: string; from?: string; status: 'modified' | 'added' | 'deleted' | 'renamed'; text: string; added: number; removed: number; binary: boolean }

const slash = (p: string) => p.replace(/\\/g, '/');

/** `abs` relative to the repo `root` (with `/`), or null when it is not inside it. Case-insensitive (Windows drives). */
export function relToRoot(abs: string, root: string): string | null {
  const a = slash(abs);
  const r = slash(root).replace(/\/+$/, '');
  if (a.length <= r.length + 1 || a.slice(0, r.length).toLowerCase() !== r.toLowerCase() || a[r.length] !== '/') return null;
  return a.slice(r.length + 1);
}

/** Repo-relative `rel` under `root`, written with the root's own separator. */
export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.replace(/[\\/]/g, sep)}`;
}

/** `src/deep/a.ts` → grey `src/deep/` + `a.ts`. */
export function splitPath(p: string): { dir: string; name: string } {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
}

/** + / − line counts of a unified diff (hunk lines only: the `---` / `+++` file headers are not changes). */
export function unifiedStat(text: string): { added: number; removed: number } {
  let added = 0, removed = 0, inHunk = false;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git')) { inHunk = false; continue; }
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (l[0] === '+') added++;
    else if (l[0] === '-') removed++;
  }
  return { added, removed };
}

/** Split a multi-file patch (`git show` / `git diff`) into one entry per file. */
export function splitUnifiedByFile(text: string): FilePatch[] {
  const out: FilePatch[] = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const c of chunks) {
    const head = c.slice(0, c.indexOf('\n') < 0 ? c.length : c.indexOf('\n'));
    const lines = c.split('\n');
    const meta = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();
    // `diff --git a/x b/y`: names may hold spaces, so prefer the explicit headers, then the b/ half of the first line
    const plusPath = meta('+++ ');
    const minusPath = meta('--- ');
    const renameTo = meta('rename to ');
    const renameFrom = meta('rename from ');
    const m = / b\/(.*)$/.exec(head);
    const path = renameTo ?? (plusPath && plusPath !== '/dev/null' ? plusPath.replace(/^b\//, '') : undefined) ?? (minusPath && minusPath !== '/dev/null' ? minusPath.replace(/^a\//, '') : undefined) ?? m?.[1] ?? head.slice(11);
    const status: FilePatch['status'] = lines.some((l) => l.startsWith('new file mode')) ? 'added' : lines.some((l) => l.startsWith('deleted file mode')) ? 'deleted' : renameTo ? 'renamed' : 'modified';
    const binary = lines.some((l) => /^Binary files .* differ$/.test(l));
    out.push({ path, from: renameFrom, status, text: c.replace(/\n$/, ''), binary, ...unifiedStat(c) });
  }
  return out;
}

const byRel = (a: ReviewRow, b: ReviewRow) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

/**
 * The files a scope lists.
 *  - 未提交的改动: every file git reports (staged, unstaged, untracked), sorted;
 *  - 已暂存: the staged ones;
 *  - 本次对话改动: the files the conversation's tools wrote (`files.changed`, absolute paths), in that order, with
 *    their git state while they still differ from HEAD (a file it changed and you committed since is listed clean);
 *  - 某次提交: the files of the commit's patch.
 */
export function reviewRows(scope: ReviewScope, o: { status: GitStatus | null; changed?: string[]; patches?: FilePatch[] }): ReviewRow[] {
  const root = o.status?.root ?? null;
  const fromGit = (g: GitFileStatus): ReviewRow => ({ key: g.path, rel: g.path, abs: root ? joinPath(root, g.path) : g.path, git: g });
  switch (scope) {
    case 'uncommitted': return root ? o.status!.files.map(fromGit).sort(byRel) : [];
    case 'staged': return root ? o.status!.files.filter((g) => g.staged).map(fromGit).sort(byRel) : [];
    case 'session': {
      const git = new Map((o.status?.files ?? []).map((g) => [g.path.toLowerCase(), g]));
      return (o.changed ?? []).map((abs) => {
        const rel = root ? relToRoot(abs, root) : null;
        return rel ? { key: rel, rel, abs, git: git.get(rel.toLowerCase()) } : { key: abs, rel: abs, abs };
      });
    }
    case 'commit': return (o.patches ?? []).map((p) => ({ key: p.path, rel: p.path, abs: root ? joinPath(root, p.path) : p.path, patch: p }));
  }
}

/** Numbers for the scope menu. */
export function scopeCounts(status: GitStatus | null, sessionFiles: number): { uncommitted: number; staged: number; session: number } {
  const files = status?.root ? status.files : [];
  return { uncommitted: files.length, staged: files.filter((g) => g.staged).length, session: sessionFiles };
}

export type DiffRequest =
  | { kind: 'git.diff'; cwd: string; path: string; staged: boolean }
  | { kind: 'files.diff'; sessionId: string; path: string };

/**
 * How one file's diff is fetched: an index / working-tree `git.diff` (one git process) when the file is changed on
 * one side only; HEAD vs working tree (`files.diff`) when it is both staged and changed again, and for the
 * conversation scope (what the conversation did, whatever is staged). A commit's files come with their patch.
 */
export function diffRequest(row: ReviewRow, scope: ReviewScope, ctx: { root: string | null; sessionId: string }): DiffRequest | null {
  if (scope === 'commit') return null;
  if (scope === 'session' || !ctx.root || !row.git) return { kind: 'files.diff', sessionId: ctx.sessionId, path: row.abs };
  if (scope === 'staged') return { kind: 'git.diff', cwd: ctx.root, path: row.rel, staged: true };
  const g = row.git;
  if (g.staged && g.unstaged) return { kind: 'files.diff', sessionId: ctx.sessionId, path: row.abs };
  return { kind: 'git.diff', cwd: ctx.root, path: row.rel, staged: g.staged && !g.unstaged };
}

/**
 * What 全部暂存 / 全部还原 / 全部取消暂存 act on (repo-relative paths), and the per-file buttons (a one-row list).
 * A conflicted file is never touched by them — staging it marks the conflict resolved, a checkout throws one side
 * away; resolve it in the full Git view / a terminal. 还原 is `checkout HEAD` (index and working tree) or deleting an
 * untracked file, so a file that is only added to the index has nothing to go back to and is left for 取消暂存; so
 * is a staged rename / copy (`checkout HEAD -- <new path>` finds nothing and the server's fallback is a no-op).
 */
export function bulkTargets(rows: ReviewRow[]): { stage: string[]; discard: string[]; unstage: string[] } {
  const stage: string[] = [], discard: string[] = [], unstage: string[] = [];
  for (const r of rows) {
    const g = r.git;
    if (!g || g.status === 'conflict') continue;
    const untracked = g.status === 'untracked';
    const moved = g.status === 'renamed' || g.status === 'copied';
    if (g.unstaged || untracked) stage.push(r.rel);
    if (!moved && (g.unstaged || untracked || (g.staged && g.status !== 'added'))) discard.push(r.rel);
    if (g.staged) unstage.push(r.rel);
  }
  return { stage, discard, unstage };
}

/** What 提交 does. */
export interface CommitPlan {
  /** commit the index · stage `stage` first (asked) · resolve the conflicts first (in the Git view) · nothing to commit */
  kind: 'commit' | 'stageAll' | 'conflicts' | 'none';
  /** files with staged changes */
  staged: number;
  /** stageAll: what 全部暂存并提交 stages — 全部暂存's own list, never a conflicted file */
  stage: string[];
  /** stageAll: how many of `stage` are new, untracked files (they go into the commit too) */
  untracked: number;
  conflicts: number;
}

/**
 * 提交: commit the index; with nothing staged but changes around, offer to stage them first (the same files
 * 全部暂存 takes). With a conflicted file around nothing is offered: `git add` would mark it resolved with the
 * conflict markers still in it (and git refuses a commit over unmerged files anyway) — resolve it in the Git view.
 */
export function commitPlan(status: GitStatus | null): CommitPlan {
  const none: CommitPlan = { kind: 'none', staged: 0, stage: [], untracked: 0, conflicts: 0 };
  if (!status?.root) return none;
  const files = status.files;
  const conflicts = files.filter((g) => g.status === 'conflict').length;
  const staged = files.filter((g) => g.staged).length;
  if (conflicts) return { ...none, kind: 'conflicts', staged, conflicts };
  if (staged) return { ...none, kind: 'commit', staged };
  const stage = bulkTargets(files.map((g) => ({ key: g.path, rel: g.path, abs: g.path, git: g }))).stage;
  if (!stage.length) return none;
  return { ...none, kind: 'stageAll', stage, untracked: files.filter((g) => g.status === 'untracked' && stage.includes(g.path)).length };
}

/** Text of a confirmation dialog (`dlg.confirm`). */
export interface ConfirmText { title: string; message: string; items?: string[]; okLabel: string }

/** Files listed by name in a bulk confirmation; the rest are counted. */
export const CONFIRM_LIST_MAX = 8;

/**
 * The 还原 confirmation. 还原 is `git checkout HEAD -- <files>` plus deleting untracked files (`fs.rm`, not the
 * recycle bin): it takes the whole file back to the last commit — staged changes too, and every change in it,
 * not only the ones this conversation made. The dialog says so, and names the files.
 */
export function discardConfirm(rows: ReviewRow[], scope: ReviewScope): ConfirmText {
  const n = rows.length;
  if (n === 1) {
    const r = rows[0];
    const g = r.git;
    const lines: string[] = [];
    if (g?.status === 'untracked') lines.push('这是一个没有提交过的新文件：还原会把它永久删除（不进回收站）。');
    else if (g?.status === 'added') lines.push('这是刚加入暂存区的新文件：会回到暂存区里的版本，之后在工作区里的改动都会丢掉。');
    else {
      lines.push(`文件会回到上一次提交时的样子，里面所有未提交的改动都会丢掉${scope === 'session' ? '——不只是这个对话做的' : ''}。`);
      if (g?.staged) lines.push('已暂存的改动也会一起丢掉。');
    }
    lines.push('这一步不能撤销。');
    return { title: `还原 ${r.rel}？`, message: lines.join('\n'), okLabel: '还原' };
  }
  const staged = rows.filter((r) => r.git?.staged).length;
  const fresh = rows.filter((r) => r.git?.status === 'untracked').length;
  const items = rows.slice(0, CONFIRM_LIST_MAX).map((r) => r.rel);
  if (n > CONFIRM_LIST_MAX) items.push(`…等 ${n} 个文件`);
  // (each consequence only when it applies: a line about staged changes over files with none reads as a warning
  // that they have some)
  const message = [
    '这些文件会回到上一次提交时的样子：',
    ...(staged ? [`· 包括已暂存的改动（${staged} 个文件有）；`] : []),
    '· 不只是这个对话做的改动：文件里所有未提交的改动都会丢掉；',
    ...(fresh ? [`· 新建的文件会被永久删除（不进回收站）：${fresh} 个；`] : []),
    '这一步不能撤销。',
  ].join('\n');
  return { title: `还原 ${n} 个文件？`, message, items, okLabel: `还原 ${n} 个文件` };
}

/** The 全部暂存并提交 question (commitPlan 'stageAll'): how many files, and that new files go in too. */
export function stageAllConfirm(plan: CommitPlan): ConfirmText {
  const n = plan.stage.length;
  const items = plan.stage.slice(0, CONFIRM_LIST_MAX);
  if (n > CONFIRM_LIST_MAX) items.push(`…等 ${n} 个文件`);
  const message = `把 ${n} 个文件的改动暂存并提交？${plan.untracked ? `\n其中 ${plan.untracked} 个是没有提交过的新文件，也会进这次提交。` : ''}`;
  return { title: '还没有暂存的改动', message, items, okLabel: '全部暂存并提交' };
}
