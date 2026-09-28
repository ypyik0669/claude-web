// The 8 workbench tabs left the default screen (phase 1). Every one of them must still be reachable:
// the session header's ··· menu and the command palette are built from WB_VIEWS.
import { describe, expect, it } from 'vitest';
import { WORKBENCH_TABS } from '@/model/layout';
import { ICON_NAMES } from '@/ui/icons';
import { WB_VIEWS, viewCommands, viewsFor } from './wb-views';

describe('workbench views stay reachable', () => {
  it('every workbench tab except the conversation itself is a view', () => {
    expect(WB_VIEWS.map((v) => v.id).sort()).toEqual(WORKBENCH_TABS.filter((t) => t !== 'live').slice().sort());
  });

  it('every view has a palette command and a real icon', () => {
    const cmds = viewCommands(false);
    for (const v of WB_VIEWS) {
      expect(cmds.some((c) => c.view === v.id && c.id === `view.${v.id}`)).toBe(true);
      expect(ICON_NAMES).toContain(v.icon);
      expect(v.label).not.toMatch(/产物|看板|轨迹/); // the old names (§5.12)
    }
  });

  it('a session on another machine keeps only what works there (the generated files list)', () => {
    expect(viewsFor(true).map((v) => v.id)).toEqual(['artifacts']);
    expect(viewCommands(true).map((c) => c.view)).toEqual(['artifacts']);
  });
});
