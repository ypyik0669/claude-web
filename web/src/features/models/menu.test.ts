import { describe, expect, it } from 'vitest';
import type { GatewayGroup, Provider } from '@shared';
import { agentModels, buildModelMenu, chipLabel, compatibleTypes, filterMenu, gatewayModelHint, gatewayModels, modelKey, modelTable, pushRecent, recentKey, usableProfile, type AgentSource } from './menu';

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
/** the sections this agent can pick from (the others are listed after them, greyed, with why) */
const sectionIds = (m: ReturnType<typeof menu>) => m.sections.filter((s) => !(s.kind === 'provider' && s.items.every((i) => !i.compatible))).map((s) => s.id);
const greyIds = (m: ReturnType<typeof menu>) => m.sections.filter((s) => s.kind === 'provider' && s.items.every((i) => !i.compatible)).map((s) => s.id);

describe('compatibility by agent', () => {
  it('claude: its login models + every profile type', () => {
    expect(compatibleTypes('claude').sort()).toEqual(['anthropic', 'claude-account', 'gateway', 'gemini', 'grok', 'openai']);
    expect(sectionIds(menu())).toEqual(['builtin', 'gkey', 'snbchr', 'gem', 'xai', 'empty', 'gw']);
  });
  it('codex: its own models + openai / gateway profiles only', () => {
    const m = menu({ agent: 'codex' });
    expect(sectionIds(m)).toEqual(['builtin', 'gkey', 'gw']);
    expect(m.items.find((i) => i.providerId === 'snbchr')?.compatible).toBe(false);
  });
  it('gemini: gateway / gemini profiles', () => expect(sectionIds(menu({ agent: 'gemini' }))).toEqual(['builtin', 'gem', 'gw']));
  it("a source the agent can't use is listed after the usable ones, greyed, saying why (user report 2026-11-03: an Anthropic relay looked lost in a Codex menu)", () => {
    const m = menu({ agent: 'codex' });
    const ids = m.sections.map((s) => s.id);
    const grey = greyIds(m);
    expect(grey.length).toBeGreaterThan(0);
    expect(Math.min(...grey.map((g) => ids.indexOf(g)))).toBeGreaterThan(ids.indexOf('gw'));
    for (const g of grey) {
      const s = m.sections.find((x) => x.id === g)!;
      expect(s.unavailable).toMatch(/Codex 只能用 OpenAI 兼容的来源/);
      expect(s.items.every((i) => i.unavailable)).toBe(true);
    }
    expect(greyIds(menu({ agent: 'claude' }))).toEqual([]);
  });
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
  it('a provider whose model list names its models shows the name (official DeepSeek: deepseek-flash is 「DeepSeek-V4.1-Flash」), the id as the hint', () => {
    const ds = prov('ds', { name: 'DeepSeek', type: 'openai', models: ['deepseek-flash', 'deepseek-v4-pro'], modelNames: { 'deepseek-flash': 'DeepSeek-V4.1-Flash' }, defaultModel: 'deepseek-flash' });
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

describe('gateway models', () => {
  it('union of member models + pinned models + defaults + non-wildcard modelMap keys (serveModels parity)', () => {
    expect(gatewayModels(PROVIDERS[5], GROUPS, PROVIDERS)).toEqual(['alias-a', 'claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol', 'gpt-6-astra', 'pinned-x', 'router-default']);
  });
  it('a gateway profile whose group is gone offers only its default', () => {
    expect(gatewayModels(prov('gw2', { type: 'gateway', gatewayGroupId: 'nope' }), GROUPS, PROVIDERS)).toEqual([]);
  });
  it('a sidecar pool member brings its family models (gateway.status().poolModels)', () => {
    const groups: GatewayGroup[] = [{ id: 'gp', name: 'pool', strategy: 'failover', members: [{ upstreamGroupId: 'u1' }] }];
    const gw = prov('gwp', { type: 'gateway', gatewayGroupId: 'gp' });
    const poolModels = { 'u:u1': ['gemini-3.6-flash', 'gemini-3.1-pro'] };
    expect(gatewayModels(gw, groups, PROVIDERS, poolModels)).toEqual(['gemini-3.1-pro', 'gemini-3.6-flash']);
    const m = menu({ providers: [gw], gatewayGroups: groups, gatewayPoolModels: poolModels });
    expect(m.items.filter((i) => i.providerId === 'gwp').map((i) => i.model)).toEqual(['gemini-3.1-pro', 'gemini-3.6-flash']);
  });
  it('a gateway model carries a one-line hint (speed / purpose), and only for gateway profiles', () => {
    const groups: GatewayGroup[] = [{ id: 'gp', name: 'pool', strategy: 'failover', members: [{ upstreamGroupId: 'u1' }] }];
    const gw = prov('gwp', { type: 'gateway', gatewayGroupId: 'gp' });
    const poolModels = { 'u:u1': ['gemini-3.6-flash', 'gemini-4-argon-thinking', 'gemini-3.5-flash-lite'] };
    const m = menu({ providers: [gw], gatewayGroups: groups, gatewayPoolModels: poolModels });
    const hint = (model: string) => m.items.find((i) => i.providerId === 'gwp' && i.model === model)?.hint;
    expect(hint('gemini-3.6-flash')).toBe('快 · 写代码推荐');
    expect(hint('gemini-4-argon-thinking')).toBe('思考 20–40 秒');
    expect(hint('gemini-3.5-flash-lite')).toBe('最快');
    expect(gatewayModelHint('gemini-image')).toBe('图像生成');
    expect(gatewayModelHint('some-unknown-model')).toBeUndefined();
    // a normal profile's hint stays the raw id (the modelNames mapping) — not the gateway wording
    const ds = prov('ds', { type: 'openai', models: ['deepseek-flash'], modelNames: { 'deepseek-flash': 'DeepSeek-V4.1-Flash' } });
    expect(menu({ providers: [ds] }).items.find((i) => i.providerId === 'ds')?.hint).toBe('deepseek-flash');
  });

  it('a single sidecar account member brings them too (a:`<id>` key)', () => {
    const groups: GatewayGroup[] = [{ id: 'ga', name: 'acct', strategy: 'failover', members: [{ accountId: 'acct_1' }] }];
    const gw = prov('gwa', { type: 'gateway', gatewayGroupId: 'ga' });
    const poolModels = { 'a:acct_1': ['gemini-3.6-flash'] };
    expect(gatewayModels(gw, groups, PROVIDERS, poolModels)).toEqual(['gemini-3.6-flash']);
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
    // final review §9 #2: never 「默认模型」 on the chip — the model it stands for, by name
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, model: '' })).toBe('Claude');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, model: '', accountDefault: 'Sonnet 5' })).toBe('Sonnet 5');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, model: 'default', accountDefault: 'Opus 5' })).toBe('Opus 5');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, model: '', agentDefault: 'claude-haiku-4-5', accountDefault: 'Opus 5' })).toBe('Haiku 4.5');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'snbchr', model: '' })).toBe('snbchr / claude-sonnet-5');
    expect(chipLabel({ agent: 'claude', providers: PROVIDERS, providerId: 'empty' })).toBe('empty');
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

