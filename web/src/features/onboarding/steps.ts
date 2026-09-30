// The first-run wizard (redesign phase 7, spec §5.8): two steps — ① connect a model (an API key through the quick
// connect, or the Claude login; skipped when logged in or when there is a provider already) ② pick a project folder. Appearance follows the system (no theme step); the shortcuts of
// the old 就绪 page live in the 入门清单 on the start page. Pure.
import type { SessionSummary } from '@shared';

export type ObStep = 'login' | 'project';

export function onboardingSteps(o: { auth: { loggedIn?: boolean } | null; providers: number }): ObStep[] {
  return o.auth?.loggedIn || o.providers > 0 ? ['project'] : ['login', 'project'];
}

/** The model step until it is done (then it drops out of `steps`) or skipped. */
export function currentStep(steps: ObStep[], skippedLogin: boolean): ObStep {
  return steps[0] === 'login' && !skippedLogin ? 'login' : 'project';
}

/**
 * From opening the app for the first time to the first message sent (spec §7: ≤ 3 steps). Picking the folder ends
 * the wizard and the start page's composer is already on that folder, focused. ui-smoke walks it on a fresh HOME.
 */
export const FIRST_RUN: { id: 'login' | 'project' | 'send'; what: string }[] = [
  { id: 'login', what: '接一个模型（填 API Key），或用 Claude 账号登录（已登录 / 有供应商时没有这一步）' },
  { id: 'project', what: '选一个项目文件夹（最近用过的一点即选）' },
  { id: 'send', what: '在输入框里写下要做的事，回车' },
];
export function firstRunSteps(o: { loggedIn: boolean }) {
  return FIRST_RUN.filter((s) => s.id !== 'login' || !o.loggedIn);
}

/** Folders of conversations already on this machine (the CLI's too), newest first, each once, not yet projects. */
export function recentFolders(sessions: SessionSummary[], projects: string[] = [], max = 4): string[] {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const seen = new Set(projects.map(norm));
  const out: string[] = [];
  for (const s of [...sessions].sort((a, b) => b.lastModified - a.lastModified)) {
    if (s.peer || !s.cwd || seen.has(norm(s.cwd))) continue;
    seen.add(norm(s.cwd));
    out.push(s.cwd);
    if (out.length >= max) break;
  }
  return out;
}
