import { ROUTING_MODELS, ROUTING_POLICIES, policyOfModel, type AgentKind, type GatewayGroup, type Provider, type ProviderType, type RoutingPolicy, type RuntimeKind } from '@shared';
import { isChatModel, modelsFor, preferredRuntime, profileFitError, providerTypesFor } from '@catalog';
import { accountWindowOf, familyWindows } from '@account-window';
import { contextWindowFor } from '../../../../server/src/models/context-window';
import { tr } from '@/i18n';

/**
 * The unified model picker (AiMaMi-style): every provider profile's models flattened into one list of
 * `<profile> / <model>` entries, so one click switches profile and model together. Pure — the composer
 * chip and the settings page both build from this.
 *
 * Keys (`ui.disabledModels` / `ui.favoriteModels`): a profile model is `<providerId>:<model>`; the
 * official Claude login keeps its historical bare model id; another agent's own models are
 * `<agent>:<model>` (what the settings page has always written). Recents (`ui.recentModels`, newest
 * first) are `<providerId>:<model>`, with `claude:<model>` for the Claude login and `@<agent>:<model>`
 * for another agent's own login (its default entry must not show up in Claude's list).
 */

export const OWN_PROVIDER = 'claude';
export const RECENT_MAX = 5;
/** Where the other agents are installed / configured (the settings regroup names it so, redesign phase 6). */
export const AGENTS_SETTING_PATH = tr('设置 → Agents 与子代理');

export interface ModelMenuItem {
  key: string;
  /** `claude` = the agent's own login (claude.ai for Claude, the CLI's account for the others) */
  providerId: string;
  providerName: string;
  model: string; // '' = the default of that login / profile
  display: string; // the model's display name (catalog label for built-ins, the id for profiles)
  label: string; // `<profile> / <model>`, or the bare display name for built-ins
  favorite: boolean;
  recent: boolean;
  compatible: boolean;
  current: boolean;
  /** the "default" entry of a login / profile (no star: it is not one model) */
  isDefault?: boolean;
  /** the profile's configured default model */
  profileDefault?: boolean;
  hint?: string;
  /** shown but not pickable, with the reason (the official engine cannot speak it, gateway off…) */
  unavailable?: string;
  /** set on another agent's own models (the `agent:<kind>` sections): picking it switches the agent */
  agent?: AgentKind;
  /**
   * The model's context window, marked after its name (A7): on the Claude account (the own login and a claude-account
   * profile) the family's 1M / 200K pick (haiku 200K); on a provider its window when it has one. None on a default entry.
   */
  window?: number;
}

export interface ModelMenuSection {
  id: string; // 'favorites' | 'recent' | 'builtin' | <providerId> | 'agent:<kind>'
  kind: 'favorites' | 'recent' | 'builtin' | 'provider' | 'agent';
  title: string;
  /** 更多模型 ›: how many of its models wait behind that row (foldMenu) */
  more?: number;
  providerId?: string;
  providerType?: ProviderType;
  /** kind 'agent': which agent */
  agent?: AgentKind;
  items: ModelMenuItem[];
  count?: number; // models listed for the profile (after hiding)
  modelsAt?: number;
  error?: string;
  /** the whole profile is shown disabled: why */
  unavailable?: string;
}

export interface ModelMenu {
  sections: ModelMenuSection[];
  /** every entry built, compatible or not (sections only hold compatible, visible ones) */
  items: ModelMenuItem[];
}

