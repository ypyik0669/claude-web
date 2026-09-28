// Opening / closing the automation page (redesign phase 7). A small store of its own, like the orchestra's and the
// right panel's — nothing here goes into store/index.ts. The page is per window and not persisted.
import { create } from 'zustand';
import { onLayoutAction, useStore } from '@/store';
import { AUTOMATION_TABS, closesAutomation, type AutomationTab } from './page';

interface AutomationState {
  open: boolean;
  tab: AutomationTab;
  /** tabs shown at least once: their bodies are mounted from then on (hidden, never unmounted) */
  seen: AutomationTab[];
  /** the header's 新建 per tab (`Date.now()` of the last click; each body applies a new value once) */
  newAt: Record<AutomationTab, number>;
}

export const useAutomation = create<AutomationState>(() => ({
  open: false,
  tab: 'schedules',
  seen: [],
  newAt: { schedules: 0, goals: 0, orchestra: 0 },
}));

const withSeen = (seen: AutomationTab[], t: AutomationTab) => (seen.includes(t) ? seen : AUTOMATION_TABS.filter((x) => x === t || seen.includes(x)));

/**
 * Show the automation page, on `tab` or the one shown last. Works everywhere (the main area is there on a phone
 * too); the phone's sidebar drawer gets out of the way. Returns true: the page is on screen.
 */
export function openAutomation(tab?: AutomationTab): boolean {
  useAutomation.setState((s) => {
    const t = tab ?? s.tab;
    return { open: true, tab: t, seen: withSeen(s.seen, t) };
  });
  if (useStore.getState().mobile) useStore.setState({ sidebarOpen: false });
  return true;
}

export function showAutomationTab(tab: AutomationTab): void {
  useAutomation.setState((s) => ({ tab, seen: withSeen(s.seen, tab) }));
}

export function closeAutomation(): void {
  if (useAutomation.getState().open) useAutomation.setState({ open: false });
}

/** The header's 新建: the tab's own "new" form (a schedule, a goal, a workflow). */
export function newInAutomation(tab: AutomationTab): void {
  useAutomation.setState((s) => ({ newAt: { ...s.newAt, [tab]: Date.now() } }));
}

/** App mounts this once: the page closes whenever the main area is sent somewhere (see `closesAutomation`). */
export function installAutomation(): () => void {
  return onLayoutAction((a) => { if (closesAutomation(a)) closeAutomation(); });
}
