import type { AgentKind, EffortLevel, ModelInfo, ProviderType, RuntimeKind } from '../protocol.js';
import { tr } from '../i18n/index.js';

/**
 * The one model / effort table.
 *
 * Verified in Sept 2026 against the docs AND the binaries installed on this machine
 * (claude 2.1.259, codex-cli 0.153.0, gemini-cli 0.41.2). Two things this table exists to get right:
 *
 * 1. Display names carry version numbers. "Fable" is not a model; "Fable 5.1" is.
 * 2. Effort is per agent AND per model. Only Codex has `ultra`; Opus/Sonnet 4.6 have no `xhigh`;
 *    Gemini has no effort command at all (it uses thinkingLevel, LOW/HIGH in the shipped CLI).
 *
 * `ultracode` is deliberately NOT in any effort list. In Claude Code it is a separate session-scoped
 * boolean (`xhigh` + dynamic workflow orchestration) that `CLAUDE_CODE_EFFORT_LEVEL` rejects; Codex's
 * structural equivalent is the real enum member `ultra`. See `supportsUltracode` below.
 *
 * This is a FALLBACK and a display-name map. When an agent reports its own model list at runtime
 * (Codex `model/list`, Claude's `supported_models`), that list wins — only the labels come from here.
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
  /** shown in the picker when we could not verify the catalog (Kimi) */
  unverified?: boolean;
  note?: string;
}

