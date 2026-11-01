import { describe, expect, it } from 'vitest';
import type { Provider } from '@shared';
import { buildModelMenu, chipLabel, compatibleTypes, filterMenu, modelKey, modelTable, profileModels, profileUnavailable, pushRecent, recentKey, usableProfile } from './menu';

const prov = (id: string, o: Partial<Provider> = {}): Provider => ({ id, name: id, type: 'anthropic', baseUrl: 'https://x', apiKey: '…', createdAt: 0, ...o });
const PROVIDERS: Provider[] = [
  prov('gkey', { models: ['gpt-6-astra', 'gpt-5.6-sol'], modelsAt: 1000 }),
  prov('snbchr', { models: ['claude-opus-5', 'claude-sonnet-5'], defaultModel: 'claude-sonnet-5' }),
  prov('xai', { models: [], defaultModel: 'grok-5' }),
  prov('empty', { modelsError: 'HTTP 401 invalid key' }),
];
const menu = (o: Partial<Parameters<typeof buildModelMenu>[0]> = {}) => buildModelMenu({ agent: 'claude', providers: PROVIDERS, settings: {}, ...o });
const sectionIds = (m: ReturnType<typeof menu>) => m.sections.map((s) => s.id);

describe('compatibility by agent', () => {
  it('claude: its login models + Anthropic-format and Claude-account profiles', () => {
    expect(compatibleTypes('claude').sort()).toEqual(['anthropic', 'claude-account']);
    expect(sectionIds(menu())).toEqual(['builtin', 'gkey', 'snbchr', 'xai', 'empty']);
  });
  it('claude.ai: no profiles at all', () => {
    const m = menu({ agent: 'claudeai' });
    expect(sectionIds(m)).toEqual(['builtin']);
    expect(m.items.find((i) => i.providerId === 'snbchr')?.compatible).toBe(false);
    expect(profileUnavailable(PROVIDERS[0], { agent: 'claudeai' })).toBeTruthy();
    expect(profileUnavailable(PROVIDERS[0], { agent: 'claude' })).toBeNull();
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
  it('keys: official Claude = bare model id (ui.disabledModels back-compat), profiles `<id>:<model>`', () => {
    expect(modelKey('claude', 'claude', 'claude-opus-5')).toBe('claude-opus-5');
    expect(modelKey('claudeai', 'claude', 'claude-opus-5')).toBe('claude-opus-5');
    expect(modelKey('claude', 'gkey', 'gpt-6')).toBe('gkey:gpt-6');
  });
  it('a provider whose model list names its models shows the name (official DeepSeek: deepseek-flash is 「DeepSeek-V4.1-Flash」), the id as the hint', () => {
    const ds = prov('ds', { name: 'DeepSeek', models: ['deepseek-flash', 'deepseek-v4-pro'], modelNames: { 'deepseek-flash': 'DeepSeek-V4.1-Flash' }, defaultModel: 'deepseek-flash' });
    const m = menu({ providers: [ds] });
    const flash = m.items.find((i) => i.providerId === 'ds' && i.model === 'deepseek-flash')!;
    expect(flash).toMatchObject({ display: 'DeepSeek-V4.1-Flash', label: 'DeepSeek / DeepSeek-V4.1-Flash', hint: 'deepseek-flash' });
    const pro = m.items.find((i) => i.providerId === 'ds' && i.model === 'deepseek-v4-pro')!;
    expect(pro.display).toBe('deepseek-v4-pro');
    expect(pro.hint).toBeUndefined();
    expect(filterMenu(m, 'v4.1').items.length).toBeGreaterThan(0);
    expect(filterMenu(m, 'v4.1').sections.flatMap((s) => s.items).map((i) => i.model)).toEqual(['deepseek-flash']);
    expect(chipLabel({ agent: 'claude', providers: [ds], providerId: 'ds', model: 'deepseek-flash' })).toBe('DeepSeek / DeepSeek-V4.1-Flash');
    expect(chipLabel({ agent: 'claude', providers: [ds], providerId: 'ds' })).toBe('DeepSeek / DeepSeek-V4.1-Flash'); // the default model, by name
  });
  it('the current selection is marked', () => {
    const m = menu({ current: { providerId: 'gkey', model: 'gpt-5.6-sol' } });
    expect(m.items.filter((i) => i.current).map((i) => i.key)).toEqual(['gkey:gpt-5.6-sol']);
    expect(menu({ current: {} }).items.filter((i) => i.current).map((i) => i.label)).toEqual(['默认模型']);
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
    const m = menu({ agent: 'claudeai', settings: { 'ui.favoriteModels': ['snbchr:claude-opus-5'] } });
    expect(sectionIds(m)).not.toContain('favorites');
  });
  it('recents: newest first, at most 5, unknown / incompatible ones dropped', () => {
    const recent = ['gkey:gpt-5.6-sol', 'claude:claude-opus-5', 'gone:model', 'snbchr:claude-opus-5', 'gkey:gpt-6-astra', 'claude:', 'claude:claude-sonnet-5'];
    const m = menu({ settings: { 'ui.recentModels': recent } });
    expect(m.sections[0].id).toBe('recent');
    expect(m.sections[0].items.map((i) => i.label)).toEqual(['gkey / gpt-5.6-sol', 'Opus 5', 'snbchr / claude-opus-5', 'gkey / gpt-6-astra', '默认模型']);
    // claude.ai takes no profiles: only its own default is left
    expect(menu({ agent: 'claudeai', settings: { 'ui.recentModels': recent } }).sections[0].items.map((i) => i.label)).toEqual(['默认模型']);
  });
  it('favorites come before recents', () => {
    expect(sectionIds(menu({ settings: { 'ui.favoriteModels': ['gkey:gpt-6-astra'], 'ui.recentModels': ['gkey:gpt-6-astra'] } })).slice(0, 2)).toEqual(['favorites', 'recent']);
  });
  it('pushRecent moves to the front, dedupes and caps', () => {
    expect(pushRecent(['a:1', 'b:2', 'c:3'], 'b:2')).toEqual(['b:2', 'a:1', 'c:3']);
    expect(pushRecent(['a:1', 'b:2', 'c:3', 'd:4', 'e:5'], 'f:6')).toEqual(['f:6', 'a:1', 'b:2', 'c:3', 'd:4']);
    expect(recentKey('claude', undefined, '')).toBe('claude:');
    expect(recentKey('claudeai', 'claude', 'claude-opus-5')).toBe('claude:claude-opus-5');
    expect(recentKey('claude', 'gkey', 'gpt-6')).toBe('gkey:gpt-6');
  });
});

describe('search and chip label', () => {
  it('filters by profile name or model name; empty sections disappear', () => {
    const m = filterMenu(menu(), 'astra');
    expect(m.sections.map((s) => s.id)).toEqual(['gkey']);
    expect(filterMenu(menu(), 'snb opus').sections.flatMap((s) => s.items.map((i) => i.label))).toEqual(['snbchr / claude-opus-5']);
    expect(filterMenu(menu(), 'fable').sections[0].items.map((i) => i.label)).toEqual(['Fable 5.1']);
  });
  it('chip label: profile / model, or the built-in display name', () => {
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'gkey', model: 'gpt-6-astra' })).toBe('gkey / gpt-6-astra');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'claude', model: 'claude-fable-5-1' })).toBe('Fable 5.1');
    // final review §9 #2: never 「默认模型」 on the chip — the model it stands for, by name
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, model: '' })).toBe('Claude');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, model: '', accountDefault: 'Sonnet 5' })).toBe('Sonnet 5');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, model: 'default', accountDefault: 'Opus 5' })).toBe('Opus 5');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'snbchr', model: '' })).toBe('snbchr / claude-sonnet-5');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'empty' })).toBe('empty');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'gone', providerName: '旧档案', model: 'm' })).toBe('旧档案 / m');
  });
});

