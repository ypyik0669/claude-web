import type { AgentKind, EffortLevel, ModelInfo, ProviderType } from '../protocol.js';
import { tr } from '../i18n/index.js';

/**
 * The one model / effort table.
 *
 * Verified in Sept 2026 against the docs and the Claude Code binary. Two things this table exists to get right:
 *
 * 1. Display names carry version numbers. "Fable" is not a model; "Fable 5.1" is.
 * 2. Effort is per model: Opus/Sonnet 4.6 have no `xhigh`.
 *
 * `ultracode` is deliberately NOT in any effort list. In Claude Code it is a separate session-scoped
 * boolean (`xhigh` + dynamic workflow orchestration) that `CLAUDE_CODE_EFFORT_LEVEL` rejects. See
 * `supportsUltracode` below.
 *
 * This is a FALLBACK and a display-name map. When Claude reports its own model list at runtime
 * (`supported_models`), that list wins — only the labels come from here.
 */

export const EFFORT_ALL: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const FIVE = EFFORT_ALL;
const NO_XHIGH: EffortLevel[] = ['low', 'medium', 'high', 'max'];

export interface CatalogModel {
  id: string;
  label: string;
  hint?: string;
  effort?: EffortLevel[];
  /** hidden from the picker unless the agent itself reports it (kept for label lookup / back-compat) */
  legacy?: boolean;
}

export interface AgentCatalog {
  models: CatalogModel[];
  /** aliases the CLI accepts in place of a model id, e.g. `opus` → Opus 5 */
  aliases?: Record<string, string>;
  effort: EffortLevel[];
  defaultEffort?: EffortLevel;
  /** false → the composer hides the effort chip entirely for this agent */
  supportsEffort: boolean;
  supportsUltracode?: boolean;
}

export const CATALOG: Partial<Record<AgentKind, AgentCatalog>> = {
  claude: {
    models: [
      { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: tr('最强，慢、贵'), effort: FIVE },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: tr('复杂任务'), effort: FIVE },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: tr('日常编码'), effort: FIVE },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: tr('日常编码（官方 sonnet 别名）'), effort: FIVE },
      { id: 'claude-opus-5', label: 'Opus 5', hint: tr('复杂任务'), effort: FIVE },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: tr('快、便宜'), effort: FIVE },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', effort: FIVE, legacy: true },
      { id: 'claude-fable-5', label: 'Fable 5', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-7', label: 'Opus 4.7', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-6', label: 'Opus 4.6', effort: NO_XHIGH, legacy: true },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', effort: NO_XHIGH, legacy: true },
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', effort: NO_XHIGH, legacy: true },
    ],
    // what the official Claude Code resolves each alias to (OFFICIAL_ALIAS_TARGETS, measured)
    aliases: {
      fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5',
      best: 'claude-fable-5-1', opusplan: 'claude-opus-5-5', default: 'claude-opus-5-5',
      'fable[1m]': 'claude-fable-5-1', 'opus[1m]': 'claude-opus-5-5', 'sonnet[1m]': 'claude-sonnet-5',
    },
    effort: FIVE,
    defaultEffort: 'high',
    supportsEffort: true,
    supportsUltracode: true,
  },
};

/**
 * What the official Claude Code (2.1.283, the Agent SDK's bundled binary) resolves the claude.ai login's aliases to —
 * read off its system/init line with `--model <alias>` (2026-09-29): no model / default → claude-opus-5-5[1m] (Max),
 * opus → claude-opus-5-5, sonnet → claude-sonnet-5, haiku → claude-haiku-4-5-20251001, fable / best → claude-fable-5-1.
 * Re-measure when the SDK's claude binary is upgraded.
 */
export const OFFICIAL_ALIAS_TARGETS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001', fable: 'claude-fable-5-1' } as const;

/** Display name for a model id or alias — falls back to the raw id so unknown models still render. */
export function modelLabel(agent: AgentKind, id: string): string {
  const c = CATALOG[agent];
  if (!c) return id;
  const resolved = c.aliases?.[id] ?? id;
  return c.models.find((m) => m.id === resolved)?.label ?? id;
}

/** Effort levels a given (agent, model) pair accepts. Empty ⇒ hide the effort control. */
export function effortLevels(agent: AgentKind, model?: string | null): EffortLevel[] {
  const c = CATALOG[agent];
  if (!c || !c.supportsEffort) return [];
  if (!model) return c.effort;
  const resolved = c.aliases?.[model] ?? model;
  return c.models.find((m) => m.id === resolved)?.effort ?? c.effort;
}

