// The 入门清单's bookkeeping (redesign phase 7): written to meta.json `settings['onboarding.checklist']`
// (`{ done: ChecklistId[], dismissed? }`) as things happen in this app. A project that exists counts by itself; the
// other three only when done here (review 7 M8): a message sent from a composer, a changed file looked at in 审阅,
// the command palette opened with its shortcut (or the list's own 试试) — the sidebar's 搜索 does not count.
import { useStore } from '@/store';
import { CHECKLIST_KEY, readChecklist, reconcileChecklist, type ChecklistId } from './model';

let last = '';

function write(event?: ChecklistId): void {
  const st = useStore.getState();
  if (!st.metaLoaded) return;
  const next = reconcileChecklist(readChecklist(st.settings[CHECKLIST_KEY]), { projects: st.workspaces.length, event });
  if (!next) return;
  const key = JSON.stringify(next);
  if (key === last) return; // the same write is on its way
  last = key;
  void st.setSetting(CHECKLIST_KEY, next).catch(() => { last = ''; });
}

/** A step that just happened (审阅 showed a changed file, the palette was opened with Ctrl K). */
export function markChecklist(id: ChecklistId): void {
  const st = useStore.getState();
  if (!st.metaLoaded || readChecklist(st.settings[CHECKLIST_KEY]).done.includes(id)) return;
  write(id);
}

/**
 * The last message id seen per conversation: store.send stamps `lastSent` with a new id (loading history never does,
 * reopening keeps the same one). It mutates the conversation in place, so the previous state cannot be compared.
 */
const sentIds = new Map<string, string>();

function freshSend(open: Record<string, { lastSent?: { id: string } } | undefined>): boolean {
  let fresh = false;
  for (const id in open) {
    const m = open[id]?.lastSent;
    if (m && sentIds.get(id) !== m.id) { sentIds.set(id, m.id); fresh = true; }
  }
  return fresh;
}

/** App installs it once: projects as they come, and the first message sent from this app. */
export function installChecklist(): () => void {
  freshSend(useStore.getState().open); // what was sent before this ran is not news
  write();
  return useStore.subscribe((s, p) => {
    if (s.metaLoaded !== p.metaLoaded || s.workspaces !== p.workspaces) write();
    if (s.open !== p.open && freshSend(s.open) && s.metaLoaded && !readChecklist(s.settings[CHECKLIST_KEY]).done.includes('send')) write('send');
  });
}
