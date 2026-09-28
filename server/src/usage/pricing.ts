import type { ProviderType } from '../protocol.js';

// USD per million tokens: [input, output, cacheWrite, cacheRead]. Claude list prices; best-effort estimate.
const CLAUDE_PRICING: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/i, [15, 75, 18.75, 1.5]],
  [/opus/i, [15, 75, 18.75, 1.5]],
  [/sonnet/i, [3, 15, 3.75, 0.3]],
  [/haiku/i, [1, 5, 1.25, 0.1]],
];
const CLAUDE_DEFAULT: [number, number, number, number] = [3, 15, 3.75, 0.3];

export const isClaudeModel = (model: string) => /claude|fable|mythos|opus|sonnet|haiku/i.test(model);

/**
 * Estimated cost of Claude usage. Other vendors' models (gpt-*, deepseek-*, gemini-*, grok-*…) are 0: we keep
 * no price table for them (relays price them their own way), and a Claude price on them is simply wrong.
 */
export function claudePrice(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  if (!isClaudeModel(model)) return 0;
  const p = CLAUDE_PRICING.find(([re]) => re.test(model))?.[1] ?? CLAUDE_DEFAULT;
  return (u.input * p[0] + u.output * p[1] + u.cacheWrite * p[2] + u.cacheRead * p[3]) / 1e6;
}

/**
 * Whether a `result.total_cost_usd` from the CLI means anything. ccb prices EVERY model with Claude's table
 * (an OpenAI-mode session on deepseek shows $5/M input), so for profiles that run a non-Anthropic API
 * (openai / gemini / grok) and for non-Claude model ids the number is dropped (0 = unknown).
 */
export function trustsCliCost(type: ProviderType | undefined, model: string): boolean {
  if (type === 'openai' || type === 'gemini' || type === 'grok') return false;
  return !model || isClaudeModel(model);
}

/**
 * A Claude session's `result` message with an untrustworthy cost: `total_cost_usd` → 0 and `cost_unknown: true`,
 * before the chat, Mission Control, goals, IM and orchestration ever see it (they show nothing for 0; the chat's
 * result row says 费用未知). Mutates and returns the message; anything else passes as is.
 */
export function markUnknownCost<T extends { type?: string; total_cost_usd?: number; modelUsage?: Record<string, unknown>; cost_unknown?: boolean }>(m: T, type: ProviderType | undefined): T {
  if (m?.type !== 'result') return m;
  const models = Object.keys(m.modelUsage ?? {});
  const trusted = models.length ? models.every((x) => trustsCliCost(type, x)) : trustsCliCost(type, '');
  if (!trusted) { m.total_cost_usd = 0; m.cost_unknown = true; }
  return m;
}

/**
 * ccb's Gemini adapter reports `promptTokenCount` (which already includes the cached part) as input_tokens
 * AND the cached part as cache_read_input_tokens — the hit would be counted twice. Other adapters subtract it.
 */
export const inputIncludesCacheRead = (type: ProviderType | undefined) => type === 'gemini';