/**
 * The model list to offer for an agent, as `ModelInfo` on the wire.
 * `reported` is what the agent itself said it supports; when present it is authoritative and this
 * only supplies labels and effort ranges.
 */
export function modelsFor(agent: AgentKind, reported?: { id: string; label?: string }[]): ModelInfo[] {
  const c = CATALOG[agent];
  const known = c?.models ?? [];
  const build = (id: string, label?: string): ModelInfo => {
    const k = known.find((m) => m.id === (c?.aliases?.[id] ?? id));
    return {
      value: id,
      displayName: label ?? k?.label ?? id,
      description: k?.hint ?? '',
      supportsEffort: !!c?.supportsEffort && effortLevels(agent, id).length > 0,
      supportedEffortLevels: effortLevels(agent, id),
    };
  };
  if (reported?.length) return reported.map((r) => build(r.id, r.label));
  return known.filter((m) => !m.legacy).map((m) => build(m.id));
}

export function supportsUltracode(agent: AgentKind): boolean {
  return !!CATALOG[agent]?.supportsUltracode;
}

/**
 * Which provider-profile types can drive an agent — what providerEnv actually wires up. Shared by the model menu
 * (web) and session.setProvider (server), so both refuse the same things.
 */
export function providerTypesFor(agent: AgentKind): ProviderType[] {
  return agent === 'claude' ? ['anthropic', 'claude-account'] : [];
}

/** The model id a provider session actually sends: an alias goes through the profile's family map; the default follows the opus one. */
export function providerModelId(p: { defaultModel?: string; modelMap?: { haiku?: string; sonnet?: string; opus?: string } }, model: string | undefined): string {
  const m = (model || p.defaultModel || '').replace(/\[1m\]$/i, '');
  const map = p.modelMap ?? {};
  if (!m || m === 'default') return map.opus ?? '';
  return (m === 'opus' || m === 'sonnet' || m === 'haiku' ? map[m] : undefined) ?? m;
}

/** Why a profile of `type` cannot drive `agent` (null = it can). */
export function profileFitError(agent: AgentKind, type: ProviderType): string | null {
  const types = providerTypesFor(agent);
  if (!types.includes(type)) return tr('{agent} 不能用 {type} 类型的供应商（只支持 {types}）', { agent: agent === 'claude' ? 'Claude Code' : agent, type, types: types.join(' / ') });
  return null;
}

// ---- thinking strength per model ----

export type ClaudeEffort = EffortLevel;
const CLAUDE_ORDER: ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Closest available level; a tie goes to the higher one (DeepSeek low/high/max: medium → high, xhigh → max). */
export function nearestLevel(level: ClaudeEffort, available: readonly ClaudeEffort[]): ClaudeEffort {
  if (!available.length || available.includes(level)) return level;
  const at = CLAUDE_ORDER.indexOf(level);
  let best = available[0]!;
  let dist = Infinity;
  for (const l of available) {
    const d = Math.abs(CLAUDE_ORDER.indexOf(l) - at);
    if (d < dist || (d === dist && CLAUDE_ORDER.indexOf(l) > CLAUDE_ORDER.indexOf(best))) { best = l; dist = d; }
  }
  return best;
}