export interface BuildMenuInput {
  agent: AgentKind;
  providers: Provider[];
  gatewayGroups?: GatewayGroup[];
  /** gateway.status().poolModels: upstreamGroupId → its sidecar family's models */
  gatewayPoolModels?: Record<string, string[]>;
  settings: Record<string, unknown>;
  current?: { providerId?: string; model?: string | null };
  /** the agent's own model list when it reported one (session info); defaults to the catalog */
  builtin?: { value: string; displayName: string; description?: string }[];
  /** built-in section title (default: 'Claude 账号' / the agent's name) */
  builtinTitle?: string;
  /** a foreign agent's configured default model, shown on its default entry */
  agentDefault?: string;
  /** engine.info: which binary Claude sessions run on (the official one only speaks Anthropic) */
  engine?: { runtime: RuntimeKind; fallback?: { runtime: RuntimeKind } } | null;
  /** gateway.status().enabled; undefined = not loaded yet (gateway profiles are not judged) */
  gatewayEnabled?: boolean;
  /**
   * The other agents (Codex, Gemini CLI…) as more sections of the same flat list — what used to be the composer's
   * separate agent picker. Their own logins only: a profile is listed once, under the current agent's rules.
   */
  otherAgents?: AgentSource[];
}

/** Another agent as a source in the model menu (from `agents.list`). */
export interface AgentSource {
  kind: AgentKind;
  name: string;
  installed: boolean;
  /** what the registry knows, used when the catalog has no list for it */
  models?: string[];
  /** what the agent itself said it offers this account (AgentInfo.reportedModels): first */
  reportedModels?: { value: string; displayName: string; description?: string }[];
  /** its configured default model (settings → Agents 与子代理) */
  defaultModel?: string;
  /**
   * the provider its new conversations run on (settings → Agents 与子代理 「新对话用」), when it has one it can use:
   * the section then lists that provider's models (a relay's ids, not the agent's own account models)
   */
  provider?: Pick<Provider, 'id' | 'name' | 'models' | 'modelNames' | 'defaultModel'>;
}

/**
 * An agent's own model list: what it said it offers this account (Codex's model/list) — the built-in catalog goes
 * stale with every release (忍冬 2026-10-14: Codex is at 6 while the catalog still said 5.6) — else the catalog, else
 * the ids it was configured with.
 */
export function agentModels(a: Pick<AgentSource, 'kind' | 'models' | 'reportedModels'>): { value: string; displayName: string; description?: string }[] {
  if (a.reportedModels?.length) return a.reportedModels.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }));
  const cat = modelsFor(a.kind);
  return cat.length ? cat.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description })) : (a.models ?? []).map((m) => ({ value: m, displayName: m }));
}

/** Which profile types can drive an agent — @catalog's table, shared with session.setProvider on the server. */
export const compatibleTypes = (agent: AgentKind): ProviderType[] => providerTypesFor(agent);

/**
 * The engine a Claude session on profile `p` would really run on (server: `resolveEngine(p.runtime)`):
 * a profile forcing the official binary gets it; otherwise ccb when it is the engine, or when the profile asks
 * for it and it is installed (the fallback); else the official binary (ccb missing, or env-forced).
 */
export function effectiveRuntime(p: Pick<Provider, 'runtime'> & { type?: Provider['type'] }, engine: BuildMenuInput['engine']): RuntimeKind | undefined {
  // OpenAI / Gemini / Grok ask for ccb whatever the profile was pinned to (@catalog preferredRuntime, as the server)
  const want = p.type ? preferredRuntime({ type: p.type, runtime: p.runtime }) : p.runtime;
  if (want === 'claude') return 'claude';
  if (!engine) return undefined;
  if (engine.runtime === 'ccb') return 'ccb';
  return want === 'ccb' && engine.fallback?.runtime === 'ccb' ? 'ccb' : 'claude';
}

/** Why a source of `type` is not offered to `agent` at all (it doesn't speak that protocol), and what to do instead. */
export function notForAgent(agent: AgentKind, type: ProviderType): string {
  const name = agent === 'codex' ? 'Codex' : agent === 'gemini' ? 'Gemini CLI' : agent;
  return agent === 'gemini'
    ? tr('{name} 只能用 Gemini 的来源：在 Claude 对话里用它，或在「上游」把它加进一个网关组', { name })
    : tr('{name} 只能用 OpenAI 兼容的来源：在 Claude 对话里用它，或在「上游」把它加进一个网关组', { name });
}

