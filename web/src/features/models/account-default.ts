// The Claude account's default model, by name, for the model chip (final review §9 #2: the chip says 「Sonnet 5」,
// not 「默认模型」). Only a running Claude conversation on the account's own login knows it (its CLI lists a
// 「Default (recommended)」 entry naming the model), so the last name seen is kept in meta.json — the welcome page
// after a restart (the desktop app's origin changes every start, localStorage would not survive) shows it too —
// with the account it was seen on (account-model.ts, re-review M-3).
import { useStore } from '@/store';
import { accountDefaultName } from './intelligence';
import { ACCOUNT_MODEL_KEY, accountKey, accountModelPending, accountModelUpdate, rememberedAccountModel } from './account-model';

export { ACCOUNT_MODEL_KEY } from './account-model';

/** The chip's account default: what this conversation's CLI says, else the remembered one (for this account). */
export function useAccountDefault(models?: readonly { value?: string | null; displayName?: string; description?: string }[]): string | undefined {
  const remembered = useStore((s) => rememberedAccountModel(s.settings, s.auth));
  return accountDefaultName(models) ?? remembered;
}

/** App mounts this once: a Claude conversation on the account's own login that names the default updates the memory. */
export function installAccountDefault(): () => void {
  let pending: string | null = null;
  return useStore.subscribe((s, prev) => {
    if (!s.metaLoaded) return;
    const stored = s.settings[ACCOUNT_MODEL_KEY];
    // nothing is written while the account is unknown (re-review n-5), so when it becomes known — the login check
    // answering, or meta.json arriving — after a conversation already named the default, that name is written then
    const caughtUp = (!accountKey(prev.auth) && !!accountKey(s.auth)) || !prev.metaLoaded;
    const next = s.open !== prev.open ? accountModelUpdate(s.open, prev.open, stored, s.auth)
      : caughtUp ? accountModelPending(s.open, stored, s.auth)
      : undefined;
    if (!next) return;
    const k = JSON.stringify(next);
    if (k === pending) return;
    pending = k;
    void s.setSetting(ACCOUNT_MODEL_KEY, next).finally(() => { if (pending === k) pending = null; });
  });
}
