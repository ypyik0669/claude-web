import type { AgentKind, EffortLevel, Provider } from '@shared';
import { modelsFor } from '@catalog';
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

/** The level that applies: the chosen one if this model takes it, else the default if it takes that. */
export function resolvedEffort(levels: EffortLevel[], value?: EffortLevel | null, defaultLevel?: EffortLevel): EffortLevel | undefined {
  if (value && levels.includes(value)) return value;
  if (defaultLevel && levels.includes(defaultLevel)) return defaultLevel;
  return undefined;
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
}

function builtinName(agent: AgentKind, model: string, builtin?: { value: string; displayName: string }[]): string {
  return builtin?.find((m) => m.value === model)?.displayName ?? modelsFor(agent, [{ id: model }])[0].displayName;
}

/**
 * `模型 · 档位`: `Sonnet 5 · 深入`, `super-nb / claude-opus-5 · 深入`, `Codex 5.6 Sol · 均衡`. Another agent's name
 * leads (the chip is the only place on the welcome page that says which agent will run), unless the model name
 * already carries it (`Gemini 3 Pro`). 深度编排 replaces the level; a model without levels has no suffix.
 */
export function modelChipText(i: ChipTextInput): { main: string; suffix?: string } {
  const own = !i.providerId || i.providerId === OWN_PROVIDER;
  const foreign = i.agent !== 'claude';
  const name = i.agentName ?? i.agent;
  let main: string;
  if (own && foreign) {
    const m = i.model || i.agentDefault || '';
    const display = m ? builtinName(i.agent, m, i.builtin) : '';
    const first = name.split(/\s+/)[0].toLowerCase();
    main = !display ? name : display.toLowerCase().includes(first) ? display : `${name} ${display}`;
  } else {
    main = chipLabel({ agent: i.agent, providers: i.providers, providerId: i.providerId, providerName: i.providerName, model: i.model, builtin: i.builtin, agentDefault: i.agentDefault });
    if (foreign) main = `${name} · ${main}`;
  }
  const level = i.efforts.length ? (i.effort ?? i.defaultEffort) : undefined;
  const suffix = i.ultracode ? ULTRACODE.label : level ? EFFORT_LABEL[level] : undefined;
  return { main, suffix };
}