/** Claude model version from any spelling (`claude-opus-5-5[1m]`, `anthropic/claude-sonnet-4.6`, Bedrock ids, `claude-3-5-sonnet`). */
export function claudeVersion(model: string): number | undefined {
  const m = model.toLowerCase();
  if (!m.includes('claude')) return undefined;
  const hit = /claude[-_.](\d)(?:[-.](\d))?[-_.](?:opus|sonnet|haiku|fable)/.exec(m) ?? /(?:opus|sonnet|haiku|fable)[-_.]?(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?/.exec(m);
  return hit ? Number(`${hit[1]}.${hit[2] ?? 0}`) : undefined;
}

/** A Claude model's levels: the catalog's (Opus / Sonnet 4.6 and Sonnet 4.5 have no xhigh); an id it lacks, by version. */
function claudeLevels(model: string, v: number): ClaudeEffort[] {
  const known = CATALOG.claude?.models.find((x) => x.id === baseName(model))?.effort;
  if (known) return known;
  return v >= 4.6 && v < 4.7 ? CLAUDE_ORDER.filter((l) => l !== 'xhigh') : CLAUDE_ORDER;
}

type CapsProvider = { type: ProviderType; modelEfforts?: Record<string, { levels: ClaudeEffort[]; default?: ClaudeEffort }> };
export interface ModelCaps { levels: ClaudeEffort[]; default?: ClaudeEffort; reasoning: boolean }

const baseName = (model: string) => { const m = model.toLowerCase(); return m.slice(m.lastIndexOf('/') + 1); };

/** What the table knows about a model by name (nothing = undefined). */
function tableCaps(model: string): { levels: ClaudeEffort[]; default?: ClaudeEffort } | undefined {
  const v = claudeVersion(model);
  return v !== undefined ? { levels: claudeLevels(model, v) } : undefined;
}

const plainId = (model: string) => model.replace(/\[1m\]$/i, '');

/**
 * What a model can do with thinking strength: its levels (the provider's model list > our table > all five) and
 * whether it reasons. `p` undefined = the Claude account.
 */
export function modelCaps(p: CapsProvider | undefined, model: string): ModelCaps {
  // the account's list holds aliases (default / opus / sonnet …): the model each stands for
  const aliases = p ? undefined : CATALOG.claude?.aliases;
  const id = aliases?.[model] ?? aliases?.[plainId(model)] ?? plainId(model);
  const declared = p?.modelEfforts?.[model] ?? p?.modelEfforts?.[id];
  const table = tableCaps(id);
  const levels = declared?.levels?.length ? declared.levels : table?.levels ?? CLAUDE_ORDER;
  const def = declared?.default ?? table?.default;
  return { levels, ...(def ? { default: def } : {}), reasoning: !!declared?.levels?.length || !!table };
}

/** Ids in an endpoint's model list that are not chat models (embeddings, images, speech, moderation, rerank…). */
const NOT_CHAT = /embed|whisper|tts|dall-?e|image|moderation|rerank|audio|speech|realtime|transcri|ocr|sora|veo|imagen|midjourney|mj[-_]|flux|suno|kling/i;
export const isChatModel = (id: string) => !!id && !NOT_CHAT.test(id);

/**
 * An id's version as the 1–2 digit numbers in it, in order; dates and sizes (3+ digits) are left out, so
 * `claude-sonnet-4-5-20250929` → [4, 5], `claude-3-5-haiku-20241022` → [3, 5], `glm-4.6` → [4, 6].
 */
export function modelVersion(id: string): number[] {
  return (id.match(/\d+/g) ?? []).filter((n) => n.length <= 2).map(Number);
}

function newer(a: string, b: string): number {
  const x = modelVersion(a), y = modelVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1);
  // same version: the plain id before its -thinking / -latest variants, and a lower-case id before an upper-case duplicate
  return a.length - b.length || Number(a !== a.toLowerCase()) - Number(b !== b.toLowerCase());
}

/** The newest chat model in `models` matching `re`, or undefined. */
export function newestMatch(models: string[], re: RegExp): string | undefined {
  return models.filter((m) => isChatModel(m) && re.test(m)).sort(newer)[0];
}

type Family = 'haiku' | 'sonnet' | 'opus';
/**
 * haiku / sonnet / opus → the newest model of that Claude family an endpoint lists; a family it lacks borrows a
 * neighbour (the CLI calls all three: background work on haiku, the main loop on the default). {} without Claude.
 */
export function claudeFamilyMap(models: string[]): Partial<Record<Family, string>> {
  const pick = (f: Family) => newestMatch(models, new RegExp(`claude.*${f}|${f}.*claude`, 'i'));
  const opus = pick('opus'), sonnet = pick('sonnet'), haiku = pick('haiku');
  const any = sonnet ?? opus ?? haiku;
  if (!any) return {};
  return { opus: opus ?? sonnet ?? any, sonnet: sonnet ?? opus ?? any, haiku: haiku ?? sonnet ?? any };
}

/** What a conversation should default to, first match wins (then the newest id within it). */
export const CHAT_MODEL_PREFERENCE: RegExp[] = [/claude.*sonnet|sonnet.*claude/i, /claude.*opus|opus.*claude/i, /claude/i];

/** A sensible default chat model from an endpoint's list: by `prefer` (Sonnet, then Opus, then any Claude), else the first id that looks like a chat model. */
export function pickChatModel(models: string[], prefer: RegExp[] = CHAT_MODEL_PREFERENCE): string | undefined {
  for (const re of prefer) { const m = newestMatch(models, re); if (m) return m; }
  return models.find(isChatModel);
}
