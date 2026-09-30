// Which provider a new Claude conversation on the start page uses when the user has not picked one in the model
// menu. Pure. The composer re-evaluates it while nothing is picked — the settings, the login check and the provider
// list all arrive after the first render, and a provider connected on first run has to show up in the chip at once.

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
