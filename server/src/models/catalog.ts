import type { AgentKind, EffortLevel, ModelInfo, ProviderType, RuntimeKind } from '../protocol.js';

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
      { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: '最强，慢、贵', effort: FIVE },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: '复杂任务', effort: FIVE },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: '日常编码', effort: FIVE },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: '日常编码（官方 sonnet 别名）', effort: FIVE },
      { id: 'claude-opus-5', label: 'Opus 5', hint: '复杂任务', effort: FIVE },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: '快、便宜', effort: FIVE },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', effort: FIVE, legacy: true },
      { id: 'claude-fable-5', label: 'Fable 5', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-7', label: 'Opus 4.7', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-6', label: 'Opus 4.6', effort: NO_XHIGH, legacy: true },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', effort: NO_XHIGH, legacy: true },
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', effort: NO_XHIGH, legacy: true },
    ],
    // what the official Claude Code resolves each alias to (OFFICIAL_ALIAS_TARGETS, measured); ccb is aligned to it
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
  codex: {
    models: [
      { id: 'gpt-5.6-sol', label: '5.6 Sol', hint: '旗舰，推荐默认' },
      { id: 'gpt-5.6-terra', label: '5.6 Terra' },
      { id: 'gpt-5.6-luna', label: '5.6 Luna', hint: '快' },
      { id: 'gpt-5.6-pro', label: '5.6 Pro', hint: '最深推理，慢' },
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
      { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite', hint: '快' },
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    ],
    effort: [],
    supportsEffort: false,
    note: 'Gemini CLI 不能调智能程度：思考深度由它自己的 thinkingLevel 控制，随包 SDK 只有 LOW / HIGH。',
  },
  qwen: {
    models: [{ id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus' }],
    effort: FIVE,
    supportsEffort: true,
    note: '官方文档只列出了 qwen3-coder-plus；智能程度会按各家接口的支持情况截断。',
  },
  kimi: {
    models: [],
    effort: [],
    supportsEffort: false,
    unverified: true,
    note: 'Kimi CLI 的模型表与智能程度开关未能核实，请以 `kimi --help` / 官方文档为准。',
  },
};

/**
 * What the official Claude Code (2.1.283, the Agent SDK's bundled binary) resolves the claude.ai login's aliases to —
 * read off its system/init line with `--model <alias>` (2026-09-29): no model / default → claude-opus-5-5[1m] (Max),
 * opus → claude-opus-5-5, sonnet → claude-sonnet-5, haiku → claude-haiku-4-5-20251001, fable / best → claude-fable-5-1.
 * The bundled ccb 2.8.4 predates the Claude 5 family (default / opus → claude-opus-4-7, sonnet → claude-sonnet-4-6,
 * `fable` passed through literally), so a claude.ai-login session on ccb gets these targets through the CLI's own
 * ANTHROPIC_DEFAULT_*_MODEL variables (ccbAccountEnv — its default follows the opus one) and the aliases ccb lacks are
 * rewritten (ccbModel). Re-measure when the SDK's claude binary is upgraded.
 */
export const OFFICIAL_ALIAS_TARGETS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001', fable: 'claude-fable-5-1' } as const;

/** Env for a claude.ai-login session on ccb: its aliases (and its default, which is the opus one) resolve like the official CLI. */
export function ccbAccountEnv(): Record<string, string> {
  return {
    ANTHROPIC_DEFAULT_OPUS_MODEL: OFFICIAL_ALIAS_TARGETS.opus,
    ANTHROPIC_DEFAULT_SONNET_MODEL: OFFICIAL_ALIAS_TARGETS.sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: OFFICIAL_ALIAS_TARGETS.haiku,
  };
}

/** A model for ccb: the aliases it doesn't know (`fable`, `best`, with or without `[1m]`) become the official target; the rest pass. */
export function ccbModel(model: string | undefined): string | undefined {
  if (!model) return model;
  const long = model.endsWith('[1m]');
  const base = long ? model.slice(0, -4) : model;
  return base === 'fable' || base === 'best' ? `${OFFICIAL_ALIAS_TARGETS.fable}${long ? '[1m]' : ''}` : model;
}

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
 * Which provider-profile types can drive an agent — what providerEnv / agentLaunch actually wire up.
 * Shared by the model menu (web) and session.setProvider (server), so both refuse the same things.
 */
export function providerTypesFor(agent: AgentKind): ProviderType[] {
  if (agent === 'claude') return ['anthropic', 'openai', 'gemini', 'grok', 'gateway'];
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
  if (!types.includes(type)) return `${AGENT_LABEL[agent] ?? agent} 不能用 ${type} 类型的供应商（只支持 ${types.join(' / ')}）`;
  if (agent === 'claude' && runtime === 'claude' && (type === 'openai' || type === 'gemini' || type === 'grok')) return `官方 Claude Code 只支持 Anthropic 兼容 / 模型网关类型的供应商，${type} 类型要换成 ccb 运行内核（设置 → 账号与登录 → 更多选项）`;
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
  const hit = /claude[-_.](\d)(?:[-.](\d))?[-_.](?:opus|sonnet|haiku)/.exec(m) ?? /(?:opus|sonnet|haiku)[-_.]?(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?/.exec(m);
  return hit ? Number(`${hit[1]}.${hit[2] ?? 0}`) : undefined;
}

type CapsProvider = { type: ProviderType; modelEfforts?: Record<string, { levels: ClaudeEffort[]; default?: ClaudeEffort }>; promptEffortModels?: string[] };
export interface ModelCaps { levels: ClaudeEffort[]; default?: ClaudeEffort; reasoning: boolean; native: boolean }

const baseName = (model: string) => { const m = model.toLowerCase(); return m.slice(m.lastIndexOf('/') + 1); };
const openAIReasons = (model: string) => { const b = baseName(model); return /^(o[134]|gpt-5)/.test(b) || b.includes('deepseek') || b.includes('qwq') || b.includes('reasoner'); };

/** What the table knows about a model by name (nothing = undefined). */
function tableCaps(model: string): { levels: ClaudeEffort[]; default?: ClaudeEffort } | undefined {
  const m = model.toLowerCase();
  if (claudeVersion(model) !== undefined) return { levels: CLAUDE_ORDER };
  if (m.includes('deepseek')) return { levels: ['low', 'high', 'max'], default: 'high' };
  if (/^(o[134]|gpt-5)/.test(baseName(model))) return { levels: ['low', 'medium', 'high'] };
  if (m.includes('qwq') || m.includes('reasoner')) return { levels: ['low', 'medium', 'high'] };
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
  const id = plainId(model);
  const declared = p?.modelEfforts?.[model] ?? p?.modelEfforts?.[id];
  const table = tableCaps(id);
  const levels = declared?.levels?.length ? declared.levels : table?.levels ?? CLAUDE_ORDER;
  const def = declared?.default ?? table?.default;
  const isClaude = claudeVersion(id) !== undefined;
  const reasoning = !!declared?.levels?.length || !!table;
  const type = p?.type ?? 'anthropic';
  const lower = id.toLowerCase();
  let native: boolean;
  if (type === 'anthropic' || type === 'gateway') native = isClaude || !!declared?.levels?.length;
  else if (type === 'openai') native = !!declared?.levels?.length || openAIReasons(id);
  else if (type === 'gemini') native = lower.includes('gemini-3') || lower.includes('gemini-2.5');
  else native = lower.includes('grok-3-mini');
  if (p?.promptEffortModels?.includes(model) || p?.promptEffortModels?.includes(id)) native = false;
  return { levels, ...(def ? { default: def } : {}), reasoning, native };
}

/**
 * `CLAUDE_WEB_MODEL_CAPS` for a session: only what we know — a model the table and the list say nothing about is left
 * out, so the engine keeps its own name rules for it (sending `reasoning:false` would switch off its MiMo detection;
 * sending five levels would read as "the list declares levels" on a Claude-format relay).
 */
export function webCapsEnv(p: CapsProvider | undefined, models: string[]): string {
  const out: Record<string, { levels?: ClaudeEffort[]; default?: ClaudeEffort; reasoning?: boolean; native?: boolean }> = {};
  for (const model of new Set(models.filter(Boolean))) {
    const declared = p?.modelEfforts?.[model];
    const table = tableCaps(plainId(model));
    const c = modelCaps(p, model);
    const entry: (typeof out)[string] = {};
    if (declared?.levels?.length || table) {
      entry.levels = c.levels;
      if (c.default) entry.default = c.default;
      entry.reasoning = true;
    }
    if (p?.promptEffortModels?.includes(model)) entry.native = false;
    if (Object.keys(entry).length) out[model] = entry;
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
