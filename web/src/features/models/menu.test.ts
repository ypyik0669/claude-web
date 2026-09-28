import { describe, expect, it } from 'vitest';
import type { GatewayGroup, Provider } from '@shared';
import { buildModelMenu, chipLabel, compatibleTypes, filterMenu, gatewayModels, modelKey, modelTable, pushRecent, recentKey } from './menu';

const prov = (id: string, o: Partial<Provider> = {}): Provider => ({ id, name: id, type: 'anthropic', baseUrl: 'https://x', apiKey: '…', createdAt: 0, ...o });
const PROVIDERS: Provider[] = [
  prov('gkey', { type: 'openai', models: ['gpt-6-astra', 'gpt-5.6-sol'], modelsAt: 1000 }),
  prov('snbchr', { type: 'anthropic', models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-sonnet-5' }),
  prov('gem', { type: 'gemini', models: ['gemini-3-pro'] }),
  prov('xai', { type: 'grok', models: [] , defaultModel: 'grok-5' }),
  prov('empty', { type: 'anthropic', modelsError: 'HTTP 401 invalid key' }),
  prov('gw', { type: 'gateway', gatewayGroupId: 'g1', defaultModel: 'router-default' }),
];
const GROUPS: GatewayGroup[] = [
  { id: 'g1', name: 'main', strategy: 'failover', members: [{ providerId: 'gkey' }, { providerId: 'snbchr', model: 'pinned-x' }], modelMap: { 'claude-*': 'gpt-6-astra', 'alias-a': 'claude-opus-5' } },
];
const menu = (o: Partial<Parameters<typeof buildModelMenu>[0]> = {}) => buildModelMenu({ agent: 'claude', providers: PROVIDERS, gatewayGroups: GROUPS, settings: {}, ...o });
const sectionIds = (m: ReturnType<typeof menu>) => m.sections.map((s) => s.id);

describe('compatibility by agent', () => {
  it('claude: its login models + every profile type', () => {
    expect(compatibleTypes('claude').sort()).toEqual(['anthropic', 'gateway', 'gemini', 'grok', 'openai']);
    expect(sectionIds(menu())).toEqual(['builtin', 'gkey', 'snbchr', 'gem', 'xai', 'empty', 'gw']);
  });
  it('codex: its own models + openai / gateway profiles only', () => {
    const m = menu({ agent: 'codex' });
    expect(sectionIds(m)).toEqual(['builtin', 'gkey', 'gw']);
    expect(m.items.find((i) => i.providerId === 'snbchr')?.compatible).toBe(false);
  });
  it('gemini: gateway / gemini profiles', () => expect(sectionIds(menu({ agent: 'gemini' }))).toEqual(['builtin', 'gem', 'gw']));
  it('other ACP agents (qwen, custom): openai / gateway', () => {
    expect(sectionIds(menu({ agent: 'qwen' }))).toEqual(['builtin', 'gkey', 'gw']);
    expect(sectionIds(menu({ agent: 'acp:mine' }))).toEqual(['builtin', 'gkey', 'gw']);
  });
});

describe('items and labels', () => {
  it('label is `<profile> / <model>`; the official login shows the catalog display name without a prefix', () => {
    const m = menu();
    const b = m.sections[0];
    expect(b.title).toBe('Claude 账号');
    expect(b.items[0]).toMatchObject({ providerId: 'claude', model: '', label: '默认模型', isDefault: true });
    expect(b.items.find((i) => i.model === 'claude-fable-5-1')?.label).toBe('Fable 5.1');
    expect(m.items.find((i) => i.providerId === 'gkey' && i.model === 'gpt-6-astra')?.label).toBe('gkey / gpt-6-astra');
  });
  it('a profile without a model list still gets a selectable default entry; defaultModel is listed', () => {
    const m = menu();
    expect(m.sections.find((s) => s.id === 'empty')).toMatchObject({ error: 'HTTP 401 invalid key', count: 0 });
    expect(m.sections.find((s) => s.id === 'empty')!.items).toEqual([expect.objectContaining({ model: '', label: 'empty / 默认模型', isDefault: true })]);
    expect(m.sections.find((s) => s.id === 'xai')!.items.map((i) => i.model)).toEqual(['grok-5']);
    expect(m.items.find((i) => i.providerId === 'snbchr' && i.model === 'claude-sonnet-5')?.profileDefault).toBe(true);
  });
  it('keys: official Claude = bare model id (ui.disabledModels back-compat), other agents `<agent>:<model>`, profiles `<id>:<model>`', () => {
    expect(modelKey('claude', 'claude', 'claude-opus-5')).toBe('claude-opus-5');
    expect(modelKey('codex', 'claude', 'gpt-6')).toBe('codex:gpt-6');
    expect(modelKey('codex', 'gkey', 'gpt-6')).toBe('gkey:gpt-6');
  });
  it('the current selection is marked', () => {
    const m = menu({ current: { providerId: 'gkey', model: 'gpt-5.6-sol' } });
    expect(m.items.filter((i) => i.current).map((i) => i.key)).toEqual(['gkey:gpt-5.6-sol']);
    expect(menu({ current: {} }).items.filter((i) => i.current).map((i) => i.label)).toEqual(['默认模型']);
  });
});

describe('gateway models', () => {
  it('union of member models + pinned models + defaults + non-wildcard modelMap keys (serveModels parity)', () => {
    expect(gatewayModels(PROVIDERS[5], GROUPS, PROVIDERS)).toEqual(['alias-a', 'claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol', 'gpt-6-astra', 'pinned-x', 'router-default']);
  });
  it('a gateway profile whose group is gone offers only its default', () => {
    expect(gatewayModels(prov('gw2', { type: 'gateway', gatewayGroupId: 'nope' }), GROUPS, PROVIDERS)).toEqual([]);
  });
});

describe('hidden, favorites, recents', () => {
  it('ui.disabledModels hides entries (legacy bare keys for Claude too)', () => {
    const m = menu({ settings: { 'ui.disabledModels': ['gkey:gpt-6-astra', 'claude-opus-5'] } });
    expect(m.sections.flatMap((s) => s.items).some((i) => i.key === 'gkey:gpt-6-astra')).toBe(false);
    expect(m.items.find((i) => i.key === 'gkey:gpt-6-astra')).toBeTruthy(); // built, just not shown
    expect(m.sections[0].items.some((i) => i.model === 'claude-opus-5')).toBe(false);
    expect(m.sections.find((s) => s.id === 'gkey')?.count).toBe(1);
  });
  it('favorites are pinned in their own section first (and stay in their profile section)', () => {
    const m = menu({ settings: { 'ui.favoriteModels': ['snbchr:claude-opus-5', 'gkey:gpt-6-astra'] } });
    expect(m.sections[0].id).toBe('favorites');
    expect(m.sections[0].items.map((i) => i.label)).toEqual(['gkey / gpt-6-astra', 'snbchr / claude-opus-5']);
    expect(m.sections.find((s) => s.id === 'snbchr')!.items.find((i) => i.model === 'claude-opus-5')!.favorite).toBe(true);
  });
  it('a favorite that is hidden or incompatible is not shown', () => {
    const m = menu({ agent: 'codex', settings: { 'ui.favoriteModels': ['snbchr:claude-opus-5'] } });
    expect(sectionIds(m)).not.toContain('favorites');
  });
  it('recents: newest first, at most 5, unknown / incompatible ones dropped', () => {
    const recent = ['gkey:gpt-5.6-sol', 'claude:claude-opus-5', 'gone:model', 'snbchr:claude-opus-5', 'gkey:gpt-6-astra', 'claude:', 'gem:gemini-3-pro', 'claude:claude-sonnet-5'];
    const m = menu({ settings: { 'ui.recentModels': recent } });
    expect(m.sections[0].id).toBe('recent');
    expect(m.sections[0].items.map((i) => i.label)).toEqual(['gkey / gpt-5.6-sol', 'Opus 5', 'snbchr / claude-opus-5', 'gkey / gpt-6-astra', '默认模型']);
    const codex = menu({ agent: 'codex', settings: { 'ui.recentModels': recent } });
    expect(codex.sections[0].items.map((i) => i.key)).toEqual(['gkey:gpt-5.6-sol', 'gkey:gpt-6-astra']); // 'claude:' is Claude's default, not Codex's
    expect(menu({ agent: 'codex', settings: { 'ui.recentModels': ['@codex:'] } }).sections[0].items.map((i) => i.label)).toEqual(['默认模型']);
  });
  it('favorites come before recents', () => {
    expect(sectionIds(menu({ settings: { 'ui.favoriteModels': ['gkey:gpt-6-astra'], 'ui.recentModels': ['gkey:gpt-6-astra'] } })).slice(0, 2)).toEqual(['favorites', 'recent']);
  });
  it('pushRecent moves to the front, dedupes and caps', () => {
    expect(pushRecent(['a:1', 'b:2', 'c:3'], 'b:2')).toEqual(['b:2', 'a:1', 'c:3']);
    expect(pushRecent(['a:1', 'b:2', 'c:3', 'd:4', 'e:5'], 'f:6')).toEqual(['f:6', 'a:1', 'b:2', 'c:3', 'd:4']);
    expect(recentKey('claude', undefined, '')).toBe('claude:');
    expect(recentKey('codex', 'claude', 'gpt-6')).toBe('@codex:gpt-6');
    expect(recentKey('codex', 'gkey', 'gpt-6')).toBe('gkey:gpt-6');
  });
});

describe('search and chip label', () => {
  it('filters by profile name or model name; empty sections disappear', () => {
    const m = filterMenu(menu(), 'astra');
    expect(m.sections.map((s) => s.id)).toEqual(['gkey', 'gw']);
    expect(filterMenu(menu(), 'snb opus').sections.flatMap((s) => s.items.map((i) => i.label))).toEqual(['snbchr / claude-opus-5']);
    expect(filterMenu(menu(), 'fable').sections[0].items.map((i) => i.label)).toEqual(['Fable 5.1']);
  });
  it('chip label: profile / model, or the built-in display name', () => {
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'gkey', model: 'gpt-6-astra' })).toBe('gkey / gpt-6-astra');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'claude', model: 'claude-fable-5-1' })).toBe('Fable 5.1');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, model: '' })).toBe('默认模型');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'snbchr', model: '' })).toBe('snbchr / claude-sonnet-5');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'empty' })).toBe('empty / 默认模型');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'gone', providerName: '旧档案', model: 'm' })).toBe('旧档案 / m');
  });
});

