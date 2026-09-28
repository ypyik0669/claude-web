import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs/promises';
import chokidar from 'chokidar';
import type { GitBranch, GitError, GitErrorKind, GitFileStatus, GitLogEntry, GitStatus, GitWorktree } from '../protocol.js';

// for-each-ref does not expand %xNN like log does → pass the separator byte literally
const SEP = String.fromCharCode(0x1f);

export class GitCommandError extends Error {
  /** `stderr`: git's whole output (`info.message` keeps only the last lines — after a usage dump, not the error) */
  constructor(public info: GitError, public stderr = '') {
    super(info.message);
  }
}

/** `--pathspec-from-file` (paths on stdin) is git 2.25+ (add / reset / checkout); older git says "unknown option". */
export function pathspecFileSupported(versionOutput: string): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 25);
}
/** The option itself refused (a git that is older than its version string says, or a subcommand without it). */
const PATHSPEC_FILE_REFUSED = /unknown option|pathspec-from-file/i;
/** Paths per git command on the command line (older git): Windows allows 32 767 characters for the whole line. */
export const ARGV_PATHS_BUDGET = 24_000;
/** Split `files` into batches whose command-line length (path + quotes + space each) stays within `budget`. */
export function argvBatches(files: string[], budget = ARGV_PATHS_BUDGET): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const f of files) {
    const n = f.length + 3;
    if (cur.length && len + n > budget) { out.push(cur); cur = []; len = 0; }
    cur.push(f);
    len += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
/** Whether this git takes paths on stdin: asked once per process (`git --version`), shared by every GitService. */
let pathspecFile: Promise<boolean> | null = null;
/** Tests: forget the answer (a stubbed `git --version` is asked again). */
export function resetGitVersionCache() { pathspecFile = null; }

const HINTS: Record<GitErrorKind, string> = {
  not_repo: '这个目录不是 git 仓库。可以在终端里 git init，或选一个仓库目录。',
  no_upstream: '当前分支没有上游分支。用「推送并设置上游」（git push -u origin <分支>）。',
  auth: '认证失败。检查凭据（gh auth login / 凭据管理器），或改用 SSH 远程地址。',
  rejected: '远程有新提交，推送被拒绝。先拉取（pull --rebase）再推送。',
  conflict: '有合并冲突。在编辑器里解决冲突文件，暂存后再提交（或 git merge --abort 放弃）。',
  detached: '当前处于分离 HEAD。先新建分支（checkout -b）再提交。',
  dirty: '工作区有未提交的改动，会被切换分支覆盖。先提交或 stash。',
  nothing_to_commit: '没有暂存的改动。先暂存文件再提交。',
  identity: '没有配置提交身份。运行 git config --global user.name / user.email。',
  lock: '仓库被锁（.git/index.lock）。确认没有别的 git 进程后删除锁文件。',
  unrelated: '两个分支没有共同历史。确认远程地址正确，或用 --allow-unrelated-histories。',
  network: '连不上远程。检查网络、代理或远程地址。',
  unknown_rev: '找不到这个分支或提交。先 fetch，或检查名字。',
  exists: '同名分支 / worktree 已存在。换个名字或先删除旧的。',
  unknown: '',
};

/** Map git's stderr to one of a handful of causes the UI can offer a fix for. */
export function classifyGitError(stderr: string, code?: number | null): GitError {
  const s = stderr.toLowerCase();
  const pick = (kind: GitErrorKind): GitError => ({ kind, message: stderr.trim().split('\n').filter(Boolean).slice(-3).join('\n') || `git exited ${code}`, hint: HINTS[kind] });
  if (s.includes('not a git repository')) return pick('not_repo');
  if (s.includes('has no upstream branch') || s.includes('no tracking information') || s.includes('no upstream configured')) return pick('no_upstream');
  if (s.includes('authentication failed') || s.includes('could not read username') || s.includes('permission denied (publickey)') || s.includes('403') || s.includes('invalid username or password') || s.includes('terminal prompts disabled')) return pick('auth');
  if (s.includes('non-fast-forward') || (s.includes('rejected') && s.includes('fetch first')) || s.includes('failed to push some refs')) return pick('rejected');
  if (s.includes('conflict') || s.includes('needs merge') || s.includes('unmerged')) return pick('conflict');
  if (s.includes('detached head') || s.includes('not currently on any branch')) return pick('detached');
  if (s.includes('would be overwritten') || s.includes('please commit your changes or stash')) return pick('dirty');
  if (s.includes('nothing to commit') || s.includes('no changes added to commit') || s.includes('nothing added to commit')) return pick('nothing_to_commit');
  if (s.includes('please tell me who you are') || s.includes('author identity unknown') || s.includes('empty ident')) return pick('identity');
  if (s.includes('index.lock') || s.includes('unable to create') && s.includes('.lock')) return pick('lock');
  if (s.includes('unrelated histories')) return pick('unrelated');
  if (s.includes('could not resolve host') || s.includes('connection timed out') || s.includes('unable to access') || s.includes('connection refused') || s.includes('network is unreachable') || s.includes('could not connect')) return pick('network');
  if (s.includes('unknown revision') || s.includes('did not match any') || s.includes('invalid reference') || s.includes('pathspec') && s.includes('did not match')) return pick('unknown_rev');
  if (s.includes('already exists') || s.includes('is already checked out')) return pick('exists');
  return pick('unknown');
}

function parseXY(x: string, y: string, untracked = false): GitFileStatus['status'] {
  if (untracked) return 'untracked';
  const c = (y !== '.' && y !== ' ' ? y : x);
  switch (c) {
    case 'M': return 'modified';
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'U': return 'conflict';
    case 'T': return 'typechange';
    default: return 'modified';
  }
}

/** Parse `git status --porcelain=v2 -z --branch` into `st` (entries are NUL-terminated; a rename's origPath is its own field). */
export function parseStatusV2z(stdout: string, st: Pick<GitStatus, 'branch' | 'upstream' | 'ahead' | 'behind' | 'detached' | 'files'>) {
  const fields = stdout.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) { const b = line.slice(14); st.branch = b === '(detached)' ? null : b; st.detached = b === '(detached)'; }
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(line); if (m) { st.ahead = Number(m[1]); st.behind = Number(m[2]); } }
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ');
      const x = parts[1][0], y = parts[1][1];
      let p: string, from: string | undefined;
      if (line.startsWith('2 ')) { p = parts.slice(9).join(' '); from = fields[++i]; }
      else p = parts.slice(8).join(' ');
      st.files.push({ path: p, from, status: parseXY(x, y), staged: x !== '.', unstaged: y !== '.' });
    } else if (line.startsWith('u ')) {
      st.files.push({ path: line.split(' ').slice(10).join(' '), status: 'conflict', staged: false, unstaged: true });
    } else if (line.startsWith('? ')) {
      st.files.push({ path: line.slice(2), status: 'untracked', staged: false, unstaged: true });
    }
  }
}

