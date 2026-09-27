// The real OrchDeps: sessions go through the same pool / canonical / transcript path as the hub's
// `session.open` + `session.send`, git goes through GitService. Kept out of service.ts so the engine
// stays unit-testable with fakes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentKind, OpenSessionParams } from '../protocol.js';
import type { RunnerPool } from '../runtime/pool.js';
import type { MetaStore } from '../meta/store.js';
import type { CanonicalLog } from '../session/canonical.js';
import type { AgentTranscripts } from '../agents/transcript.js';
import type { AgentRegistry, AgentDriver } from '../agents/types.js';
import type { GitService } from '../git/service.js';
import type { GoalService } from '../goals/service.js';
import type { LibraryService } from '../library/service.js';
import { expandSessionRefs } from '../library/briefing.js';
import { DEFAULT_MAX_PARALLEL, type OrchDeps, type OrchGit, type OrchSession } from './service.js';

const FALLBACK_IDENTITY = ['-c', 'user.name=claude-web', '-c', 'user.email=claude-web@localhost'];

/** GitService-backed OrchGit. Commits / merges retry with a fallback identity when the repo has none. */
export function gitAdapter(git: GitService): OrchGit {
  const identityRetry = async <T>(fn: (pre: string[]) => Promise<T>): Promise<T> => {
    try { return await fn([]); } catch (e: any) {
      if (e?.info?.kind !== 'identity') throw e;
      return fn(FALLBACK_IDENTITY);
    }
  };
  const errText = (e: any) => (e?.info?.message ?? e?.message ?? String(e)).split('\n').filter(Boolean).slice(0, 6).join('\n');
  return {
    root: (cwd) => git.root(cwd),
    async currentBranch(cwd) {
      const r = await git.run(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null);
      return r?.stdout.trim() || null;
    },
    async exclude(root) {
      const { stdout } = await git.run(root, ['rev-parse', '--git-path', 'info/exclude']);
      const file = path.resolve(root, stdout.trim());
      const cur = await fs.readFile(file, 'utf8').catch(() => '');
      if (cur.split(/\r?\n/).some((l) => l.trim() === '/.claude-web/')) return;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}# claude-web orchestration worktrees\n/.claude-web/\n`);
    },
    async worktreeAdd(root, dir, branch, from) {
      // a leftover from an earlier attempt (retry / resume) with the same names: start over cleanly
      const wts = await git.worktrees(root).catch(() => []);
      if (wts.some((w) => path.resolve(w.path) === path.resolve(dir))) await git.run(root, ['worktree', 'remove', '--force', dir]).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await git.run(root, ['worktree', 'prune']).catch(() => {});
      await git.run(root, ['branch', '-D', branch]).catch(() => {});
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await git.run(root, ['worktree', 'add', '-b', branch, dir, from]);
      git.emit('changed', root);
    },
    async commitAll(dir, message) {
      await git.run(dir, ['add', '-A']);
      const { stdout } = await git.run(dir, ['status', '--porcelain']);
      if (!stdout.trim()) return false;
      await identityRetry((pre) => git.run(dir, [...pre, 'commit', '-q', '-F', '-'], { input: message }));
      return true;
    },
    async diffStat(root, base, branch) {
      const range = `${base}...${branch}`;
      const { stdout: stat } = await git.run(root, ['diff', '--stat', range]);
      const { stdout: names } = await git.run(root, ['diff', '--name-only', range]);
      return { stat: stat.trimEnd(), files: names.split('\n').filter(Boolean).length };
    },
    async diff(root, base, branch) {
      return (await git.run(root, ['diff', `${base}...${branch}`])).stdout;
    },
    async merge(cwd, branch, message) {
      try {
        await identityRetry((pre) => git.run(cwd, [...pre, 'merge', '--no-ff', '-q', '-m', message, branch]));
        git.emit('changed', cwd);
        return { ok: true };
      } catch (e: any) {
        // never leave the user's working tree half-merged: abort, keep the branch for manual handling
        await git.run(cwd, ['merge', '--abort']).catch(() => {});
        return { ok: false, error: errText(e) };
      }
    },
    async worktreeRemove(root, dir) {
      await git.run(root, ['worktree', 'remove', '--force', dir]).catch(() => {});
      // a just-closed agent process may still be releasing its cwd on Windows
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
      await git.run(root, ['worktree', 'prune']).catch(() => {});
      git.emit('changed', root);
    },
    async deleteBranch(root, branch) { await git.run(root, ['branch', '-D', branch]); },
  };
}

export interface RuntimeServices {
  pool: RunnerPool; meta: MetaStore; canonical: CanonicalLog; transcripts: AgentTranscripts;
  agents: AgentRegistry; git: GitService; goals: GoalService; library: LibraryService;
}

export function orchestraDeps(s: RuntimeServices, dir: string, notify?: OrchDeps['notify']): OrchDeps {
  const titles = new Map<string, string>();
  return {
    dir,
    notify,
    git: gitAdapter(s.git),
    goals: s.goals,
    workflows: {
      list: () => s.meta.workflows(),
      set: (w) => s.meta.setWorkflow(w),
      remove: (id) => s.meta.removeWorkflow(id),
    },
    available: async () => (await s.agents.list()).filter((a) => a.installed && a.enabled).map((a) => a.kind),
    maxParallel: () => Number(s.meta.settings()['orchestra.maxParallel']) || DEFAULT_MAX_PARALLEL,
    async open(p) {
      // same defaults as the hub's session.open for a brand-new session
      const settings = s.meta.settings();
      let params: OpenSessionParams = { cwd: p.cwd, model: p.model, permissionMode: p.permissionMode ?? 'default' };
      if (p.agent !== 'claude') params.agent = p.agent as AgentKind;
      else {
        params = { ...params, providerId: settings.defaultProviderId as string | undefined };
        if (settings.defaultFeatures) params.features = settings.defaultFeatures as any;
      }
      const r = s.pool.open(params, p.agent === 'claude' ? null : []);
      await s.canonical.ensure(r.sessionId, p.cwd);
      if (params.providerId && params.providerId !== 'claude') await s.meta.setSessionMeta(r.sessionId, { providerId: params.providerId }).catch(() => {});
      titles.set(r.sessionId, p.title);
      return r as unknown as OrchSession;
    },
    async send(sess, text) {
      const r = sess as unknown as AgentDriver;
      for (let i = 0; i < 240 && r.state === 'starting'; i++) await new Promise((res) => setTimeout(res, 250));
      if (r.state === 'closed' || r.state === 'error') throw new Error('会话没能启动');
      const outgoing = text.includes('<session-ref ') ? await expandSessionRefs(text, (id) => s.library.readAll(id)) : text;
      const uuid = randomUUID();
      r.send(outgoing, undefined, undefined, uuid);
      s.canonical.observe(r.sessionId, { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } });
      // foreign agents: give the session a recognisable title (Claude derives it from the first prompt, whose first line says 编排)
      const title = titles.get(r.sessionId);
      titles.delete(r.sessionId);
      const head = await s.transcripts.head(r.sessionId).catch(() => null);
      if (head && !head.title && title) await s.transcripts.patchHead(r.sessionId, { title: `编排 · ${title}`.slice(0, 80) }).catch(() => {});
    },
    async interrupt(sessionId) { await s.pool.get(sessionId)?.interrupt(); },
    async close(sessionId) { await s.pool.close(sessionId); },
  };
}
