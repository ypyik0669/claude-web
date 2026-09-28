import { useMemo, useState } from 'react';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import { Icon, AGENT_ICONS } from '@/ui/icons';
import { CATALOG, modelsFor } from '@catalog';
import type { AgentKind, Provider } from '@shared';
import { modelTable, profileModels, type ModelRow } from '@/features/models/menu';
import { refreshAllModels, useGatewayGroups, useRefreshRun } from '@/features/models/data';
import { agoText } from '@/features/models/ModelMenu';
import '@/features/models/models.css';
import { TERMS, ULTRACODE, effortLabel, effortTitle } from '@/ui/terms';

/** stable fallback for the selectors below (a fresh `[]` per call re-renders forever: React #185) */
const NONE: string[] = [];

const AGENTS: { kind: AgentKind; name: string }[] = [
  { kind: 'claude', name: 'Claude Code' },
  { kind: 'codex', name: 'Codex' },
  { kind: 'gemini', name: 'Gemini CLI' },
  { kind: 'qwen', name: 'Qwen Code' },
  { kind: 'kimi', name: 'Kimi CLI' },
];

/**
 * Settings → Models. Top: "refresh every profile's model list" and each profile's pull status. Two views:
 * by model (each model once, the profiles that serve it, favourite star, show / hide) and by profile
 * (the built-in lists per agent with their effort ladders, then each profile's models). Hiding
 * (`ui.disabledModels`) and favourites (`ui.favoriteModels`) feed the composer's model menu.
 */
