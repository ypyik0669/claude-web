import type { AgentKind, EffortLevel, Provider } from '@shared';
import { CATALOG, modelsFor } from '@catalog';
import { EFFORT_DESC, EFFORT_LABEL, ULTRACODE, effortTitle } from '@/ui/terms';
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

/** 「深入（默认）：复杂改动更稳，速度适中」 — the line under the control. */
export function effortCaption(value?: EffortLevel | null, defaultLevel?: EffortLevel): string {
  const cur = value ?? defaultLevel;
  if (!cur) return '';
  return `${EFFORT_LABEL[cur]}${cur === defaultLevel ? '（默认）' : ''}：${EFFORT_DESC[cur]}`;
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
