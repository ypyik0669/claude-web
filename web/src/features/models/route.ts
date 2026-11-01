import type { AgentKind, Provider } from '@shared';
import { OWN_PROVIDER, type ModelMenuItem } from './menu';
import { tr } from '@/i18n';

/** What picking an entry in a live session's model menu does. */
export type PickAction =
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'setModel'; model: string }
  /** the invisible restart of session.setProvider; model undefined = the new profile's / login's default */
  | { kind: 'setProvider'; providerId?: string; model?: string; confirm: boolean };

export interface PickContext {
  agent: AgentKind;
  currentProvider: string; // 'claude' = the Claude account
  currentModel?: string | null;
  remote: boolean; // a session on another machine: its profiles are not ours, only models change
  busy: boolean; // a turn is running: a restart interrupts it, ask first
  providers: Provider[];
}

/**
 * Toast after a model / provider switch in a live session. Prompt caches are per model (and per provider), so
 * with history behind it the next turn pays full price for the whole context once — say so.
 */
export function switchedNote(label: string, hasContext: boolean): string {
  return hasContext ? tr('已切换到 {label}（提示缓存不跨模型 / 供应商，下一轮会按全价重新计费全部上下文）', { label }) : tr('已切换到 {label}', { label });
}

/**
 * Route one pick. A default entry is resolved to a concrete value here, never left empty: an empty model
 * used to make the server keep the previous one, which on another profile is a model that endpoint lacks.
 */
export function routePick(it: ModelMenuItem, c: PickContext): PickAction {
  if (it.unavailable) return { kind: 'error', message: it.unavailable };
  const own = it.providerId === OWN_PROVIDER;
  const profile = own ? undefined : c.providers.find((p) => p.id === it.providerId);
  if (c.remote || it.providerId === c.currentProvider) {
    let model = it.model;
    if (!model) {
      if (own) model = 'default';
      else {
        if (!profile?.defaultModel) return { kind: 'error', message: tr('供应商「{name}」没有设默认模型，请选一个具体的模型', { name: profile?.name ?? it.providerName }) };
        model = profile.defaultModel;
      }
    }
    return model === c.currentModel ? { kind: 'none' } : { kind: 'setModel', model };
  }
  return { kind: 'setProvider', providerId: own ? undefined : it.providerId, model: it.model || profile?.defaultModel || undefined, confirm: c.busy };
}
