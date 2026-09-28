import type { AgentKind, GatewayGroup, Provider, ProviderType } from '@shared';
import { modelsFor } from '@catalog';

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
}

export interface ModelMenuSection {
  id: string; // 'favorites' | 'recent' | 'builtin' | <providerId>
  kind: 'favorites' | 'recent' | 'builtin' | 'provider';
  title: string;
  providerId?: string;
  providerType?: ProviderType;
  items: ModelMenuItem[];
  count?: number; // models listed for the profile (after hiding)
  modelsAt?: number;
  error?: string;
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
  settings: Record<string, unknown>;
  current?: { providerId?: string; model?: string | null };
  /** the agent's own model list when it reported one (session info); defaults to the catalog */
  builtin?: { value: string; displayName: string; description?: string }[];
  /** built-in section title (default: 'Claude 账号' / the agent's name) */
  builtinTitle?: string;
  /** a foreign agent's configured default model, shown on its default entry */
  agentDefault?: string;
}

/** Which profile types can drive an agent (what the server's providerEnv / agentLaunch actually wire up). */
export function compatibleTypes(agent: AgentKind): ProviderType[] {
  if (agent === 'claude') return ['anthropic', 'openai', 'gemini', 'grok', 'gateway'];
  if (agent === 'gemini') return ['gemini', 'gateway'];
  return ['openai', 'gateway']; // codex, qwen, kimi, opencode, custom ACP agents: OpenAI-compatible endpoints
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
export function gatewayModels(p: Provider, groups: GatewayGroup[] | undefined, providers: Provider[]): string[] {
  const ids = new Set<string>();
  const g = groups?.find((x) => x.id === p.gatewayGroupId);
  if (g) {
    for (const k of Object.keys(g.modelMap ?? {})) if (!k.includes('*')) ids.add(k);
    for (const m of g.members) {
      if (m.model) ids.add(m.model);
      const mp = providers.find((x) => x.id === m.providerId);
      for (const x of mp?.models ?? []) ids.add(x);
      if (mp?.defaultModel) ids.add(mp.defaultModel);
    }
  }
  if (p.defaultModel) ids.add(p.defaultModel);
  return [...ids].sort();
}

/** The models a profile offers, in list order, with its default model included. */
export function profileModels(p: Provider, groups: GatewayGroup[] | undefined, providers: Provider[]): string[] {
  if (p.type === 'gateway') return gatewayModels(p, groups, providers);
  const list = [...(p.models ?? [])];
  if (p.defaultModel && !list.includes(p.defaultModel)) list.unshift(p.defaultModel);
  return list;
}

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

  const items: ModelMenuItem[] = [];
  const sections: ModelMenuSection[] = [];

  // the agent's own login
  const ownTitle = i.builtinTitle ?? (i.agent === 'claude' ? 'Claude 账号' : i.agent);
  const own: ModelMenuItem[] = [make(OWN_PROVIDER, ownTitle, '', i.agentDefault ? `默认（${i.agentDefault}）` : '默认模型', true, { isDefault: true })];
  for (const m of builtinList(i)) if (m.value && m.value !== 'default') own.push(make(OWN_PROVIDER, ownTitle, m.value, m.displayName || m.value, true, { hint: m.description || undefined }));
  items.push(...own);
  const ownShown = own.filter(visible);
  sections.push({ id: 'builtin', kind: 'builtin', title: ownTitle, providerId: OWN_PROVIDER, items: ownShown, count: ownShown.filter((x) => !x.isDefault).length });

  for (const p of i.providers) {
    const compatible = types.includes(p.type);
    const models = profileModels(p, i.gatewayGroups, i.providers);
    const list = models.length
      ? models.map((m) => make(p.id, p.name, m, m, compatible, { profileDefault: m === p.defaultModel }))
      : [make(p.id, p.name, '', '默认模型', compatible, { isDefault: true })];
    items.push(...list);
    if (!compatible) continue;
    const shown = list.filter(visible);
    // a profile whose every model is hidden still needs one entry, or it can no longer be picked at all
    sections.push({
      id: p.id,
      kind: 'provider',
      title: p.name,
      providerId: p.id,
      providerType: p.type,
      items: shown.length ? shown : [make(p.id, p.name, '', '默认模型', compatible, { isDefault: true })],
      count: shown.filter((x) => !x.isDefault).length,
      modelsAt: p.modelsAt,
      error: p.modelsError,
    });
  }

  const pool = items.filter(visible);
  const byKey = (k: string) => pool.find((x) => !x.isDefault && x.key === k);
  const favs = favorites.map(byKey).filter((x): x is ModelMenuItem => !!x).sort((a, b) => a.label.localeCompare(b.label));
  const rec = recents
    .map((r) => pool.find((x) => recentKey(i.agent, x.providerId, x.model) === r))
    .filter((x): x is ModelMenuItem => !!x)
    .slice(0, RECENT_MAX);
  const head: ModelMenuSection[] = [];
  if (favs.length) head.push({ id: 'favorites', kind: 'favorites', title: '收藏', items: favs });
  if (rec.length) head.push({ id: 'recent', kind: 'recent', title: '最近', items: rec });
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

/** What the model chip says: `<profile> / <model>`, or the built-in display name on the agent's own login. */
export function chipLabel(o: { agent: AgentKind; providers: Provider[]; providerId?: string; providerName?: string; model?: string | null; builtin?: { value: string; displayName: string }[]; agentDefault?: string }): string {
  const pid = o.providerId || OWN_PROVIDER;
  const model = o.model ?? '';
  if (pid === OWN_PROVIDER) {
    if (!model) return o.agentDefault ? `默认（${o.agentDefault}）` : '默认模型';
    const list = o.builtin ?? modelsFor(o.agent);
    return list.find((m) => m.value === model)?.displayName ?? modelsFor(o.agent, [{ id: model }])[0].displayName; // legacy ids keep their label
  }
  const p = o.providers.find((x) => x.id === pid);
  const name = p?.name ?? o.providerName ?? pid;
  return `${name} / ${model || p?.defaultModel || '默认模型'}`;
}

export interface ModelRow {
  model: string;
  /** profiles offering it (`claude` = the Claude login when the catalog lists it) */
  providers: { id: string; name: string; isDefault: boolean }[];
  /** the ui.disabledModels / ui.favoriteModels keys this row stands for */
  keys: string[];
}

/** Settings → Models, "by model": each model id once, with every profile that serves it. */
export function modelTable(providers: Provider[], groups: GatewayGroup[] | undefined, query = ''): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  const add = (model: string, id: string, name: string, isDefault: boolean) => {
    let r = rows.get(model);
    if (!r) rows.set(model, (r = { model, providers: [], keys: [] }));
    if (r.providers.some((x) => x.id === id)) return;
    r.providers.push({ id, name, isDefault });
    r.keys.push(modelKey('claude', id, model));
  };
  for (const m of modelsFor('claude')) add(m.value, OWN_PROVIDER, 'Claude 账号', false);
  for (const p of providers) for (const m of profileModels(p, groups, providers)) add(m, p.id, p.name, m === p.defaultModel);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...rows.values()]
    .filter((r) => !terms.length || terms.every((t) => `${r.model} ${r.providers.map((x) => x.name).join(' ')}`.toLowerCase().includes(t)))
    .sort((a, b) => b.providers.length - a.providers.length || a.model.localeCompare(b.model));
}
