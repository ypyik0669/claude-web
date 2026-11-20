// The start page (redesign 2026-11 stage 4; first spec §5.8): the greeting, the three starters, the 入门清单, the
// project the composer starts on and the login / runtime notice. Pure — the components in this folder and
// workbench/Welcome.tsx only draw it. (The lists under the box are gone: the sidebar has the conversations.)
import type { SessionMeta, SessionSummary } from '@shared';
import type { IconName } from '@/ui/icons';
import { isWithin } from '@/features/paths';
import { tr } from '@/i18n';

// ---------------------------------------------------------------------------------------------------- greeting

/** The one line over the composer. It is set in the heading face, so ui/heading-text.ts lists it. */
export const GREETING = tr('今天想做点什么？');

// ---------------------------------------------------------------------------------------------------- starters

export interface Starter { id: string; icon: IconName; label: string; text: string }
/**
 * Three ways to begin (redesign 2026-11 #pages 首页). A click only puts the text in the box: nothing is sent. They
 * are shown only while the project in the box has no conversations yet (`projectHasConversations`).
 */
export const STARTERS: Starter[] = [
  { id: 'explain', icon: 'read', label: tr('讲讲这个项目的结构'), text: tr('讲讲这个项目的结构：有哪些主要目录、入口在哪、各部分怎么配合。') },
  { id: 'bug', icon: 'search', label: tr('找一个 bug 并修好'), text: tr('找一个 bug 并修好：先说清楚问题在哪、怎么复现，再动手改。') },
  { id: 'tests', icon: 'todo', label: tr('给最近的改动补测试'), text: tr('给最近的改动补测试：看看最近的提交和未提交的改动，找出没被测到的地方。') },
];

/**
 * Has the project the new conversation is about to start in had a conversation? (the starters go once it has.) Its
 * folder or one under it, on the same machine (`peer`: a federation peer's id, '' = this computer); a conversation
 * listed under the project by its group folder counts too. No folder chosen → nothing to say yet (true: no starters).
 */
export function projectHasConversations(o: { cwd: string; peer?: string }, sessions: readonly SessionSummary[], meta?: Record<string, SessionMeta>): boolean {
  if (!o.cwd) return true;
  return sessions.some((s) => (o.peer ? s.peer?.id === o.peer : !s.peer) && (isWithin(s.cwd ?? '', o.cwd) || isWithin(meta?.[s.sessionId]?.groupCwd ?? '', o.cwd)));
}

/**
 * The first time: no conversation on this computer yet (the CLI's own history counts — someone who used Claude Code
 * before is not new). The 入门清单 is shown only then (redesign 2026-11: 「入门卡只在第一次出现」); before the list has
 * come it is not known (false).
 */
export function firstTime(o: { listed: boolean; sessions: readonly SessionSummary[] }): boolean {
  return o.listed && !o.sessions.some((s) => !s.peer);
}

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

// ---------------------------------------------------------------------------------------------------- times

/** 刚刚 / 10 分钟前 / 3 小时前 / 昨天 / 4 天前 / 9/20 — the second line of a row. */
export function agoText(ts: number, now = Date.now()): string {
  if (!ts) return '';
  const d = now - ts;
  if (d < 60_000) return tr('刚刚');
  if (d < 3600_000) return tr('{d} 分钟前', { d: Math.floor(d / 60_000) });
  if (d < 86400_000) return tr('{d} 小时前', { d: Math.floor(d / 3600_000) });
  if (d < 2 * 86400_000) return tr('昨天');
  if (d < 7 * 86400_000) return tr('{d} 天前', { d: Math.floor(d / 86400_000) });
  const t = new Date(ts);
  return `${t.getMonth() + 1}/${t.getDate()}`;
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
  if (o.engine === 'missing') return { kind: 'engine', text: tr('没找到 Claude Code 的运行内核，对话开不起来。'), actions: ['runtime'] };
  if (o.auth && o.auth.loggedIn === false && o.providers === 0) return { kind: 'login', text: tr('还没接模型：填一个 API Key，或者用 Claude 账号登录。'), actions: ['provider', 'login'] };
  return null;
}
