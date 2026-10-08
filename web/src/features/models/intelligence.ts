import type { AgentKind, EffortLevel, Provider, RuntimeKind } from '@shared';
import { CATALOG, effortLevels, modelCaps, modelsFor, nearestLevel, providerModelId, type ClaudeEffort } from '@catalog';
import { EFFORT_DESC, EFFORT_LABEL, EFFORT_MODE_NOTE, EFFORT_PROMPT_TITLE, ULTRACODE, effortTitle } from '@/ui/terms';
import { OWN_PROVIDER, chipLabel } from './menu';

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

/**
 * 「深入（默认）：复杂改动更稳，速度适中」 — the line under the control; on our engine followed by how it goes out:
 * 「（原生）」 the model's own parameter, 「（通过提示词）」 a reminder each turn (models without one).
 */
export function effortCaption(value?: EffortLevel | null, defaultLevel?: EffortLevel, mode?: 'native' | 'prompt'): string {
  const cur = value ?? defaultLevel;
  if (!cur) return '';
  return `${EFFORT_LABEL[cur]}${cur === defaultLevel ? '（默认）' : ''}：${EFFORT_DESC[cur]}${mode ? EFFORT_MODE_NOTE[mode] : ''}`;
}

export { EFFORT_PROMPT_TITLE };

export interface EffortView {
  levels: EffortLevel[];
  defaultLevel?: EffortLevel;
  /** Claude on a provider: the model's own parameter, or through the prompt */
  mode?: 'native' | 'prompt';
  /** the 深度编排 switch */
  ultracode: boolean;
}

/**
 * 智能程度 and 深度编排 for a conversation that has no live model info (welcome page, not running) — and the default
 * level / mode for one that has. Claude on a provider, on our engine: every model (levels from the provider's model
 * list > our table > all five; native or through the prompt, @catalog modelCaps — the rules the server and the
 * engine use). On the official binary (`runtime: 'claude'`) only models with the parameter: it has no prompt way.
 * The Claude account and other agents: the catalog.
 */
export function claudeEffortView(i: { agent: AgentKind; providers: Provider[]; providerId?: string; model?: string | null; runtime?: RuntimeKind }): EffortView {
  const ultracode = !!CATALOG[i.agent]?.supportsUltracode;
  const catalogDefault = CATALOG[i.agent]?.defaultEffort;
  const provider = i.agent === 'claude' && i.providerId && i.providerId !== OWN_PROVIDER ? i.providers.find((p) => p.id === i.providerId) : undefined;
  if (!provider) return { levels: effortLevels(i.agent, i.model || undefined), defaultLevel: catalogDefault, ultracode };
  const model = providerModelId(provider, i.model || undefined);
  const caps = modelCaps(provider, model);
  const levels: EffortLevel[] = i.runtime === 'claude' && !caps.native ? [] : caps.levels;
  const fallback = catalogDefault && catalogDefault !== 'ultra' && levels.length ? nearestLevel(catalogDefault as ClaudeEffort, levels as ClaudeEffort[]) : undefined;
  return { levels, defaultLevel: caps.default ?? fallback, mode: caps.native ? 'native' : 'prompt', ultracode };
}

export interface ChipTextInput {
  agent: AgentKind;
  agentName?: string;
  providers: Provider[];
  providerId?: string;
  providerName?: string;
  model?: string | null;
  builtin?: { value: string; displayName: string }[];
  agentDefault?: string;
  efforts: EffortLevel[];
  effort?: EffortLevel | null;
  defaultEffort?: EffortLevel;
  ultracode?: boolean;
  /** the Claude account's default model by name (accountDefaultName / the remembered one), for a chip with no model */
  accountDefault?: string;
}

function builtinName(agent: AgentKind, model: string, builtin?: { value: string; displayName: string }[]): string {
  return builtin?.find((m) => m.value === model)?.displayName ?? modelsFor(agent, [{ id: model }])[0].displayName;
}

/**
 * `模型 · 档位`: `Sonnet 5 · 深入`, `super-nb / claude-opus-5 · 深入`, `Codex 5.6 Sol · 均衡`. Another agent's name
 * leads (the chip is the only place on the welcome page that says which agent will run), unless the model name
 * already carries it (`Gemini 3 Pro`). 深度编排 replaces the level; a model without levels has no suffix.
 */
export function modelChipText(i: ChipTextInput): { main: string; suffix?: string; isDefault?: true } {
  const own = !i.providerId || i.providerId === OWN_PROVIDER;
  // no model chosen: the chip names what the default stands for; the tooltip says it is the default
  const isDefault = !i.model || i.model === 'default' ? (true as const) : undefined;
  const foreign = i.agent !== 'claude';
  const name = i.agentName ?? i.agent;
  let main: string;
  if (own && foreign) {
    const m = i.model || i.agentDefault || '';
    const display = m ? builtinName(i.agent, m, i.builtin) : '';
    const first = name.split(/\s+/)[0].toLowerCase();
    main = !display ? name : display.toLowerCase().includes(first) ? display : `${name} ${display}`;
  } else {
    main = chipLabel({ agent: i.agent, agentName: i.agentName, providers: i.providers, providerId: i.providerId, providerName: i.providerName, model: i.model, builtin: i.builtin, agentDefault: i.agentDefault, accountDefault: i.accountDefault });
    if (foreign) main = `${name} · ${main}`;
  }
  const level = i.efforts.length ? (i.effort ?? i.defaultEffort) : undefined;
  const suffix = i.ultracode ? ULTRACODE.label : level ? EFFORT_LABEL[level] : undefined;
  return isDefault ? { main, suffix, isDefault } : { main, suffix };
}

/**
 * The Claude account's default model, by name, from the CLI's own model list: its 「Default (recommended)」 entry
 * (value `default`, or none in ccb) says 「Use the default model (currently Sonnet 5)」 or 「Opus 5 for up to … then
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