/** Why profile `p` cannot be picked right now although the agent takes its type (null = it can). */
export function profileUnavailable(p: Provider, i: Pick<BuildMenuInput, 'agent' | 'engine' | 'gatewayGroups' | 'gatewayEnabled'>): string | null {
  if (p.type === 'gateway') {
    if (i.gatewayEnabled === false) return tr('模型网关未启用（设置 → 模型网关）');
    if (i.gatewayEnabled && i.gatewayGroups && !i.gatewayGroups.some((g) => g.id === p.gatewayGroupId)) return tr('网关组不存在（设置 → 模型网关）');
    return null;
  }
  return i.agent === 'claude' ? profileFitError('claude', p.type, effectiveRuntime(p, i.engine)) : null;
}

export function modelKey(agent: AgentKind, providerId: string, model: string): string {
  if (providerId !== OWN_PROVIDER) return `${providerId}:${model}`;
  return agent === 'claude' ? model : `${agent}:${model}`;
}

export function recentKey(agent: AgentKind, providerId: string | undefined, model: string): string {
  const pid = providerId || OWN_PROVIDER;
  return pid === OWN_PROVIDER && agent !== 'claude' ? `@${agent}:${model}` : `${pid}:${model}`;
}

export function pushRecent(list: string[] | undefined, key: string, max = RECENT_MAX): string[] {
  return [key, ...(list ?? []).filter((x) => x !== key)].slice(0, max);
}

/** A gateway profile's models: the same set `/gateway/<group>/v1/models` serves (GatewayService.serveModels). */
export function gatewayModels(
  p: Provider,
  groups: GatewayGroup[] | undefined,
  providers: Provider[],
  poolModels?: Record<string, string[]>,
): string[] {
  const ids = new Set<string>();
  const g = groups?.find((x) => x.id === p.gatewayGroupId);
  // 智能路由: its strategies are its models (the candidates are not offered one by one there)
  if (g?.routing) return ROUTING_POLICIES.map((x) => ROUTING_MODELS[x]);
  if (g) {
    for (const k of Object.keys(g.modelMap ?? {})) if (!k.includes('*')) ids.add(k);
    for (const m of g.members) {
      if (m.model) ids.add(m.model);
      const mp = providers.find((x) => x.id === m.providerId);
      for (const x of mp?.models ?? []) ids.add(x);
      if (mp?.defaultModel) ids.add(mp.defaultModel);
      // a sidecar account or pool (Gemini / WorkBuddy) keeps its models outside any profile
      const key = m.accountId ? `a:${m.accountId}` : m.upstreamGroupId ? `u:${m.upstreamGroupId}` : '';
      if (key) for (const x of poolModels?.[key] ?? []) ids.add(x);
    }
  }
  if (p.defaultModel) ids.add(p.defaultModel);
  return [...ids].sort();
}

/** The models a profile offers, in list order, with its default model included. */
export function profileModels(
  p: Provider,
  groups: GatewayGroup[] | undefined,
  providers: Provider[],
  poolModels?: Record<string, string[]>,
): string[] {
  if (p.type === 'gateway') return gatewayModels(p, groups, providers, poolModels);
  // an image / embedding / speech model is not something to hold a conversation with (an image-only key listed 3)
  const list = (p.models ?? []).filter(isChatModel);
  if (p.defaultModel && !list.includes(p.defaultModel)) list.unshift(p.defaultModel);
  return list;
}

/** 智能路由's strategies as the model menu names them. */
export const routingPolicyLabel = (p: RoutingPolicy): string =>
  p === 'auto' ? tr('自动') : p === 'free' ? tr('免费优先') : p === 'performance' ? tr('性能优先') : p === 'capability' ? tr('能力优先') : tr('自定义');