/** Where shared refs live: a linked worktree's git dir names its common dir in `commondir` (usually relative). */
export async function resolveCommonDir(gitDir: string): Promise<string> {
  const rel = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => '')).trim();
  return rel ? path.resolve(gitDir, rel) : gitDir;
}

/**
 * Number of stashes. Files ref backend (the default): no git process — one reflog line per stash entry in
 * `<common dir>/logs/refs/stash` (`stash drop` rewrites it, `stash clear` deletes it). A reftable repository
 * (`<common dir>/reftable`) keeps reflogs inside its tables and has no logs/ at all: ask git
 * (`rev-list --walk-reflogs --count refs/stash`; an error means no stash ref, i.e. 0).
 * Not `status --show-stash`: git 2.14–2.34 accept the flag but print no `# stash` line, older git rejects it,
 * and current git omits the line at zero.
 */
export async function stashCount(root: string, git: (args: string[]) => Promise<string>): Promise<number> {
  const common = await resolveCommonDir(await resolveGitDir(root));
  if (await fs.stat(path.join(common, 'reftable')).then((st) => st.isDirectory(), () => false)) {
    const out = await git(['rev-list', '--walk-reflogs', '--count', 'refs/stash', '--']).catch(() => '0');
    return Number(out.trim()) || 0;
  }
  const log = await fs.readFile(path.join(common, 'logs', 'refs', 'stash'), 'utf8').catch(() => '');
  return log.split('\n').filter((l) => l.trim()).length;
}

