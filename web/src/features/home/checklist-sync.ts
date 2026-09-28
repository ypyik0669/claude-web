// The 入门清单's bookkeeping (redesign phase 7): the steps that are true by themselves (a project, a conversation)
// and the two that happen somewhere else (the command palette opened, 审阅 brought to the front) are written to
// meta.json `settings['onboarding.checklist']` as they happen. App installs it once.
import { useStore } from '@/store';
import { CHECKLIST_KEY, readChecklist, reconcileChecklist, type ChecklistId } from './model';

export function installChecklist(): () => void {
  let last = '';
  const run = (event?: ChecklistId) => {
    const st = useStore.getState();
    if (!st.metaLoaded) return;
    const next = reconcileChecklist(readChecklist(st.settings[CHECKLIST_KEY]), { projects: st.workspaces.length, sessions: st.sessions.filter((s) => !s.peer).length, event });
    if (!next) return;
    const key = JSON.stringify(next);
    if (key === last) return; // the same write is on its way
    last = key;
    void st.setSetting(CHECKLIST_KEY, next).catch(() => { last = ''; });
  };
  const reviewing = (d: ReturnType<typeof useStore.getState>['layout']['dock']) => d.open && !d.minimized && d.active === 'files' && d.tabs.includes('files');
  run();
  return useStore.subscribe((s, p) => {
    if (s.paletteOpen && !p.paletteOpen) return run('palette');
    if (reviewing(s.layout.dock) && !reviewing(p.layout.dock)) return run('review');
    if (s.metaLoaded !== p.metaLoaded || s.workspaces !== p.workspaces || s.sessions !== p.sessions) run();
  });
}
