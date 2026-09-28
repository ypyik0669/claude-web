// Opening / closing the automation page (redesign phase 7). A small store of its own, like the orchestra's and the
// right panel's — nothing here goes into store/index.ts. The page is per window and not persisted.
import { create } from 'zustand';
import { hideSheet, onLayoutAction, useStore } from '@/store';
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

/** When the page was last opened (it stays open for a late answer to a request sent before that). */
let openedAt = 0;

const withSeen = (seen: AutomationTab[], t: AutomationTab) => (seen.includes(t) ? seen : AUTOMATION_TABS.filter((x) => x === t || seen.includes(x)));

/**
 * Show the automation page, on `tab` or the one shown last. Works everywhere (the main area is there on a phone
 * too); on a phone the sidebar drawer and the bottom drawer get out of the way (review 7 I2). Returns true: the
 * page is on screen.
 */
export function openAutomation(tab?: AutomationTab): boolean {
  if (!useAutomation.getState().open) openedAt = Date.now();
  useAutomation.setState((s) => {
    const t = tab ?? s.tab;
    return { open: true, tab: t, seen: withSeen(s.seen, t) };
  });
  if (useStore.getState().mobile) { useStore.setState({ sidebarOpen: false }); hideSheet(); }
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

/**
 * App mounts this once. Whenever the main area is sent somewhere (`closesAutomation`) the page closes and, on a
 * phone, the bottom drawer goes down (it would cover where the user is going; review 7 I2). An action that places
 * the answer to an earlier request (`meta.since`: a new conversation put in its tile when `session.open` came back)
 * leaves alone what the user opened after sending it (review 7 M2).
 */
export function installAutomation(): () => void {
  return onLayoutAction((a, meta) => {
    if (!closesAutomation(a)) return;
    const late = (at: number) => meta.since !== undefined && at >= meta.since;
    if (useAutomation.getState().open && !late(openedAt)) closeAutomation();
    const st = useStore.getState();
    if (st.mobile && st.sheetAt && !late(st.sheetAt)) hideSheet();
  });
}
