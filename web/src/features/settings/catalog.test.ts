import { describe, expect, it } from 'vitest';
import {
  ADVANCED_SECTIONS, BODY_INFO, DEFAULT_SECTION, LEGACY_SECTIONS, SETTINGS_GROUPS, SETTINGS_SECTIONS, VISIBLE_SECTIONS,
  activeTab, allBodies, allEntries, findSection, moreHint, navStatus, resolveSettingsTarget, searchSettings,
  targetBodies, type BodyId, type SettingsHit, type SettingsTarget,
} from './catalog';
import { WORKBENCH_SETTING_PATH } from '@/ui/terms';

/**
 * The settings window before the regroup (redesign phase 6): 22 flat sections, verbatim. Body components that the
 * regroup split in parts are listed by their parts (Overview → login + 运行内核, Mcp → list + JSON form, Skills →
 * list / install + backup, 远程 / 手机 → phone + other computers + SSH tunnels).
 */
const LEGACY: Record<string, { entries?: string[]; bodies?: BodyId[] }> = {
  appearance: { entries: ['ui.theme', 'ui.fontSize', 'ui.density', 'ui.cjkFont', 'ui.reduceMotion'] },
  interface: { entries: ['ui.workbench', 'ui.showThinking', 'ui.autoSave', 'ui.diffMode', 'ui.confirmExit', 'ui.closeToTray', 'ui.notifications'] },
  session: { entries: ['autoContinueOnReset', 'ui.defaultMode', 'ui.softwareRender', 'orchestra.maxParallel'] },
  engine: { bodies: ['account', 'engine'] },
  providers: { bodies: ['providers', 'env'] },
  models: { bodies: ['models'] },
  gateway: { bodies: ['gateway'] },
  secrets: { bodies: ['secrets'] },
  mcp: { bodies: ['mcpCatalog', 'mcp', 'mcpJson'] },
  plugins: { bodies: ['plugins'] },
  skills: { bodies: ['skills', 'skillsBackup'] },
  memory: { bodies: ['memory'] },
  library: { bodies: ['library'] },
  agents: { bodies: ['agents'] },
  subagents: { bodies: ['subagents'] },
  hooks: { bodies: ['hooks'] },
  remote: { bodies: ['remote', 'peers', 'hosts'] },
  im: { bodies: ['im'] },
  tools: { bodies: ['tools'] },
  update: { bodies: ['update'] },
  diagnostics: { bodies: ['diagnostics'] },
  raw: { bodies: ['raw'] },
};
/** Parts that intentionally left their old page (spec §5.7): → the section that has them now. */
const MOVED: Partial<Record<BodyId, string>> = { env: 'env' };
/**
 * Old content that is now one click away: behind its page's 更多选项, which stays collapsed when the old id opens the
 * page. Everything else an old id showed must be on the page directly (or 更多选项 must open with it, like engine).
 */
const BEHIND_MORE: Record<string, string[]> = {
  appearance: ['ui.cjkFont'],
  session: ['ui.softwareRender', 'orchestra.maxParallel'],
  mcp: ['mcpJson'],
  skills: ['skillsBackup'],
  remote: ['hosts'],
};

/** What opening a target shows: rows and parts on the page, and the ones behind 更多选项 when it opens collapsed. */
function shownBy(t: SettingsTarget): { direct: string[]; behindMore: string[] } {
  const sec = findSection(t.section)!;
  const tab = activeTab(sec, t.tab);
  const main = [...(sec.entries ?? []).filter((e) => !e.more).map((e) => e.id), ...(tab ? tab.bodies : sec.bodies ?? [])];
  const more = [...(sec.entries ?? []).filter((e) => e.more).map((e) => e.id), ...(tab ? tab.more ?? [] : sec.more ?? [])];
  return t.more ? { direct: [...main, ...more], behindMore: [] } : { direct: main, behindMore: more };
}

