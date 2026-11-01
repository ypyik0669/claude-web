/**
 * The model a conversation's subagents (Task / Agent tool, workflows) run on — `CLAUDE_CODE_SUBAGENT_MODEL`, which
 * the CLI reads before anything else (an agent's own `model:`, the tool's haiku / sonnet / opus). A user's
 * friend ran out of budget with every subagent on the expensive main model (2026-10-14): the main task stays on the
 * main model, the subagents go to a cheaper one.
 *
 * A pick is a whole (provider, model) — `cw-x:<provider id>:<model>`, 'claude' = the account — and has nothing to do
 * with the main model (user, 2026-10-18: 「主模型 / 会话不影响子代理的设置」). It applies while the conversation is on
 * that provider. '' = the same as the main model. Values from before (a plain model id) belonged to the provider
 * they were picked on and are read that way (`fullPick`).
 */
/** meta.json setting: the subagent model new conversations get (a full pick, '' = the main model) */
export const SUBAGENT_DEFAULT = 'subagentModel';
/** meta.json setting before 2026-10-18: provider id → plain model, one default per provider (read when the above is unset) */
export const SUBAGENT_DEFAULTS = 'subagentModels';

export interface SubagentPick { providerId: string; model: string }

export const providerKey = (id: string | undefined): string => (id && id !== 'claude' ? id : 'claude');

const CROSS = 'cw-x:';
export function crossPick(value: string | undefined): SubagentPick | null {
  if (!value || !value.startsWith(CROSS)) return null;
  const rest = value.slice(CROSS.length);
  const i = rest.indexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  try { return { providerId: decodeURIComponent(rest.slice(0, i)), model: rest.slice(i + 1) }; } catch { return null; }
}
export const crossValue = (providerId: string, model: string): string => `${CROSS}${encodeURIComponent(providerKey(providerId))}:${model}`;

/** A pick as a whole (provider, model): a plain id is a model of `providerId` (where it was picked). */
export function fullPick(value: string | undefined, providerId: string | undefined): string {
  if (!value) return '';
  return crossPick(value) ? value : crossValue(providerKey(providerId), value);
}

/** The old per-provider default of `providerId` ('' = none). */
function oldDefault(defaults: unknown, providerId: string | undefined): string {
  if (!defaults || typeof defaults !== 'object') return '';
  const v = (defaults as Record<string, unknown>)[providerKey(providerId)];
  return typeof v === 'string' ? v : '';
}

/** What a conversation's subagents run on: its own pick, else the default for new conversations. */
export function subagentModelFor(o: { recorded?: SubagentPick; settings: Record<string, unknown> | undefined; providerId: string | undefined }): string {
  if (o.recorded && typeof o.recorded.model === 'string') return fullPick(o.recorded.model, o.recorded.providerId);
  const s = o.settings ?? {};
  const global = s[SUBAGENT_DEFAULT];
  if (typeof global === 'string') return global;
  return fullPick(oldDefault(s[SUBAGENT_DEFAULTS], o.providerId), o.providerId);
}

/** The old `subagentModels` map with one provider's default set ('' removes it). */
export function withSubagentDefault(defaults: unknown, providerId: string | undefined, model: string): Record<string, string> {
  const next: Record<string, string> = {};
  if (defaults && typeof defaults === 'object') for (const [k, v] of Object.entries(defaults as Record<string, unknown>)) if (typeof v === 'string' && v) next[k] = v;
  const key = providerKey(providerId);
  if (model) next[key] = model;
  else delete next[key];
  return next;
}

/**
 * The model a pick gives the subagents of a conversation on `mainProviderId`: a model of that provider, as it is.
 * null: the main model — also for a pick made on another provider (there is no route from one provider to another).
 */
export function subagentTarget(value: string | undefined, mainProviderId: string | undefined): string | null {
  if (!value) return null;
  const x = crossPick(value);
  if (!x) return value;
  return providerKey(x.providerId) === providerKey(mainProviderId) ? x.model : null;
}
