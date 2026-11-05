import { tr } from '@/i18n';

/**
 * `config.auth` (`claude auth status`), as far as the sidebar's account row reads it. `relay`: the server found a relay
 * (base URL / key) in ~/.claude/settings.json or the environment — its host, or 'API Key'.
 */
export interface AccountAuth {
  loggedIn?: boolean; email?: string; orgName?: string; subscriptionType?: string; authMethod?: string; relay?: string;
  /** signed in on paper, but a conversation on it just failed to authenticate (revoked / could not refresh) */
  expired?: boolean; expiredMessage?: string; expiredAt?: number;
}

/**
 * What the built-in Claude Code login is called in model lists and menus: 「Claude 账号」, or — when settings.json points it
 * at a relay — 「Claude Code · 中转 host」 (GitHub issues #5 / #6: the list said 「Claude 账号」 for a relay).
 */
export function ownClaudeName(a: AccountAuth | null | undefined): string {
  return a?.relay ? tr('Claude Code · 中转 {host}', { host: a.relay }) : tr('Claude 账号');
}

/**
 * Is this `config.auth` reply an answer about the login (a boolean `loggedIn`: signed in, or `claude auth status`'s
 * "not logged in" JSON)? Only those replace the store's `auth`: an engine error, an empty or malformed reply says
 * nothing about the account and must not turn a signed-in row into 「未登录」.
 */
export function isAuthAnswer(a: unknown): a is AccountAuth & { loggedIn: boolean } {
  return !!a && typeof a === 'object' && typeof (a as { loggedIn?: unknown }).loggedIn === 'boolean';
}