describe('modelTable (settings, by model)', () => {
  it('each model once with every profile serving it; defaults marked; keys per profile', () => {
    const rows = modelTable(PROVIDERS);
    const astra = rows.find((r) => r.model === 'gpt-6-astra')!;
    expect(astra.providers.map((p) => p.id)).toEqual(['gkey']);
    expect(astra.keys).toEqual(['gkey:gpt-6-astra']);
    const opus = rows.find((r) => r.model === 'claude-opus-5')!;
    expect(opus.providers.map((p) => p.id)).toEqual(['claude', 'snbchr']);
    expect(opus.keys).toEqual(['claude-opus-5', 'snbchr:claude-opus-5']); // the Claude login keeps its bare key
    expect(rows.find((r) => r.model === 'claude-sonnet-5')!.providers.find((p) => p.id === 'snbchr')!.isDefault).toBe(true);
    expect(rows[0].providers.length).toBeGreaterThanOrEqual(rows[rows.length - 1].providers.length);
  });
  it('search matches model or profile name', () => {
    expect(modelTable(PROVIDERS, 'astra').map((r) => r.model)).toEqual(['gpt-6-astra']);
    expect(modelTable(PROVIDERS, 'xai').map((r) => r.model)).toEqual(['grok-5']);
  });
});

describe('usableProfile (welcome composer remembered profile)', () => {
  it('only a profile the agent takes', () => {
    expect(usableProfile(PROVIDERS, 'gkey', { agent: 'claude' })?.id).toBe('gkey');
    expect(usableProfile(PROVIDERS, 'gkey', { agent: 'claudeai' })).toBeUndefined();
    expect(usableProfile(PROVIDERS, 'claude', { agent: 'claude' })).toBeUndefined();
    expect(usableProfile(PROVIDERS, 'gone', { agent: 'claude' })).toBeUndefined();
  });
});