describe('modelTable (settings, by model)', () => {
  it('each model once with every profile serving it; defaults marked; keys per profile', () => {
    const rows = modelTable(PROVIDERS, GROUPS);
    const astra = rows.find((r) => r.model === 'gpt-6-astra')!;
    expect(astra.providers.map((p) => p.id)).toEqual(['gkey', 'gw']);
    expect(astra.keys).toEqual(['gkey:gpt-6-astra', 'gw:gpt-6-astra']);
    const opus = rows.find((r) => r.model === 'claude-opus-5')!;
    expect(opus.providers.map((p) => p.id)).toEqual(['claude', 'snbchr', 'gw']);
    expect(opus.keys[0]).toBe('claude-opus-5'); // the Claude login keeps its bare key
    expect(rows.find((r) => r.model === 'claude-sonnet-5')!.providers.find((p) => p.id === 'snbchr')!.isDefault).toBe(true);
    expect(rows[0].providers.length).toBeGreaterThanOrEqual(rows[rows.length - 1].providers.length);
  });
  it('search matches model or profile name', () => {
    expect(modelTable(PROVIDERS, GROUPS, 'gem').map((r) => r.model)).toEqual(['gemini-3-pro']);
    expect(modelTable(PROVIDERS, GROUPS, 'xai').map((r) => r.model)).toEqual(['grok-5']);
  });
});
