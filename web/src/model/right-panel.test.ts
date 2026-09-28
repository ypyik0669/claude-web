// Redesign phase 2 (spec §5.6): the right panel's tiers, its default-mode tab row and what a toggle / close does.
import { describe, expect, it } from 'vitest';
import { CORE_PANELS, PANELS, PANEL_IDS, defaultDockPanel, dockView, initialLayout, layoutReducer, panelToggleEffect, sanitizeLayout, type Dock, type LayoutState } from './layout';
import { panelToggleLabel } from '@/ui/terms';

const dock = (patch: Partial<Dock>): Dock => ({ open: true, minimized: false, width: 440, tabs: [], active: null, ...patch });

describe('panel tiers', () => {
  it('every panel has a tier', () => {
    for (const p of PANELS) expect(['core', 'extra', 'workbench']).toContain(p.tier);
  });

  it('the four fixed tabs are 审阅 · 文件 · 终端 · 任务, in that order', () => {
    expect(CORE_PANELS).toEqual(['files', 'explorer', 'terminal', 'tasks']);
    expect(PANELS.filter((p) => p.tier === 'core').map((p) => p.id).sort()).toEqual([...CORE_PANELS].sort());
    const title = (id: string) => PANELS.find((p) => p.id === id)!.title;
    expect(CORE_PANELS.map(title)).toEqual(['审阅', '文件', '终端', '任务']);
  });

  it('panel ids are unique', () => {
    expect(new Set(PANEL_IDS).size).toBe(PANEL_IDS.length);
  });
});

describe('dockView: the tab row', () => {
  it('default mode: the four fixed tabs always, mounted only once opened; other panels are temporary tabs after them', () => {
    const v = dockView(dock({ tabs: ['goals', 'terminal'], active: 'terminal' }), { workbench: false, inspect: false });
    expect(v.tabs.map((t) => t.id)).toEqual(['files', 'explorer', 'terminal', 'tasks', 'goals']);
    expect(v.tabs.filter((t) => t.fixed).map((t) => t.id)).toEqual(CORE_PANELS);
    expect(v.tabs.filter((t) => t.mounted).map((t) => t.id)).toEqual(['terminal', 'goals']);
    expect(v.active).toBe('terminal');
    expect(v.mounted).toEqual(['goals', 'terminal']);
  });

  it('workbench mode: exactly the dock tabs, all closable, as before the redesign', () => {
    const v = dockView(dock({ tabs: ['goals', 'terminal'], active: 'goals' }), { workbench: true, inspect: false });
    expect(v.tabs.map((t) => t.id)).toEqual(['goals', 'terminal']);
    expect(v.tabs.every((t) => !t.fixed && t.mounted)).toBe(true);
    expect(v.active).toBe('goals');
  });

  it('a requested inspection shows the 详情 tab (temporary) and takes the front', () => {
    for (const workbench of [false, true]) {
      const v = dockView(dock({ tabs: ['tasks'], active: 'tasks' }), { workbench, inspect: true });
      expect(v.active).toBe('inspector');
      expect(v.tabs.find((t) => t.id === 'inspector')).toMatchObject({ fixed: false, mounted: true });
    }
  });

  it('an active panel that is not mounted falls back to the first mounted tab in row order', () => {
    const v = dockView(dock({ tabs: ['goals', 'tasks'], active: 'explorer' }), { workbench: false, inspect: false });
    expect(v.active).toBe('tasks'); // row order: files explorer terminal tasks goals
    expect(dockView(dock({ tabs: [], active: 'files' }), { workbench: false, inspect: false }).active).toBeNull();
  });

  it('switching the workbench setting never changes which panels are mounted (nothing unmounts)', () => {
    const d = dock({ tabs: ['terminal', 'mission', 'files'], active: 'mission' });
    expect(dockView(d, { workbench: false, inspect: false }).mounted).toEqual(dockView(d, { workbench: true, inspect: false }).mounted);
  });
});

describe('toggling and closing', () => {
  it('default mode: toggling a fixed tab that is in view hides the panel and keeps the tab (its state stays)', () => {
    for (const id of CORE_PANELS) {
      let s = layoutReducer(initialLayout(), { t: 'dock.show', panel: id });
      expect(panelToggleEffect(s.dock, id, false)).toBe('hide');
      s = layoutReducer(s, { t: 'dock.toggle', panel: id, workbench: false });
      expect(s.dock.open).toBe(false);
      expect(s.dock.tabs).toContain(id);
    }
  });

  it('default mode: a temporary tab in view is closed by its toggle', () => {
    let s = layoutReducer(initialLayout(), { t: 'dock.show', panel: 'goals' });
    expect(panelToggleEffect(s.dock, 'goals', false)).toBe('remove');
    s = layoutReducer(s, { t: 'dock.toggle', panel: 'goals', workbench: false });
    expect(s.dock.tabs).not.toContain('goals');
  });

  it('workbench mode keeps the old rules: only the terminal hides, the rest close', () => {
    let s = layoutReducer(initialLayout(), { t: 'dock.show', panel: 'files' });
    expect(panelToggleEffect(s.dock, 'files', true)).toBe('remove');
    expect(panelToggleEffect(s.dock, 'files')).toBe('remove'); // the default is the old behaviour
    s = layoutReducer(s, { t: 'dock.show', panel: 'terminal' });
    expect(panelToggleEffect(s.dock, 'terminal', true)).toBe('hide');
  });

  it('closing a background tab (its ×) closes that tab — it does not bring it forward', () => {
    let s = layoutReducer(initialLayout(), { t: 'dock.show', panel: 'goals' });
    s = layoutReducer(s, { t: 'dock.show', panel: 'memory' });
    s = layoutReducer(s, { t: 'dock.close', panel: 'goals' });
    expect(s.dock.tabs).not.toContain('goals');
    expect(s.dock.active).toBe('memory');
    expect(s.dock.open).toBe(true);
  });

  it('closing the front tab moves to its neighbour; closing the last one closes the panel', () => {
    let s: LayoutState = { ...initialLayout(), dock: dock({ tabs: ['goals', 'memory', 'usage'], active: 'memory' }) };
    s = layoutReducer(s, { t: 'dock.close', panel: 'memory' });
    expect(s.dock.active).toBe('usage');
    s = { ...s, dock: dock({ tabs: ['goals'], active: 'goals' }) };
    s = layoutReducer(s, { t: 'dock.close', panel: 'goals' });
    expect(s.dock).toMatchObject({ tabs: [], active: null, open: false });
  });

  it('the palette label says what happens: a hidden fixed tab has nothing running in the background', () => {
    expect(panelToggleLabel('hide', '审阅', false)).toBe('隐藏审阅面板');
    expect(panelToggleLabel('hide', '终端')).toMatch(/继续在后台运行/);
  });

  it('opening the empty panel picks 审阅 in the default mode and 任务 with the workbench tools (as before)', () => {
    expect(defaultDockPanel(false)).toBe('files');
    expect(defaultDockPanel(true)).toBe('tasks');
  });
});

describe('saved layouts', () => {
  it('a panel id this version does not know is dropped from the saved dock', () => {
    const s = sanitizeLayout({ ...initialLayout(), dock: { open: true, minimized: false, width: 440, tabs: ['tasks', 'nope', 'files'], active: 'nope' } })!;
    expect(s.dock.tabs).toEqual(['tasks', 'files']);
    expect(s.dock.active).toBe('tasks');
  });
});