export const CATALOG: Partial<Record<AgentKind, AgentCatalog>> = {
  claude: {
    models: [
      { id: 'claude-fable-5-2', label: 'Fable 5.2', hint: tr('最强，慢、贵'), effort: FIVE },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: tr('复杂任务'), effort: FIVE },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: tr('日常编码'), effort: FIVE },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: tr('快、便宜'), effort: FIVE },
      { id: 'claude-fable-5-1', label: 'Fable 5.1', effort: FIVE, legacy: true },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', effort: FIVE, legacy: true },
      { id: 'claude-opus-5', label: 'Opus 5', effort: FIVE, legacy: true },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', effort: FIVE, legacy: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', effort: FIVE, legacy: true },
      { id: 'claude-fable-5', label: 'Fable 5', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-7', label: 'Opus 4.7', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-6', label: 'Opus 4.6', effort: NO_XHIGH, legacy: true },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', effort: NO_XHIGH, legacy: true },
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', effort: NO_XHIGH, legacy: true },
    ],
    // what the official Claude Code resolves each alias to (2.1.322, measured); ccb is aligned to it. When the
    // account's live model list is known, the newest of each family wins over this (setLiveClaude / aliasTarget)
    aliases: {
      fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5',
      best: 'claude-opus-5-5', opusplan: 'claude-opus-5-5', default: 'claude-opus-5-5',
      'fable[1m]': 'claude-fable-5-2', 'opus[1m]': 'claude-opus-5-5', 'sonnet[1m]': 'claude-sonnet-5-5',
    },
    effort: FIVE,
    defaultEffort: 'high',
    supportsEffort: true,
    supportsUltracode: true,
  },
  codex: {
    models: [
      { id: 'gpt-5.6-sol', label: '5.6 Sol', hint: tr('旗舰，推荐默认') },
      { id: 'gpt-5.6-terra', label: '5.6 Terra' },
      { id: 'gpt-5.6-luna', label: '5.6 Luna', hint: tr('快') },
      { id: 'gpt-5.6-pro', label: '5.6 Pro', hint: tr('最深推理，慢') },
      { id: 'gpt-5.5', label: '5.5', legacy: true },
      { id: 'gpt-5.3-codex-spark', label: '5.3 Codex Spark', legacy: true },
    ],
    // `ultra` is a real enum member here — Codex's answer to ultracode
    effort: [...FIVE, 'ultra'] as EffortLevel[],
    defaultEffort: 'medium',
    supportsEffort: true,
  },
  gemini: {
    models: [
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
      { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite', hint: tr('快') },
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    ],
    effort: [],
    supportsEffort: false,
    note: tr('Gemini CLI 不能调智能程度：思考深度由它自己的 thinkingLevel 控制，随包 SDK 只有 LOW / HIGH。'),
  },
  qwen: {
    models: [{ id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' }],
    effort: FIVE,
    supportsEffort: true,
    note: tr('官方文档只列出了 qwen3-coder-plus；智能程度会按各家接口的支持情况截断。'),
  },
  kimi: {
    models: [],
    effort: [],
    supportsEffort: false,
    unverified: true,
    note: tr('Kimi CLI 的模型表与智能程度开关未能核实，请以 `kimi --help` / 官方文档为准。'),
  },
};

/**
 * What the official Claude Code (2.1.322, the Agent SDK's bundled binary) resolves the claude.ai login's aliases to —
 * read off its system/init line with `--model <alias>` (2026-11-10): no model / default / opus / best → claude-opus-5-5,
 * sonnet → claude-sonnet-5-5, haiku → claude-haiku-5-5, fable → claude-fable-5-2 — the newest model of each family in
 * the account's `/v1/models`, so once that list is known (setLiveClaude) it decides and this is only the fallback.
 * The bundled ccb 2.8.4 predates the Claude 5 family (default / opus → claude-opus-4-7, sonnet → claude-sonnet-4-6,
 * `fable` passed through literally), so a claude.ai-login session on ccb gets these targets through the CLI's own
 * ANTHROPIC_DEFAULT_*_MODEL variables (ccbAccountEnv — its default follows the opus one) and the aliases ccb lacks are
 * rewritten (ccbModel).
 */
export const OFFICIAL_ALIAS_TARGETS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2' } as const;

type AliasFamily = keyof typeof OFFICIAL_ALIAS_TARGETS;
export interface LiveClaudeModel { id: string; displayName: string }
/** The signed-in account's own model list, newest first (server: usage/claude-live.ts). Null: not known yet. */
let live: LiveClaudeModel[] | null = null;
export function setLiveClaude(models: LiveClaudeModel[] | null | undefined): void { live = models?.length ? models : null; }
const familyOf = (id: string): AliasFamily | null => (/(fable|opus|sonnet|haiku)/.exec(id)?.[1] as AliasFamily | undefined) ?? null;

/** The alias targets: the newest model of each family the account lists, else the measured table. */
export function officialAliasTargets(): Record<AliasFamily, string> {
  const out: Record<AliasFamily, string> = { ...OFFICIAL_ALIAS_TARGETS };
  const seen = new Set<AliasFamily>();
  for (const m of live ?? []) { const f = familyOf(m.id); if (f && !seen.has(f)) { seen.add(f); out[f] = m.id; } }
  return out;
}

/** The model an alias stands for (`fable[1m]` → claude-fable-5-2); a plain id is returned as is. */
export function aliasTarget(agent: AgentKind, id: string): string {
  const c = CATALOG[agent];
  if (agent === 'claude' && live) {
    const base = id.endsWith('[1m]') ? id.slice(0, -4) : id;
    const t = officialAliasTargets();
    if (Object.hasOwn(t, base)) return t[base as AliasFamily];
    if (base === 'best' || base === 'default' || base === 'opusplan') return t.opus;
  }
  return c?.aliases && Object.hasOwn(c.aliases, id) ? c.aliases[id] : id;
}

/** Env for a claude.ai-login session on ccb: its aliases (and its default, which is the opus one) resolve like the official CLI. */
export function ccbAccountEnv(): Record<string, string> {
  const t = officialAliasTargets();
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: t.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: t.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: t.haiku,
  };
}

/** A model for ccb: the aliases it doesn't know (`fable`, `best`, with or without `[1m]`) become the official target; the rest pass. */
export function ccbModel(model: string | undefined): string | undefined {
  if (!model) return model;
  const long = model.endsWith('[1m]');
  const base = long ? model.slice(0, -4) : model;
  const t = officialAliasTargets();
  return base === 'fable' ? `${t.fable}${long ? '[1m]' : ''}` : base === 'best' ? `${t.opus}${long ? '[1m]' : ''}` : model;
}

/** Display name for a model id or alias — falls back to the raw id so unknown models still render. */
export function modelLabel(agent: AgentKind, id: string): string {
  const c = CATALOG[agent];
  if (!c) return id;
  const resolved = aliasTarget(agent, id);
  return c.models.find((m) => m.id === resolved)?.label ?? (agent === 'claude' ? live?.find((m) => m.id === resolved)?.displayName : undefined) ?? id;
}

/** Effort levels a given (agent, model) pair accepts. Empty ⇒ hide the effort control. */
export function effortLevels(agent: AgentKind, model?: string | null): EffortLevel[] {
  const c = CATALOG[agent];
  if (!c || !c.supportsEffort) return [];
  if (!model) return c.effort;
  const resolved = aliasTarget(agent, model);
  return c.models.find((m) => m.id === resolved)?.effort ?? c.effort;
}

/**
 * The account's models worth a place in the picker, newest first: the newest of each family, and every model the
 * catalog does not call legacy. A model Anthropic adds tomorrow shows up here without a release of ours.
 */
function livePicker(): LiveClaudeModel[] {
  const known = CATALOG.claude?.models ?? [];
  const seen = new Set<AliasFamily>();
  return (live ?? []).filter((m) => {
    const f = familyOf(m.id);
    const first = !!f && !seen.has(f);
    if (f) seen.add(f);
    const k = known.find((x) => x.id === m.id);
    return first || (k ? !k.legacy : false);
  });
}

/** Live models missing from a list the CLI reported (its ids and aliases, resolved): appended to the model menu. */
export function liveClaudeExtras(listed: string[]): ModelInfo[] {
  const have = new Set(listed.flatMap((v) => [v, aliasTarget('claude', v)]));
  return livePicker().filter((m) => !have.has(m.id)).map((m) => modelsFor('claude', [{ id: m.id, label: modelLabel('claude', m.id) }])[0]);
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
    const k = known.find((m) => m.id === aliasTarget(agent, id));
    return {
      value: id,
      displayName: label ?? k?.label ?? id,
      description: k?.hint ?? '',
      supportsEffort: !!c?.supportsEffort && effortLevels(agent, id).length > 0,
      supportedEffortLevels: effortLevels(agent, id),
    };
  };
  if (reported?.length) return reported.map((r) => build(r.id, r.label));
  if (agent === 'claude' && live) return livePicker().map((m) => build(m.id, modelLabel('claude', m.id)));
  return known.filter((m) => !m.legacy).map((m) => build(m.id));
}

