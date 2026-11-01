// How much context each model of a provider has (2026-10-14 user report: a relay's Claude compacted at 175K — the
// engines take any model they do not know for 200K — and a GPT relay's 272K was never told to them; aimami lets you
// set it per model). Pure: the session runner turns it into each engine's own switch.
import type { Provider } from '../protocol.js';

/** What both engines assume for a model they know nothing about. */
export const ENGINE_DEFAULT_WINDOW = 200_000;
/** What `[1m]` means to both engines. */
export const ONE_M = 1_000_000;

const CLAUDE = /claude|(?:^|[^a-z])(opus|sonnet|fable)(?:[^a-z]|$)/i;

/**
 * The most a model takes when nobody said otherwise — by its name, for the families whose size is well known
 * ("拉满": Claude through a relay is 1M; GPT is 272K, what the relays serve). Undefined: the engine's own default.
 */
export function knownContextWindow(model: string): number | undefined {
  const m = model.toLowerCase().replace(/\[1m\]$/, '');
  if (/haiku/.test(m)) return ENGINE_DEFAULT_WINDOW;
  if (CLAUDE.test(m)) return ONE_M;
  if (/(?:^|\/)(gpt-[56]|gpt5|codex|o[34](?:-|$))/.test(m)) return 272_000;
  if (/gpt-4\.1/.test(m)) return 1_047_576;
  if (/gemini-(2\.5|[3-9])/.test(m)) return 1_048_576;
  if (/kimi|moonshot|k2/.test(m)) return 256_000;
  if (/qwen3?-coder/.test(m)) return 256_000;
  if (/grok-(4|code)/.test(m)) return 256_000;
  if (/glm-4\.[5-9]|glm-[5-9]/.test(m)) return 200_000;
  // V4 (and the bare -flash / -pro names api.deepseek.com serves it under): 1M, what DeepSeek's own model list says —
  // on 128K a relay's deepseek-v4.1-flash compacted every two minutes and lost its cache (2026-10-19)
  if (/deepseek-(?:v(?:[4-9]|\d{2})|flash(?![a-z])|pro(?![a-z]))/.test(m)) return 1_048_576;
  if (/deepseek/.test(m)) return 128_000;
  return undefined;
}

type WindowProvider = Pick<Provider, 'contextWindows' | 'modelContext'>;

/** A model's window on a provider: what the user set, else what the model list said, else what the name says. */
export function contextWindowFor(p: WindowProvider | undefined, model: string): number | undefined {
  const id = model.replace(/\[1m\]$/i, '');
  const set = p?.contextWindows?.[id];
  if (set && set > 0) return set;
  const listed = p?.modelContext?.[id];
  if (listed && listed >= 16_000) return listed;
  return knownContextWindow(id);
}

/** Where a model's window came from, for the settings page's placeholder. */
export function contextWindowSource(p: WindowProvider | undefined, model: string): 'set' | 'list' | 'known' | 'engine' {
  if (p?.contextWindows?.[model]) return 'set';
  if ((p?.modelContext?.[model] ?? 0) >= 16_000) return 'list';
  return knownContextWindow(model) ? 'known' : 'engine';
}

export const isClaudeModel = (model: string) => CLAUDE.test(model) || /haiku/i.test(model);

/**
 * The official binary has no window setting: a Claude model with more than 200K goes out as `<model>[1m]` (its own
 * opt-in: 1M and the 1M beta header), and anything smaller than what it will assume compacts earlier through
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (it only ever lowers the window).
 */
export function officialWindow(window: number | undefined, model: string): { suffix: boolean; compactWindow?: number } {
  if (!window) return { suffix: false };
  const suffix = isClaudeModel(model) && window > ENGINE_DEFAULT_WINDOW && !/\[1m\]$/i.test(model);
  const assumed = suffix || /\[1m\]$/i.test(model) ? ONE_M : ENGINE_DEFAULT_WINDOW;
  return { suffix, ...(window < assumed ? { compactWindow: window } : {}) };
}

/**
 * Context sizes a model list declares, under the names relays use: OpenRouter `context_length` (also under
 * `top_provider`), Anthropic `max_input_tokens`, Gemini `inputTokenLimit`, others `context_window` /
 * `max_context_length` / `max_model_len` (vLLM).
 */
export function listedContext(m: any): number | undefined {
  if (!m || typeof m !== 'object') return undefined;
  for (const v of [m.context_length, m.max_input_tokens, m.inputTokenLimit, m.context_window, m.max_context_length, m.max_model_len, m.top_provider?.context_length]) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n) && n >= 16_000) return Math.round(n);
  }
  return undefined;
}