export const routingPolicyHint = (p: RoutingPolicy): string =>
  p === 'auto' ? tr('综合能力、可用性、额度、速度和成本') : p === 'free' ? tr('只用免费的，都不能用就停下') : p === 'performance' ? tr('先挑快的、稳的') : p === 'capability' ? tr('先挑能力最强、支持工具的') : tr('按你写的规则');
/** A routing group's model id → its strategy label, else undefined. */
export function routingModelName(groups: GatewayGroup[] | undefined, p: Pick<Provider, 'type' | 'gatewayGroupId'> | undefined, model: string): string | undefined {
  if (p?.type !== 'gateway' || !groups?.find((g) => g.id === p.gatewayGroupId)?.routing) return undefined;
  const pol = policyOfModel(model);
  return pol ? routingPolicyLabel(pol) : undefined;
}

/** How a provider's model shows: the name its model list gave (「DeepSeek-V4.1-Flash」 for `deepseek-flash`), else the id. */
export const providerModelName = (p: Pick<Provider, 'modelNames'> | undefined, model: string): string => p?.modelNames?.[model] || model;

/**
 * One line about a gateway (account-pool) model, since those are raw ids like `gemini-3.6-flash`: what it costs in
 * time and what it is for. Gemini web has no native tool calling, so "写代码推荐" really means "fast enough".
 */
export function gatewayModelHint(model: string): string | undefined {
  const m = model.toLowerCase();
  if (/(^|[-_:])thinking$/.test(m)) return tr('思考 20–40 秒');
  if (m.includes('flash-lite')) return tr('最快');
  if (m.includes('flash')) return tr('快 · 写代码推荐');
  if (m.includes('argon')) return tr('旗舰 · 最慢');
  if (/(^|[-_:])pro$/.test(m)) return tr('更强 · 较慢');
  if (m.includes('image') || m.includes('canvas')) return tr('图像生成');
  if (m.includes('music')) return tr('音乐生成');
  if (m.includes('video')) return tr('视频生成');
  return undefined;
}

const windowMark = (w: number | undefined): Pick<ModelMenuItem, 'window'> => (w && w > 0 ? { window: w } : {});

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function builtinList(i: BuildMenuInput) {
  return i.builtin ?? modelsFor(i.agent).map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }));
}

