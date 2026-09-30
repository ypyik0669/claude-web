// The start page (redesign phase 7, spec §5.8 / mock-home.png): the four starters, the 入门清单, the three lists
// under the composer, the project the composer starts on and the login / runtime notice. Pure — the components in
// this folder and workbench/Welcome.tsx only draw it.
import type { Schedule, SessionMeta, SessionSummary } from '@shared';
import type { IconName } from '@/ui/icons';
import { isArchived } from '@/features/sidebar/filter';
import { rowStatus } from '@/features/sidebar/status';
import { basename } from '@/util';
import { isWithin } from '@/features/paths';
import { nextRunText, scheduleText } from '@/features/automation/schedule-text';

// ---------------------------------------------------------------------------------------------------- starters

export interface Starter { id: string; icon: IconName; label: string; text: string }
/** Four ways to begin (spec §5.8). A click only puts the text in the box: nothing is sent. */
export const STARTERS: Starter[] = [
  { id: 'explain', icon: 'read', label: '讲讲这个项目的结构', text: '讲讲这个项目的结构：有哪些主要目录、入口在哪、各部分怎么配合。' },
  { id: 'bug', icon: 'search', label: '找一个 bug 并修好', text: '找一个 bug 并修好：先说清楚问题在哪、怎么复现，再动手改。' },
  { id: 'tests', icon: 'todo', label: '给最近的改动补测试', text: '给最近的改动补测试：看看最近的提交和未提交的改动，找出没被测到的地方。' },
  { id: 'plan', icon: 'plan', label: '先出方案再动手', text: '先出一个方案给我看，我同意之后再动手：' },
];

/** The box after a starter is clicked: it fills an empty box (or replaces another starter); typed text is kept. */
export function applyStarter(current: string, text: string): string {
  const cur = current.trim();
  if (!cur || STARTERS.some((s) => s.text.trim() === cur)) return text;
  return `${current.replace(/\s+$/, '')}\n${text}`;
}

// ---------------------------------------------------------------------------------------------------- 入门清单

/** meta.json key (settings) holding the checklist's progress. */
export const CHECKLIST_KEY = 'onboarding.checklist';
export type ChecklistId = 'project' | 'send' | 'review' | 'palette';
/** The four steps of spec §5.8, in order. The words (they name a shortcut) are built by the component. */
export const CHECKLIST: { id: ChecklistId }[] = [{ id: 'project' }, { id: 'send' }, { id: 'review' }, { id: 'palette' }];
const IDS = CHECKLIST.map((c) => c.id);

/** `since`: when this app first showed the list (written the first time it is read — older stores get it then). */
export interface ChecklistStore { done: ChecklistId[]; dismissed?: boolean; since?: number }

export function readChecklist(raw: unknown): ChecklistStore {
  const r = raw && typeof raw === 'object' ? (raw as { done?: unknown; dismissed?: unknown; since?: unknown }) : {};
  const done = Array.isArray(r.done) ? IDS.filter((id) => (r.done as unknown[]).includes(id)) : [];
  const out: ChecklistStore = r.dismissed === true ? { done, dismissed: true } : { done };
  if (typeof r.since === 'number' && Number.isFinite(r.since)) out.since = r.since;
  return out;
}

export interface ChecklistFacts {
  projects: number;
  /**
   * a step that just happened in this app: a message sent from a composer, a changed file looked at in 审阅, the
   * palette opened with its shortcut. Conversations that merely exist (the CLI's history) do not count.
   */
  event?: ChecklistId;
  /** the time now: a list read for the first time gets its `since` */
  now?: number;
}

/**
 * The stored progress with what is true now: a project exists → 选一个项目, plus the step that just happened.
 * Steps are recorded, never derived only — removing the last project must not bring a finished card back. null =
 * nothing to write (also once it is dismissed or finished: it is gone for good).
 */
export function reconcileChecklist(stored: ChecklistStore, f: ChecklistFacts): ChecklistStore | null {
  if (stored.dismissed || stored.done.length >= IDS.length) return null;
  const add = new Set(stored.done);
  if (f.projects > 0) add.add('project');
  if (f.event) add.add(f.event);
  const stamp = stored.since === undefined && f.now !== undefined;
  if (add.size === stored.done.length && !stamp) return null;
  return { ...stored, done: IDS.filter((id) => add.has(id)), ...(stamp ? { since: f.now } : {}) };
}

