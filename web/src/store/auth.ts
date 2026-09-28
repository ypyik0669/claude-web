/** `config.auth` (`claude auth status`), as far as the sidebar's account row reads it. */
export interface AccountAuth { loggedIn?: boolean; email?: string; orgName?: string; subscriptionType?: string; authMethod?: string }

/**
 * Is this `config.auth` reply an answer about the login (a boolean `loggedIn`: signed in, or `claude auth status`'s
 * "not logged in" JSON)? Only those replace the store's `auth`: an engine error, an empty or malformed reply says
 * nothing about the account and must not turn a signed-in row into 「未登录」.
 */
export function isAuthAnswer(a: unknown): a is AccountAuth & { loggedIn: boolean } {
  return !!a && typeof a === 'object' && typeof (a as { loggedIn?: unknown }).loggedIn === 'boolean';
}
