// 自动化 as one page with five tabs (redesign 2026-11 stage 1): 运行中 · 定时任务 · Bot · 目标 · 编排. Behind them are
// three pages, each with its own store and still mounted once and only hidden — the background page (运行中), the
// automation page (定时任务 / 目标 / 编排) and the Bot page — moved in as they were. This module draws the family's tab
// row over each of them (registered with sections/frame.ts, OverPage asks by the page's name), remembers the tab shown
// last, and says what waits for the user (the sidebar's 自动化 carries that number).
import { useMemo } from 'react';
import type { BgSession } from '@shared';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { registerPageFrame, type PageFrame } from '@/features/sections/frame';
import { openBackground, useBackground } from '@/features/background/state';
import { liveCounts } from '@/features/background/model';
import { BackgroundSide } from '@/features/background/BackgroundSide';
import { openBots, useBots } from '@/features/bots/state';
import { useOrch, waitingOf } from '@/features/orchestra/state';
import { openAutomation, useAutomation } from './state';
import { AUTOMATION_DESC, AUTOMATION_TITLE, FAMILY_TABS, FAMILY_TAB_INFO, familyPage, type AutomationTab, type FamilyTab } from './page';
import type { AutomationId } from '@/features/sidebar/entries';
import { tr } from '@/i18n';

/** The tab shown last (per window, not kept): 自动化 in the sidebar opens it again. The first time, the first tab. */
let last: FamilyTab = 'running';
useBackground.subscribe((s) => { if (s.open) last = 'running'; });
useBots.subscribe((s) => { if (s.open) last = 'bots'; });
useAutomation.subscribe((s) => { if (s.open) last = s.tab; });

export const lastFamilyTab = (): FamilyTab => last;

/** Show 自动化 on a tab, or on the one shown last. Returns true: the page is on screen. */
export function openFamily(tab: FamilyTab = last): boolean {
  switch (familyPage(tab)) {
    case 'background': return openBackground();
    case 'bots': return openBots();
    default: return openAutomation(tab as AutomationTab);
  }
}

/** The tab in front, or null while no page of the family is open. */
export function useFamilyTab(): FamilyTab | null {
  const bg = useBackground((s) => s.open);
  const bots = useBots((s) => s.open);
  const auto = useAutomation((s) => (s.open ? s.tab : null));
  return bg ? 'running' : bots ? 'bots' : auto;
}

/** Running background tasks of every conversation (workflows, sub-agents, background commands). */
const runningTasks = (sessions: Record<string, BgSession>) => Object.values(sessions).reduce((n, s) => n + liveCounts(s).tasks, 0);

/** Approvals / comparisons of the orchestra waiting for the user. */
function useOrchWaiting(): number {
  const full = useOrch((s) => s.full);
  return useMemo(() => waitingOf(full).length, [full]);
}

/** What waits for the user in 自动化 — the Bot inbox and the orchestra's approvals: the sidebar's 自动化 shows it. */
export function useAutomationWaiting(): number {
  const inbox = useBots((s) => s.pending);
  return inbox + useOrchWaiting();
}

/**
 * The family's tab row. Each tab says how many there are (定时任务, 运行中) or what waits for you (Bot's inbox,
 * 编排's approvals) — a status in the warning colour. On a phone it is one row that scrolls sideways.
 */
export function FamilyTabs() {
  const tab = useFamilyTab();
  const running = useBackground((s) => runningTasks(s.sessions));
  const schedules = useStore((s) => s.schedules.length);
  const inbox = useBots((s) => s.pending);
  const orch = useOrchWaiting();
  const count: Record<FamilyTab, React.ReactNode> = {
    running: running ? <span className="n">{running}</span> : null,
    schedules: schedules ? <span className="n">{schedules}</span> : null,
    bots: inbox ? <span className="n need" title={tr('{inbox} 件事等你决定', { inbox })}>{inbox}</span> : null,
    goals: null,
    orchestra: orch ? <span className="n need">{tr('{orch} 等你', { orch })}</span> : null,
  };
  const id = (x: AutomationId) => x;
  return (
    <div className="fam-tabs" role="tablist" aria-label={AUTOMATION_TITLE}>
      {FAMILY_TABS.map((t) => (
        <button key={t} type="button" role="tab" className={clsx('ft', tab === t && 'on')} aria-selected={tab === t} data-id={id(t)} title={FAMILY_TAB_INFO[t].title} onClick={() => openFamily(t)}>
          <Icon name={FAMILY_TAB_INFO[t].icon} size={14} />
          <span className="l">{FAMILY_TAB_INFO[t].label}</span>
          {count[t]}
        </button>
      ))}
    </div>
  );
}

const FRAME: PageFrame = { title: AUTOMATION_TITLE, desc: AUTOMATION_DESC, Tabs: FamilyTabs };
registerPageFrame('auto', FRAME);
registerPageFrame('bots', FRAME);
// 运行中: the conversations with background work (and the selected one's finished runs) are the page's own column
registerPageFrame('bg', { ...FRAME, Side: BackgroundSide });
