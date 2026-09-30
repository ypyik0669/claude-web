// 「用哪个供应商」 for places that start conversations without the composer: an agent's own default (settings →
// Agents), an IM bot. Lists the providers that agent can use (same table as the model menu and the server's
// fitError); the last entry adds one through the quick connect.
import { useStore } from '@/store';
import type { AgentKind, Provider } from '@shared';
import { compatibleTypes, profileUnavailable } from '@/features/models/menu';
import { useGatewayStatus } from '@/features/models/data';
import { connectModel } from './ConnectModel';

const ADD = '__add';

/** The providers `agent` can run on, each with why it cannot be picked right now (null = it can). */
export function providerChoices(providers: Provider[], agent: AgentKind, i: Parameters<typeof profileUnavailable>[1]): { p: Provider; why: string | null }[] {
  const types = compatibleTypes(agent);
  return providers.filter((p) => types.includes(p.type)).map((p) => ({ p, why: profileUnavailable(p, { ...i, agent }) }));
}

export function ProviderSelect({ agent, value, onChange, first, own, className = 'field' }: {
  agent: AgentKind;
  /** '' = the first entry (`first`), 'claude' = the account / the agent's own login, else a provider id */
  value: string;
  onChange: (v: string) => void;
  /** the '' entry: e.g. 「自己的登录」, 「跟新对话默认一样」 */
  first: { label: string; title?: string };
  /** an explicit 'claude' entry besides `first` (IM: the account even when a default provider exists) */
  own?: string;
  className?: string;
}) {
  const providers = useStore((s) => s.providers);
  const engine = useStore((s) => s.engine);
  const toast = useStore((s) => s.toast);
  const gw = useGatewayStatus();
  const list = providerChoices(providers, agent, { agent, engine, gatewayGroups: gw.groups, gatewayEnabled: gw.enabled });
  // a picked provider that was deleted since: shown as such instead of silently reading as 「自己的登录」
  const missing = value && value !== 'claude' && !providers.some((p) => p.id === value);
  const pick = async (v: string) => {
    if (v !== ADD) return onChange(v);
    const p = await connectModel({ reason: 'settings', makeDefault: false });
    if (!p) return;
    if (!compatibleTypes(agent).includes(p.type)) { toast(`「${p.name}」已添加，但这个 Agent 用不了这种格式的供应商`); return; }
    onChange(p.id);
  };
  return (
    <select className={className} value={missing ? '__missing' : value} onChange={(e) => void pick(e.target.value)} data-provider-select>
      <option value="" title={first.title}>{first.label}</option>
      {own && <option value="claude">{own}</option>}
      {missing && <option value="__missing" disabled>（已删除的供应商）</option>}
      {list.map(({ p, why }) => <option key={p.id} value={p.id} disabled={!!why} title={why ?? p.baseUrl ?? ''}>{p.name}{p.defaultModel ? ` · ${p.defaultModel}` : ''}{why ? `（${why}）` : ''}</option>)}
      <option value={ADD}>添加供应商…</option>
    </select>
  );
}
