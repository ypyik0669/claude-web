import type { AgentKind, EffortLevel, Provider } from '@shared';
import { CATALOG, effortLevels, modelCaps, nearestLevel, providerModelId } from '@catalog';
import { EFFORT_DESC, EFFORT_LABEL, ULTRACODE, effortTitle } from '@/ui/terms';
import { OWN_PROVIDER, chipLabel } from './menu';
import { tr } from '@/i18n';

/**
 * 「用哪个脑子、想多深」 (spec §5.5): the words for the effort ladder at the top of the model menu, and what the
 * model chip says. Pure; the labels themselves live in ui/terms.ts (EFFORT_LABEL).
 */

export interface EffortSegment { level: EffortLevel; label: string; title: string; on: boolean }

/** One segment per level the model accepts. Nothing chosen → the default level is the lit one. */
export function effortSegments(levels: EffortLevel[], value?: EffortLevel | null, defaultLevel?: EffortLevel): EffortSegment[] {
  const cur = value ?? defaultLevel;
  return levels.map((level) => ({ level, label: EFFORT_LABEL[level], title: effortTitle(level), on: level === cur }));
}

/** 「深入（默认）：复杂改动更稳，速度适中」 — the line under the control. */
export function effortCaption(value?: EffortLevel | null, defaultLevel?: EffortLevel): string {
  const cur = value ?? defaultLevel;
  if (!cur) return '';
  return `${EFFORT_LABEL[cur]}${cur === defaultLevel ? tr('（默认）') : ''}：${EFFORT_DESC[cur]}`;
}

export interface EffortView {
  levels: EffortLevel[];
  defaultLevel?: EffortLevel;
  /** the 深度编排 switch */
  ultracode: boolean;
}

/**
 * 智能程度 and 深度编排 for a conversation that has no live model info (welcome page, not running) — and the default
 * level for one that has. Claude on a provider: only models Claude Code sends the strength for (levels from the
 * provider's model list > our table, @catalog modelCaps — the rules the server uses). The Claude account: the catalog.
 */
export function claudeEffortView(i: { agent: AgentKind; providers: Provider[]; providerId?: string; model?: string | null }): EffortView {
  const ultracode = !!CATALOG[i.agent]?.supportsUltracode;
  const catalogDefault = CATALOG[i.agent]?.defaultEffort;
  const provider = i.agent === 'claude' && i.providerId && i.providerId !== OWN_PROVIDER ? i.providers.find((p) => p.id === i.providerId) : undefined;
  if (!provider) return { levels: effortLevels(i.agent, i.model || undefined), defaultLevel: catalogDefault, ultracode };
  const model = providerModelId(provider, i.model || undefined);
  const caps = modelCaps(provider, model);
  // Claude Code sends strength only for models it knows itself (our table)
  const levels: EffortLevel[] = caps.reasoning ? caps.levels : [];
  const fallback = catalogDefault && levels.length ? nearestLevel(catalogDefault, levels) : undefined;
  return { levels, defaultLevel: caps.default ?? fallback, ultracode };
}

export interface ChipTextInput {
  agent: AgentKind;
  providers: Provider[];
  providerId?: string;
  providerName?: string;
  model?: string | null;
  builtin?: { value: string; displayName: string }[];
  efforts: EffortLevel[];
  effort?: EffortLevel | null;
  defaultEffort?: EffortLevel;
  ultracode?: boolean;
  /** the Claude account's default model by name (accountDefaultName / the remembered one), for a chip with no model */
  accountDefault?: string;
}

/**
 * `模型 · 档位`: `Sonnet 5 · 深入`, `super-nb / claude-opus-5 · 深入`. 深度编排 replaces the level; a model without
 * levels has no suffix.
 */
export function modelChipText(i: ChipTextInput): { main: string; suffix?: string; isDefault?: true } {
  // no model chosen: the chip names what the default stands for; the tooltip says it is the default
  const isDefault = !i.model || i.model === 'default' ? (true as const) : undefined;
  const main = chipLabel({ agent: i.agent, providers: i.providers, providerId: i.providerId, providerName: i.providerName, model: i.model, builtin: i.builtin, accountDefault: i.accountDefault });
  const level = i.efforts.length ? (i.effort ?? i.defaultEffort) : undefined;
  const suffix = i.ultracode ? ULTRACODE.label : level ? EFFORT_LABEL[level] : undefined;
  return isDefault ? { main, suffix, isDefault } : { main, suffix };
}

/**
 * The Claude account's default model, by name, from the CLI's own model list: its 「Default (recommended)」 entry
 * (value `default`) says 「Use the default model (currently Sonnet 5)」 or 「Opus 5 for up to … then
 * Sonnet 5」 — the catalog model named first, else whatever follows 「currently」. Undefined when there is no such
 * entry or it names nothing.
 */
export function accountDefaultName(models?: readonly { value?: string | null; displayName?: string; description?: string }[]): string | undefined {
  const d = models?.find((m) => !m.value || m.value === 'default' || /^default\b/i.test(m.displayName ?? ''));
  const text = d?.description ?? '';
  if (!text) return undefined;
  const low = text.toLowerCase();
  let best: { label: string; at: number } | undefined;
  for (const m of CATALOG.claude?.models ?? []) {
    const at = low.indexOf(m.label.toLowerCase());
    if (at >= 0 && (!best || at < best.at || (at === best.at && m.label.length > best.label.length))) best = { label: m.label, at };
  }
  if (best) return best.label;
  return /currently\s+([^)·,]+?)\s*(?:[)·,]|$)/i.exec(text)?.[1]?.trim() || undefined;
}