export function checklistView(stored: ChecklistStore): { items: { id: ChecklistId; done: boolean }[]; done: number; total: number; next: ChecklistId | null; visible: boolean } {
  const items = IDS.map((id) => ({ id, done: stored.done.includes(id) }));
  const done = items.filter((i) => i.done).length;
  const next = items.find((i) => !i.done)?.id ?? null;
  return { items, done, total: IDS.length, next, visible: !stored.dismissed && next !== null };
}

// ---------------------------------------------------------------------------------------------------- the lists

export type HomeTab = 'recent' | 'schedules' | 'archived';
export function homeTabs(o: { schedules: number }): { id: HomeTab; label: string; n?: number }[] {
  return [
    { id: 'recent', label: '最近任务' },
    { id: 'schedules', label: '定时任务', n: o.schedules || undefined },
    { id: 'archived', label: '已归档' },
  ];
}

/** What sits at the right of a row: the sidebar's status in words (a wider row), a schedule's next run. */
export type HomeStatus =
  | { kind: 'confirm' | 'ask' | 'error' | 'running' | 'paused'; label: string; title: string }
  | { kind: 'diff'; label: string; title: string; added: number; removed: number }
  | { kind: 'time'; label: string; title: string };

export interface HomeRow { id: string; title: string; where: string; agent?: string; when: string; whenTitle?: string; status: HomeStatus | null }

/** The runner state this window knows about a conversation (open sessions), for the row's status. */
export interface KnownStatus { state?: string; pending?: readonly { toolName: string }[]; error?: string; diff?: { added: number; removed: number } | null }

export interface HomeInput {
  sessions: SessionSummary[];
  meta: Record<string, SessionMeta>;
  workspaces: { path: string; name: string }[];
  agents?: { kind: string; name: string }[];
  schedules?: Schedule[];
  status?: Record<string, KnownStatus>;
  now?: number;
}

export const HOME_PAGE = 5;

