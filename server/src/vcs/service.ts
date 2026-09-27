import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitService } from '../git/service.js';
import type { VcsDetail, VcsItem, VcsRepo } from '../protocol.js';

const execFileAsync = promisify(execFile);
const isWin = process.platform === 'win32';

interface Target { provider: 'github' | 'gitlab'; host: string; owner: string; repo: string }

/**
 * GitHub / GitLab issues and PR/MR boards. Auth: `gh auth token` / GH_TOKEN for GitHub, `glab` config or GITLAB_TOKEN
 * for GitLab; all data calls go over REST/GraphQL with fetch (one process per token lookup, not per request).
 */
export class VcsService {
  private tokens = new Map<string, { token: string; at: number }>();
  private users = new Map<string, string>();
  constructor(private git: GitService) {}

  /** Parse the repo from `origin` (or an explicit `owner/repo[@host]`). */
  async target(cwd: string, explicit?: string): Promise<Target> {
    if (explicit) {
      const m = /^(?:https?:\/\/([^/]+)\/)?([^/@\s]+)\/([^/@\s]+?)(?:\.git)?(?:@([^\s]+))?$/.exec(explicit.trim());
      if (!m) throw new Error('仓库格式：owner/repo 或 https://host/owner/repo');
      const host = m[4] ?? m[1] ?? 'github.com';
      return { provider: /gitlab/i.test(host) ? 'gitlab' : 'github', host, owner: m[2], repo: m[3] };
    }
    const remotes = await this.git.remotes(cwd);
    const url = (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.url;
    if (!url) throw new Error('这个目录没有 git remote');
    const m = /^(?:https?:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/|git@([^:]+):|ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url.trim());
    if (!m) throw new Error(`看不懂 remote：${url}`);
    const host = m[1] ?? m[2] ?? m[3];
    const parts = m[5].split('/');
    return { provider: /gitlab/i.test(host) ? 'gitlab' : 'github', host, owner: m[4] + (parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : ''), repo: parts[parts.length - 1] };
  }

  private async token(t: Target): Promise<string> {
    const key = `${t.provider}:${t.host}`;
    const hit = this.tokens.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.token;
    let token = '';
    if (t.provider === 'github') {
      token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
      if (!token) { try { const { stdout } = await execFileAsync(isWin ? 'gh.exe' : 'gh', ['auth', 'token', '-h', t.host], { windowsHide: true, timeout: 15_000 }); token = stdout.trim(); } catch { /* not logged in */ } }
    } else {
      token = process.env.GITLAB_TOKEN ?? '';
      if (!token) { try { const { stdout } = await execFileAsync(isWin ? 'glab.exe' : 'glab', ['config', 'get', 'token', '-h', t.host], { windowsHide: true, timeout: 15_000 }); token = stdout.trim(); } catch { /* not logged in */ } }
    }
    if (!token) throw new Error(t.provider === 'github' ? '未登录 GitHub：运行 `gh auth login`，或设置 GH_TOKEN' : '未登录 GitLab：运行 `glab auth login`，或设置 GITLAB_TOKEN');
    this.tokens.set(key, { token, at: Date.now() });
    return token;
  }

  private base(t: Target) {
    if (t.provider === 'github') return t.host === 'github.com' ? 'https://api.github.com' : `https://${t.host}/api/v3`;
    return `https://${t.host}/api/v4`;
  }
  private pid(t: Target) { return encodeURIComponent(`${t.owner}/${t.repo}`); }

  private async api<T = any>(t: Target, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.token(t);
    const headers: Record<string, string> = t.provider === 'github' ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'claude-web' } : { 'private-token': token, 'user-agent': 'claude-web' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(`${this.base(t)}${path}`, { method: init.method ?? 'GET', headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    if (!r.ok) throw new Error(`${r.status} ${json?.message ?? json?.error ?? text.slice(0, 200)}`);
    return json as T;
  }

  private async graphql<T = any>(t: Target, query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.token(t);
    const url = t.host === 'github.com' ? 'https://api.github.com/graphql' : `https://${t.host}/api/graphql`;
    const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'claude-web' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* HTML error page from a proxy / GHE */ }
    // 401 "Bad credentials" has no `errors` array — without this the caller crashes on `undefined.repository`
    if (!r.ok || !j) throw new Error(`${r.status} ${j?.message ?? text.slice(0, 200)}`);
    if (j.errors?.length) throw new Error(j.errors.map((e: any) => e.message).join('; '));
    return j.data as T;
  }

  async repo(cwd: string, explicit?: string): Promise<VcsRepo> {
    const t = await this.target(cwd, explicit);
    const out: VcsRepo = { ...t, url: `https://${t.host}/${t.owner}/${t.repo}`, authOk: false, user: '', error: '', cli: t.provider === 'github' ? 'gh' : 'glab' };
    try {
      const key = `${t.provider}:${t.host}`;
      let user = this.users.get(key);
      if (!user) {
        // app / Actions / narrow fine-grained tokens get 403 on /user yet can read repos: the repo call below decides authOk
        try {
          const me = await this.api<any>(t, '/user');
          user = t.provider === 'github' ? me.login : me.username;
          this.users.set(key, user ?? '');
        } catch (e: any) {
          if (!/^403\b/.test(String(e?.message))) throw e;
        }
      }
      out.user = user ?? '';
      if (t.provider === 'github') { const r = await this.api<any>(t, `/repos/${t.owner}/${t.repo}`); out.defaultBranch = r.default_branch; out.openIssues = r.open_issues_count; out.private = !!r.private; }
      else { const r = await this.api<any>(t, `/projects/${this.pid(t)}`); out.defaultBranch = r.default_branch; out.openIssues = r.open_issues_count; out.private = r.visibility !== 'public'; }
      out.authOk = true;
    } catch (e: any) { out.error = e.message; }
    return out;
  }

  // ---- lists ----
  async issues(cwd: string, o: { state?: 'open' | 'closed' | 'all'; q?: string; page?: number; repo?: string; mine?: boolean } = {}): Promise<VcsItem[]> {
    const t = await this.target(cwd, o.repo);
    const state = o.state ?? 'open';
    if (t.provider === 'github') {
      if (o.q || o.mine) {
        const user = o.mine ? (await this.repo(cwd, o.repo)).user : '';
        const q = `repo:${t.owner}/${t.repo} is:issue${state === 'all' ? '' : ` is:${state}`}${o.mine ? ` assignee:${user}` : ''} ${o.q ?? ''}`.trim();
        const r = await this.api<any>(t, `/search/issues?q=${encodeURIComponent(q)}&per_page=50&page=${o.page ?? 1}&sort=updated`);
        return (r.items ?? []).map((x: any) => this.ghIssue(x));
      }
      const r = await this.api<any[]>(t, `/repos/${t.owner}/${t.repo}/issues?state=${state}&per_page=50&page=${o.page ?? 1}&sort=updated`);
      return r.filter((x) => !x.pull_request).map((x) => this.ghIssue(x));
    }
    const st = state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all';
    const r = await this.api<any[]>(t, `/projects/${this.pid(t)}/issues?state=${st}&per_page=50&page=${o.page ?? 1}&order_by=updated_at${o.q ? `&search=${encodeURIComponent(o.q)}` : ''}${o.mine ? '&scope=assigned_to_me' : ''}`);
    return r.map((x) => this.glIssue(x));
  }

  async pulls(cwd: string, o: { state?: 'open' | 'closed' | 'merged' | 'all'; page?: number; repo?: string } = {}): Promise<VcsItem[]> {
    const t = await this.target(cwd, o.repo);
    const state = o.state ?? 'open';
    if (t.provider === 'github') {
      const states = state === 'open' ? ['OPEN'] : state === 'closed' ? ['CLOSED'] : state === 'merged' ? ['MERGED'] : ['OPEN', 'CLOSED', 'MERGED'];
      const d = await this.graphql<any>(t, `query($owner:String!,$name:String!,$states:[PullRequestState!]){ repository(owner:$owner,name:$name){ pullRequests(first:50,states:$states,orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ number title isDraft state url createdAt updatedAt mergedAt author{login} headRefName baseRefName additions deletions changedFiles reviewDecision mergeable labels(first:10){nodes{name color}} assignees(first:5){nodes{login}} comments{totalCount} reviewThreads{totalCount} commits(last:1){nodes{commit{statusCheckRollup{state}}}} } } } }`, { owner: t.owner, name: t.repo, states });
      return (d.repository?.pullRequests?.nodes ?? []).map((p: any): VcsItem => ({ number: p.number, title: p.title, state: p.state === 'MERGED' ? 'merged' : p.state === 'OPEN' ? 'open' : 'closed', isPr: true, draft: p.isDraft, author: p.author?.login ?? '', labels: (p.labels?.nodes ?? []).map((l: any) => ({ name: l.name, color: l.color })), assignees: (p.assignees?.nodes ?? []).map((a: any) => a.login), comments: (p.comments?.totalCount ?? 0) + (p.reviewThreads?.totalCount ?? 0), createdAt: p.createdAt, updatedAt: p.updatedAt, url: p.url, head: p.headRefName, base: p.baseRefName, additions: p.additions, deletions: p.deletions, changedFiles: p.changedFiles, reviewDecision: (p.reviewDecision ?? '').toLowerCase(), checks: rollup(p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state), mergeable: p.mergeable === 'MERGEABLE' ? true : p.mergeable === 'CONFLICTING' ? false : undefined }));
    }
    const st = state === 'open' ? 'opened' : state === 'all' ? 'all' : state;
    const r = await this.api<any[]>(t, `/projects/${this.pid(t)}/merge_requests?state=${st}&per_page=50&page=${o.page ?? 1}&order_by=updated_at&with_merge_status_recheck=true`);
    return r.map((x) => this.glMr(x));
  }

  // ---- detail ----
  async item(cwd: string, number: number, isPr: boolean, repo?: string): Promise<VcsDetail> {
    const t = await this.target(cwd, repo);
    if (t.provider === 'github') {
      const [issue, comments] = await Promise.all([this.api<any>(t, `/repos/${t.owner}/${t.repo}/${isPr ? 'pulls' : 'issues'}/${number}`), this.api<any[]>(t, `/repos/${t.owner}/${t.repo}/issues/${number}/comments?per_page=100`)]);
      const base = isPr ? this.ghPull(issue) : this.ghIssue(issue);
      const d: VcsDetail = { ...base, body: issue.body ?? '', comments: comments.map((c) => ({ id: String(c.id), author: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at, url: c.html_url })), commentsList: [] };
      if (isPr) {
        const [reviews, files, checks] = await Promise.all([
          this.api<any[]>(t, `/repos/${t.owner}/${t.repo}/pulls/${number}/reviews?per_page=100`).catch(() => []),
          this.api<any[]>(t, `/repos/${t.owner}/${t.repo}/pulls/${number}/files?per_page=100`).catch(() => []),
          issue.head?.sha ? this.api<any>(t, `/repos/${t.owner}/${t.repo}/commits/${issue.head.sha}/check-runs?per_page=100`).catch(() => null) : Promise.resolve(null),
        ]);
        d.reviews = reviews.filter((r) => r.state !== 'COMMENTED').map((r) => ({ author: r.user?.login ?? '', state: String(r.state).toLowerCase(), submittedAt: r.submitted_at }));
        d.files = files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, status: f.status }));
        d.checkRuns = (checks?.check_runs ?? []).map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion ?? '', url: c.html_url ?? '' }));
        const latest = new Map<string, string>();
        for (const r of d.reviews) latest.set(r.author, r.state);
        const states = [...latest.values()];
        d.reviewDecision = states.includes('changes_requested') ? 'changes_requested' : states.includes('approved') ? 'approved' : d.reviewDecision || 'review_required';
        d.mergeable = issue.mergeable ?? undefined;
        d.mergeableState = issue.mergeable_state;
      }
      return d;
    }
    const kind = isPr ? 'merge_requests' : 'issues';
    const [it, notes] = await Promise.all([this.api<any>(t, `/projects/${this.pid(t)}/${kind}/${number}`), this.api<any[]>(t, `/projects/${this.pid(t)}/${kind}/${number}/notes?per_page=100&sort=asc`)]);
    const base = isPr ? this.glMr(it) : this.glIssue(it);
    const d: VcsDetail = { ...base, body: it.description ?? '', comments: notes.filter((n) => !n.system).map((n) => ({ id: String(n.id), author: n.author?.username ?? '', body: n.body ?? '', createdAt: n.created_at, url: '' })), commentsList: [] };
    if (isPr) {
      const [approvals, changes, pipelines] = await Promise.all([this.api<any>(t, `/projects/${this.pid(t)}/merge_requests/${number}/approvals`).catch(() => null), this.api<any>(t, `/projects/${this.pid(t)}/merge_requests/${number}/changes`).catch(() => null), this.api<any[]>(t, `/projects/${this.pid(t)}/merge_requests/${number}/pipelines?per_page=5`).catch(() => [])]);
      d.reviews = (approvals?.approved_by ?? []).map((a: any) => ({ author: a.user?.username ?? '', state: 'approved', submittedAt: '' }));
      d.files = (changes?.changes ?? []).map((c: any) => ({ path: c.new_path, additions: 0, deletions: 0, status: c.new_file ? 'added' : c.deleted_file ? 'removed' : c.renamed_file ? 'renamed' : 'modified' }));
      d.checkRuns = (pipelines ?? []).map((p: any) => ({ name: `pipeline #${p.id}`, status: p.status === 'success' || p.status === 'failed' || p.status === 'canceled' ? 'completed' : p.status, conclusion: p.status, url: p.web_url ?? '' }));
      d.reviewDecision = (d.reviews ?? []).length ? 'approved' : 'review_required';
      d.mergeable = it.merge_status === 'can_be_merged' || it.detailed_merge_status === 'mergeable';
    }
    return d;
  }

  // ---- mutations ----
  async comment(cwd: string, number: number, body: string, isPr: boolean, repo?: string) {
    const t = await this.target(cwd, repo);
    if (t.provider === 'github') return this.api(t, `/repos/${t.owner}/${t.repo}/issues/${number}/comments`, { method: 'POST', body: { body } });
    return this.api(t, `/projects/${this.pid(t)}/${isPr ? 'merge_requests' : 'issues'}/${number}/notes`, { method: 'POST', body: { body } });
  }
  async setState(cwd: string, number: number, state: 'open' | 'closed', isPr: boolean, repo?: string) {
    const t = await this.target(cwd, repo);
    if (t.provider === 'github') return this.api(t, `/repos/${t.owner}/${t.repo}/${isPr ? 'pulls' : 'issues'}/${number}`, { method: 'PATCH', body: { state } });
    return this.api(t, `/projects/${this.pid(t)}/${isPr ? 'merge_requests' : 'issues'}/${number}`, { method: 'PUT', body: { state_event: state === 'open' ? 'reopen' : 'close' } });
  }
  async assign(cwd: string, number: number, assignees: string[], isPr: boolean, repo?: string) {
    const t = await this.target(cwd, repo);
    if (t.provider === 'github') return this.api(t, `/repos/${t.owner}/${t.repo}/issues/${number}`, { method: 'PATCH', body: { assignees } });
    // GitLab wants user ids
    const ids: number[] = [];
    for (const u of assignees) { const r = await this.api<any[]>(t, `/users?username=${encodeURIComponent(u)}`); if (r[0]) ids.push(r[0].id); }
    return this.api(t, `/projects/${this.pid(t)}/${isPr ? 'merge_requests' : 'issues'}/${number}`, { method: 'PUT', body: { assignee_ids: ids } });
  }
  async labels(cwd: string, number: number, labels: string[], isPr: boolean, repo?: string) {
    const t = await this.target(cwd, repo);
    if (t.provider === 'github') return this.api(t, `/repos/${t.owner}/${t.repo}/issues/${number}`, { method: 'PATCH', body: { labels } });
    return this.api(t, `/projects/${this.pid(t)}/${isPr ? 'merge_requests' : 'issues'}/${number}`, { method: 'PUT', body: { labels: labels.join(',') } });
  }
  async merge(cwd: string, number: number, method: 'merge' | 'squash' | 'rebase', repo?: string) {
    const t = await this.target(cwd, repo);
    if (t.provider === 'github') return this.api(t, `/repos/${t.owner}/${t.repo}/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: method } });
    return this.api(t, `/projects/${this.pid(t)}/merge_requests/${number}/merge`, { method: 'PUT', body: { squash: method === 'squash' } });
  }
  async create(cwd: string, p: { title: string; body?: string; isPr?: boolean; head?: string; base?: string; draft?: boolean; labels?: string[] }, repo?: string): Promise<VcsItem> {
    const t = await this.target(cwd, repo);
    if (t.provider === 'github') {
      if (p.isPr) return this.ghPull(await this.api(t, `/repos/${t.owner}/${t.repo}/pulls`, { method: 'POST', body: { title: p.title, body: p.body ?? '', head: p.head, base: p.base, draft: !!p.draft } }));
      return this.ghIssue(await this.api(t, `/repos/${t.owner}/${t.repo}/issues`, { method: 'POST', body: { title: p.title, body: p.body ?? '', labels: p.labels ?? [] } }));
    }
    if (p.isPr) return this.glMr(await this.api(t, `/projects/${this.pid(t)}/merge_requests`, { method: 'POST', body: { title: p.draft ? `Draft: ${p.title}` : p.title, description: p.body ?? '', source_branch: p.head, target_branch: p.base } }));
    return this.glIssue(await this.api(t, `/projects/${this.pid(t)}/issues`, { method: 'POST', body: { title: p.title, description: p.body ?? '', labels: (p.labels ?? []).join(',') } }));
  }

  /** Fetch the PR/MR head into a local branch; optionally as a worktree. Returns the directory to work in. */
  async checkout(cwd: string, number: number, o: { worktree?: boolean; repo?: string } = {}): Promise<{ branch: string; path: string }> {
    const t = await this.target(cwd, o.repo);
    const branch = t.provider === 'github' ? `pr-${number}` : `mr-${number}`;
    const ref = t.provider === 'github' ? `pull/${number}/head` : `merge-requests/${number}/head`;
    const root = (await this.git.root(cwd)) ?? cwd;
    await this.git.run(root, ['fetch', 'origin', `+${ref}:refs/remotes/origin/${branch}`]);
    if (o.worktree) {
      const exists = (await this.git.listBranches(root)).some((b) => !b.remote && b.name === branch);
      if (exists) await this.git.run(root, ['branch', '-f', branch, `origin/${branch}`]).catch(() => {});
      const wt = await this.git.worktreeAdd(root, branch, { branch, from: `origin/${branch}` });
      return { branch, path: wt.path };
    }
    await this.git.run(root, ['checkout', '-B', branch, `origin/${branch}`]);
    return { branch, path: root };
  }

  // ---- mappers ----
  private ghIssue(x: any): VcsItem {
    return { number: x.number, title: x.title, state: x.state === 'open' ? 'open' : 'closed', isPr: !!x.pull_request, author: x.user?.login ?? '', labels: (x.labels ?? []).map((l: any) => ({ name: l.name, color: l.color ?? '' })), assignees: (x.assignees ?? []).map((a: any) => a.login), comments: x.comments ?? 0, createdAt: x.created_at, updatedAt: x.updated_at, url: x.html_url, milestone: x.milestone?.title ?? '' };
  }
  private ghPull(x: any): VcsItem {
    return { ...this.ghIssue(x), isPr: true, state: x.merged_at ? 'merged' : x.state === 'open' ? 'open' : 'closed', draft: !!x.draft, head: x.head?.ref, base: x.base?.ref, additions: x.additions, deletions: x.deletions, changedFiles: x.changed_files, comments: (x.comments ?? 0) + (x.review_comments ?? 0), mergeable: x.mergeable ?? undefined };
  }
  private glIssue(x: any): VcsItem {
    return { number: x.iid, title: x.title, state: x.state === 'opened' ? 'open' : 'closed', isPr: false, author: x.author?.username ?? '', labels: (x.labels ?? []).map((l: any) => ({ name: typeof l === 'string' ? l : l.name, color: '' })), assignees: (x.assignees ?? []).map((a: any) => a.username), comments: x.user_notes_count ?? 0, createdAt: x.created_at, updatedAt: x.updated_at, url: x.web_url, milestone: x.milestone?.title ?? '' };
  }
  private glMr(x: any): VcsItem {
    return { ...this.glIssue(x), isPr: true, state: x.state === 'merged' ? 'merged' : x.state === 'opened' ? 'open' : 'closed', draft: !!x.draft || !!x.work_in_progress, head: x.source_branch, base: x.target_branch, checks: x.head_pipeline ? rollup(String(x.head_pipeline.status).toUpperCase()) : 'none', mergeable: x.merge_status === 'can_be_merged' ? true : x.merge_status === 'cannot_be_merged' ? false : undefined, reviewDecision: '' };
  }
}

function rollup(state?: string): VcsItem['checks'] {
  switch ((state ?? '').toUpperCase()) {
    case 'SUCCESS': return 'success';
    case 'FAILURE': case 'ERROR': case 'FAILED': return 'failure';
    case 'PENDING': case 'EXPECTED': case 'RUNNING': case 'CREATED': case 'WAITING_FOR_RESOURCE': case 'PREPARING': return 'pending';
    default: return state ? 'pending' : 'none';
  }
}
