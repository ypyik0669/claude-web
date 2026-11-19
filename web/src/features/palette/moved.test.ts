// Redesign 2026-11 stage 1: the icon rail is gone. Everything it held must still be found in the palette — by its new
// place and by the name it had on the rail (the old 后台 / Bot / 模型 / 扩展 sections, the ··· panels).
import { describe, expect, it } from 'vitest';
import { PANELS, type Dock } from '@/model/layout';
import { panelCommandLabel } from '@/features/workbench/panel-entries';
import { FAMILY_TABS } from '@/features/automation/page';
import { EXTENSION_TABS } from '@/features/extensions/page';
import { HUB_PAGES } from '@/features/model-hub/page';
import { commandHits, type Filterable } from './filter';
import { MOVED, PANEL_OLD_NAMES } from './moved';

const dock: Dock = { open: false, minimized: false, width: 440, tabs: [], active: 'files' };
/** The palette's 前往 and 面板 commands as the palette builds them (CommandPalette.tsx). */
const COMMANDS: (Filterable & { id: string })[] = [
  ...MOVED.map((m) => ({ id: m.id, label: m.label, group: '前往', keywords: m.old })),
  ...PANELS.map((p) => ({ id: `panel.${p.id}`, label: panelCommandLabel(dock, p, false), group: '面板', keywords: PANEL_OLD_NAMES[p.id] })),
];
const found = (q: string) => { const h = commandHits(COMMANDS, q.toLowerCase()); return [...h.named, ...h.grouped].map((c) => c.id); };

describe('the rail is gone, nothing it held is lost', () => {
  it('every section of the rail is found by its old name, and lands where it went', () => {
    expect(found('后台')).toContain('go.running');
    expect(found('Bot')).toContain('go.bots');
    expect(found('自动化')).toEqual(expect.arrayContaining(['go.running', 'go.schedules', 'go.bots', 'go.goals', 'go.orchestra']));
    expect(found('扩展')).toEqual(expect.arrayContaining(['go.connectors', 'go.skills', 'go.plugins']));
    expect(found('模型')).toEqual(expect.arrayContaining(['go.hub', 'go.hub.sources', 'go.hub.routing', 'go.hub.usage']));
  });

  it('every panel of the rail\'s ··· is found by the name ··· gave it', () => {
    const more: Record<string, string> = { mission: '总览', cafe: '网吧', usage: '用量与账本', memory: '共享记忆', board: 'Issue 与 PR', android: 'Android', config: '配置中心' };
    for (const [id, name] of Object.entries(more)) expect(found(name), name).toContain(`panel.${id}`);
    expect(found('账本')).toContain('panel.usage');
  });

  it('the new places are found by their own names too (Artifacts, 自定义, 模型看板)', () => {
    expect(found('Artifacts')).toContain('go.artifacts');
    expect(found('生成的文件')).toContain('go.artifacts');
    expect(found('自定义')).toEqual(expect.arrayContaining(['go.connectors', 'go.skills', 'go.plugins']));
    expect(found('模型看板')).toContain('go.hub');
  });

  it('every target exists: a tab of 自动化 / 自定义, a page of the model hub, a panel', () => {
    const hub = HUB_PAGES.map((p) => p.id) as string[];
    for (const m of MOVED) {
      const t = m.target;
      if (t.to === 'automation') expect(FAMILY_TABS as readonly string[], m.id).toContain(t.tab);
      if (t.to === 'extensions') expect(EXTENSION_TABS as readonly string[], m.id).toContain(t.tab);
      if (t.to === 'hub') expect(hub, m.id).toContain(t.page);
      if (t.to === 'panel') expect(PANELS.map((p) => p.id), m.id).toContain(t.panel);
    }
    for (const t of FAMILY_TABS) expect(MOVED.some((m) => m.target.to === 'automation' && m.target.tab === t), t).toBe(true);
    expect(new Set(MOVED.map((m) => m.id)).size).toBe(MOVED.length);
  });
});