/** The repo's git dir: `<root>/.git`, or where a `.git` file points (linked worktrees, submodules — often a relative path). */
export async function resolveGitDir(root: string): Promise<string> {
  const g = path.join(root, '.git');
  const gs = await fs.stat(g).catch(() => null);
  if (!gs?.isFile()) return g;
  const target = (await fs.readFile(g, 'utf8')).replace(/^gitdir:\s*/, '').trim();
  return path.resolve(root, target);
}

export class GitService extends EventEmitter {
  private watchers = new Map<string, { w: any; timer?: ReturnType<typeof setTimeout> }>();
  private fetchTimer: ReturnType<typeof setInterval> | null = null;
  private fetchDirs = new Set<string>();
  /**
   * cwd → repo root. `rev-parse --show-toplevel` is one more git process in front of every status / watch / diff,
   * and status runs on every git.changed for every view showing the repo. Roots barely move: positive answers
   * are kept a minute, "not a repo" a few seconds (a fresh `git init` shows up quickly); worktree add / remove
   * and any failing status drop the entries.
   */
  private roots = new Map<string, { root: string | null; at: number }>();
  static ROOT_TTL_MS = 60_000;
  static NO_ROOT_TTL_MS = 5_000;

  async run(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...args], {
        cwd,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 60_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      }, (err, stdout, stderr) => {
        if (err) reject(new GitCommandError(classifyGitError(String(stderr || err.message), (err as any).code), String(stderr || err.message)));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
      if (opts.input !== undefined) { child.stdin?.end(opts.input); }
    });
  }

  async root(cwd: string): Promise<string | null> {
    const key = path.resolve(cwd);
    const hit = this.roots.get(key);
    if (hit && Date.now() - hit.at < (hit.root ? GitService.ROOT_TTL_MS : GitService.NO_ROOT_TTL_MS)) return hit.root;
    let root: string | null;
    try {
      const { stdout } = await this.run(cwd, ['rev-parse', '--show-toplevel']);
      root = stdout.trim().replace(/\//g, path.sep);
    } catch {
      root = null;
    }
    this.roots.set(key, { root, at: Date.now() });
    return root;
  }
  forgetRoots() { this.roots.clear(); }

  async status(cwd: string): Promise<GitStatus> {
    const root = await this.root(cwd);
    if (!root) return { root: null, branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [], stashes: 0, state: 'clean' };
    // -z: without it git C-quotes paths containing `"`, `\`, tabs or newlines, and those quoted strings
    // would be handed back verbatim to add / reset / checkout as pathspecs that match nothing
    let stdout: string;
    try {
      ({ stdout } = await this.run(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all']));
    } catch (e) {
      this.roots.delete(path.resolve(cwd)); // the repo moved / vanished: resolve it again next time
      throw e;
    }
    const st: GitStatus = { root, branch: null, upstream: null, ahead: 0, behind: 0, detached: false, files: [], stashes: 0, state: 'clean' };
    parseStatusV2z(stdout, st);
    if (st.detached) st.state = 'detached';
    try {
      const gitDir = await resolveGitDir(root);
      const has = async (n: string) => !!(await fs.stat(path.join(gitDir, n)).catch(() => null));
      if (await has('MERGE_HEAD')) st.state = 'merging';
      else if (await has('rebase-merge') || await has('rebase-apply')) st.state = 'rebasing';
      else if (await has('CHERRY_PICK_HEAD')) st.state = 'cherry-picking';
      if (st.files.some((f) => f.status === 'conflict')) st.state = st.state === 'clean' ? 'conflict' : st.state;
    } catch { /* ignore */ }
    st.stashes = await stashCount(root, async (a) => (await this.run(root, a)).stdout).catch(() => 0); // the reflog, not `stash list`
    return st;
  }

  async diff(cwd: string, file: string, staged: boolean): Promise<{ kind: 'diff' | 'new' | 'binary' | 'unchanged'; text: string }> {
    const root = (await this.root(cwd)) ?? cwd;
    const args = staged ? ['diff', '--cached', '--no-color', '--', file] : ['diff', '--no-color', '--', file];
    const { stdout } = await this.run(root, args);
    // anchored: a text diff whose *content* mentions "Binary files" (e.g. this very line) is still a text diff
    if (/^Binary files .* differ$/m.test(stdout)) return { kind: 'binary', text: '' };
    if (stdout.trim()) return { kind: 'diff', text: stdout };
    if (!staged) {
      const { stdout: st } = await this.run(root, ['status', '--porcelain', '--', file]);
      if (st.startsWith('??')) return { kind: 'new', text: await fs.readFile(path.join(root, file), 'utf8').catch(() => '') };
    }
    return { kind: 'unchanged', text: '' };
  }

  /** Whether this git takes paths on stdin (git ≥ 2.25; `git --version` asked once per process). */
  pathspecFromFile(): Promise<boolean> {
    pathspecFile ??= this.run(process.cwd(), ['--version']).then((r) => pathspecFileSupported(r.stdout), () => false);
    return pathspecFile;
  }
  /**
   * A git command over a list of paths. `--literal-pathspecs`: they are file names out of `git status`, not patterns
   * (`a[1].txt` must not also match `a1.txt`).
   *  - git ≥ 2.25: the paths on stdin (`--pathspec-from-file=- --pathspec-file-nul`) — 全部暂存 / 全部还原 / 全部取消暂存
   *    over a few hundred files outgrow Windows' 32 767-character command line (`spawn ENAMETOOLONG`, nothing staged);
   *  - older git (Ubuntu 18.04 has 2.17, Debian 10 2.20 — remote machines often do): `-- <paths>` on the command line
   *    as before, in batches of ≤ `ARGV_PATHS_BUDGET` characters. Also when a git refuses the option after all
   *    (unknown option): that answer then sticks for the process.
   */
  async runPaths(cwd: string, args: string[], files: string[]) {
    if (await this.pathspecFromFile()) {
      try {
        return await this.run(cwd, ['--literal-pathspecs', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: files.join('\0') });
      } catch (e) {
        if (!(e instanceof GitCommandError) || !PATHSPEC_FILE_REFUSED.test(e.stderr)) throw e;
        pathspecFile = Promise.resolve(false);
      }
    }
    let last = { stdout: '', stderr: '' };
    for (const batch of argvBatches(files)) last = await this.run(cwd, ['--literal-pathspecs', ...args, '--', ...batch]);
    return last;
  }
  /** `files`: repo-relative paths (an empty list stages nothing — not `git add -A --`, which would stage everything) */
  async stage(cwd: string, files: string[] | 'all') {
    if (files === 'all') await this.run(cwd, ['add', '-A']);
    else if (files.length) await this.runPaths(cwd, ['add', '-A'], files);
    this.emit('changed', cwd);
  }
  async unstage(cwd: string, files: string[] | 'all') {
    if (files === 'all') await this.run(cwd, ['reset', '-q']);
    else if (files.length) await this.runPaths(cwd, ['reset', '-q'], files);
    this.emit('changed', cwd);
  }
  /** Discard working tree changes (checkout HEAD for tracked, delete untracked). */
  async discard(cwd: string, files: string[]) {
    const root = (await this.root(cwd)) ?? cwd;
    const st = await this.status(root);
    const untrackedSet = new Set(st.files.filter((x) => x.status === 'untracked').map((x) => x.path));
    const untracked = files.filter((f) => untrackedSet.has(f));
    const tracked = files.filter((f) => !untrackedSet.has(f));
    if (tracked.length) await this.runPaths(root, ['checkout', 'HEAD'], tracked).catch(async () => this.runPaths(root, ['checkout'], tracked));
    for (const f of untracked) await fs.rm(path.join(root, f), { recursive: true, force: true });
    this.emit('changed', cwd);
  }
  async commit(cwd: string, message: string, opts: { amend?: boolean; all?: boolean } = {}) {
    const args = ['commit', '-F', '-'];
    if (opts.amend) args.push('--amend');
    if (opts.all) args.push('-a');
    const r = await this.run(cwd, args, { input: message });
    this.emit('changed', cwd);
    return r.stdout;
  }
  async log(cwd: string, n = 30, rev?: string): Promise<GitLogEntry[]> {
    const fmt = '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D';
    const { stdout } = await this.run(cwd, ['log', `-n${n}`, `--format=${fmt}`, ...(rev ? [rev] : [])]).catch(() => ({ stdout: '' }));
    return stdout.split('\n').filter(Boolean).map((l) => {
      const [hash, short, author, email, ts, subject, refs] = l.split('\x1f');
      return { hash, short, author, email, date: Number(ts) * 1000, subject, refs: refs ? refs.split(',').map((x) => x.trim()).filter(Boolean) : [] };
    });
  }
  async show(cwd: string, rev: string): Promise<{ text: string; stat: string }> {
    const { stdout: stat } = await this.run(cwd, ['show', '--stat', '--format=%H%n%an <%ae>%n%ad%n%n%B', rev]);
    const { stdout: text } = await this.run(cwd, ['show', '--no-color', '--format=', rev]);
    return { text, stat };
  }
  async listBranches(cwd: string): Promise<GitBranch[]> {
    const { stdout: local } = await this.run(cwd, ['for-each-ref', `--format=%(refname:short)${SEP}%(HEAD)${SEP}%(upstream:short)${SEP}%(committerdate:unix)${SEP}%(objectname:short)`, 'refs/heads']);
    const { stdout: remote } = await this.run(cwd, ['for-each-ref', `--format=%(refname:short)${SEP}%(HEAD)${SEP}%(upstream:short)${SEP}%(committerdate:unix)${SEP}%(objectname:short)`, 'refs/remotes']);
    const parse = (s: string, isRemote: boolean): GitBranch[] => s.split('\n').filter(Boolean).map((l) => {
      const [name, head, upstream, ts, sha] = l.split('\x1f');
      return { name, current: head === '*', remote: isRemote, upstream: upstream || null, date: Number(ts) * 1000, sha };
    });
    return [...parse(local, false), ...parse(remote, true).filter((b) => !b.name.endsWith('/HEAD'))];
  }
  async checkout(cwd: string, name: string, opts: { create?: boolean; from?: string } = {}) {
    const args = opts.create ? ['checkout', '-b', name, ...(opts.from ? [opts.from] : [])] : ['checkout', name];
    await this.run(cwd, args);
    this.emit('changed', cwd);
  }
  async deleteBranch(cwd: string, name: string, force = false) {
    await this.run(cwd, ['branch', force ? '-D' : '-d', name]);
    this.emit('changed', cwd);
  }
  async fetch(cwd: string) {
    await this.run(cwd, ['fetch', '--prune', '--quiet'], { timeoutMs: 120_000 });
    this.emit('changed', cwd);
  }
  async pull(cwd: string, rebase = true) {
    const r = await this.run(cwd, ['pull', rebase ? '--rebase' : '--no-rebase', '--quiet'], { timeoutMs: 180_000 });
    this.emit('changed', cwd);
    return r.stdout;
  }
  async push(cwd: string, opts: { setUpstream?: boolean; force?: boolean } = {}) {
    const args = ['push', '--quiet'];
    if (opts.force) args.push('--force-with-lease');
    if (opts.setUpstream) {
      const st = await this.status(cwd);
      if (!st.branch) throw new GitCommandError(classifyGitError('detached HEAD'));
      const remotes = (await this.run(cwd, ['remote'])).stdout.split('\n').filter(Boolean);
      args.push('-u', remotes[0] ?? 'origin', st.branch);
    }
    const r = await this.run(cwd, args, { timeoutMs: 180_000 });
    this.emit('changed', cwd);
    return r.stderr + r.stdout;
  }
  async stash(cwd: string, op: 'push' | 'pop' | 'drop' | 'list', message?: string) {
    if (op === 'list') return (await this.run(cwd, ['stash', 'list'])).stdout;
    const args = op === 'push' ? ['stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])] : ['stash', op];
    const r = await this.run(cwd, args);
    this.emit('changed', cwd);
    return r.stdout;
  }
  async worktrees(cwd: string): Promise<GitWorktree[]> {
    const { stdout } = await this.run(cwd, ['worktree', 'list', '--porcelain']);
    const out: GitWorktree[] = [];
    let cur: Partial<GitWorktree> = {};
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) cur = { path: line.slice(9).replace(/\//g, path.sep) };
      else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12);
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
      else if (line === 'detached') cur.branch = null;
      else if (line === 'bare') cur.bare = true;
      else if (line.startsWith('locked')) cur.locked = true;
      else if (line === '' && cur.path) { out.push({ path: cur.path!, head: cur.head ?? '', branch: cur.branch ?? null, main: out.length === 0, bare: !!cur.bare, locked: !!cur.locked }); cur = {}; }
    }
    if (cur.path) out.push({ path: cur.path, head: cur.head ?? '', branch: cur.branch ?? null, main: out.length === 0, bare: !!cur.bare, locked: !!cur.locked });
    return out;
  }
  /** Add a worktree under <root>/.claude/worktrees/<name> (same convention as Claude Code's --worktree). */
  async worktreeAdd(cwd: string, name: string, opts: { branch?: string; from?: string; dir?: string } = {}): Promise<GitWorktree> {
    const root = (await this.root(cwd)) ?? cwd;
    const dir = opts.dir ?? path.join(root, '.claude', 'worktrees', name);
    const branch = opts.branch ?? name;
    const exists = (await this.listBranches(root)).some((b) => !b.remote && b.name === branch);
    const args = ['worktree', 'add', dir, ...(exists ? [branch] : ['-b', branch, ...(opts.from ? [opts.from] : [])])];
    await this.run(root, args);
    this.roots.clear();
    this.emit('changed', cwd);
    return { path: dir, head: '', branch, main: false, bare: false, locked: false };
  }
  async worktreeRemove(cwd: string, dir: string, force = false) {
    await this.run(cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
    this.roots.clear();
    this.emit('changed', cwd);
  }
  async remotes(cwd: string): Promise<{ name: string; url: string }[]> {
    const { stdout } = await this.run(cwd, ['remote', '-v']).catch(() => ({ stdout: '' }));
    const m = new Map<string, string>();
    for (const l of stdout.split('\n')) { const [n, u] = l.split(/\s+/); if (n && u && !m.has(n)) m.set(n, u); }
    return [...m].map(([name, url]) => ({ name, url }));
  }

  /** Watch .git metadata of a repo and broadcast `changed`; also schedule background fetches. */
  async watch(cwd: string) {
    const root = await this.root(cwd);
    if (!root || this.watchers.has(root)) return root;
    // linked worktrees / submodules: `.git` is a file; HEAD + index live in the per-worktree dir, refs in the common dir
    const g = await resolveGitDir(root);
    const common = await resolveCommonDir(g);
    if (this.watchers.has(root)) return root; // a concurrent watch() won while we were reading
    const w = chokidar.watch([path.join(g, 'HEAD'), path.join(g, 'index'), path.join(common, 'refs'), path.join(g, 'ORIG_HEAD'), path.join(g, 'MERGE_HEAD')], { ignoreInitial: true, depth: 3 });
    const entry: { w: any; timer?: ReturnType<typeof setTimeout> } = { w };
    w.on('all', () => { if (entry.timer) clearTimeout(entry.timer); entry.timer = setTimeout(() => this.emit('changed', root), 400); });
    w.on('error', (e: unknown) => console.error('[git] watch error:', (e as Error)?.message ?? e)); // unhandled 'error' would throw
    this.watchers.set(root, entry);
    this.fetchDirs.add(root);
    if (!this.fetchTimer) {
      this.fetchTimer = setInterval(() => { for (const d of this.fetchDirs) this.fetch(d).catch(() => {}); }, 5 * 60_000);
      this.fetchTimer.unref();
    }
    return root;
  }
  async unwatch(cwd: string) {
    const root = (await this.root(cwd)) ?? cwd;
    const e = this.watchers.get(root);
    if (e) { if (e.timer) clearTimeout(e.timer); this.watchers.delete(root); this.fetchDirs.delete(root); await e.w.close(); }
  }
}
