// Which provider a new Claude conversation on the start page uses when the user has not picked one in the model
// menu. Pure. The composer re-evaluates it while nothing is picked — the settings, the login check and the provider
// list all arrive after the first render, and a provider connected on first run has to show up in the chip at once.
// `startPick` is the same choice for a new conversation opened anywhere else (new-conversation.ts).
import type { AgentKind } from '@shared';

export interface WelcomeProviderInput {
  /** the provider of the last conversation started here ('claude' = the account), from this browser's storage */
  last: string | null;
  /** settings → 供应商 「设为默认」 */
  def?: string;
  /** the Claude account's login (undefined = not known yet) */
  loggedIn?: boolean;
  /** providers a Claude conversation can use right now, in list order */
  usable: string[];
}

/**
 * The last one used (when still usable) → the default → the account, unless the account is known to be logged out
 * and there is a provider to use instead (sending on it would only answer 「Not logged in」).
 */
export function welcomeProvider(i: WelcomeProviderInput): string {
  const ok = (id?: string | null): id is string => !!id && id !== 'claude' && i.usable.includes(id);
  if (ok(i.last)) return i.last;
  if (i.last === 'claude' && i.loggedIn !== false) return 'claude';
  if (ok(i.def)) return i.def;
  if (i.loggedIn === false && i.usable.length) return i.usable[0];
  return 'claude';
}

/** Sending now would go out on the Claude account while it is known to be logged out: connect a model first. */
export function needsModel(o: { provider: string; foreignAgent: boolean; loggedIn?: boolean }): boolean {
  return !o.foreignAgent && o.provider === 'claude' && o.loggedIn === false;
}

/** What the start page's send remembered of the last conversation it started (this browser's storage). */
export interface LastStart {
  /** cw.lastProvider ('claude' = the account, or another agent's own login) */
  provider: string | null;
  /** cw.lastModel ('' = the provider's default) */
  model: string | null;
  /** cw.lastAgent */
  agent: string | null;
}

export interface StartPickInput {
  last: LastStart;
  /** settings → 供应商 「设为默认」 */
  def?: string;
  /** the Claude account's login (undefined = not known yet) */
  loggedIn?: boolean;
  /** providers a Claude conversation can use right now, in list order */
  usable: string[];
  /** the agents this machine has (agents.list) */
  agents: readonly string[];
  /** whether another agent can use provider `id` right now (the model menu's check) */
  usableFor(agent: AgentKind, id: string): boolean;
}

/** What a new conversation starts on: `agent` only for another agent than Claude, `model` only when one is remembered for it. */
export interface StartPick { providerId: string; model?: string; agent?: AgentKind }

/**
 * The start page's chips before anything is picked, as one choice: the agent started last (while this machine still has
 * it); another agent on the provider it used last while it can still use it, else its own login; Claude on
 * welcomeProvider's; the model used last only while it is the same agent and provider (the composer drops it as soon
 * as its provider changes: one provider's model id must never go out to another).
 */
export function startPick(i: StartPickInput): StartPick {
  const other = i.last.agent && i.last.agent !== 'claude' && i.agents.includes(i.last.agent) ? (i.last.agent as AgentKind) : undefined;
  const providerId = other
    ? (i.last.provider && i.last.provider !== 'claude' && i.usableFor(other, i.last.provider) ? i.last.provider : 'claude')
    : welcomeProvider({ last: i.last.provider, def: i.def, loggedIn: i.loggedIn, usable: i.usable });
  const same = providerId === (i.last.provider || 'claude') && (other ?? 'claude') === (i.last.agent || 'claude');
  return { providerId, ...(same && i.last.model ? { model: i.last.model } : {}), ...(other ? { agent: other } : {}) };
}
