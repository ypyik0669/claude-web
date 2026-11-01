import type { AgentKind, Provider, ProviderType } from '@shared';
import { isChatModel, modelsFor, profileFitError, providerTypesFor } from '@catalog';
import { accountWindowOf, familyWindows } from '@account-window';
import { contextWindowFor } from '../../../../server/src/models/context-window';
import { tr } from '@/i18n';

/**
 * The unified model picker (AiMaMi-style): every provider profile's models flattened into one list of
 * `<profile> / <model>` entries, so one click switches profile and model together. Pure — the composer
 * chip and the settings page both build from this.
 *
 * Keys (`ui.disabledModels` / `ui.favoriteModels`): a profile model is `<providerId>:<model>`; the
 * official Claude login keeps its historical bare model id. Recents (`ui.recentModels`, newest first) are
 * `<providerId>:<model>`, with `claude:<model>` for the Claude login.
 */

export const OWN_PROVIDER = 'claude';
export const RECENT_MAX = 5;

export interface ModelMenuItem {
  key: string;
  /** `claude` = the Claude account (claude.ai) */
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
  /** shown but not pickable, with the reason */
  unavailable?: string;
  /**
   * The model's context window, marked after its name (A7): on the Claude account (the own login and a claude-account
   * profile) the family's 1M / 200K pick (haiku 200K); on a provider its window when it has one. None on a default entry.
   */
  window?: number;
}

export interface ModelMenuSection {
  id: string; // 'favorites' | 'recent' | 'builtin' | <providerId>
  kind: 'favorites' | 'recent' | 'builtin' | 'provider';
  title: string;
  /** 更多模型 ›: how many of its models wait behind that row (foldMenu) */
  more?: number;
  providerId?: string;
  providerType?: ProviderType;
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
  settings: Record<string, unknown>;
  current?: { providerId?: string; model?: string | null };
  /** Claude's own model list when it reported one (session info); defaults to the catalog */
  builtin?: { value: string; displayName: string; description?: string }[];
  /** built-in section title (default: 'Claude 账号') */
  builtinTitle?: string;
}

/** Which profile types can drive an agent — @catalog's table, shared with session.setProvider on the server. */
export const compatibleTypes = (agent: AgentKind): ProviderType[] => providerTypesFor(agent);

/** Why profile `p` cannot be picked right now although the agent takes its type (null = it can). */
export function profileUnavailable(p: Provider, i: Pick<BuildMenuInput, 'agent'>): string | null {
  return profileFitError(i.agent, p.type);
}

export function modelKey(_agent: AgentKind, providerId: string, model: string): string {
  return providerId !== OWN_PROVIDER ? `${providerId}:${model}` : model;
}

export function recentKey(_agent: AgentKind, providerId: string | undefined, model: string): string {
  return `${providerId || OWN_PROVIDER}:${model}`;
}

export function pushRecent(list: string[] | undefined, key: string, max = RECENT_MAX): string[] {
  return [key, ...(list ?? []).filter((x) => x !== key)].slice(0, max);
}

/** The models a profile offers, in list order, with its default model included. */
export function profileModels(p: Provider): string[] {
  // an image / embedding / speech model is not something to hold a conversation with (an image-only key listed 3)
  const list = (p.models ?? []).filter(isChatModel);
  if (p.defaultModel && !list.includes(p.defaultModel)) list.unshift(p.defaultModel);
  return list;
}