describe('unavailable profiles (engine / gateway)', () => {
  const ccb = { runtime: 'ccb' as const };
  const official = { runtime: 'claude' as const }; // ccb missing (silent fallback) or forced by env
  it('on the official Claude Code engine, openai / gemini / grok profiles are shown but disabled with the reason', () => {
    const m = menu({ engine: official });
    const gkey = m.sections.find((s) => s.id === 'gkey')!;
    expect(gkey.unavailable).toMatch(/官方/);
    expect(gkey.items.every((i) => i.unavailable)).toBe(true);
    expect(m.sections.find((s) => s.id === 'snbchr')!.unavailable).toBeUndefined();
    expect(m.sections.find((s) => s.id === 'gw')!.unavailable).toBeUndefined();
  });
  it('a pin to the official binary on an OpenAI-format profile is ignored: it runs on ccb (user report: every GPT model greyed out)', () => {
    // how it happens: the probe pins an Anthropic-format relay (super-nb) to the official binary, then its format is
    // changed to OpenAI for the GPT models — the pin stayed and nothing of it could be picked
    const provs = [...PROVIDERS, prov('forced', { type: 'openai', runtime: 'claude', models: ['gpt-5.5'] }), prov('forcedA', { type: 'anthropic', runtime: 'claude', models: ['y'] })];
    const m = buildModelMenu({ agent: 'claude', providers: provs, gatewayGroups: GROUPS, settings: {}, engine: ccb });
    expect(m.sections.find((s) => s.id === 'forced')!.unavailable).toBeUndefined();
    expect(m.sections.find((s) => s.id === 'forced')!.items.every((i) => !i.unavailable)).toBe(true);
    expect(m.sections.find((s) => s.id === 'forcedA')!.unavailable).toBeUndefined();
    // the official binary as the engine with ccb installed as the fallback: still ccb for it
    expect(buildModelMenu({ agent: 'claude', providers: provs, settings: {}, engine: { runtime: 'claude', fallback: { runtime: 'ccb' } } }).sections.find((s) => s.id === 'forced')!.unavailable).toBeUndefined();
    // no ccb at all: then it really cannot run, and says why
    expect(buildModelMenu({ agent: 'claude', providers: provs, settings: {}, engine: official }).sections.find((s) => s.id === 'forced')!.unavailable).toMatch(/官方/);
  });
  it('asking for ccb helps only when ccb is installed', () => {
    const provs = [prov('wantccb', { type: 'openai', runtime: 'ccb', models: ['x'] })];
    expect(buildModelMenu({ agent: 'claude', providers: provs, settings: {}, engine: { runtime: 'claude', fallback: { runtime: 'ccb' } } }).sections[1].unavailable).toBeUndefined();
    expect(buildModelMenu({ agent: 'claude', providers: provs, settings: {}, engine: { runtime: 'claude' } }).sections[1].unavailable).toMatch(/官方/);
  });
  it('the engine does not matter for other agents', () => {
    expect(menu({ agent: 'codex', engine: official }).sections.find((s) => s.id === 'gkey')!.unavailable).toBeUndefined();
  });
  it('gateway profile: gateway off / group missing → disabled with the reason; unknown status → not judged', () => {
    expect(menu({ gatewayEnabled: false }).sections.find((s) => s.id === 'gw')!.unavailable).toMatch(/未启用/);
    const orphan = [...PROVIDERS, prov('gw2', { type: 'gateway', gatewayGroupId: 'nope' })];
    expect(buildModelMenu({ agent: 'claude', providers: orphan, gatewayGroups: GROUPS, gatewayEnabled: true, settings: {} }).sections.find((s) => s.id === 'gw2')!.unavailable).toMatch(/组不存在/);
    expect(menu({}).sections.find((s) => s.id === 'gw')!.unavailable).toBeUndefined();
  });
  it('unavailable entries never appear in favourites or recents', () => {
    const m = menu({ engine: official, settings: { 'ui.favoriteModels': ['gkey:gpt-6-astra'], 'ui.recentModels': ['gkey:gpt-5.6-sol'] } });
    expect(sectionIds(m)).not.toContain('favorites');
    expect(sectionIds(m)).not.toContain('recent');
  });
});

