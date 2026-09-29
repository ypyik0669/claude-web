// The Claude account's default model, by name, for the model chip (final review §9 #2: the chip says 「Sonnet 5」,
// not 「默认模型」). Only a running Claude conversation on the account's own login knows it (its CLI lists a
// 「Default (recommended)」 entry naming the model), so the last name seen is kept in meta.json — the welcome page
// after a restart (the desktop app's origin changes every start, localStorage would not survive) shows it too.
import { useStore } from '@/store';
import { OWN_PROVIDER } from './menu';
import { accountDefaultName } from './intelligence';

export const ACCOUNT_MODEL_KEY = 'ui.accountModel';

/** The remembered name (a string in meta.json), or undefined. */
export function rememberedAccountModel(settings: Record<string, unknown>): string | undefined {
  const v = settings[ACCOUNT_MODEL_KEY];
  return typeof v === 'string' && v ? v : undefined;
}

/** The chip's account default: what this conversation's CLI says, else the remembered one. */
export function useAccountDefault(models?: readonly { value?: string | null; displayName?: string; description?: string }[]): string | undefined {
  const remembered = useStore((s) => rememberedAccountModel(s.settings));
  return accountDefaultName(models) ?? remembered;
}

/** App mounts this once: a Claude conversation on the account's own login that names the default updates the memory. */
export function installAccountDefault(): () => void {
  let pending: string | null = null;
  return useStore.subscribe((s, prev) => {
    if (s.open === prev.open || !s.metaLoaded) return;
    for (const o of Object.values(s.open)) {
      const i = o.info;
      if (!i?.models?.length || (i.agent && i.agent !== 'claude') || (i.providerId && i.providerId !== OWN_PROVIDER)) continue;
      const name = accountDefaultName(i.models);
      if (!name || name === rememberedAccountModel(s.settings) || name === pending) continue;
      pending = name;
      void s.setSetting(ACCOUNT_MODEL_KEY, name).finally(() => { if (pending === name) pending = null; });
      return;
    }
  });
}
