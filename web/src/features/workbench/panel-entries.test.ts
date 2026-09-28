// Spec §4.2 is a hard constraint: every dock panel and every one of the old 8 workbench tabs must stay reachable,
// in at most 2 clicks from a conversation, in the default (quiet) UI. The menus that offer them are built from the
// tables asserted here (the right panel's fixed tabs / 「更多」 menu, the header ···, the palette).
import { describe, expect, it } from 'vitest';
import { CORE_PANELS, PANELS, WORKBENCH_TABS, type Dock } from '@/model/layout';
import { ENTRY_CLICKS, MORE_PANELS, minClicks, panelCommandLabel, panelEntries, viewEntries, viewTarget } from './panel-entries';
import { WB_VIEWS } from './wb-views';
import { ACCOUNT, ACCOUNT_PANELS, AUTOMATION, AUTOMATION_PANELS } from '@/features/sidebar/entries';
import { AUTOMATION_TABS, tabClicks } from '@/features/automation/page';

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

  it('the palette label: a fixed tab in view is hidden with nothing “running in the background”; the terminal is', () => {
    const d: Dock = { open: true, minimized: false, width: 440, tabs: ['files', 'terminal'], active: 'files' };
    const p = (id: string) => PANELS.find((x) => x.id === id)!;
    expect(panelCommandLabel(d, p('files'), false)).toBe('隐藏审阅面板');
    expect(panelCommandLabel({ ...d, active: 'terminal' }, p('terminal'), false)).toBe('隐藏终端面板（继续在后台运行）');
    expect(panelCommandLabel(d, p('tasks'), false)).toBe('打开任务面板');
    expect(panelCommandLabel(d, p('files'), true)).toBe('关闭审阅面板');
  });

  it('the sidebar\'s entries (same ids as sidebar/entries.ts): 自动化 → the page\'s 定时任务 / 目标 / 编排, account → 用量 / 配置中心, 2 clicks', () => {
    expect(ENTRY_CLICKS.sidebarAutomation).toBe(2);
    expect(ENTRY_CLICKS.accountMenu).toBe(2);
    // the automation page's tabs are the sidebar's automation ids; the two that show a panel's content are counted
    expect([...AUTOMATION]).toEqual([...AUTOMATION_TABS]);
    for (const t of AUTOMATION_TABS) for (const last of AUTOMATION_TABS) expect(tabClicks(t, last)).toBeLessThanOrEqual(ENTRY_CLICKS.sidebarAutomation);
    expect(Object.keys(AUTOMATION_PANELS).sort()).toEqual(['goals', 'orchestra']);
    for (const k of Object.keys(ACCOUNT_PANELS)) expect(ACCOUNT as readonly string[]).toContain(k);
    for (const p of PANELS) {
      expect(panelEntries(p.id).includes('sidebarAutomation')).toBe((Object.values(AUTOMATION_PANELS) as string[]).includes(p.id));
      expect(panelEntries(p.id).includes('accountMenu')).toBe((Object.values(ACCOUNT_PANELS) as string[]).includes(p.id));
    }
    // 任务 is the conversation's; its old 定时任务 fold moved to the automation page
    expect(panelEntries('tasks')).not.toContain('sidebarAutomation');
    expect(minClicks(panelEntries('tasks'))).toBeLessThanOrEqual(2);
    expect(panelEntries('goals')).toContain('sidebarAutomation');
    expect(panelEntries('orchestra')).toContain('sidebarAutomation');
    expect(panelEntries('usage')).toContain('accountMenu');
    expect(panelEntries('config')).toContain('accountMenu');
    // 定时任务 is also a view: 自动化 reaches it in 2 clicks with or without a conversation
    expect(viewEntries('schedules')).toContain('sidebarAutomation');
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
    for (const v of views) {
      expect(viewEntries(v)).toEqual(v === 'schedules' ? ['headerMore', 'palette', 'sidebarAutomation'] : ['headerMore', 'palette']);
      expect(minClicks(viewEntries(v))).toBeLessThanOrEqual(2);
    }
  });

  it('the entries come from the menus’ own tables: a conversation on another machine only offers 生成的文件', () => {
    // (定时任务 are this machine's: 自动化 opens them on the automation page)
    const header = (v: (typeof views)[number]) => viewEntries(v, true).filter((e) => e !== 'sidebarAutomation');
    expect(views.filter((v) => header(v).length)).toEqual(['artifacts']);
    for (const v of views) if (v !== 'artifacts') expect(header(v)).toEqual([]);
  });

  it('they open in the right panel (spec §4.2; the bottom drawer on a phone) — 定时任务 on the automation page', () => {
    for (const mobile of [false, true]) {
      const where = Object.fromEntries(views.map((v) => { const t = viewTarget(v, { mobile, remote: false }); return [v, t.to === 'panel' ? t.panel : t.to]; }));
      expect(where).toEqual({ changes: 'files', git: 'files', files: 'explorer', search: 'explorer', artifacts: 'explorer', board: 'board', schedules: 'automation' });
    }
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

  it('a conversation on another machine keeps the in-place views (its files are over there); 定时任务 are this machine\'s', () => {
    for (const v of views) {
      for (const mobile of [false, true]) expect(viewTarget(v, { mobile, remote: true }).to).toBe(v === 'schedules' ? 'automation' : 'tile');
    }
  });
});
