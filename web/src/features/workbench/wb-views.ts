// The per-session views that used to sit in a row of 8 workbench tabs above every conversation. The row is gone
// from the default screen (spec §4.2 / §5.2); until they move into the right-hand panel (phase 2) each one is
// reached from the session header's ··· menu and from the command palette — both read this one table.
import { WORKBENCH_TABS, type WorkbenchTab } from '@/model/layout';
import type { IconName } from '@/ui/icons';
import { WORKBENCH_VIEW_LABEL } from '@/ui/terms';

export type WbView = Exclude<WorkbenchTab, 'live'>;

export interface WbViewDef { id: WbView; label: string; icon: IconName; /** also shown for a session on another machine */ remote?: boolean }

const ICONS: Record<WbView, IconName> = { changes: 'diff', git: 'branch', files: 'folder', search: 'search', schedules: 'tasks', artifacts: 'artifact', board: 'board' };

export const WB_VIEWS: WbViewDef[] = WORKBENCH_TABS.filter((t): t is WbView => t !== 'live').map((id) => ({
  id,
  label: WORKBENCH_VIEW_LABEL[id],
  icon: ICONS[id],
  remote: id === 'artifacts',
}));

/** Views that make sense for this session (a session on another machine: its files / git / search live there). */
export function viewsFor(remote: boolean): WbViewDef[] {
  return remote ? WB_VIEWS.filter((v) => v.remote) : WB_VIEWS;
}

/** Command palette entries, one per view (`view.<id>`). */
export function viewCommands(remote: boolean): { id: string; label: string; icon: IconName; view: WbView }[] {
  return viewsFor(remote).map((v) => ({ id: `view.${v.id}`, label: `查看这个对话的${v.label}`, icon: v.icon, view: v.id }));
}