export function buildModelMenu(i: BuildMenuInput): ModelMenu {
  const disabled = new Set(strList(i.settings['ui.disabledModels']));
  const favorites = strList(i.settings['ui.favoriteModels']);
  const recents = strList(i.settings['ui.recentModels']);
  const favSet = new Set(favorites);
  const recentSet = new Set(recents);
  const types = compatibleTypes(i.agent);
  const curProvider = i.current?.providerId || OWN_PROVIDER;
  const curModel = i.current?.model === 'default' ? '' : i.current?.model ?? ''; // Claude Code's `default` alias = the default entry

  const make = (providerId: string, providerName: string, model: string, display: string, compatible: boolean, extra: Partial<ModelMenuItem> = {}): ModelMenuItem => {
    const key = modelKey(i.agent, providerId, model);
    const own = providerId === OWN_PROVIDER;
    return {
      key,
      providerId,
      providerName,
      model,
      display,
      label: own ? display : `${providerName} / ${display}`,
      favorite: !!model && favSet.has(key),
      recent: recentSet.has(recentKey(i.agent, providerId, model)),
      compatible,
      current: providerId === curProvider && model === curModel,
      ...extra,
    };
  };
  const visible = (it: ModelMenuItem) => it.compatible && (it.isDefault || !disabled.has(it.key));
  const pickable = (it: ModelMenuItem) => visible(it) && !it.unavailable;

  const items: ModelMenuItem[] = [];
  const sections: ModelMenuSection[] = [];

  // the agent's own login
  const ownTitle = i.builtinTitle ?? (i.agent === 'claude' ? tr('Claude 账号') : i.agent);
  const own: ModelMenuItem[] = [make(OWN_PROVIDER, ownTitle, '', i.agentDefault ? tr('默认（{agentDefault}）', { agentDefault: i.agentDefault }) : tr('默认模型'), true, { isDefault: true })];
  // the Claude login's 200K / 1M per family (settings → the account; what the settings say — through a relay of the
  // user's own the server leaves the picks out, which this cannot know cheaply)
  const ownWindows = i.agent === 'claude' ? familyWindows(i.settings['claude.contextWindows']) : undefined;
  for (const m of builtinList(i)) if (m.value && m.value !== 'default') own.push(make(OWN_PROVIDER, ownTitle, m.value, m.displayName || m.value, true, { hint: m.description || undefined, ...windowMark(ownWindows ? accountWindowOf(m.value, ownWindows) : undefined) }));
  items.push(...own);
  const ownShown = own.filter(visible);
  sections.push({ id: 'builtin', kind: 'builtin', title: ownTitle, providerId: OWN_PROVIDER, items: ownShown, count: ownShown.filter((x) => !x.isDefault).length });

  const incompatible: ModelMenuSection[] = [];
  for (const p of i.providers) {
    const compatible = types.includes(p.type);
    const unavailable = compatible ? profileUnavailable(p, i) ?? undefined : undefined;
    const models = profileModels(p, i.gatewayGroups, i.providers, i.gatewayPoolModels);
    // another Claude account keeps its family picks in contextWindows (opus / sonnet / fable), not per model id
    const acctWindows = p.type === 'claude-account' ? familyWindows(p.contextWindows) : undefined;
    const list = models.length
      ? models.map((m) => {
        // a gateway model is a raw id from an account pool: say what it is good for (speed / coding / thinking)
        const pol = p.type === 'gateway' && i.gatewayGroups?.find((g) => g.id === p.gatewayGroupId)?.routing ? policyOfModel(m) : undefined;
        if (pol) return make(p.id, p.name, m, routingPolicyLabel(pol), compatible, { unavailable, hint: routingPolicyHint(pol) });
        const hint = p.type === 'gateway' ? gatewayModelHint(m) : providerModelName(p, m) !== m ? m : undefined;
        const window = acctWindows ? accountWindowOf(m, acctWindows) : contextWindowFor(p, m);
        return make(p.id, p.name, m, providerModelName(p, m), compatible, { profileDefault: m === p.defaultModel, unavailable, ...(hint ? { hint } : {}), ...windowMark(window) });
      })
      : [make(p.id, p.name, '', tr('默认模型'), compatible, { isDefault: true, unavailable })];
    items.push(...list);
    if (!compatible) {
      // listed, greyed, with why: hidden, a user who added an Anthropic relay (or the Magpie pool) looked for it in a
      // Codex conversation's menu and thought it was lost (user report 2026-11-03)
      if (p.type !== 'gateway') incompatible.push({ id: p.id, kind: 'provider', title: p.name, providerId: p.id, providerType: p.type, items: [make(p.id, p.name, '', tr('默认模型'), false, { isDefault: true, unavailable: notForAgent(i.agent, p.type) })], count: 0, unavailable: notForAgent(i.agent, p.type) });
      continue;
    }
    const shown = list.filter(visible);
    // a profile whose every model is hidden still needs one entry, or it can no longer be picked at all
    sections.push({
      id: p.id,
      kind: 'provider',
      title: p.name,
      providerId: p.id,
      providerType: p.type,
      items: shown.length ? shown : [make(p.id, p.name, '', tr('默认模型'), compatible, { isDefault: true, unavailable })],
      count: shown.filter((x) => !x.isDefault).length,
      modelsAt: p.modelsAt,
      error: p.modelsError,
      unavailable,
    });
  }
  sections.push(...incompatible);

  for (const a of i.otherAgents ?? []) {
    if (a.kind === i.agent) continue;
    const unavailable = a.installed ? undefined : tr('未安装（{AGENTS_SETTING_PATH}）', { AGENTS_SETTING_PATH });
    const via = a.provider;
    const entry = (model: string, display: string, extra: Partial<ModelMenuItem> = {}): ModelMenuItem => ({
      key: modelKey(a.kind, via?.id ?? OWN_PROVIDER, model),
      providerId: via?.id ?? OWN_PROVIDER,
      providerName: via?.name ?? a.name,
      model,
      display,
      label: `${a.name} · ${display}`,
      favorite: false,
      recent: false,
      compatible: true,
      current: false,
      agent: a.kind,
      unavailable,
      ...extra,
    });
    const def = via ? via.defaultModel : a.defaultModel;
    const list = [entry('', def ? tr('默认（{def}）', { def }) : tr('默认模型'), { isDefault: true })];
    const own = via ? [...new Set([...(via.defaultModel ? [via.defaultModel] : []), ...(via.models ?? [])])].map((m) => ({ value: m, displayName: providerModelName(via, m), description: (providerModelName(via, m) !== m ? m : undefined) as string | undefined })) : agentModels(a);
    for (const m of own) if (m.value && m.value !== 'default') list.push(entry(m.value, m.displayName || m.value, { hint: m.description || undefined }));
    items.push(...list);
    const shown = list.filter(visible);
    sections.push({ id: `agent:${a.kind}`, kind: 'agent', title: via ? `${a.name} · ${via.name}` : a.name, agent: a.kind, items: shown, count: shown.filter((x) => !x.isDefault).length, unavailable });
  }

  // favourites / recents: the current agent's entries only — another agent's model is a switch of agent (in a
  // running conversation a hand-over), not something to be one click away
  const pool = items.filter((x) => pickable(x) && !x.agent);
  const byKey = (k: string) => pool.find((x) => !x.isDefault && x.key === k);
  const favs = favorites.map(byKey).filter((x): x is ModelMenuItem => !!x).sort((a, b) => a.label.localeCompare(b.label));
  const rec = recents
    .map((r) => pool.find((x) => recentKey(i.agent, x.providerId, x.model) === r))
    .filter((x): x is ModelMenuItem => !!x)
    .slice(0, RECENT_MAX);
  const head: ModelMenuSection[] = [];
  if (favs.length) head.push({ id: 'favorites', kind: 'favorites', title: tr('收藏'), items: favs });
  if (rec.length) head.push({ id: 'recent', kind: 'recent', title: tr('最近'), items: rec });
  return { sections: [...head, ...sections], items };
}

