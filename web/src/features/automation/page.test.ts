import { describe, expect, it } from 'vitest';
import type { LayoutAction } from '@/model/layout';
import { AUTOMATION_TABS, AUTOMATION_TAB_INFO, closesAutomation, tabClicks } from './page';

describe('the automation page (spec §5.9)', () => {
  it('has the three tabs of the spec, each with a name, one line and a 新建 label', () => {
    expect(AUTOMATION_TABS).toEqual(['schedules', 'goals', 'orchestra']);
    for (const t of AUTOMATION_TABS) {
      const i = AUTOMATION_TAB_INFO[t];
      expect(i.label && i.desc && i.newLabel && i.icon).toBeTruthy();
    }
    expect(AUTOMATION_TABS.map((t) => AUTOMATION_TAB_INFO[t].label)).toEqual(['定时任务', '目标', '编排']);
  });

  it('every tab is at most 2 clicks from the sidebar: 自动化, then the tab (none when it is the one shown)', () => {
    for (const t of AUTOMATION_TABS) for (const last of AUTOMATION_TABS) expect(tabClicks(t, last)).toBeLessThanOrEqual(2);
    expect(tabClicks('goals', 'goals')).toBe(1);
    expect(tabClicks('orchestra', 'schedules')).toBe(2);
  });

  it('closes when the main area goes somewhere else — not for right-panel or sidebar changes, nor a tile quietly updating itself', () => {
    const nav: LayoutAction['t'][] = ['tile.open', 'tile.activate', 'tile.close', 'tile.next', 'tile.move', 'session.assign', 'pane.split', 'pane.close', 'pane.jump', 'pane.cycle', 'pane.zoom', 'pane.preset', 'group.new', 'group.activate', 'group.next', 'group.close', 'group.add', 'group.remove'];
    const quiet: LayoutAction['t'][] = ['dock.set', 'dock.toggle', 'dock.show', 'dock.close', 'sidebar.set', 'pane.ratio', 'pane.even', 'pane.focus', 'tile.patch', 'tile.rename', 'group.rename'];
    for (const t of nav) expect(closesAutomation({ t } as LayoutAction), t).toBe(true);
    for (const t of quiet) expect(closesAutomation({ t } as LayoutAction), t).toBe(false);
  });
});