/** How a provider's model shows: the name its model list gave (「DeepSeek-V4.1-Flash」 for `deepseek-flash`), else the id. */
export const providerModelName = (p: Pick<Provider, 'modelNames'> | undefined, model: string): string => p?.modelNames?.[model] || model;

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

  // the Claude account
  const ownTitle = i.builtinTitle ?? tr('Claude 账号');
  const own: ModelMenuItem[] = [make(OWN_PROVIDER, ownTitle, '', tr('默认模型'), true, { isDefault: true })];
  // the Claude login's 200K / 1M per family (settings → the account; what the settings say — through a relay of the
  // user's own the server leaves the picks out, which this cannot know cheaply)
  const ownWindows = i.agent === 'claude' ? familyWindows(i.settings['claude.contextWindows']) : undefined;
  for (const m of builtinList(i)) if (m.value && m.value !== 'default') own.push(make(OWN_PROVIDER, ownTitle, m.value, m.displayName || m.value, true, { hint: m.description || undefined, ...windowMark(ownWindows ? accountWindowOf(m.value, ownWindows) : undefined) }));
  items.push(...own);
  const ownShown = own.filter(visible);
  sections.push({ id: 'builtin', kind: 'builtin', title: ownTitle, providerId: OWN_PROVIDER, items: ownShown, count: ownShown.filter((x) => !x.isDefault).length });

  for (const p of i.providers) {
    const compatible = types.includes(p.type);
    const unavailable = compatible ? profileUnavailable(p, i) ?? undefined : undefined;
    const models = profileModels(p);
    // another Claude account keeps its family picks in contextWindows (opus / sonnet / fable), not per model id
    const acctWindows = p.type === 'claude-account' ? familyWindows(p.contextWindows) : undefined;
    const list = models.length
      ? models.map((m) => {
        const hint = providerModelName(p, m) !== m ? m : undefined;
        const window = acctWindows ? accountWindowOf(m, acctWindows) : contextWindowFor(p, m);
        return make(p.id, p.name, m, providerModelName(p, m), compatible, { profileDefault: m === p.defaultModel, unavailable, ...(hint ? { hint } : {}), ...windowMark(window) });
      })
      : [make(p.id, p.name, '', tr('默认模型'), compatible, { isDefault: true, unavailable })];
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
      items: shown.length ? shown : [make(p.id, p.name, '', tr('默认模型'), compatible, { isDefault: true, unavailable })],
      count: shown.filter((x) => !x.isDefault).length,
      modelsAt: p.modelsAt,
      error: p.modelsError,
      unavailable,
    });
  }

  // favourites / recents
  const pool = items.filter(pickable);
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
 * What the model chip says: `<profile> / <model>`, or the built-in display name on the Claude account. Never
 * 「默认模型」 (final review §9 #2: a newcomer cannot tell what that is): no model chosen = the model the default
 * stands for — the account's default by name (`accountDefault`, read from the CLI's own list), a profile's default
 * model; 「默认」 is left to the tooltip and the menu's tick. When even that is unknown (a fresh start with no
 * conversation run yet) it is 'Claude'.
 */
export function chipLabel(o: { agent: AgentKind; providers: Provider[]; providerId?: string; providerName?: string; model?: string | null; builtin?: { value: string; displayName: string }[]; accountDefault?: string }): string {
  const pid = o.providerId || OWN_PROVIDER;
  const model = o.model && o.model !== 'default' ? o.model : '';
  const list = o.builtin ?? modelsFor(o.agent);
  const named = (id: string) => list.find((m) => m.value === id)?.displayName ?? modelsFor(o.agent, [{ id }])[0].displayName; // legacy ids keep their label
  if (pid === OWN_PROVIDER) {
    if (model) return named(model);
    return o.accountDefault ?? 'Claude';
  }
  const p = o.providers.find((x) => x.id === pid);
  const name = p?.name ?? o.providerName ?? pid;
  const m = model || p?.defaultModel || '';
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
export function modelTable(providers: Provider[], query = '', ownName = tr('Claude 账号')): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  const add = (model: string, id: string, name: string, isDefault: boolean) => {
    let r = rows.get(model);
    if (!r) rows.set(model, (r = { model, providers: [], keys: [] }));
    if (r.providers.some((x) => x.id === id)) return;
    r.providers.push({ id, name, isDefault });
    r.keys.push(modelKey('claude', id, model));
  };
  for (const m of modelsFor('claude')) add(m.value, OWN_PROVIDER, ownName, false);
  for (const p of providers) for (const m of profileModels(p)) add(m, p.id, p.name, m === p.defaultModel);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return [...rows.values()]
    .filter((r) => !terms.length || terms.every((t) => `${r.model} ${r.providers.map((x) => x.name).join(' ')}`.toLowerCase().includes(t)))
    .sort((a, b) => b.providers.length - a.providers.length || a.model.localeCompare(b.model));
}

/** The welcome composer's remembered profile, if it can be used right now (else undefined → the account). */
export function usableProfile(providers: Provider[], id: string | undefined, i: Pick<BuildMenuInput, 'agent'>): Provider | undefined {
  if (!id || id === OWN_PROVIDER) return undefined;
  const p = providers.find((x) => x.id === id);
  if (!p || !compatibleTypes(i.agent).includes(p.type) || profileUnavailable(p, i)) return undefined;
  return p;
}
