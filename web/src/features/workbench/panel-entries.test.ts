// Spec §4.2 is a hard constraint: every dock panel and every one of the old 8 workbench tabs must stay reachable,
// in at most 2 clicks from a conversation, in the default (quiet) UI. The menus that offer them are built from the
// tables asserted here (the right panel's fixed tabs / 「更多」 menu, the header ···, the palette).
import { describe, expect, it } from 'vitest';
import { CORE_PANELS, PANELS, WORKBENCH_TABS } from '@/model/layout';
import { ENTRY_CLICKS, MORE_PANELS, minClicks, panelEntries, viewEntries, viewTarget } from './panel-entries';
import { WB_VIEWS } from './wb-views';

// the 11 panels of the pre-redesign dock: none may disappear
const OLD_PANELS = ['mission', 'goals', 'orchestra', 'memory', 'tasks', 'files', 'usage', 'config', 'terminal', 'inspector', 'android'];

describe('every panel is reachable in ≤ 2 clicks', () => {
  it('no panel of the old dock is gone', () => {
    for (const id of OLD_PANELS) expect(PANELS.map((p) => p.id)).toContain(id);
  });

  for (const p of PANELS) {
    it(`${p.title} (${p.id}, ${p.tier})`, () => {
      const entries = panelEntries(p.id);
      expect(entries.length).toBeGreaterThan(0);
      expect(minClicks(entries)).toBeLessThanOrEqual(2);
    });
  }

  it('the fixed tabs are one header button + one tab away; 审阅 and 终端 also have their own header button', () => {
    for (const id of CORE_PANELS) expect(panelEntries(id)).toContain('panelButton');
    expect(panelEntries('files')).toContain('changesButton');
    expect(panelEntries('terminal')).toContain('terminalButton');
    expect(ENTRY_CLICKS.changesButton).toBe(1);
  });

  it('the 「更多」 menu holds exactly the extra tier (never a fixed tab)', () => {
    expect(MORE_PANELS.map((p) => p.id)).toEqual(PANELS.filter((p) => p.tier === 'extra').map((p) => p.id));
    for (const p of MORE_PANELS) expect(CORE_PANELS).not.toContain(p.id);
  });
});

describe('the old 8 workbench tabs', () => {
  const views = WORKBENCH_TABS.filter((t) => t !== 'live');

  it('each is still a view with an entry in ≤ 2 clicks (header ··· / palette)', () => {
    expect(WB_VIEWS.map((v) => v.id).sort()).toEqual(views.slice().sort());
    for (const v of views) expect(minClicks(viewEntries(v))).toBeLessThanOrEqual(2);
  });

  it('on a desktop they open in the right panel (spec §4.2) — except 定时任务, which waits for the automation page', () => {
    const where = Object.fromEntries(views.map((v) => { const t = viewTarget(v, { mobile: false, remote: false }); return [v, t.to === 'panel' ? t.panel : 'tile']; }));
    expect(where).toEqual({ changes: 'files', git: 'files', files: 'explorer', search: 'explorer', artifacts: 'explorer', board: 'board', schedules: 'tile' });
    for (const v of views) {
      const t = viewTarget(v, { mobile: false, remote: false });
      if (t.to === 'panel') expect(PANELS.find((p) => p.id === t.panel)?.tier).toMatch(/core|extra/);
    }
  });

  it('the scope / mode each one asks for', () => {
    expect(viewTarget('changes', { mobile: false, remote: false })).toMatchObject({ review: { scope: 'session' } });
    expect(viewTarget('git', { mobile: false, remote: false })).toMatchObject({ review: { git: true } });
    expect(viewTarget('search', { mobile: false, remote: false })).toMatchObject({ explorer: 'search' });
    expect(viewTarget('artifacts', { mobile: false, remote: false })).toMatchObject({ explorer: 'artifacts' });
  });

  it('a phone (no right panel) and a conversation on another machine keep the in-place views', () => {
    for (const v of views) {
      expect(viewTarget(v, { mobile: true, remote: false }).to).toBe('tile');
      expect(viewTarget(v, { mobile: false, remote: true }).to).toBe('tile');
    }
  });
});
