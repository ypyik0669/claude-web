import { describe, expect, it } from 'vitest';
import {
  ADVANCED_SECTIONS, AWAY_SECTIONS, BODY_INFO, BOT_ENTRIES, BOTS_CRUMB, DEFAULT_SECTION, KEYBOARD_WORDS, LEGACY_SECTIONS,
  SETTINGS_GROUPS, SETTINGS_SECTIONS, VISIBLE_SECTIONS, activeTab, allBodies, allEntries, awayTarget, entriesOn, findSection,
  moreHint, navStatus, resolveSettingsTarget, searchSettings, targetBodies, type BodyId, type SettingsHit, type SettingsTarget,
} from './catalog';
import { WORKBENCH_SETTING_PATH } from '@/ui/terms';

/**
 * The settings window of 2026-09 (before the phase 6 regroup): 22 flat sections, verbatim. Body components that were
 * split in parts are listed by their parts (Overview → login + 运行内核, Mcp → list + JSON form, Skills → list /
 * install + backup, 远程 / 手机 → phone + other computers + SSH tunnels). The parts that left the settings in the
 * redesign 2026-11 stage 2 (MCP / 插件 / Skills → 自定义) keep their old names here: they are strings, not BodyIds.
 */
const LEGACY: Record<string, { entries?: string[]; bodies?: string[] }> = {
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
/**
 * Stage 1's page ids (6 groups: 常用 / 模型 / 扩展 / 连接 / 数据 / 高级) that are not 2026-09 ids too, with what they
 * showed: they must land as well.
 */
const STAGE1: Record<string, { entries?: string[]; bodies?: string[] }> = {
  general: { entries: ['ui.defaultMode', 'autoContinueOnReset', 'ui.showThinking', 'ui.viewMode', 'ui.welcomeLayout', 'ui.promptSuggestions', 'ui.diffMode', 'ui.inlineDiffs', 'sessions.mcp', 'ui.nodegraphHint'] },
  account: { bodies: ['account'] },
  web: { bodies: ['web'] },
  env: { bodies: ['localEnv', 'env'] },
};
/** The parts that left the settings (spec #ia: 「MCP 与插件、Skills → 自定义，设置里不再重复一份」). */
const GONE_PARTS = ['mcpCatalog', 'mcp', 'mcpJson', 'plugins', 'skills', 'skillsBackup'];
/** Parts that intentionally left their old page (spec §5.7 / stage 2): → the section that has them now. */
const MOVED: Partial<Record<BodyId, string>> = { env: 'env' };
/**
 * Rows of a split page (通用 → 对话 + 通知与窗口; 界面 / 会话 likewise): the old id opens the page with most of them,
 * these are one page further — on the page named here.
 */
const SPLIT: Record<string, Record<string, string>> = {
  interface: { 'ui.showThinking': 'conversation', 'ui.diffMode': 'conversation' },
  session: { 'ui.softwareRender': 'window' },
};
/**
 * Old content that is now one click away: behind its page's 更多选项, which stays collapsed when the old id opens the
 * page. Everything else an old id showed must be on the page directly (or 更多选项 must open with it, like engine).
 */
const BEHIND_MORE: Record<string, string[]> = {
  appearance: ['ui.cjkFont'],
  session: ['orchestra.maxParallel'],
  remote: ['hosts'],
};

/** What opening a target shows: rows and parts on the page, and the ones behind 更多选项 when it opens collapsed. */
function shownBy(t: SettingsTarget): { direct: string[]; behindMore: string[] } {
  const sec = findSection(t.section)!;
  const tab = activeTab(sec, t.tab);
  const rows = entriesOn(sec, tab?.id);
  const main = [...rows.filter((e) => !e.more).map((e) => e.id), ...(tab ? tab.bodies : sec.bodies ?? [])];
  const more = [...rows.filter((e) => e.more).map((e) => e.id), ...(tab ? tab.more ?? [] : sec.more ?? [])];
  return t.more ? { direct: [...main, ...more], behindMore: [] } : { direct: main, behindMore: more };
}

const ids = (hits: SettingsHit[]) => hits.map((h) => (h.kind === 'entry' ? `entry:${h.entry.id}` : h.kind === 'away-entry' ? `away-entry:${h.entry.id}` : h.kind === 'away' ? `away:${h.id}` : `page:${h.section.id}${h.tab ? `/${h.tab.id}` : ''}${h.body ? `#${h.body}` : ''}`));
const sectionOf = (h: SettingsHit) => (h.kind === 'entry' || h.kind === 'page' ? h.section.id : undefined);

describe('settings map (界面改版 2026-11 阶段 2: 4 groups, 14 pages)', () => {
  it('four groups, fourteen pages, exactly as the spec table (#ia 「设置 · 4 组 14 页」)', () => {
    expect(SETTINGS_GROUPS.map((g) => g.l)).toEqual(['账号', '应用', 'Claude Code', '高级']);
    const byGroup = Object.fromEntries(SETTINGS_GROUPS.map((g) => [g.l, SETTINGS_SECTIONS.filter((s) => s.group === g.id).map((s) => s.l)]));
    expect(byGroup).toEqual({
      账号: ['账号与登录', '用量与账本'],
      应用: ['外观', '通知与窗口', '手机与远程', '隐私与密钥'],
      'Claude Code': ['对话', '模型', '联网与浏览器', 'Agents 与子代理', '记忆与对话库'],
      高级: ['环境变量', 'Hooks 与 settings.json', '诊断与更新'],
    });
    expect(SETTINGS_SECTIONS.length).toBe(14);
    // 高级's pages are the ones where implementation words may show (the wording gate's scope is the rest)
    expect(ADVANCED_SECTIONS.map((s) => s.id)).toEqual(['env', 'hooks', 'diagnostics']);
    expect(ADVANCED_SECTIONS.every((s) => s.group === 'advanced')).toBe(true);
    expect(VISIBLE_SECTIONS.length + ADVANCED_SECTIONS.length).toBe(14);
  });

  it('设置 › 模型 is one page with three tabs: 来源 · 路由 · 模型', () => {
    const m = findSection('model')!;
    expect(m.tabs!.map((t) => [t.id, t.l])).toEqual([['sources', '来源'], ['routing', '路由'], ['models', '模型']]);
    expect(m.tabs!.map((t) => t.bodies)).toEqual([['providers', 'proxy'], ['gateway'], ['models']]);
    // 思考用的语言 is a row of the 模型 tab, not of the other two
    expect(entriesOn(m, 'models').map((e) => e.id)).toEqual(['ai.thinkingLanguage']);
    expect(entriesOn(m, 'sources')).toEqual([]);
    expect(entriesOn(m, 'routing')).toEqual([]);
  });

  it('ids are unique; every section has a lead line; tabs have unique ids', () => {
    const sids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(new Set(sids).size).toBe(sids.length);
    for (const s of SETTINGS_SECTIONS) {
      expect(s.desc.length, s.id).toBeGreaterThan(4);
      if (s.tabs) expect(new Set(s.tabs.map((t) => t.id)).size, s.id).toBe(s.tabs.length);
      if (s.tabs) expect(s.bodies ?? [], `${s.id}: a tabbed page keeps its parts in the tabs`).toEqual([]);
      for (const e of s.entries ?? []) if (e.tab) expect(s.tabs?.some((t) => t.id === e.tab), `${e.id}: tab ${e.tab}`).toBe(true);
    }
    expect(DEFAULT_SECTION).toBe('conversation');
    // a legacy id is never also a page id (it would never be read)
    for (const old of Object.keys(LEGACY_SECTIONS)) expect(findSection(old), old).toBeUndefined();
    for (const old of Object.keys(AWAY_SECTIONS)) expect(findSection(old), old).toBeUndefined();
  });

  it('every entry of the old windows is still there, exactly once — on a settings page or in 自动化 › Bot › 设置', () => {
    const legacy = Object.values(LEGACY).flatMap((x) => x.entries ?? []);
    // the rows added since 2026-09
    const added = ['ui.inlineDiffs', 'ui.haptics', 'ui.zoom', 'ui.language', 'ui.promptSuggestions', 'ui.viewMode', 'ui.infoPanel', 'ui.sidebarFolded', 'ui.backdropMotion', 'ui.welcomeLayout', 'ui.autoArchivePr', 'sessions.mcp', 'claude.desktopSkills', 'worktree.dir', 'worktree.prefix', 'ai.thinkingLanguage', 'ui.backdropInChat', 'vcs.gitlabHosts', 'vcs.resolveOnReply', 'ui.nodegraphHint',
      // 设置 → Bot (duty bots), now 自动化 › Bot › 设置
      'bots.concurrency', 'bots.globalBudgetUsd', 'bots.defaultProvider', 'bots.defaultTier', 'bots.duty.service', 'bots.loginItem', 'bots.unleashAll',
      // 外观 → 开场和背景 (界面改版方案 第 7 版 #opening)
      'ui.opening.pack', 'ui.opening.when', 'ui.opening.length', 'ui.opening.sound', 'ui.opening.keep'];
    const onPages = allEntries().map(({ entry }) => entry.id);
    const now = [...onPages, ...BOT_ENTRIES.map((e) => e.id)];
    expect(new Set(now).size).toBe(now.length);
    for (const id of legacy) expect(now, id).toContain(id);
    expect([...now].sort()).toEqual([...legacy, ...added].sort());
    const at = (id: string) => allEntries().find((e) => e.entry.id === id);
    expect(at('ui.inlineDiffs')?.section.id).toBe(at('ui.diffMode')?.section.id);
    expect(at('ui.inlineDiffs')?.entry.block).toBe(at('ui.diffMode')?.entry.block);
    // 通用 split: the conversation's rows on 对话, the window's on 通知与窗口
    for (const id of ['ui.defaultMode', 'autoContinueOnReset', 'ui.viewMode', 'ui.showThinking', 'ui.promptSuggestions', 'ui.diffMode', 'ui.infoPanel', 'ui.welcomeLayout', 'sessions.mcp', 'ui.autoArchivePr', 'vcs.gitlabHosts', 'worktree.dir', 'worktree.prefix', 'orchestra.maxParallel']) expect(at(id)?.section.id, id).toBe('conversation');
    for (const id of ['ui.notifications', 'ui.closeToTray', 'ui.confirmExit', 'ui.workbench', 'ui.autoSave', 'ui.softwareRender', 'ui.sidebarFolded']) expect(at(id)?.section.id, id).toBe('window');
    // the spec mock's 对话 page: 新对话 · 显示 · 对话之间
    expect([...new Set(entriesOn(findSection('conversation')!).filter((e) => !e.more).map((e) => e.block))]).toEqual(['新对话', '显示', '对话之间', 'PR 与 MR']);
    // 思考用的语言: on the model page, found by 思考 together with 显示思考过程
    expect(at('ai.thinkingLanguage')?.section.id).toBe('model');
    expect(ids(searchSettings('思考'))).toEqual(expect.arrayContaining(['entry:ui.showThinking', 'entry:ai.thinkingLanguage']));
    // 背景动画 (A6) and 对话里的淡背景: backgrounds live in 外观 (spec #ia: 「飘字背景和字符画主题的背景留在 外观 里」)
    expect(at('ui.backdropMotion')?.section.id).toBe('appearance');
    expect(at('ui.backdropInChat')?.section.id).toBe('appearance');
    expect(at('ui.welcomeBackdrop')).toBeUndefined();
    // 开场和背景: one block under 外观, the cards first; found by 开场 and by 背景
    for (const id of ['ui.opening.pack', 'ui.opening.when', 'ui.opening.length', 'ui.opening.sound', 'ui.opening.keep']) expect(at(id)?.section.id, id).toBe('appearance');
    expect(new Set(['ui.opening.pack', 'ui.opening.when', 'ui.opening.keep'].map((id) => at(id)?.entry.block)).size).toBe(1);
    expect(at('ui.opening.pack')?.entry.wide).toBe(true);
    expect(ids(searchSettings('开场'))).toEqual(expect.arrayContaining(['entry:ui.opening.pack', 'entry:ui.opening.when']));
    expect(ids(searchSettings('留作背景'))).toContain('entry:ui.opening.keep');
  });

  it('every part of the old windows is on exactly one page — or left for 自定义', () => {
    const now = allBodies().map((b) => b.body as string);
    expect(new Set(now).size).toBe(now.length);
    for (const b of Object.values(LEGACY).flatMap((x) => x.bodies ?? [])) {
      if (GONE_PARTS.includes(b)) expect(now, `${b} left the settings`).not.toContain(b);
      else expect(now, b).toContain(b);
    }
    for (const b of now) expect(BODY_INFO[b as BodyId]?.l, b).toBeTruthy();
    // the new parts: 用量与账本, and the way into the board's 隐私 page
    expect(targetBodies({ section: 'usage' })).toEqual(['usage']);
    expect(targetBodies({ section: 'secrets' })).toEqual(['secrets', 'privacy']);
  });

  it('every old section id opens a page that shows what the old one showed — or the place it left for', () => {
    for (const [old, want] of Object.entries({ ...LEGACY, ...STAGE1 })) {
      const away = awayTarget({ section: old });
      if ((want.bodies ?? []).some((b) => GONE_PARTS.includes(b))) {
        expect(away, `${old} → 自定义`).toEqual(expect.objectContaining({ to: 'extensions' }));
        continue;
      }
      expect(away, old).toBeUndefined();
      const t = resolveSettingsTarget({ section: old });
      const sec = findSection(t.section);
      expect(sec, old).toBeTruthy();
      if (t.tab) expect(sec!.tabs?.some((x) => x.id === t.tab), `${old} → ${t.section}/${t.tab}`).toBe(true);
      const shown = targetBodies(t);
      const { direct, behindMore } = shownBy(t);
      for (const e of want.entries ?? []) {
        const elsewhere = SPLIT[old]?.[e];
        if (elsewhere) { expect(allEntries().find((x) => x.entry.id === e)?.section.id, `${old}: ${e} → ${elsewhere}`).toBe(elsewhere); continue; }
        if (BEHIND_MORE[old]?.includes(e)) expect(behindMore, `${old}: ${e} behind 更多选项`).toContain(e);
        else expect(direct, `${old}: ${e} directly on the page`).toContain(e);
      }
      for (const b of want.bodies ?? []) {
        if (MOVED[b as BodyId]) { expect(targetBodies({ section: MOVED[b as BodyId]! }), `${old}: ${b} moved`).toContain(b); continue; }
        expect(shown, `${old}: ${b}`).toContain(b);
        if (BEHIND_MORE[old]?.includes(b)) expect(behindMore, `${old}: ${b} behind 更多选项`).toContain(b);
        else expect(direct, `${old}: ${b} directly on the page`).toContain(b);
      }
    }
    for (const [old, xs] of Object.entries(BEHIND_MORE)) {
      const was = [...(LEGACY[old].entries ?? []), ...(LEGACY[old].bodies ?? [])];
      for (const x of xs) expect(was, `BEHIND_MORE.${old}: ${x} was on that page`).toContain(x);
    }
    // the ones that changed name are explicit aliases
    expect(Object.keys(LEGACY_SECTIONS).sort()).toEqual(['engine', 'gateway', 'general', 'im', 'interface', 'library', 'models', 'providers', 'raw', 'session', 'subagents', 'tools', 'update']);
    expect(resolveSettingsTarget({ section: 'providers' })).toEqual({ section: 'model', tab: 'sources' });
    expect(resolveSettingsTarget({ section: 'gateway' })).toEqual({ section: 'model', tab: 'routing' });
    expect(resolveSettingsTarget({ section: 'models' })).toEqual({ section: 'model', tab: 'models' });
    expect(resolveSettingsTarget({ section: 'subagents' })).toEqual({ section: 'agents', tab: 'subagents' });
    expect(resolveSettingsTarget({ section: 'im' })).toEqual({ section: 'remote', body: 'im' });
    expect(resolveSettingsTarget({ section: 'library' })).toEqual({ section: 'memory', body: 'library' });
    // 引擎与账号 → 账号与登录 with 更多选项 open, scrolled to 运行内核 (both old parts in view)
    expect(resolveSettingsTarget({ section: 'engine' })).toEqual({ section: 'account', more: true, body: 'engine' });
    expect(shownBy(resolveSettingsTarget({ section: 'engine' })).direct).toEqual(expect.arrayContaining(['account', 'engine']));
  });

  it('what left the settings opens its new place: MCP / 插件 / Skills → 自定义, 值班 Bot\'s rows → 自动化 › Bot › 设置', () => {
    expect(awayTarget({ section: 'mcp' })).toEqual({ to: 'extensions', tab: 'connectors' });
    expect(awayTarget({ section: 'plugins' })).toEqual({ to: 'extensions', tab: 'plugins' });
    // the connector directory's old 「用配置手动添加…」 link: 连接器 with its JSON form
    expect(awayTarget({ section: 'mcp-json' })).toEqual({ to: 'extensions', tab: 'connectors', json: true });
    expect(awayTarget({ section: 'skills' })).toEqual({ to: 'extensions', tab: 'skills' });
    for (const e of BOT_ENTRIES) expect(awayTarget({ reveal: e.id }), e.id).toEqual({ to: 'bots', reveal: e.id });
    // settings pages, old aliases, settings rows and unknown ids stay in the settings
    for (const s of SETTINGS_SECTIONS) expect(awayTarget({ section: s.id }), s.id).toBeUndefined();
    for (const old of Object.keys(LEGACY_SECTIONS)) expect(awayTarget({ section: old }), old).toBeUndefined();
    expect(awayTarget({ reveal: 'ui.closeToTray' })).toBeUndefined();
    expect(awayTarget({ section: 'nope' })).toBeUndefined();
    expect(awayTarget({})).toBeUndefined();
    expect(awayTarget(null)).toBeUndefined();
  });

  it('new ids resolve to themselves (a tab only when the page has it); nothing / unknown → 对话', () => {
    for (const s of SETTINGS_SECTIONS) expect(resolveSettingsTarget({ section: s.id }).section).toBe(s.id);
    expect(resolveSettingsTarget({ section: 'model', tab: 'routing' })).toEqual({ section: 'model', tab: 'routing' });
    expect(resolveSettingsTarget({ section: 'model', tab: 'nope' })).toEqual({ section: 'model' });
    expect(resolveSettingsTarget({ section: 'appearance', tab: 'routing' })).toEqual({ section: 'appearance' });
    expect(resolveSettingsTarget({})).toEqual({ section: 'conversation' });
    expect(resolveSettingsTarget(null)).toEqual({ section: 'conversation' });
    expect(resolveSettingsTarget({ section: 'nope' })).toEqual({ section: 'conversation' });
  });

  it('reveal finds the page (and tab) of an entry and opens 更多选项 when the entry is in there', () => {
    for (const { section, entry } of allEntries()) {
      expect(resolveSettingsTarget({ reveal: entry.id })).toEqual({ section: section.id, ...(entry.tab ? { tab: entry.tab } : {}), reveal: entry.id, ...(entry.more ? { more: true } : {}) });
    }
    expect(resolveSettingsTarget({ reveal: 'ui.softwareRender' }).more).toBe(true);
    expect(resolveSettingsTarget({ reveal: 'ui.workbench' }).more).toBeUndefined();
    expect(resolveSettingsTarget({ reveal: 'ai.thinkingLanguage' })).toEqual({ section: 'model', tab: 'models', reveal: 'ai.thinkingLanguage' });
    // an unknown reveal falls back to the section
    expect(resolveSettingsTarget({ section: 'engine', reveal: 'nope' })).toEqual({ section: 'account', more: true, body: 'engine' });
  });

  it('更多选项 lists what it holds; pages without low-frequency parts have none', () => {
    expect(moreHint(findSection('conversation')!)).toBe('独立副本（worktree）分支前缀、编排并发上限');
    expect(moreHint(findSection('window')!)).toBe('软件渲染（桌面版）');
    expect(moreHint(findSection('appearance')!)).toBe('中文字体');
    expect(moreHint(findSection('account')!)).toBe('运行内核');
    expect(moreHint(findSection('remote')!)).toBe('牵线服务器与最近连接、SSH 隧道');
    expect(moreHint(findSection('model')!, 'models')).toBe('');
    expect(moreHint(findSection('secrets')!)).toBe('');
  });

  it('在外面也能用: the switch on 手机与远程 itself; its brokers / STUN / phone page / recent connections behind 更多选项', () => {
    const where = allBodies().filter((b) => b.body === 'anywhere');
    expect(where.map((b) => [b.section.id, b.more])).toEqual([['remote', true]]);
    expect(findSection('remote')!.bodies).toEqual(['remote', 'peers', 'im']);
    for (const q of ['在外面也能用', '不让电脑睡眠', '配对链接']) expect(ids(searchSettings(q)), q).toContain('page:remote#remote');
    for (const q of ['stun', 'mqtt', '牵线', '最近连接']) {
      const hit = searchSettings(q).find((h) => h.kind === 'page' && h.body === 'anywhere');
      expect(hit && hit.kind === 'page' && hit.more, q).toBe(true);
    }
  });

  it('值班 Bot: no settings page has its rows (自动化 › Bot › 设置 does); the search still finds each, live, with that crumb', () => {
    expect(BOT_ENTRIES.map((e) => e.id)).toEqual(['bots.concurrency', 'bots.globalBudgetUsd', 'bots.defaultProvider', 'bots.defaultTier', 'bots.duty.service', 'bots.loginItem', 'bots.unleashAll']);
    expect(allEntries().filter(({ entry }) => entry.id.startsWith('bots.'))).toEqual([]);
    expect(BOT_ENTRIES.find((e) => e.id === 'bots.defaultProvider')!.hint).toBe('Bot 7×24 小时跑，默认走 API / 网关来源，不用 Claude 订阅登录（2026-04 起条款可能禁止这样用订阅，有封号风险）');
    expect(BOTS_CRUMB).toBe('自动化 › Bot › 设置');
    expect(ids(searchSettings('放开'))).toContain('away-entry:bots.unleashAll');
    expect(ids(searchSettings('值班 后台'))).toContain('away-entry:bots.duty.service');
    for (const q of ['值班', 'Bot']) expect(ids(searchSettings(q)), q).toEqual(expect.arrayContaining(BOT_ENTRIES.map((e) => `away-entry:${e.id}`)));
    const hit = searchSettings('预算').find((h) => h.kind === 'away-entry');
    expect(hit && hit.kind === 'away-entry' && [hit.crumb, hit.target]).toEqual(['自动化 › Bot › 设置', { to: 'bots', reveal: 'bots.globalBudgetUsd' }]);
  });

  it('退出前确认 and 减少动画 are on their pages, not behind 更多选项', () => {
    for (const id of ['ui.confirmExit', 'ui.reduceMotion']) expect(allEntries().find(({ entry }) => entry.id === id)!.entry.more, id).toBeFalsy();
  });

  it('「显示工作台工具」 lives on 通知与窗口, and the one-time notice says so', () => {
    const where = allEntries().find(({ entry }) => entry.id === 'ui.workbench')!;
    expect(where.section.id).toBe('window');
    expect(where.entry.more).toBeFalsy();
    expect(WORKBENCH_SETTING_PATH).toBe(`设置 → ${where.section.l}`);
  });

  it('phones show no keyboard words (spec #phone 问题 8): a hint that has them comes with a touchHint that has none', () => {
    const rows = [...allEntries().map(({ entry }) => entry), ...BOT_ENTRIES];
    const keyed = rows.filter((e) => e.hint && KEYBOARD_WORDS.test(e.hint));
    expect(keyed.map((e) => e.id).sort()).toEqual(['ui.autoSave', 'ui.promptSuggestions', 'ui.viewMode', 'ui.workbench']);
    for (const e of keyed) {
      expect(e.touchHint, e.id).toBeTruthy();
      expect(KEYBOARD_WORDS.test(e.touchHint!), `${e.id}: ${e.touchHint}`).toBe(false);
    }
    for (const e of rows) if (e.touchHint) expect(KEYBOARD_WORDS.test(e.touchHint), e.id).toBe(false);
    expect(KEYBOARD_WORDS.test('Ctrl+O 随时切换')).toBe(true);
    expect(KEYBOARD_WORDS.test('按 Tab 采用')).toBe(true);
    expect(KEYBOARD_WORDS.test('每轮结束后')).toBe(false);
  });
});

describe('searchSettings', () => {
  it('finds entries with a 分组 › 分区 crumb, 更多选项 included', () => {
    const tray = searchSettings('托盘');
    expect(ids(tray)).toContain('entry:ui.closeToTray');
    expect(tray.find((h) => h.kind === 'entry' && h.entry.id === 'ui.closeToTray')!.crumb).toBe('应用 › 通知与窗口');
    const soft = searchSettings('软件渲染').find((h) => h.kind === 'entry')!;
    expect(soft.crumb).toBe('应用 › 通知与窗口 › 更多选项');
    const lang = searchSettings('思考用的语言').find((h) => h.kind === 'entry')!;
    expect(lang.crumb).toBe('Claude Code › 模型 › 模型');
  });

  it('keeps the old words working (single pane, the old section names)', () => {
    expect(ids(searchSettings('单窗格'))).toContain('entry:ui.workbench');
    expect(ids(searchSettings('引擎与账号'))).toContain('page:account');
    expect(ids(searchSettings('IM 网关'))).toContain('page:remote');
    expect(ids(searchSettings('CLI Agents'))).toContain('page:agents/cli');
    expect(ids(searchSettings('供应商'))).toEqual(expect.arrayContaining(['page:model', 'page:model/sources']));
    expect(ids(searchSettings('模型网关'))).toContain('page:model/routing');
    expect(ids(searchSettings('共享记忆'))).toContain('page:memory');
    expect(ids(searchSettings('对话库'))).toContain('page:memory');
    expect(ids(searchSettings('手机与其它电脑'))).toContain('page:remote');
    expect(ids(searchSettings('通用'))).toEqual(expect.arrayContaining(['page:conversation', 'page:window']));
  });

  it('finds pages, tabs and parts — 更多选项 and the 高级 group included', () => {
    const raw = searchSettings('settings.json').find((h) => h.kind === 'page' && h.section.id === 'hooks')!;
    expect(raw.crumb).toBe('高级 › Hooks 与 settings.json');
    const ssh = searchSettings('ssh').find((h) => h.kind === 'page' && h.body === 'hosts')!;
    expect(ssh).toBeTruthy();
    expect(ssh.kind === 'page' && ssh.more).toBe(true);
    expect(ssh.crumb).toBe('应用 › 手机与远程 › 更多选项');
    expect(ids(searchSettings('环境变量'))).toContain('page:env');
    expect(ids(searchSettings('更新'))).toContain('page:diagnostics');
  });

  it('what left is found where it went: MCP / 插件 / Skills as jumps to 自定义', () => {
    expect(ids(searchSettings('插件'))).toContain('away:plugins');
    expect(ids(searchSettings('mcp'))).toContain('away:mcp');
    expect(ids(searchSettings('skills'))).toContain('away:skills');
    const mcp = searchSettings('MCP 与插件').find((h) => h.kind === 'away')!;
    expect(mcp.kind === 'away' && [mcp.crumb, mcp.target]).toEqual(['自定义 › 连接器', { to: 'extensions', tab: 'connectors' }]);
    // 值班 Bot as a page is not listed (its rows are, live)
    expect(ids(searchSettings('值班')).includes('away:bots')).toBe(false);
  });

  it('every entry, page and part is findable by its own name; several words must all match', () => {
    for (const { entry } of allEntries()) expect(ids(searchSettings(entry.label)), entry.label).toContain(`entry:${entry.id}`);
    for (const e of BOT_ENTRIES) expect(ids(searchSettings(e.label)), e.label).toContain(`away-entry:${e.id}`);
    for (const s of SETTINGS_SECTIONS) expect(searchSettings(s.l).some((h) => sectionOf(h) === s.id), s.l).toBe(true);
    for (const { body, section } of allBodies()) expect(searchSettings(BODY_INFO[body].l).some((h) => sectionOf(h) === section.id), body).toBe(true);
    for (const [id, a] of Object.entries(AWAY_SECTIONS)) if (!a.hidden) expect(ids(searchSettings(a.l)), a.l).toContain(`away:${id}`);
    expect(searchSettings('托盘 关闭').some((h) => h.kind === 'entry' && h.entry.id === 'ui.closeToTray')).toBe(true);
    expect(searchSettings('托盘 不存在的词')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  // final review M3: the Claude account's 200K / 1M and 自动压缩 (A7) sit in 登录状态's card and in each provider's edit page
  it('the context window and 自动压缩 controls are found from 账号与登录 and 模型 › 来源', () => {
    const where = (body: BodyId) => allBodies().find((b) => b.body === body)!.section.id;
    for (const body of ['account', 'providers'] as const) {
      for (const q of ['上下文窗口', '自动压缩', '压缩', '1M', '200K', 'context window', 'auto-compact']) {
        expect(searchSettings(q).some((h) => sectionOf(h) === where(body)), `${body}: ${q}`).toBe(true);
      }
    }
  });

  it('a part that is in view once its page / tab opens is not listed twice', () => {
    // 网关 matches the 路由 tab and the gateway part inside it: one hit for that tab, none for the part
    const hits = ids(searchSettings('网关'));
    expect(hits.filter((h) => h.startsWith('page:model/routing'))).toEqual(['page:model/routing']);
    // only the part matches: the part itself
    expect(ids(searchSettings('failover')).filter((h) => h.startsWith('page:model'))).toEqual(['page:model/routing#gateway']);
  });
});

describe('navStatus', () => {
  it('shows only what is known', () => {
    expect(navStatus({})).toEqual({});
    expect(navStatus({ loggedIn: true })).toEqual({ account: '已登录' });
    expect(navStatus({ loggedIn: false })).toEqual({ account: '未登录' });
  });
});
