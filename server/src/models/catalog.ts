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
      { id: 'claude-opus-5', label: 'Opus 5', hint: '复杂任务', effort: FIVE },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: '日常编码', effort: FIVE },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: '快、便宜', effort: FIVE },
      { id: 'claude-fable-5', label: 'Fable 5', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-7', label: 'Opus 4.7', effort: FIVE, legacy: true },
      { id: 'claude-opus-4-6', label: 'Opus 4.6', effort: NO_XHIGH, legacy: true },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', effort: NO_XHIGH, legacy: true },
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', effort: NO_XHIGH, legacy: true },
    ],
    // the CLI's own alias list, read out of claude.exe
    aliases: {
      fable: 'claude-fable-5-1', opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5',
      best: 'claude-fable-5-1', opusplan: 'claude-opus-5',
      'fable[1m]': 'claude-fable-5-1', 'opus[1m]': 'claude-opus-5', 'sonnet[1m]': 'claude-sonnet-5',
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
 * Why a profile of `type` cannot drive `agent` (null = it can). `runtime` is the engine a Claude session would
 * run on: only ccb speaks OpenAI / Gemini / Grok; the official Claude Code binary (forced per profile, or the
 * silent fallback when ccb is missing) only talks Anthropic — to a relay or through the local gateway.
 */
export function profileFitError(agent: AgentKind, type: ProviderType, runtime?: RuntimeKind): string | null {
  const types = providerTypesFor(agent);
  if (!types.includes(type)) return `${AGENT_LABEL[agent] ?? agent} 不能用 ${type} 类型的档案（只支持 ${types.join(' / ')}）`;
  if (agent === 'claude' && runtime === 'claude' && (type === 'openai' || type === 'gemini' || type === 'grok')) return `官方 Claude Code 引擎只支持 Anthropic 兼容 / 模型网关档案，${type} 类型需要 ccb 引擎`;
  return null;
}
