import type { Provider } from '@shared';
import { modelsFor } from '@catalog';
import { OWN_PROVIDER, providerModelName } from './menu';
import { crossPick, providerKey } from '../../../../server/src/models/subagent';
import { tr } from '@/i18n';

/** What the chip says for a subagent model: just the model on the conversation's own provider, else 「供应商 / 模型」. */
export function subagentLabel(o: { providers: Provider[]; providerId: string; model: string; builtin?: { value: string; displayName: string }[] }): string {
  if (!o.model) return tr('同主模型');
  const x = crossPick(o.model) ?? { providerId: o.providerId, model: o.model };
  const account = providerKey(x.providerId) === OWN_PROVIDER;
  const other = account ? undefined : o.providers.find((p) => p.id === x.providerId);
  const name = account ? o.builtin?.find((m) => m.value === x.model)?.displayName ?? modelsFor('claude', [{ id: x.model }])[0]?.displayName ?? x.model : providerModelName(other, x.model);
  if (providerKey(x.providerId) === providerKey(o.providerId)) return name;
  return `${account ? tr('Claude 账号') : other?.name ?? x.providerId} / ${name}`;
}
