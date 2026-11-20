// Redesign 2026-11: things moved. Everything must still be found in the palette — by its new place and by the name it
// had before. Stage 1: the icon rail (the old 后台 / Bot / 模型 / 扩展 sections, the ··· panels); stage 2: the settings
// pages that merged or left, and the 配置中心 panel, taken apart.
import { describe, expect, it } from 'vitest';
import { PANELS, type Dock } from '@/model/layout';
import { panelCommandLabel } from '@/features/workbench/panel-entries';
import { FAMILY_TABS } from '@/features/automation/page';
import { EXTENSION_TABS } from '@/features/extensions/page';
import { HUB_PAGES } from '@/features/model-hub/page';
import { findSection } from '@/features/settings/catalog';
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
    expect(found('模型')).toEqual(expect.arrayContaining(['go.hub', 'go.hub.sources', 'go.hub.routing', 'go.hub.usage', 'go.settings.model']));
  });

  it('every panel of the rail\'s ··· is found by the name ··· gave it (配置中心: where its pieces went)', () => {
    const more: Record<string, string> = { mission: '总览', cafe: '网吧', usage: '用量与账本', memory: '共享记忆', board: 'Issue 与 PR', android: 'Android' };
    for (const [id, name] of Object.entries(more)) expect(found(name), name).toContain(`panel.${id}`);
    expect(found('账本')).toContain('panel.usage');
    // 配置中心 was taken apart (stage 2): 插件 in 自定义, Hooks / settings.json and 环境变量 in 设置 › 高级
    expect(found('配置中心')).toEqual(expect.arrayContaining(['go.plugins', 'go.settings.hooks', 'go.settings.env']));
    expect(found('配置中心').some((id) => id === 'panel.config')).toBe(false);
  });

  it('the new places are found by their own names too (Artifacts, 自定义, 模型看板)', () => {
    expect(found('Artifacts')).toContain('go.artifacts');
    expect(found('生成的文件')).toContain('go.artifacts');
    expect(found('自定义')).toEqual(expect.arrayContaining(['go.skills', 'go.connectors', 'go.plugins', 'go.types']));
    expect(found('模型看板')).toContain('go.hub');
  });
});

describe('the settings regroup (stage 2): the old page names land on the new pages', () => {
  it('a merged page is found by each name it had', () => {
    const was: Record<string, string> = {
      通用: 'go.settings.conversation', 供应商: 'go.settings.model', 模型网关: 'go.settings.model', 模型与智能程度: 'go.settings.model',
      手机与其它电脑: 'go.settings.remote', IM: 'go.settings.remote', 共享记忆: 'go.memory', 对话库: 'go.memory', 密钥: 'go.settings.secrets',
      更新: 'go.settings.diagnostics', 'CLI 工具': 'go.settings.diagnostics', 'settings.json': 'go.settings.hooks', Hooks: 'go.settings.hooks',
    };
    for (const [name, id] of Object.entries(was)) expect(found(name), name).toContain(id);
    expect(found('通用')).toContain('go.settings.window');
  });

  it('what left the settings is found where it went: MCP 与插件 → 自定义, 值班 Bot → 自动化 › Bot › 设置', () => {
    expect(found('MCP 与插件')).toEqual(expect.arrayContaining(['go.connectors', 'go.plugins']));
    expect(found('值班 Bot')).toContain('go.bots.settings');
    expect(found('Artifact 类型')).toContain('go.types');
  });
});

describe('every target exists', () => {
  it('a tab of 自动化 / 自定义, a page of the model hub, a panel, a settings page', () => {
    const hub = HUB_PAGES.map((p) => p.id) as string[];
    for (const m of MOVED) {
      const t = m.target;
      if (t.to === 'automation') expect(FAMILY_TABS as readonly string[], m.id).toContain(t.tab);
      if (t.to === 'extensions') expect(EXTENSION_TABS as readonly string[], m.id).toContain(t.tab);
      if (t.to === 'hub') expect(hub, m.id).toContain(t.page);
      if (t.to === 'panel') expect(PANELS.map((p) => p.id), m.id).toContain(t.panel);
      if (t.to === 'settings') {
        const s = findSection(t.section);
        expect(s, m.id).toBeTruthy();
        if (t.tab) expect(s!.tabs?.some((x) => x.id === t.tab), m.id).toBe(true);
      }
    }
    for (const t of FAMILY_TABS) expect(MOVED.some((m) => m.target.to === 'automation' && m.target.tab === t), t).toBe(true);
    for (const t of EXTENSION_TABS) expect(MOVED.some((m) => m.target.to === 'extensions' && m.target.tab === t), t).toBe(true);
    expect(new Set(MOVED.map((m) => m.id)).size).toBe(MOVED.length);
  });
});