/** 刚刚 / 10 分钟前 / 3 小时前 / 昨天 / 4 天前 / 9/20 — the second line of a row. */
export function agoText(ts: number, now = Date.now()): string {
  if (!ts) return '';
  const d = now - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  if (d < 2 * 86400_000) return '昨天';
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)} 天前`;
  const t = new Date(ts);
  return `${t.getMonth() + 1}/${t.getDate()}`;
}

/** A waiting request in words: which kind of thing Claude waits on. */
export function waitingText(pending: readonly { toolName: string }[]): string {
  if (!pending.length) return '等你确认';
  if (pending.every((p) => p.toolName === 'AskUserQuestion')) return '有问题问你';
  if (pending.length > 1) return `等你确认 ${pending.length} 个操作`;
  const t = pending[0].toolName;
  if (t === 'Bash' || t === 'PowerShell') return '等你确认一条命令';
  if (t === 'Edit' || t === 'MultiEdit' || t === 'Write' || t === 'NotebookEdit') return '等你确认一处修改';
  if (t === 'ExitPlanMode') return '等你确认方案';
  return '等你确认';
}

function projectOf(cwd: string, workspaces: HomeInput['workspaces']): string {
  const w = [...workspaces].sort((a, b) => b.path.length - a.path.length).find((x) => isWithin(cwd, x.path));
  return w?.name ?? (basename(cwd) || cwd);
}

export function homeStatus(s: SessionSummary, k: KnownStatus | undefined): HomeStatus | null {
  const st = rowStatus({ state: (k?.state ?? s.live) as never, pending: k?.pending, error: k?.error, diff: k?.diff, lastModified: s.lastModified });
  switch (st.kind) {
    case 'confirm': return { kind: 'confirm', label: waitingText(k?.pending ?? []), title: st.title };
    case 'ask': return { kind: 'ask', label: '有问题问你', title: st.title };
    case 'error': return { kind: 'error', label: '出错', title: st.title };
    case 'running': return { kind: 'running', label: '运行中', title: st.title };
    case 'diff': return { kind: 'diff', label: st.label, title: st.title, added: st.added ?? 0, removed: st.removed ?? 0 };
    default: return null; // the time and the agent are on the second line already
  }
}

/** The rows of one tab (at most HOME_PAGE) and how many more there are. */
export function homeRows(tab: HomeTab, o: HomeInput): { rows: HomeRow[]; more: number } {
  const now = o.now ?? Date.now();
  if (tab === 'schedules') {
    // in the order the automation page lists them
    const list = o.schedules ?? [];
    const rows = list.slice(0, HOME_PAGE).map((sc): HomeRow => {
      const period = scheduleText(sc);
      return {
        id: sc.id,
        title: sc.name || sc.prompt.slice(0, 30),
        where: sc.cwd ? projectOf(sc.cwd, o.workspaces) : '',
        when: period.text,
        ...(period.title ? { whenTitle: period.title } : {}),
        status: sc.lastError ? { kind: 'error', label: '出错', title: sc.lastError }
          : !sc.enabled ? { kind: 'paused', label: '已暂停', title: '没有启用' }
          : sc.nextRunAt ? { kind: 'time', label: nextRunText(sc.nextRunAt, now), title: `下次运行：${new Date(sc.nextRunAt).toLocaleString()}` }
          : null,
      };
    });
    return { rows, more: Math.max(0, list.length - rows.length) };
  }
  const list = o.sessions
    .filter((s) => !s.parentId && (tab === 'archived') === isArchived(s, o.meta))
    .sort((a, b) => b.lastModified - a.lastModified);
  const agentName = (k?: string) => (k && k !== 'claude' ? o.agents?.find((a) => a.kind === k)?.name ?? k : undefined);
  const rows = list.slice(0, HOME_PAGE).map((s): HomeRow => {
    const where = projectOf(s.cwd, o.workspaces);
    return {
      id: s.sessionId,
      title: s.title,
      where: s.peer ? `${s.peer.name} · ${where}` : where,
      agent: agentName(s.agent),
      when: agoText(s.lastModified, now),
      status: homeStatus(s, o.status?.[s.sessionId]),
    };
  });
  return { rows, more: Math.max(0, list.length - rows.length) };
}

// ---------------------------------------------------------------------------------------------------- the composer's project

/** A throwaway checkout the user did not pick: an orchestration worktree (kept outside the repo, under the data dir). */
const ORCH_WORKTREE = /[\\/]\.claude-web[\\/]worktrees[\\/]/i;
/** Claude Code's own worktree session: `<repo>/.claude/worktrees/<name>` → the repo. */
const CLAUDE_WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/i;

/**
 * The folder the start page's composer begins with: the one used last (remembered by this browser), else the project
 * of the newest top-level conversation on this machine, else the first project. A conversation's project is its
 * sidebar group (`SessionMeta.groupCwd`: an orchestration node's run folder, not its worktree); a worktree session
 * counts as its repo; forks / sub-agents are skipped (they follow their parent). A conversation on another machine
 * has a path that does not exist here.
 */
export function initialCwd(o: { stored: string | null | undefined; sessions: SessionSummary[]; workspaces: { path: string }[]; meta?: Record<string, SessionMeta> }): string {
  if (o.stored) return o.stored;
  const local = o.sessions.filter((s) => !s.peer && !s.parentId && s.cwd).sort((a, b) => b.lastModified - a.lastModified);
  for (const s of local) {
    const dir = o.meta?.[s.sessionId]?.groupCwd ?? s.cwd.replace(CLAUDE_WORKTREE, '');
    if (dir && !ORCH_WORKTREE.test(dir)) return dir;
  }
  return o.workspaces[0]?.path ?? '';
}

// ---------------------------------------------------------------------------------------------------- the notice

export type NoticeAction = 'login' | 'provider' | 'runtime';
export interface EngineNotice { kind: 'login' | 'engine'; text: string; actions: NoticeAction[] }

/**
 * The start page says something about login / the runtime only when it is a problem (spec §5.8): no runtime at
 * all, or not logged in to Claude with no provider to use instead. Unknown yet (`auth` null) = nothing. Nothing to
 * send with: connecting a model (an API key) comes first — most people here have no Claude subscription — the
 * Claude login second.
 */
export function engineNotice(o: { auth: { loggedIn?: boolean } | null; providers: number; engine: 'ok' | 'missing' | 'unknown' }): EngineNotice | null {
  if (o.engine === 'missing') return { kind: 'engine', text: '没找到 Claude Code 的运行内核，对话开不起来。', actions: ['runtime'] };
  if (o.auth && o.auth.loggedIn === false && o.providers === 0) return { kind: 'login', text: '还没接模型：填一个 API Key，或者用 Claude 账号登录。', actions: ['provider', 'login'] };
  return null;
}