describe('usableProfile (welcome composer remembered profile)', () => {
  it('only a profile the agent takes and that is available now', () => {
    expect(usableProfile(PROVIDERS, 'gkey', { agent: 'claude' })?.id).toBe('gkey');
    expect(usableProfile(PROVIDERS, 'gkey', { agent: 'claude', engine: { runtime: 'claude' } })).toBeUndefined();
    expect(usableProfile(PROVIDERS, 'snbchr', { agent: 'codex' })).toBeUndefined();
    expect(usableProfile(PROVIDERS, 'gw', { agent: 'codex', gatewayEnabled: false })).toBeUndefined();
    expect(usableProfile(PROVIDERS, 'gw', { agent: 'codex', gatewayEnabled: true, gatewayGroups: GROUPS })?.id).toBe('gw');
    expect(usableProfile(PROVIDERS, 'claude', { agent: 'claude' })).toBeUndefined();
    expect(usableProfile(PROVIDERS, 'gone', { agent: 'claude' })).toBeUndefined();
  });
});

describe('other agents as sources in the same flat list (the old agent picker, spec §5.5 / 定案 1)', () => {
  const AGENTS: AgentSource[] = [
    { kind: 'codex', name: 'Codex', installed: true },
    { kind: 'gemini', name: 'Gemini CLI', installed: false },
    { kind: 'opencode', name: 'OpenCode', installed: true, models: ['anthropic/claude-x'], defaultModel: 'anthropic/claude-x' },
  ];
  const withAgents = (o: Partial<Parameters<typeof buildModelMenu>[0]> = {}) => menu({ otherAgents: AGENTS, ...o });

  it('each other agent is one more section after the profiles, flat (default + its models), no sub-menu', () => {
    const m = withAgents();
    expect(sectionIds(m)).toEqual(['builtin', 'gkey', 'snbchr', 'gem', 'xai', 'empty', 'gw', 'agent:codex', 'agent:gemini', 'agent:opencode']);
    const codex = m.sections.find((s) => s.id === 'agent:codex')!;
    expect(codex).toMatchObject({ kind: 'agent', title: 'Codex', agent: 'codex' });
    expect(codex.items[0]).toMatchObject({ agent: 'codex', providerId: 'claude', model: '', isDefault: true, label: 'Codex · 默认模型' });
    expect(codex.items.find((i) => i.model === 'gpt-5.6-sol')).toMatchObject({ label: 'Codex · 5.6 Sol', key: 'codex:gpt-5.6-sol', current: false });
  });
  it('what Codex said this account offers (model/list) replaces the built-in list (忍冬: 「都到 6 了」)', () => {
    const reportedModels = [{ value: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.' }, { value: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra' }];
    const cx = menu({ otherAgents: [{ kind: 'codex', name: 'Codex', installed: true, reportedModels }] }).sections.find((s) => s.id === 'agent:codex')!;
    expect(cx.items.map((i) => i.model)).toEqual(['', 'gpt-6-luna', 'gpt-5.6-terra']);
    expect(cx.items[1]).toMatchObject({ label: 'Codex · GPT-6-Luna', key: 'codex:gpt-6-luna' });
    expect(agentModels({ kind: 'codex', reportedModels })).toEqual(reportedModels);
    // nothing reported yet: the built-in list
    expect(agentModels({ kind: 'codex' }).map((m) => m.value)).toContain('gpt-5.6-sol');
  });
  it('an agent without a catalog lists the models it reported; its configured default is named', () => {
    const oc = withAgents().sections.find((s) => s.id === 'agent:opencode')!;
    expect(oc.items.map((i) => i.model)).toEqual(['', 'anthropic/claude-x']);
    expect(oc.items[0].display).toBe('默认（anthropic/claude-x）');
  });
  it('not installed: shown greyed with the reason, not pickable', () => {
    const g = withAgents().sections.find((s) => s.id === 'agent:gemini')!;
    expect(g.unavailable).toMatch(/未安装/);
    expect(g.items.every((i) => i.unavailable)).toBe(true);
  });
  it('the current agent is never listed as "other"; Claude is one when another agent is current', () => {
    const m = menu({ agent: 'codex', otherAgents: [{ kind: 'claude', name: 'Claude Code', installed: true }, { kind: 'codex', name: 'Codex', installed: true }] });
    expect(sectionIds(m)).toEqual(['builtin', 'gkey', 'gw', 'agent:claude']);
    expect(m.sections.at(-1)!.items.find((i) => i.model === 'claude-opus-5')).toMatchObject({ agent: 'claude', key: 'claude-opus-5', label: 'Claude Code · Opus 5' });
  });
  it('other agents stay out of favourites / recents (picking them in a session is a hand-over)', () => {
    const m = withAgents({ settings: { 'ui.favoriteModels': ['codex:gpt-5.6-sol'], 'ui.recentModels': ['@codex:gpt-5.6-sol'] } });
    expect(sectionIds(m)).not.toContain('favorites');
    expect(sectionIds(m)).not.toContain('recent');
  });
  it("ui.disabledModels hides another agent's model by its `<agent>:<model>` key", () => {
    const m = withAgents({ settings: { 'ui.disabledModels': ['codex:gpt-5.6-luna'] } });
    expect(m.sections.find((s) => s.id === 'agent:codex')!.items.some((i) => i.model === 'gpt-5.6-luna')).toBe(false);
  });
  it('search finds an agent by name', () => {
    expect(filterMenu(withAgents(), 'codex sol').sections.map((s) => s.id)).toEqual(['agent:codex']);
  });
  it('an agent set to run on a provider (settings → Agents 「新对话用」): its section lists that provider\'s models, picked on it', () => {
    const m = menu({ otherAgents: [{ kind: 'codex', name: 'Codex', installed: true, provider: { id: 'relay', name: '我的中转', models: ['deepseek-chat', 'gpt-5.2'], defaultModel: 'gpt-5.2' } }] });
    const cx = m.sections.find((s) => s.id === 'agent:codex')!;
    expect(cx.title).toBe('Codex · 我的中转');
    expect(cx.items.map((i) => i.model)).toEqual(['', 'gpt-5.2', 'deepseek-chat']);
    expect(cx.items[0]).toMatchObject({ providerId: 'relay', agent: 'codex', display: '默认（gpt-5.2）' });
    expect(cx.items[1]).toMatchObject({ providerId: 'relay', key: 'relay:gpt-5.2' });
    expect(cx.items.some((i) => i.model === 'gpt-5.6-sol')).toBe(false); // not the ChatGPT account's models
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
    const set = prov('set', { type: 'openai', models: ['gpt-6-astra', 'mystery-1'], contextWindows: { 'gpt-6-astra': 400_000 } });
    const m = menu({ providers: [...PROVIDERS, set] });
    expect(win(m, 'gkey', 'gpt-6-astra')).toBe(272_000);
    expect(win(m, 'snbchr', 'claude-opus-5')).toBe(1_000_000);
    expect(win(m, 'set', 'gpt-6-astra')).toBe(400_000);
    expect(win(m, 'set', 'mystery-1')).toBeUndefined();
    expect(m.items.find((i) => i.providerId === 'empty')!.window).toBeUndefined();
  });
  it('another agent\'s own login: no mark', () => {
    const m = menu({ agent: 'codex' });
    expect(m.items.filter((i) => i.providerId === 'claude').every((i) => i.window === undefined)).toBe(true);
    const withCodex = menu({ otherAgents: [{ kind: 'codex', name: 'Codex', installed: true, models: ['gpt-6-luna'] }] });
    expect(withCodex.items.filter((i) => i.agent).every((i) => i.window === undefined)).toBe(true);
  });
});

describe('provider models that are not for chatting, and the effort that never leaves', () => {
  it('an image-only key lists no chat models; image models drop out of a mixed list', async () => {
    const { profileModels } = await import('./menu');
    expect(profileModels(prov('img', { type: 'openai', models: ['gpt-image-2', 'gpt-image-2.5-flare'] }), [], [])).toEqual([]);
    expect(profileModels(prov('mix', { type: 'openai', models: ['dall-e-3', 'gpt-5.6-sol', 'text-embedding-3-large'] }), [], [])).toEqual(['gpt-5.6-sol']);
  });
  it('智能程度 on every provider format now (our engine sends it natively or through the prompt); the old no-control rule is gone', async () => {
    const m = await import('./menu');
    expect('effortStaysHome' in m).toBe(false);
    const { claudeEffortView } = await import('./intelligence');
    for (const id of ['gkey', 'gem', 'xai', 'snbchr', 'gw']) {
      expect(claudeEffortView({ agent: 'claude', providers: PROVIDERS, providerId: id, model: 'some-model' }).levels.length).toBeGreaterThan(0);
    }
  });
});