export function supportsUltracode(agent: AgentKind): boolean {
  return !!CATALOG[agent]?.supportsUltracode;
}

/**
 * Which provider-profile types can drive an agent — what providerEnv / agentLaunch actually wire up.
 * Shared by the model menu (web) and session.setProvider (server), so both refuse the same things.
 */
export function providerTypesFor(agent: AgentKind): ProviderType[] {
  if (agent === 'claude') return ['anthropic', 'openai', 'gemini', 'grok', 'gateway', 'claude-account'];
  if (agent === 'gemini') return ['gemini', 'gateway'];
  return ['openai', 'gateway']; // codex, qwen, kimi, opencode, custom ACP agents: OpenAI-compatible endpoints
}

const AGENT_LABEL: Partial<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', qwen: 'Qwen Code', kimi: 'Kimi CLI', opencode: 'OpenCode' };

/**
 * ccb 2.8.4 decides thinking by the model's name: adaptive for the opus-4-6 / opus-4-7 / sonnet-4-6 it knows, a fixed
 * `budget_tokens` for every other opus / sonnet / haiku. The Claude 5 models came after it, and claude-opus-5-5
 * refuses a budget — 400 "requires adaptive thinking" (aizhongzhuan, 2026-10-01; the official binary sends adaptive
 * and the same key answers). True for the ids ccb would send a budget to that are Claude 5 or later.
 */
export function ccbMisthinks(model: string | undefined): boolean {
  const m = /(?:^|[^a-z])(opus|sonnet|haiku)[-_.]?(\d{1,2})(?!\d)/i.exec(model ?? '');
  return !!m && Number(m[2]) >= 5;
}

/** The model id a provider session actually sends: an alias goes through the profile's family map; ccb's default follows the opus one. */
export function providerModelId(p: { defaultModel?: string; modelMap?: { haiku?: string; sonnet?: string; opus?: string } }, model: string | undefined): string {
  const m = (model || p.defaultModel || '').replace(/\[1m\]$/i, '');
  const map = p.modelMap ?? {};
  if (!m || m === 'default') return map.opus ?? '';
  return (m === 'opus' || m === 'sonnet' || m === 'haiku' ? map[m] : undefined) ?? m;
}

/**
 * The runtime a Claude session on a provider asks for. OpenAI / Gemini / Grok formats exist only in ccb, so a pin to
 * the official binary on one of those is ignored — it is left over from an Anthropic-format past (the probe pins a
 * relay like super-nb to the official binary; switching that provider's format to OpenAI kept the pin, and every
 * model of it then showed greyed out: user report, 「GPT 选不了模型」). With `model` given, an Anthropic-format
 * provider left on automatic runs a model ccb gets wrong (`ccbMisthinks`) on the official binary.
 */
