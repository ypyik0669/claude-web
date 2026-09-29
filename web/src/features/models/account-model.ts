// `ui.accountModel`: the Claude account's default model by name, kept with the account it was seen on (re-review
// M-3: Pro and Max have different defaults — after a sign-out or another account signs in, the name is not shown).
// Pure: the store-facing half is account-default.ts.
import type { AccountAuth } from '@/store/auth';
import { OWN_PROVIDER } from './menu';
import { accountDefaultName } from './intelligence';

export const ACCOUNT_MODEL_KEY = 'ui.accountModel';

/** What `ui.accountModel` holds: the name, and the account it was seen on (e-mail, else the plan; absent = unknown). */
export interface AccountModel { name: string; account?: string }

/**
 * Which account a name belongs to: the e-mail, else the plan — hashed (FNV-1a), so meta.json and the diagnostics
 * bundle's copy of it never carry the address; matching is all it is for. Undefined when not known (not checked, or
 * signed out).
 */
export function accountKey(auth: AccountAuth | null | undefined): string | undefined {
  if (!auth?.loggedIn) return undefined;
  const id = auth.email || auth.subscriptionType;
  if (!id) return undefined;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `a${h.toString(16).padStart(8, '0')}`;
}

/** The stored value, either shape: an older build wrote a bare string (its account unknown). */
export function readAccountModel(v: unknown): (AccountModel & { legacy?: true }) | undefined {
  if (typeof v === 'string') return v ? { name: v, legacy: true } : undefined;
  if (v && typeof v === 'object' && typeof (v as AccountModel).name === 'string' && (v as AccountModel).name) {
    const a = (v as AccountModel).account;
    return { name: (v as AccountModel).name, ...(typeof a === 'string' && a ? { account: a } : {}) };
  }
  return undefined;
}

/**
 * The remembered name the chip may show: never when signed out; an older bare string only while signed in (its
 * account is unknown); a recorded account only when it is the one signed in now (not yet checked = no conflict).
 */
export function rememberedAccountModel(settings: Record<string, unknown>, auth: AccountAuth | null | undefined): string | undefined {
  const m = readAccountModel(settings[ACCOUNT_MODEL_KEY]);
  if (!m || auth?.loggedIn === false) return undefined;
  if (m.legacy) return auth?.loggedIn ? m.name : undefined;
  const now = accountKey(auth);
  if (m.account && now && m.account !== now) return undefined;
  return m.name;
}

type InfoLike = { agent?: string; providerId?: string; models?: readonly { value?: string | null; displayName?: string; description?: string }[] } | undefined;

/**
 * What to write after an `open` change, if anything: the default named by a Claude conversation on the account's own
 * login whose info just changed (not every open conversation — reaped ones keep old info, and two CLIs started at
 * different times can name different defaults, which used to write A, B, A… on every event), when it differs from
 * what is stored for this account. Only once the account is known (re-review n-5): a name written before the login
 * check answers would carry no account and show for whoever signs in next — the subscription tries again when `auth`
 * arrives (`accountModelPending`).
 */
export function accountModelUpdate(
  open: Record<string, { info?: InfoLike }>,
  prevOpen: Record<string, { info?: InfoLike }>,
  stored: unknown,
  auth: AccountAuth | null | undefined,
): AccountModel | undefined {
  const account = accountKey(auth);
  if (!account) return undefined;
  const cur = readAccountModel(stored);
  for (const [id, o] of Object.entries(open)) {
    const i = o.info;
    if (!i || i === prevOpen[id]?.info) continue;
    if (!i.models?.length || (i.agent && i.agent !== 'claude') || (i.providerId && i.providerId !== OWN_PROVIDER)) continue;
    const name = accountDefaultName(i.models);
    if (!name) continue;
    if (cur && !cur.legacy && cur.name === name && cur.account === account) return undefined;
    return { name, account };
  }
  return undefined;
}

/**
 * When the account becomes known (the login check answered) after a conversation already named the default: the
 * name its CLI reports now, for this account — what `accountModelUpdate` skipped while the account was unknown.
 */
export function accountModelPending(
  open: Record<string, { info?: InfoLike }>,
  stored: unknown,
  auth: AccountAuth | null | undefined,
): AccountModel | undefined {
  return accountModelUpdate(open, {}, stored, auth);
}