const ids = (hits: SettingsHit[]) => hits.map((h) => (h.kind === 'entry' ? `entry:${h.entry.id}` : `page:${h.section.id}${h.tab ? `/${h.tab.id}` : ''}${h.body ? `#${h.body}` : ''}`));

describe('settings map (spec §5.7)', () => {
  it('five groups of visible sections plus a collapsed 高级, exactly as the spec table', () => {
    expect(SETTINGS_GROUPS.map((g) => g.l)).toEqual(['常用', '模型', '扩展', '连接', '数据', '高级']);
    const byGroup = Object.fromEntries(SETTINGS_GROUPS.map((g) => [g.l, SETTINGS_SECTIONS.filter((s) => s.group === g.id).map((s) => s.l)]));
    expect(byGroup).toEqual({
      常用: ['通用', '外观', '账号与登录'],
      模型: ['模型与智能程度', '供应商', '模型网关'],
      扩展: ['MCP 与插件', 'Skills', 'Agents 与子代理', '共享记忆'],
      连接: ['手机与其它电脑', 'IM 机器人'],
      数据: ['会话库', '密钥'],
      高级: ['Hooks', '环境变量', 'CLI 工具', '诊断', '更新', 'settings.json'],
    });
    expect(VISIBLE_SECTIONS.length).toBeLessThanOrEqual(15);
    expect(VISIBLE_SECTIONS.length).toBe(14);
    expect(ADVANCED_SECTIONS.every((s) => s.advanced && s.group === 'advanced')).toBe(true);
    expect(VISIBLE_SECTIONS.some((s) => s.advanced)).toBe(false);
  });

  it('ids are unique; every section has a lead line; tabs have unique ids', () => {
    const sids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(sids).size).toBe(sids.length);
    for (const s of SETTINGS_SECTIONS) {
      expect(s.desc.length, s.id).toBeGreaterThan(4);
      if (s.tabs) expect(new Set(s.tabs.map((t) => t.id)).size, s.id).toBe(s.tabs.length);
      if (s.tabs) expect(s.bodies ?? [], `${s.id}: a tabbed page keeps its parts in the tabs`).toEqual([]);
    }
    expect(DEFAULT_SECTION).toBe('general');
  });

  it('every entry of the old window is still there, exactly once', () => {
    const legacy = Object.values(LEGACY).flatMap((x) => x.entries ?? []);
    const now = allEntries().map(({ entry }) => entry.id);
    expect(new Set(now).size).toBe(now.length);
    for (const id of legacy) expect(now, id).toContain(id);
    expect([...now].sort()).toEqual([...legacy].sort());
  });

  it('every part of the old window is on exactly one page', () => {
    const now = allBodies().map((b) => b.body);
    expect(new Set(now).size).toBe(now.length);
    for (const b of Object.values(LEGACY).flatMap((x) => x.bodies ?? [])) expect(now, b).toContain(b);
    for (const b of now) expect(BODY_INFO[b]?.l, b).toBeTruthy();
  });

  it('every old section id opens a page that shows what the old one showed', () => {
    for (const [old, want] of Object.entries(LEGACY)) {
      const t = resolveSettingsTarget({ section: old });
      const sec = findSection(t.section);
      expect(sec, old).toBeTruthy();
      if (t.tab) expect(sec!.tabs?.some((x) => x.id === t.tab), `${old} → ${t.section}/${t.tab}`).toBe(true);
      for (const e of want.entries ?? []) expect(sec!.entries?.some((x) => x.id === e), `${old}: ${e}`).toBe(true);
      const shown = targetBodies(t);
      const { direct, behindMore } = shownBy(t);
      for (const b of want.bodies ?? []) {
        if (MOVED[b]) { expect(targetBodies({ section: MOVED[b]! }), `${old}: ${b} moved`).toContain(b); continue; }
        expect(shown, `${old}: ${b}`).toContain(b);
      }
      // directly in view vs. behind a collapsed 更多选项 — exactly as BEHIND_MORE says
      for (const x of [...(want.entries ?? []), ...(want.bodies ?? []).filter((b) => !MOVED[b])]) {
        if (BEHIND_MORE[old]?.includes(x)) expect(behindMore, `${old}: ${x} behind 更多选项`).toContain(x);
        else expect(direct, `${old}: ${x} directly on the page`).toContain(x);
      }
    }
    for (const [old, xs] of Object.entries(BEHIND_MORE)) {
      const was = [...(LEGACY[old].entries ?? []), ...(LEGACY[old].bodies ?? [])];
      for (const x of xs) expect(was, `BEHIND_MORE.${old}: ${x} was on that page`).toContain(x);
    }
    // the ones that changed name are explicit aliases
    expect(Object.keys(LEGACY_SECTIONS).sort()).toEqual(['engine', 'interface', 'plugins', 'session', 'subagents']);
    expect(resolveSettingsTarget({ section: 'plugins' })).toEqual({ section: 'mcp', tab: 'plugins' });
    expect(resolveSettingsTarget({ section: 'subagents' })).toEqual({ section: 'agents', tab: 'subagents' });
    // 引擎与账号 → 账号与登录 with 更多选项 open, scrolled to 运行内核 (both old parts in view)
    expect(resolveSettingsTarget({ section: 'engine' })).toEqual({ section: 'account', more: true, body: 'engine' });
    expect(shownBy(resolveSettingsTarget({ section: 'engine' })).direct).toEqual(expect.arrayContaining(['account', 'engine']));
  });

  it('new ids resolve to themselves; nothing / unknown → 通用', () => {
    for (const s of SETTINGS_SECTIONS) expect(resolveSettingsTarget({ section: s.id }).section).toBe(s.id);
    expect(resolveSettingsTarget({})).toEqual({ section: 'general' });
    expect(resolveSettingsTarget(null)).toEqual({ section: 'general' });
    expect(resolveSettingsTarget({ section: 'nope' })).toEqual({ section: 'general' });
  });

  it('reveal finds the page of an entry and opens 更多选项 when the entry is in there', () => {
    for (const { section, entry } of allEntries()) {
      expect(resolveSettingsTarget({ reveal: entry.id })).toEqual({ section: section.id, reveal: entry.id, ...(entry.more ? { more: true } : {}) });
    }
    expect(resolveSettingsTarget({ reveal: 'ui.softwareRender' }).more).toBe(true);
    expect(resolveSettingsTarget({ reveal: 'ui.workbench' }).more).toBeUndefined();
    // an unknown reveal falls back to the section
    expect(resolveSettingsTarget({ section: 'engine', reveal: 'nope' })).toEqual({ section: 'account', more: true, body: 'engine' });
  });

  it('更多选项 lists what it holds; pages without low-frequency parts have none', () => {
    expect(moreHint(findSection('general')!)).toBe('软件渲染（桌面版）、编排并发上限');
    expect(moreHint(findSection('appearance')!)).toBe('中文字体');
    expect(moreHint(findSection('account')!)).toBe('运行内核');
    expect(moreHint(findSection('remote')!)).toBe('SSH 隧道');
    expect(moreHint(findSection('mcp')!, 'servers')).toBe('手动添加（JSON）');
    expect(moreHint(findSection('mcp')!, 'plugins')).toBe('');
    expect(moreHint(findSection('secrets')!)).toBe('');
  });

  it('退出前确认 and 减少动画 are on their pages, not behind 更多选项', () => {
    for (const id of ['ui.confirmExit', 'ui.reduceMotion']) expect(allEntries().find(({ entry }) => entry.id === id)!.entry.more, id).toBeFalsy();
  });

  it('「显示工作台工具」 lives on 通用, and the one-time notice says so', () => {
    const where = allEntries().find(({ entry }) => entry.id === 'ui.workbench')!;
    expect(where.section.id).toBe('general');
    expect(where.entry.more).toBeFalsy();
    expect(WORKBENCH_SETTING_PATH).toBe(`设置 → ${where.section.l}`);
  });
});

describe('searchSettings', () => {
  it('finds entries with a 分组 › 分区 crumb, 更多选项 included', () => {
    const tray = searchSettings('托盘');
    expect(ids(tray)).toContain('entry:ui.closeToTray');
    expect(tray.find((h) => h.kind === 'entry' && h.entry.id === 'ui.closeToTray')!.crumb).toBe('常用 › 通用');
    const soft = searchSettings('软件渲染').find((h) => h.kind === 'entry')!;
    expect(soft.crumb).toBe('常用 › 通用 › 更多选项');
  });

  it('keeps the old words working (single pane, the old section names)', () => {
    expect(ids(searchSettings('单窗格'))).toContain('entry:ui.workbench');
    expect(ids(searchSettings('引擎与账号'))).toContain('page:account');
    expect(ids(searchSettings('IM 网关'))).toContain('page:im');
    expect(ids(searchSettings('CLI Agents'))).toContain('page:agents/cli');
  });

  it('finds pages, tabs and parts — also inside the collapsed 高级 and 更多选项', () => {
    const raw = searchSettings('settings.json').find((h) => h.kind === 'page' && h.section.id === 'raw')!;
    expect(raw.crumb).toBe('高级 › settings.json');
    expect(ids(searchSettings('插件'))).toContain('page:mcp/plugins');
    const ssh = searchSettings('ssh').find((h) => h.kind === 'page' && h.body === 'hosts')!;
    expect(ssh).toBeTruthy();
    expect(ssh.kind === 'page' && ssh.more).toBe(true);
    expect(ssh.crumb).toBe('连接 › 手机与其它电脑 › 更多选项');
    const env = searchSettings('环境变量');
    expect(ids(env)).toContain('page:env');
  });

  it('every entry, page and part is findable by its own name; several words must all match', () => {
    for (const { entry } of allEntries()) expect(ids(searchSettings(entry.label)), entry.label).toContain(`entry:${entry.id}`);
    for (const s of SETTINGS_SECTIONS) expect(searchSettings(s.l).some((h) => h.section.id === s.id), s.l).toBe(true);
    for (const { body, section } of allBodies()) expect(searchSettings(BODY_INFO[body].l).some((h) => h.section.id === section.id), body).toBe(true);
    expect(searchSettings('托盘 关闭').some((h) => h.kind === 'entry' && h.entry.id === 'ui.closeToTray')).toBe(true);
    expect(searchSettings('托盘 不存在的词')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('a part that is in view once its page opens is not listed twice', () => {
    // 插件 matches the tab and the plugin list inside it: one hit for that tab, none for the MCP tab
    const hits = ids(searchSettings('插件'));
    expect(hits.filter((h) => h.startsWith('page:mcp/plugins'))).toEqual(['page:mcp/plugins']);
    expect(hits.some((h) => h.startsWith('page:mcp/servers'))).toBe(false);
    // only the part matches: the part itself
    expect(ids(searchSettings('marketplace')).filter((h) => h.startsWith('page:mcp/'))).toEqual(['page:mcp/plugins#plugins']);
  });
});

describe('navStatus', () => {
  it('shows only what is known', () => {
    expect(navStatus({})).toEqual({});
    expect(navStatus({ loggedIn: true, providers: 2, gatewayEnabled: false })).toEqual({ account: '已登录', providers: '2', gateway: '关' });
    expect(navStatus({ loggedIn: false, providers: 0, gatewayEnabled: true })).toEqual({ account: '未登录', gateway: '开' });
  });
});