// A7: the Claude account's 200K / 1M per family (claude.contextWindows / a claude-account profile's contextWindows),
// a provider's window when it has one
describe('the window mark on a model row', () => {
  const win = (m: ReturnType<typeof menu>, providerId: string, model: string) => m.items.find((i) => i.providerId === providerId && i.model === model && !i.isDefault)?.window;
  it('the own Claude login: the family pick (1M by default), haiku 200K, the default entry none', () => {
    const m = menu();
    expect(win(m, 'claude', 'claude-opus-5-5')).toBe(1_000_000);
    expect(win(m, 'claude', 'claude-sonnet-5')).toBe(1_000_000);
    expect(win(m, 'claude', 'claude-fable-5-1')).toBe(1_000_000);
    expect(win(m, 'claude', 'claude-haiku-4-5')).toBe(200_000);
    expect(m.items.find((i) => i.providerId === 'claude' && i.isDefault)!.window).toBeUndefined();
    const picked = menu({ settings: { 'claude.contextWindows': { opus: 200_000, fable: 'x' } } });
    expect(win(picked, 'claude', 'claude-opus-5-5')).toBe(200_000);
    expect(win(picked, 'claude', 'claude-sonnet-5-5')).toBe(1_000_000);
    expect(win(picked, 'claude', 'claude-fable-5-1')).toBe(1_000_000); // not a pick: the default
    // the CLI's own list (aliases, a [1m] id): the same rule
    const cli = menu({ builtin: [{ value: 'default', displayName: 'Default' }, { value: 'opus', displayName: 'Opus' }, { value: 'sonnet[1m]', displayName: 'Sonnet (1M)' }, { value: 'haiku', displayName: 'Haiku' }], settings: { 'claude.contextWindows': { sonnet: 200_000 } } });
    expect([win(cli, 'claude', 'opus'), win(cli, 'claude', 'sonnet[1m]'), win(cli, 'claude', 'haiku')]).toEqual([1_000_000, 200_000, 200_000]);
  });
  it('a claude-account profile: its own picks, not the login\'s', () => {
    const acct = prov('acct', { type: 'claude-account', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'], contextWindows: { opus: 200_000 } });
    const m = menu({ providers: [...PROVIDERS, acct], settings: { 'claude.contextWindows': { sonnet: 200_000 } } });
    expect([win(m, 'acct', 'claude-opus-5-5'), win(m, 'acct', 'claude-sonnet-5-5'), win(m, 'acct', 'claude-haiku-4-5')]).toEqual([200_000, 1_000_000, 200_000]);
    expect(win(m, 'claude', 'claude-sonnet-5-5')).toBe(200_000);
  });
  it('a provider: its window for the model when it has one (set, listed, known by name)', () => {
    const set = prov('set', { models: ['gpt-6-astra', 'mystery-1'], contextWindows: { 'gpt-6-astra': 400_000 } });
    const m = menu({ providers: [...PROVIDERS, set] });
    expect(win(m, 'gkey', 'gpt-6-astra')).toBe(272_000);
    expect(win(m, 'snbchr', 'claude-opus-5')).toBe(1_000_000);
    expect(win(m, 'set', 'gpt-6-astra')).toBe(400_000);
    expect(win(m, 'set', 'mystery-1')).toBeUndefined();
    expect(m.items.find((i) => i.providerId === 'empty')!.window).toBeUndefined();
  });
});

describe('provider models that are not for chatting', () => {
  it('an image-only key lists no chat models; image models drop out of a mixed list', () => {
    expect(profileModels(prov('img', { models: ['gpt-image-2', 'gpt-image-2.5-flare'] }))).toEqual([]);
    expect(profileModels(prov('mix', { models: ['dall-e-3', 'gpt-5.6-sol', 'text-embedding-3-large'] }))).toEqual(['gpt-5.6-sol']);
  });
});