export const preferredRuntime = (p: { type: ProviderType; runtime?: RuntimeKind; defaultModel?: string; modelMap?: { haiku?: string; sonnet?: string; opus?: string } }, model?: string): RuntimeKind | undefined => {
  if (p.type === 'openai' || p.type === 'gemini' || p.type === 'grok') return 'ccb';
  if (p.runtime || model === undefined) return p.runtime;
  return ccbMisthinks(providerModelId(p, model)) ? 'claude' : undefined;
};

/**
 * Why a profile of `type` cannot drive `agent` (null = it can). `runtime` is the engine a Claude session would
 * run on: only ccb speaks OpenAI / Gemini / Grok; the official Claude Code binary (forced per profile, or the
 * silent fallback when ccb is missing) only talks Anthropic — to a relay or through the local gateway.
 */
export function profileFitError(agent: AgentKind, type: ProviderType, runtime?: RuntimeKind): string | null {
  const types = providerTypesFor(agent);
  if (!types.includes(type)) return tr('{agent} 不能用 {type} 类型的供应商（只支持 {types}）', { agent: AGENT_LABEL[agent] ?? agent, type, types: types.join(' / ') });
  if (agent === 'claude' && runtime === 'claude' && (type === 'openai' || type === 'gemini' || type === 'grok')) return tr('官方 Claude Code 只支持 Anthropic 兼容 / 模型网关类型的供应商，{type} 类型要换成 ccb 运行内核（设置 → 账号与登录 → 更多选项）', { type });
  return null;
}

// ---- thinking strength on every model (claude-web-engine; same rules as the engine's effortPlan.ts) ----

/** The Claude-side levels: `ultra` is Codex's own and never goes to the engine. */
export type ClaudeEffort = Exclude<EffortLevel, 'ultra'>;
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
  if (known) return known.filter((l): l is ClaudeEffort => l !== 'ultra');
  return v >= 4.6 && v < 4.7 ? CLAUDE_ORDER.filter((l) => l !== 'xhigh') : CLAUDE_ORDER;
}

type CapsProvider = { type: ProviderType; modelEfforts?: Record<string, { levels: ClaudeEffort[]; default?: ClaudeEffort }>; promptEffortModels?: string[] };
export interface ModelCaps { levels: ClaudeEffort[]; default?: ClaudeEffort; reasoning: boolean; native: boolean }

const baseName = (model: string) => { const m = model.toLowerCase(); return m.slice(m.lastIndexOf('/') + 1); };
/** OpenAI's own reasoning models: o1 / o3 / o4, gpt-5 and every later gpt (the engine's effortPlan.ts / requestBody.ts have the same rule). */
export const OPENAI_REASONING = /^(o[134]|gpt-(?:[5-9]|[1-9]\d))/;
/**
 * Kimi's thinking models: k2-thinking, k2.5 and later, k3 and later (k2-instruct does not reason). 2026-10-26 user report:
 * kimi-k3.1-pro through a NewAPI relay never got `reasoning_effort`, so its strength was only ever in the prompt.
 */
const KIMI_REASONING = /kimi-k(?:2[.-]?(?:[5-9]|thinking)|[3-9])/;

/** What the table knows about a model by name (nothing = undefined). */
function tableCaps(model: string): { levels: ClaudeEffort[]; default?: ClaudeEffort } | undefined {
  const m = model.toLowerCase();
  const v = claudeVersion(model);
  if (v !== undefined) return { levels: claudeLevels(model, v) };
  if (m.includes('deepseek')) return { levels: ['low', 'high', 'max'], default: 'high' };
  if (OPENAI_REASONING.test(baseName(model))) return { levels: ['low', 'medium', 'high'] };
  if (m.includes('qwq') || m.includes('reasoner')) return { levels: ['low', 'medium', 'high'] };
  if (KIMI_REASONING.test(baseName(model))) return { levels: ['low', 'medium', 'high'] };
  if (m.includes('gemini-3')) return { levels: ['low', 'high'] };
  if (m.includes('gemini-2.5')) return { levels: CLAUDE_ORDER };
  if (m.includes('grok-3-mini')) return { levels: ['low', 'high'] };
  return undefined;
}

const plainId = (model: string) => model.replace(/\[1m\]$/i, '');

/**
 * What a model can do with thinking strength on claude-web-engine: its levels (the provider's model list > our table >
 * all five), whether it reasons, and whether the engine sends the provider's own parameter (`native`) or puts the
 * strength in the prompt. `p` undefined = the Claude account. Same target rules as the engine's effortPlan.ts.
 */