export function ModelsSection() {
  // a selector must return a stable reference: a fresh `[]` per call makes zustand re-render forever (React #185)
  const disabled = useStore((s) => (s.settings['ui.disabledModels'] as string[] | undefined) ?? NONE);
  const favorites = useStore((s) => (s.settings['ui.favoriteModels'] as string[] | undefined) ?? NONE);
  const setSetting = useStore((s) => s.setSetting);
  const providers = useStore((s) => s.providers);
  const toast = useStore((s) => s.toast);
  const groups = useGatewayGroups();
  const refresh = useRefreshRun();
  const [view, setView] = useState<'model' | 'profile'>('model');
  const [q, setQ] = useState('');
  const rows = useMemo(() => modelTable(providers, groups, q), [providers, groups, q]);

  const toggle = (id: string) => void setSetting('ui.disabledModels', disabled.includes(id) ? disabled.filter((x) => x !== id) : [...disabled, id]);
  // a model row covers one key per profile: it is shown / starred when any of them is
  const rowHidden = (r: ModelRow) => r.keys.every((k) => disabled.includes(k));
  const rowFav = (r: ModelRow) => r.keys.some((k) => favorites.includes(k));
  const setRowHidden = (r: ModelRow, hide: boolean) => void setSetting('ui.disabledModels', hide ? [...new Set([...disabled, ...r.keys])] : disabled.filter((k) => !r.keys.includes(k)));
  const setRowFav = (r: ModelRow, on: boolean) => void setSetting('ui.favoriteModels', on ? [...new Set([...favorites, ...r.keys])] : favorites.filter((k) => !r.keys.includes(k)));
  const makeDefault = async (p: Provider, model: string) => {
    if (p.defaultModel === model) return;
    try {
      await ws.request({ kind: 'providers.upsert', provider: { id: p.id, defaultModel: model } });
      toast(`「${p.name}」的默认模型改为 ${model}`, true);
    } catch (e: any) { toast(e.message); }
  };
  const fetchable = providers.filter((p) => p.type !== 'gateway');

  const row = (id: string, l: string, d?: string) => (
    <div key={id} className="row">
      <button className={clsx('toggle', !disabled.includes(id) && 'on')} role="switch" aria-checked={!disabled.includes(id)} aria-label={l} onClick={() => toggle(id)} />
      <div className="grow"><div>{l}</div>{d && <div className="sub">{d}</div>}</div>
    </div>
  );

  return (
    <>
      <div className="models-top">
        <button className="btn sm" onClick={() => void refreshAllModels()} disabled={refresh.running || !fetchable.length} title="拉取每个供应商档案的 /v1/models（只列模型，不花 token）">
          {refresh.running ? <span className="spinner" /> : <Icon name="refresh" size={13} />} {refresh.running ? `刷新中 ${refresh.done}/${refresh.total}` : '刷新全部模型'}
        </button>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={view === 'model'} className={clsx(view === 'model' && 'active')} onClick={() => setView('model')}>按模型</button>
          <button role="tab" aria-selected={view === 'profile'} className={clsx(view === 'profile' && 'active')} onClick={() => setView('profile')}>按档案</button>
        </div>
        {view === 'model' && <input className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索模型或档案…" aria-label="搜索模型" />}
      </div>

      {fetchable.length > 0 && (
        <div className="models-fetch">
          {fetchable.map((p) => {
            const pending = refresh.running && refresh.ids.includes(p.id) && !refresh.results.some((r) => r.id === p.id);
            return (
              <div key={p.id} className="pf">
                <div className="n">
                  <Icon name="cloud" size={12} /><span title={p.name}>{p.name}</span><span className="badge">{p.type}</span>
                  <button className="icon-btn xs" title="只刷新这个档案" aria-label={`刷新 ${p.name}`} disabled={refresh.running} onClick={() => void refreshAllModels([p.id])}>{pending ? <span className="spinner" /> : <Icon name="refresh" size={11} />}</button>
                </div>
                {p.modelsError
                  ? <div className="s err" title={p.modelsError}>拉取失败：{p.modelsError}</div>
                  : <div className="s">{p.models?.length ? `${p.models.length} 个模型` : '还没拉取'}{p.modelsAt ? ` · ${agoText(p.modelsAt)}` : ''}</div>}
              </div>
            );
          })}
        </div>
      )}

      {view === 'model' ? (
        <div className="models-table-wrap">
          <table className="models-table">
            <thead><tr><th>模型</th><th>提供它的档案（点击设为该档案默认）</th><th aria-label="收藏与显示" /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const hidden = rowHidden(r);
                const fav = rowFav(r);
                return (
                  <tr key={r.model} className={clsx(hidden && 'off')}>
                    <td className="name" title={r.model}>{r.model}</td>
                    <td className="provs">
                      {r.providers.map((x) => {
                        const p = providers.find((pp) => pp.id === x.id);
                        return p
                          ? <button key={x.id} className={clsx('prov-chip', x.isDefault && 'def')} title={x.isDefault ? `「${p.name}」的默认模型` : `设为「${p.name}」的默认模型`} onClick={() => void makeDefault(p, r.model)}>{x.isDefault && <Icon name="check" size={10} />}{x.name}</button>
                          : <span key={x.id} className="prov-chip static" title="claude.ai 登录（内置模型，没有默认模型可设）">{x.name}</span>;
                      })}
                    </td>
                    <td className="acts">
                      <button className={clsx('mm-star', fav && 'on')} aria-label={fav ? '取消收藏' : '收藏'} title={fav ? '取消收藏' : '收藏（在模型菜单置顶）'} onClick={() => setRowFav(r, !fav)}><Icon name="star" size={12} /></button>
                      <button className={clsx('toggle', !hidden && 'on')} role="switch" aria-checked={!hidden} aria-label={`显示 ${r.model}`} title={hidden ? '已隐藏' : '在模型菜单显示'} onClick={() => setRowHidden(r, !hidden)} />
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={3} className="empty">{q ? `没有匹配「${q}」的模型` : '还没有模型：加一个供应商档案，然后点「刷新全部模型」'}</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {AGENTS.map(({ kind, name }) => {
            const c = CATALOG[kind];
            const models = modelsFor(kind);
            return (
              <div key={kind} className="section">
                <h5><Icon name={AGENT_ICONS[kind] ?? 'agent'} size={13} /> {name}</h5>
                <div className="list">
                  {models.map((m) => row(kind === 'claude' ? m.value : `${kind}:${m.value}`, m.displayName, m.description || undefined))}
                  {!models.length && <div className="empty">{c?.unverified ? '模型表未核实' : '没有内置模型'}</div>}
                </div>
                <div className="efforts">
                  {c?.supportsEffort && c.effort.length > 0 ? (
                    <>
                      <span className="label">{TERMS.effort}</span>
                      {c.effort.map((e) => <span key={e} className={clsx('badge', e === c.defaultEffort && 'ok')} title={`${effortTitle(e)}${e === c.defaultEffort ? ' · 默认' : ''}`}>{effortLabel(e)}</span>)}
                      {c.supportsUltracode && <span className="badge" title={ULTRACODE.title}><Icon name="bolt" size={10} /> {ULTRACODE.label}</span>}
                    </>
                  ) : (
                    <span className="sub">不能调智能程度</span>
                  )}
                </div>
                {c?.note && <div className="sub" style={{ padding: '2px 4px' }}>{c.note}</div>}
              </div>
            );
          })}
          {providers.map((p) => {
            const models = profileModels(p, groups, providers);
            return (
              <div key={p.id} className="section">
                <h5><Icon name={p.type === 'gateway' ? 'gateway' : 'cloud'} size={13} /> {p.name} <span className="badge">{p.type}</span></h5>
                <div className="list">
                  {models.map((m) => row(`${p.id}:${m}`, m, p.defaultModel === m ? '默认' : undefined))}
                  {!models.length && <div className="empty">{p.type === 'gateway' ? '网关组的成员还没有模型列表' : '点上面的「刷新全部模型」拉取模型列表'}</div>}
                </div>
              </div>
            );
          })}
        </>
      )}
      <div className="sub" style={{ padding: '8px 4px 0' }}>关掉的模型不再出现在输入框的模型菜单里；星标的模型在菜单里置顶。「刷新全部模型」只请求各档案的 <code>/v1/models</code>，不跑对话、不花 token；启动后也会在后台刷新超过 24 小时的列表。模型表与智能程度（effort）档位来自 <code>server/src/models/catalog.ts</code>，agent 自己上报的列表优先。</div>
    </>
  );
}
