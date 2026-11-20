import { useMemo, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import type { ChannelStatus, SourceSummary } from '@shared';
import { useGateway, showSource } from './state';
import { CATEGORY_TEXT, HEALTH_TEXT, accountsOf, familyModels, quotaLeft } from './page';
import { AccountsTab } from './AccountsTab';
import { TasksTab } from './TasksTab';
import { LogsTab } from './LogsTab';
import { SidecarCard } from './SidecarCard';
import { EnginePanel } from './EnginePanel';
import type { EngineId } from '@shared';
import { tr } from '@/i18n';

const ctx = (n?: number) => (n ? (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`) : '');

function Module({ title, note, children, id }: { title: string; note?: string; id: string; children: React.ReactNode }) {
  return (
    <section className="gw-module" data-module={id}>
      <div className="gw-module-head"><b>{title}</b>{note && <span className="sub">{note}</span>}</div>
      {children}
    </section>
  );
}

/**
 * One source, on the same page (← back): its state, accounts, models, upkeep, connection component and its own
 * request log. A provider's settings stay in 设置 → 模型 → 来源 (linked); an account family's live here.
 */
export function SourceDetail({ source }: { source: SourceSummary }) {
  const accounts = useGateway((s) => s.accounts);
  const pools = useGateway((s) => s.pools);
  const sidecars = useGateway((s) => s.sidecars);
  const status = useGateway((s) => s.status);
  const providers = useStore((s) => s.providers);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const kind = source.upstreamKind;
  const mine = useMemo(() => accountsOf(source, accounts), [source, accounts]);
  const myPools = useMemo(() => (kind ? pools.filter((p) => p.kind === kind) : []), [pools, kind]);
  const provider = source.providerId ? providers.find((p) => p.id === source.providerId) : undefined;
  const sidecar = kind && kind !== 'claude' ? sidecars.find((s) => s.id === kind) : undefined;
  const names = useMemo(
    () => (provider ? [provider.name] : [...mine.map((a) => a.name), ...myPools.map((p) => p.name)]),
    [provider, mine, myPools],
  );
  const familyList = [...new Set([
    ...mine.flatMap((a) => a.models ?? []),
    ...(kind ? familyModels(mine.map((a) => a.id), myPools.map((p) => p.id), status?.poolModels) : []),
  ])];
  const lastError = mine.find((a) => a.lastError)?.lastError ?? sidecar?.detail;
  const q = kind ? quotaLeft(mine) : undefined;
  const h = HEALTH_TEXT[source.health];

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await ws.request<ChannelStatus>({ kind: 'channels.refresh', id: source.id });
      useGateway.setState({ sources: r.sources, sourceWarnings: r.warnings });
      await useGateway.getState().load();
      toast(tr('已重新检查'), true);
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const editProvider = () => useStore.getState().openSettings({ section: 'providers' });

  return (
    <div className="gw-detail" data-source={source.id}>
      <div className="gw-detail-head">
        <button className="btn sm ghost" onClick={() => showSource(null)} title={tr('返回 (Esc)')}><Icon name="arrowLeft" size={13} /> {tr('全部来源')}</button>
        <span className="grow" />
        {source.actions.canEditProvider && <button className="btn sm" onClick={editProvider}>{tr('编辑供应商')}</button>}
      </div>
      <div className="gw-detail-title">
        <h3>{source.name}</h3>
        <span className={clsx('gw-status', h.c)}><i />{h.l}</span>
        <span className="sub">{CATEGORY_TEXT[source.category]}</span>
      </div>

      <Module id="status" title={tr('状态')}>
        <div className="gw-kvs">
          {source.detail && <div className="gw-kv"><span className="muted">{tr('说明')}</span><span>{source.detail}</span></div>}
          {source.engine && (
            <div className="gw-kv">
              <span className="muted">{tr('连接组件')}</span>
              <span>{source.engine.running ? tr('运行中') : source.engine.installed ? tr('未运行') : tr('未安装')}{source.engine.version ? ` · v${source.engine.version.replace(/^v/, '')}` : ''}</span>
            </div>
          )}
          {kind && <div className="gw-kv"><span className="muted">{tr('账号')}</span><span>{tr('{ok} / {n} 个可用', { ok: source.healthyAccountCount ?? 0, n: source.accountCount ?? mine.length })}</span></div>}
          {q && <div className="gw-kv"><span className="muted">{tr('剩余额度')}</span><span>{q.pct}%{q.resetAt ? ` · ${tr('{time} 重置', { time: new Date(q.resetAt).toLocaleString() })}` : ''}</span></div>}
          {lastError && <div className="gw-kv"><span className="muted">{tr('最近的错误')}</span><span className="err" title={lastError}>{lastError.slice(0, 200)}</span></div>}
        </div>
      </Module>

      {kind && (
        <Module id="accounts" title={tr('账号')} note={tr('代理、同时请求数和每天上限在每个账号的「编辑」里；账号顺序和模型映射在账号池里。')}>
          <AccountsTab kind={kind} />
        </Module>
      )}

      <Module id="models" title={tr('模型')}>
        {source.models.length > 0 && (
          <div className="gw-models">
            {source.models.map((m) => (
              <div className="gw-model" key={m.id}>
                <code>{m.id}</code>
                {m.name !== m.id && <span className="sub">{m.name}</span>}
                <span className="grow" />
                {m.free && <span className="gw-tag">{tr('免费')}</span>}
                {m.capabilities.tools && <span className="gw-tag">{tr('工具')}</span>}
                {m.capabilities.images && <span className="gw-tag">{tr('图片')}</span>}
                {m.capabilities.reasoning && <span className="gw-tag">{tr('思考')}</span>}
                {m.contextWindow ? <span className="sub">{ctx(m.contextWindow)}</span> : null}
              </div>
            ))}
          </div>
        )}
        {!source.models.length && familyList.length > 0 && (
          <div className="gw-models">{familyList.map((id) => <div className="gw-model" key={id}><code>{id}</code></div>)}</div>
        )}
        {!source.models.length && !familyList.length && <div className="empty">{tr('还没读到模型列表。点下面的「重新检查」再读一次。')}</div>}
        {provider?.modelMap && Object.values(provider.modelMap).some(Boolean) && (
          <div className="gw-kvs" style={{ marginTop: 8 }}>
            {(['opus', 'sonnet', 'haiku'] as const).filter((k) => provider.modelMap?.[k]).map((k) => (
              <div className="gw-kv" key={k}><span className="muted">{tr('{tier} 用', { tier: k })}</span><code>{provider.modelMap?.[k]}</code></div>
            ))}
          </div>
        )}
        {provider && <button className="link" onClick={editProvider}>{tr('改模型和映射…')}</button>}
      </Module>

      {kind && (
        <Module id="tasks" title={tr('每日任务')} note={tr('签到、保活和额度刷新，到点自动跑。')}>
          <TasksTab kind={kind} />
        </Module>
      )}

      {source.kind === 'engine' && (
        <Module id="engine" title={tr('本机程序')} note={tr('它在这台电脑上运行；安装、启动、停止、更新都在这里。')}>
          <EnginePanel id={source.id.slice(7) as EngineId} />
        </Module>
      )}

      {sidecar && (
        <Module id="component" title={tr('连接组件')} note={tr('这类账号靠本机的一个小程序连上去；出口代理也在这里。')}>
          <SidecarCard s={sidecar} />
        </Module>
      )}

      <Module id="diagnostics" title={tr('诊断')}>
        <div className="gateway-row">
          <span className="sub grow">{tr('这个来源最近的请求。')}</span>
          <button className="btn sm" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={12} /> {busy ? tr('检查中…') : tr('重新检查')}</button>
        </div>
        <LogsTab names={names} />
      </Module>
    </div>
  );
}
