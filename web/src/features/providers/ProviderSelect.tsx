// 「用哪个供应商」 for places that start conversations without the composer (an IM bot). Lists the providers Claude
// can use (same table as the model menu and the server's fitError); the last entry adds one through the quick connect.
import { useStore } from '@/store';
import type { AgentKind, Provider } from '@shared';
import { compatibleTypes, profileUnavailable } from '@/features/models/menu';
import { connectModel } from './ConnectModel';
import { tr } from '@/i18n';
import { Select } from '@/ui/Select';

const ADD = '__add';

/** The providers `agent` can run on, each with why it cannot be picked right now (null = it can). */
export function providerChoices(providers: Provider[], agent: AgentKind, i: Parameters<typeof profileUnavailable>[1]): { p: Provider; why: string | null }[] {
  const types = compatibleTypes(agent);
  return providers.filter((p) => types.includes(p.type)).map((p) => ({ p, why: profileUnavailable(p, { ...i, agent }) }));
}

export function ProviderSelect({ agent, value, onChange, first, own, className = 'field' }: {
  agent: AgentKind;
  /** '' = the first entry (`first`), 'claude' = the account, else a provider id */
  value: string;
  onChange: (v: string) => void;
  /** the '' entry: e.g. 「跟新对话默认一样」 */
  first: { label: string; title?: string };
  /** an explicit 'claude' entry besides `first` (IM: the account even when a default provider exists) */
  own?: string;
  className?: string;
}) {
  const providers = useStore((s) => s.providers);
  const toast = useStore((s) => s.toast);
  const list = providerChoices(providers, agent, { agent });
  // a picked provider that was deleted since: shown as such instead of silently reading as the account
  const missing = value && value !== 'claude' && !providers.some((p) => p.id === value);
  const pick = async (v: string) => {
    if (v !== ADD) return onChange(v);
    const p = await connectModel({ reason: 'settings', makeDefault: false });
    if (!p) return;
    if (!compatibleTypes(agent).includes(p.type)) { toast(tr('「{name}」已添加，但用不了这种格式的供应商', { name: p.name })); return; }
    onChange(p.id);
  };
  const options = [
    { value: '', label: first.label, description: first.title },
    ...(own ? [{ value: 'claude', label: own }] : []),
    ...(missing ? [{ value: '__missing', label: tr('（已删除的供应商）'), disabled: true }] : []),
    ...list.map(({ p, why }) => ({ value: p.id, label: `${p.name}${p.defaultModel ? ` · ${p.defaultModel}` : ''}`, description: why ?? p.baseUrl ?? undefined, disabled: !!why })),
    { value: ADD, label: tr('添加供应商…') },
  ];
  return <Select className={className} value={missing ? '__missing' : value} onValueChange={(v) => void pick(String(v))} options={options} searchable={options.length > 10} aria-label={tr('供应商')} data-provider-select />;
}