export function modelCaps(p: CapsProvider | undefined, model: string): ModelCaps {
  // the account's list holds aliases (default / opus / sonnet …): the model each stands for
  const aliases = p ? undefined : CATALOG.claude?.aliases;
  const id = aliases?.[model] ?? aliases?.[plainId(model)] ?? plainId(model);
  const declared = p?.modelEfforts?.[model] ?? p?.modelEfforts?.[id];
  const table = tableCaps(id);
  const type = p?.type ?? 'anthropic';
  // an OpenAI-format model nobody describes: the standard reasoning_effort values
  const levels = declared?.levels?.length ? declared.levels : table?.levels ?? (type === 'openai' ? OPENAI_LEVELS : CLAUDE_ORDER);
  const def = declared?.default ?? table?.default;
  const reasoning = !!declared?.levels?.length || !!table;
  const lower = id.toLowerCase();
  let native: boolean;
  // 2026-10-26 user report: a relay's log showed which requests carried reasoning_effort, and every model our table
  // did not know (Kimi) never did. So every model on a Claude-format, OpenAI-format or gateway profile gets the
  // parameter; a model that refuses it is remembered (promptEffortModels) and goes through the prompt from then on.
  // Gemini and Grok stay by name: the engine picks those targets by name only, and their other models take none.
  if (type === 'anthropic' || type === 'claude-account' || type === 'gateway' || type === 'openai') native = true;
  else if (type === 'gemini') native = lower.includes('gemini-3') || lower.includes('gemini-2.5');
  else native = lower.includes('grok-3-mini');
  if (p?.promptEffortModels?.includes(model) || p?.promptEffortModels?.includes(id)) native = false;
  return { levels, ...(def ? { default: def } : {}), reasoning, native };
}

const OPENAI_LEVELS: ClaudeEffort[] = ['low', 'medium', 'high'];
const NATIVE_FOR_ALL = new Set<ProviderType>(['anthropic', 'claude-account', 'gateway', 'openai']);

/**
 * `CLAUDE_WEB_MODEL_CAPS` for a session: our `modelCaps` verdict for every model — the ones this format sends
 * natively get their levels and "reasons" (the engine sends the parameter only for a model marked so; on an
 * OpenAI-format profile that also turns on the DeepSeek-style thinking switches, which the engine drops for the rest of
 * the process when a model refuses them); the others (one recorded as refusing, a Gemini / Grok model the engine has
 * no target for) get `{native:false}`: the prompt way. On Gemini / Grok profiles a model neither the list nor the table
 * knows is left out (the engine's own name rules cover the same names; `reasoning:false` would switch off its MiMo
 * detection).
 */
export function webCapsEnv(p: CapsProvider | undefined, models: string[]): string {
  const out: Record<string, { levels?: ClaudeEffort[]; default?: ClaudeEffort; reasoning?: boolean; native?: boolean }> = {};
  for (const model of new Set(models.filter(Boolean))) {
    const declared = p?.modelEfforts?.[model];
    const known = NATIVE_FOR_ALL.has(p?.type ?? 'anthropic') || !!declared?.levels?.length || !!tableCaps(plainId(model)) || !!p?.promptEffortModels?.includes(model);
    if (!known) continue;
    const c = modelCaps(p, model);
    out[model] = c.native ? { levels: c.levels, ...(c.default ? { default: c.default } : {}), reasoning: true } : { native: false };
  }
  return JSON.stringify(out);
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

/** What a coding agent should default to, first match wins (then the newest id within it). */
export const CHAT_MODEL_PREFERENCE: RegExp[] = [
  /claude.*sonnet|sonnet.*claude/i, /claude.*opus|opus.*claude/i,
  /^gpt-(?:[5-9]|\d{2})(?!.*(nano|mini|chat|image|audio))/i, /deepseek-(chat|v\d)/i, /kimi-k2/i, /glm-[4-9]\.\d|glm-[5-9]/i,
  /qwen3?-coder/i, /qwen3|qwen-(max|plus)/i, /gemini-[\d.]+-pro/i, /grok-[\d]/i, /deepseek/i, /^gpt-4\.1|^gpt-4o/i,
];

/**
 * A sensible default chat model from an endpoint's list: by `prefer` (Claude first — this is a Claude Code front
 * end — then the known coding-capable families), else the first id that looks like a chat model.
 */
export function pickChatModel(models: string[], prefer: RegExp[] = CHAT_MODEL_PREFERENCE): string | undefined {
  for (const re of prefer) { const m = newestMatch(models, re); if (m) return m; }
  return models.find(isChatModel);
}