/** Keep entries whose profile name / model id / display name contain every whitespace-separated term. */
export function filterMenu(menu: ModelMenu, query: string): ModelMenu {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return menu;
  const hit = (it: ModelMenuItem) => {
    const hay = `${it.providerName} ${it.model} ${it.display}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
  const sections = menu.sections
    .filter((s) => s.kind !== 'favorites' && s.kind !== 'recent') // while searching, each entry once
    .map((s) => ({ ...s, items: s.items.filter(hit) }))
    .filter((s) => s.items.length);
  return { sections, items: menu.items };
}

/**
 * What the model chip says: `<profile> / <model>`, or the built-in display name on the agent's own login. Never
 * 「默认模型」 (final review §9 #2: a newcomer cannot tell what that is): no model chosen = the model the default
 * stands for — the agent's configured default, the account's default by name (`accountDefault`, read from the
 * CLI's own list), a profile's default model; 「默认」 is left to the tooltip and the menu's tick. When even that is
 * unknown (a fresh start with no conversation run yet) it is the agent's name.
 */
export function chipLabel(o: { agent: AgentKind; agentName?: string; providers: Provider[]; providerId?: string; providerName?: string; model?: string | null; builtin?: { value: string; displayName: string }[]; agentDefault?: string; accountDefault?: string }): string {
  const pid = o.providerId || OWN_PROVIDER;
  const model = o.model && o.model !== 'default' ? o.model : '';
  const list = o.builtin ?? modelsFor(o.agent);
  const named = (id: string) => list.find((m) => m.value === id)?.displayName ?? modelsFor(o.agent, [{ id }])[0].displayName; // legacy ids keep their label
  if (pid === OWN_PROVIDER) {
    if (model) return named(model);
    if (o.agentDefault) return named(o.agentDefault);
    return o.accountDefault ?? (o.agent === 'claude' ? 'Claude' : o.agentName ?? o.agent);
  }
  const p = o.providers.find((x) => x.id === pid);
  const name = p?.name ?? o.providerName ?? pid;
  const m = model || p?.defaultModel || '';
  // 智能路由's strategy ids read as their names (智能路由 / 自动)
  const pol = p?.type === 'gateway' && m ? policyOfModel(m) : undefined;
  if (pol) return `${name} / ${routingPolicyLabel(pol)}`;
  return m ? `${name} / ${providerModelName(p, m)}` : name;
}

export interface ModelRow {
  model: string;
  /** profiles offering it (`claude` = the Claude login when the catalog lists it) */
  providers: { id: string; name: string; isDefault: boolean }[];
  /** the ui.disabledModels / ui.favoriteModels keys this row stands for */
  keys: string[];
}

/** How many of a long list show before 「更多模型 ›」 (the official menu's four, plus one). */
export const FIRST_MODELS = 5;

/**
 * 更多模型 ›: a model list or account longer than FIRST_MODELS shows its first ones (and the current one wherever it is);
 * the rest wait behind one row until it is opened. Searching shows everything. `more` on a section = how many wait.
 */
export function foldMenu<M extends { sections: ModelMenuSection[] }>(m: M, opened: ReadonlySet<string>, query: string): M {
  if (query.trim()) return m;
  return {
    ...m,
    sections: m.sections.map((s) => {
      if ((s.kind !== 'builtin' && s.kind !== 'provider') || opened.has(s.id) || s.items.length <= FIRST_MODELS + 1) return s;
      const keep = s.items.filter((it, i) => i < FIRST_MODELS || it.current);
      return { ...s, items: keep, more: s.items.length - keep.length };
    }),
  };
}

/** Settings → Models, "by model": each model id once, with every profile that serves it. */
export function modelTable(
  providers: Provider[],
  groups: GatewayGroup[] | undefined,
  query = '',
  ownName = tr('Claude 账号'),
  poolModels?: Record<string, string[]>,
): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  const add = (model: string, id: string, name: string, isDefault: boolean) => {
    let r = rows.get(model);
    if (!r) rows.set(model, (r = { model, providers: [], keys: [] }));
    if (r.providers.some((x) => x.id === id)) return;
    r.providers.push({ id, name, isDefault });
    r.keys.push(modelKey('claude', id, model));
  };
  for (const m of modelsFor('claude')) add(m.value, OWN_PROVIDER, ownName, false);
  for (const p of providers) for (const m of profileModels(p, groups, providers, poolModels)) add(m, p.id, p.name, m === p.defaultModel);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...rows.values()]
    .filter((r) => !terms.length || terms.every((t) => `${r.model} ${r.providers.map((x) => x.name).join(' ')}`.toLowerCase().includes(t)))
    .sort((a, b) => b.providers.length - a.providers.length || a.model.localeCompare(b.model));
}

/** The welcome composer's remembered profile, if the chosen agent can use it right now (else undefined → own login). */
export function usableProfile(providers: Provider[], id: string | undefined, i: Pick<BuildMenuInput, 'agent' | 'engine' | 'gatewayGroups' | 'gatewayEnabled'>): Provider | undefined {
  if (!id || id === OWN_PROVIDER) return undefined;
  const p = providers.find((x) => x.id === id);
  if (!p || !compatibleTypes(i.agent).includes(p.type) || profileUnavailable(p, i)) return undefined;
  return p;
}
