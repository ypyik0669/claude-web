import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelStatus, Provider, QuotaWindow, SourceSummary, UpstreamAccountView, UpstreamKind } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { useGateway } from '@/features/gateway/state';
import { openAddSource, openAddSourceEntry } from '@/features/gateway/add-source';
import { AddAccountWizard } from '@/features/gateway/AddAccountWizard';
import { ProviderLoginWizard } from '@/features/gateway/ProviderLoginWizard';
import { ImportDialog } from '@/features/providers/ImportDialog';
import { FAMILY_LABEL } from '@/features/gateway/tasks-model';
import { accountsOf, familyModels } from '@/features/gateway/page';
import { canSignIn, signInGemini } from '@/features/gateway/gemini-login';
import { Popover } from '@/features/composer/Popover';
import { dlg } from '@/ui/dialog';
import { Icon, type IconName } from '@/ui/icons';
import { ago, clsx } from '@/util';
import { dateLocale, tr } from '@/i18n';
import { SourceHealthLine } from '@/features/routing/SourceHealthLine';

type HubKind = 'subscription' | 'api' | 'local' | 'custom' | 'remote';
type Tone = '' | 'warn' | 'off';
interface QuotaBit { label: string; pct?: number }

interface HubCard {
  id: string;
  name: string;
  kind: HubKind;
  icon?: IconName;
  accounts: UpstreamAccountView[];
  provider?: Provider;
  source?: SourceSummary;
  models: number;
  status: { l: string; c: Tone };
  detail?: string;
  quota: QuotaBit[];
  lastCheck?: number;
  calls: number;
  canRemove?: boolean;
  /** a provider preset that is advertised but not configured yet: the card's primary action is 添加 */
  unconfigured?: boolean;
  free?: boolean | 'some';
}

const KIND_LABEL: Record<HubKind, string> = {
  subscription: tr('订阅'),
  api: tr('API Key'),
  local: tr('本机'),
  custom: tr('自定义'),
  remote: tr('远程'),
};

/** How a preset signs in, in two words (the card's second line). */
const AUTH_LABEL: Record<string, string> = {
  'oauth-loopback': tr('浏览器登录'),
  'device-code': tr('设备码'),
  'paste-token': tr('粘贴令牌'),
  'local-credential': tr('本机登录态'),
  checkin: tr('每日签到'),
  'api-key': tr('API Key'),
  none: tr('无需密钥'),
};

const FILTERS: { id: HubKind | 'all'; label: string; icon: IconName }[] = [
  { id: 'all', label: tr('全部'), icon: 'library' },
  { id: 'subscription', label: tr('订阅'), icon: 'user' },
  { id: 'api', label: tr('API Key'), icon: 'cloud' },
  { id: 'local', label: tr('本机'), icon: 'machine' },
  { id: 'custom', label: tr('自定义'), icon: 'config' },
  { id: 'remote', label: tr('远程'), icon: 'web' },
];

const COLORS = ['#16A34A', '#3B82F6', '#F59E0B', '#8B5CF6', '#EC4899', '#14B8A6', '#64748B'];
const colorOf = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
};
const letters = (name: string) => (name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '?').toUpperCase();
const FAMILY_ICON: Record<UpstreamKind, IconName> = { claude: 'claude', gemini: 'gemini', workbuddy: 'agent', provider: 'cloud' };
const PROVIDER_ICONS: [RegExp, IconName][] = [
  [/gemini/i, 'gemini'], [/claude|anthropic/i, 'claude'], [/kimi|moonshot/i, 'kimi'], [/qwen|dashscope|bailian/i, 'qwen'],
  [/codex|openai/i, 'agent'], [/grok|xai/i, 'sparkle'], [/copilot|github/i, 'files'],
];

/** Provider descriptors whose ids differ from the add-source catalog entry (P2 registry → wizard). */
const CATALOG_ALIAS: Record<string, string> = {
  google: 'google-ai-studio', 'kimi-api': 'moonshot', zhipu: 'zhipu', zai: 'zai', qwen: 'dashscope',
  openrouter: 'openrouter', groq: 'groq', nvidia: 'nvidia-nim', modelscope: 'modelscope', cerebras: 'cerebras',
  siliconflow: 'siliconflow', mistral: 'mistral-free', minimax: 'minimax', stepfun: 'stepfun', fireworks: 'fireworks',
  mimo: 'mimo', anthropic: 'anthropic', deepseek: 'deepseek', ollama: 'ollama', lmstudio: 'lmstudio', openai: 'openai',
  xai: 'xai', together: 'together',
};

/** Descriptor ids that already have a richer family card on this page. */
const FAMILY_DESCRIPTORS = new Set(['gemini', 'workbuddy']);

const usedOf = (w: QuotaWindow): number | undefined => w.usedPct ?? (w.used !== undefined && w.limit ? Math.round((w.used / w.limit) * 100) : undefined);

function quotaBits(accounts: UpstreamAccountView[]): QuotaBit[] {
  const out: QuotaBit[] = [];
  for (const a of accounts) {
    if (!a.enabled) continue;
    for (const w of a.quota?.windows ?? []) out.push({ label: w.label, pct: usedOf(w) });
  }
  return out.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1)).slice(0, 2);
}

function resetIn(ts?: number): string {
  if (!ts) return '';
  const d = ts - Date.now();
  if (d <= 0) return tr('已到期');
  const hours = Math.floor(d / 3_600_000);
  const mins = Math.round((d % 3_600_000) / 60_000);
  if (hours >= 24) return tr('{d} 天 {h} 小时后重置', { d: Math.floor(hours / 24), h: hours % 24 });
  if (hours) return tr('{h} 小时 {m} 分后重置', { h: hours, m: mins });
  return tr('{m} 分钟后重置', { m: mins });
}

/** Which hub filter a saved provider belongs in (the spec's 订阅 / API Key / 本机 / 自定义 / 远程). */
function providerKind(p: Provider): HubKind {
  if (p.type === 'claude-account') return 'subscription';
  const url = (p.baseUrl || '').toLowerCase();
  if (p.type === 'gateway') return /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(url) ? 'local' : 'remote';
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url)) return 'local';
  if (/中转|relay|自定义|custom/i.test(p.name) || /中转|relay/i.test(url)) return 'custom';
  return 'api';
}

const healthOf = (s?: SourceSummary): { l: string; c: Tone } => {
  if (!s) return { l: tr('还没配置'), c: '' };
  if (s.health === 'ready') return { l: tr('可用'), c: '' };
  if (s.health === 'attention') return { l: tr('需要处理'), c: 'warn' };
  if (s.health === 'disabled') return { l: tr('已停用'), c: 'off' };
  return { l: tr('还没配置'), c: '' };
};

function ProviderCard({ c, onOpen, onRefresh, onEdit, onRemove, onAdd }: {
  c: HubCard;
  onOpen(): void;
  onRefresh(): void;
  onEdit(): void;
  onRemove(): void;
  onAdd(): void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const run = (fn: () => void) => () => { setMenu(false); fn(); };
  return (
    <div
      className="hub-card hub-provider"
      data-source={c.id}
      role="button"
      tabIndex={0}
      aria-label={c.name}
      onClick={onOpen}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onOpen(); } }}
    >
      <div className="top">
        <span className="hub-logo" style={{ background: colorOf(c.id) }}>
          {c.icon ? <Icon name={c.icon} size={16} /> : letters(c.name)}
        </span>
        <span className="hub-grow hub-provider-who">
          <h4>{c.name}</h4>
          <span className="hub-meta">
            <span className="hub-chip">{KIND_LABEL[c.kind]}</span>
            {c.free === true && <span className="hub-chip green">{tr('免费')}</span>}
            {c.free === 'some' && <span className="hub-chip green">{tr('部分免费')}</span>}
            {c.accounts.length > 0 && <> · {tr('{n} 个账号', { n: c.accounts.length })}</>}
          </span>
        </span>
        <span className={clsx('hub-status', c.status.c)}><span className="dot" />{c.status.l}</span>
      </div>
      <div className="hub-provider-detail">
        {c.detail && <span className="hub-meta" title={c.detail}>{c.detail}</span>}
        {c.calls > 0 && <span className="hub-meta">{tr('今天 {n} 次调用', { n: c.calls })}</span>}
        {/* 来源健康: probe + 429 cooldown / quota left (features/routing/SourceHealthLine.tsx) */}
        {c.provider && c.provider.type !== 'gateway' && c.provider.type !== 'claude-account' && <SourceHealthLine providerId={c.provider.id} free={!!(c.free || c.source?.free)} />}
      </div>
      {c.quota.length > 0 && (
        <div className="hub-quotas-mini">
          {c.quota.map((q, i) => (
            <div className="hub-quota" key={`${q.label}-${i}`}>
              <div className="l"><span>{q.label}</span><span>{q.pct === undefined ? tr('未知') : `${q.pct}%`}</span></div>
              <div className="hub-bar"><i className={q.pct !== undefined && q.pct > 90 ? 'warn' : ''} style={{ width: `${q.pct ?? 0}%` }} /></div>
            </div>
          ))}
        </div>
      )}
      <div className="foot">
        <span>{c.models ? tr('{n} 个模型', { n: c.models }) : c.unconfigured ? tr('需要添加后读取') : tr('模型待读取')}</span>
        <span>{c.lastCheck ? tr('上次检查 {a}', { a: ago(c.lastCheck) }) : c.source ? tr('还没检查') : ''}</span>
        {c.unconfigured && (
          <button className="btn sm hub-provider-add" onClick={(e) => { e.stopPropagation(); onAdd(); }}>
            <Icon name="plus" size={12} /> {tr('添加')}
          </button>
        )}
      </div>
      <button
        ref={more}
        className="hub-more icon-btn xs"
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label={tr('来源操作')}
        title={tr('更多')}
        onClick={(e) => { e.stopPropagation(); setMenu((v) => !v); }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Icon name="more" size={14} />
      </button>
      {menu && (
        <Popover anchor={more} onClose={() => setMenu(false)} align="right" label={tr('来源操作')}>
          <button data-mi="" role="menuitem" onClick={run(onOpen)}><Icon name="eye" size={13} /> {tr('查看详情')}</button>
          <button data-mi="" role="menuitem" onClick={run(onRefresh)}><Icon name="refresh" size={13} /> {tr('立即刷新')}</button>
          <button data-mi="" role="menuitem" onClick={run(onEdit)}><Icon name="edit" size={13} /> {tr('编辑')}</button>
          {c.canRemove && <button data-mi="" role="menuitem" className="danger" onClick={run(onRemove)}><Icon name="trash" size={13} /> {tr('移除')}</button>}
        </Popover>
      )}
    </div>
  );
}

/** 账号详情 (spec §6.4): the account's windows with reset countdowns, its actions, and this source's recent calls. */
function SourceDetailPanel({ card, onBack, onAdd }: { card: HubCard; onBack(): void; onAdd(): void }) {
  const pools = useGateway((s) => s.pools);
  const logs = useGateway((s) => s.logs);
  const status = useGateway((s) => s.status);
  const providers = useStore((s) => s.providers);
  const openSettings = useStore((s) => s.openSettings);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [addKind, setAddKind] = useState<UpstreamKind | null>(null);
  const provider = card.provider ?? (card.source?.providerId ? providers.find((p) => p.id === card.source?.providerId) : undefined);
  const mine = card.accounts;
  const myPools = useMemo(() => (mine.length ? pools.filter((p) => p.kind === mine[0].kind) : []), [pools, mine]);
  const names = useMemo(() => [...new Set([...mine.map((a) => a.name), ...myPools.map((p) => p.name), ...(card.name ? [card.name] : [])])], [mine, myPools, card.name]);
  const modelIds = useMemo(() => {
    if (card.source?.models.length) return [];
    const kind = mine[0]?.kind;
    if (!kind) return [];
    const own = mine.flatMap((a) => a.models ?? []);
    return [...new Set([...own, ...familyModels(mine.map((a) => a.id), myPools.map((p) => p.id), status?.poolModels)])];
  }, [card.source, mine, myPools, status]);
  const calls = useMemo(() => logs.filter((l) => names.includes(l.member)).slice(0, 8), [logs, names]);
  const enabled = mine.filter((a) => a.enabled).length;
  const load = () => useGateway.getState().load().catch(() => {});

  const run = async (label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try { await fn(); await load(); toast(label, true); return true; }
    catch (e: any) { toast(e.message); return false; }
    finally { setBusy(false); }
  };
  const refresh = () => run(tr('已刷新'), async () => {
    if (card.source && card.source.kind !== 'engine') await ws.request<ChannelStatus>({ kind: 'channels.refresh', id: card.source.id });
    for (const a of mine) await ws.request({ kind: 'upstreams.probe', id: a.id }).catch(() => {});
  });
  const toggleAll = () => run(enabled ? tr('已停用') : tr('已启用'), async () => {
    for (const a of mine) await ws.request({ kind: 'upstreams.update', id: a.id, patch: { enabled: !enabled } });
  });
  const makeDefault = () => run(tr('已设为默认'), async () => {
    if (mine[0]) await ws.request({ kind: 'upstreams.attachDefault', id: mine[0].id });
  });
  const signIn = async (a: UpstreamAccountView) => {
    setBusy(true);
    try {
      const r = await signInGemini({ accountId: a.id, proxyId: a.sidecarProxy?.id });
      if (!r) return;
      await load();
      if (r.account.health === 'ok') toast(tr('登录已更新'), true);
      else toast(tr('登录了，但检查没通过：{e}', { e: r.account.lastError ?? tr('没有登录态') }));
    } catch (e: any) { toast(e.message); }
    finally { setBusy(false); }
  };
  const removeAccount = async (a: UpstreamAccountView) => {
    if (!(await dlg.confirm(tr('删除账号「{name}」？', { name: a.name }), { message: tr('会从所有账号池和网关组里移除，凭据一并删除。'), danger: true, okLabel: tr('删除') }))) return;
    await run(tr('已删除'), () => ws.request({ kind: 'upstreams.remove', id: a.id }));
  };
  const removeSource = async () => {
    if (!card.source?.actions.canRemove) return;
    if (!(await dlg.confirm(tr('移除「{name}」？', { name: card.name }), { danger: true, okLabel: tr('移除') }))) return;
    if (await run(tr('已移除'), () => ws.request({ kind: 'channels.remove', id: card.source!.id }))) onBack();
  };

  return (
    <div className="hub-detail">
      <div className="hub-detail-head">
        <button className="btn sm ghost" onClick={onBack}><Icon name="arrowLeft" size={13} /> {tr('全部来源')}</button>
        <span className="hub-grow" />
        {card.unconfigured && <button className="btn sm" onClick={onAdd}><Icon name="plus" size={12} /> {tr('添加')}</button>}
        <button className="btn sm" disabled={busy} onClick={() => void refresh()}><Icon name="refresh" size={12} /> {busy ? tr('刷新中…') : tr('立即刷新')}</button>
        {mine.length > 0 && <button className="btn sm ghost" disabled={busy} onClick={() => void makeDefault()}>{tr('设为默认')}</button>}
        {card.kind === 'subscription' && mine[0] && mine[0].kind !== 'provider' && (
          <button className="btn sm ghost" disabled={busy} onClick={() => setAddKind(mine[0].kind)}>{tr('添加账号')}</button>
        )}
        {card.kind === 'subscription' && card.source?.providerId && mine[0]?.kind === 'provider' && (
          <button className="btn sm ghost" disabled={busy} onClick={onAdd}>{tr('添加账号')}</button>
        )}
        {provider && <button className="btn sm ghost" onClick={() => openSettings({ section: 'providers' })}>{tr('编辑供应商')}</button>}
        {mine.length > 0 && (
          <button className="btn sm ghost" disabled={busy} onClick={() => void toggleAll()}>{enabled ? tr('全部停用') : tr('全部启用')}</button>
        )}
        {card.canRemove && (
          <button className="btn sm ghost danger" disabled={busy} onClick={() => void removeSource()}>{tr('移除')}</button>
        )}
      </div>

      <div className="hub-detail-title">
        <span className="hub-logo" style={{ background: colorOf(card.id) }}>{card.icon ? <Icon name={card.icon} size={18} /> : letters(card.name)}</span>
        <h3>{card.name}</h3>
        <span className="hub-chip">{KIND_LABEL[card.kind]}</span>
        <span className={clsx('hub-status', card.status.c)}><span className="dot" />{card.status.l}</span>
        {card.detail && <span className="hub-meta" title={card.detail}>{card.detail}</span>}
      </div>

      <div className="hub-kvs">
        <div className="hub-kv"><span className="k">{tr('账号')}</span><span>{mine.length ? tr('{ok} / {n} 个可用', { ok: mine.filter((a) => a.enabled && a.health === 'ok').length, n: mine.length }) : tr('还没有账号')}</span></div>
        <div className="hub-kv"><span className="k">{tr('模型')}</span><span>{card.source?.models.length ? card.source.models.length : modelIds.length || card.models || 0}</span></div>
        {card.lastCheck && <div className="hub-kv"><span className="k">{tr('上次检查')}</span><span>{ago(card.lastCheck)}</span></div>}
        {provider?.baseUrl && <div className="hub-kv"><span className="k">{tr('地址')}</span><span className="hub-mono">{provider.baseUrl}</span></div>}
        {card.source?.docsUrl && <div className="hub-kv"><span className="k">{tr('文档')}</span><a className="link" href={card.source.docsUrl} target="_blank" rel="noreferrer">{card.source.docsUrl}</a></div>}
      </div>

      {mine.length > 0 && (
        <section className="hub-card">
          <div className="hd"><h3>{tr('账号')}</h3><span className="hub-grow" /><span className="hub-muted hub-sml">{tr('所有窗口都显示已用百分比与重置时间')}</span></div>
          <div className="bd hub-accounts">
            {mine.map((a) => {
              const windows = a.quota?.windows ?? [];
              return (
                <div className="hub-account" key={a.id}>
                  <span className="hub-account-who">
                    <b>{a.name}</b>
                    <span className="hub-meta">{a.identity?.email ?? FAMILY_LABEL[a.kind]} · {a.credentialMasked}{a.identity?.plan ? ` · ${a.identity.plan}` : ''}</span>
                    {a.lastError && <span className="hub-meta err" title={a.lastError}>{a.lastError.slice(0, 100)}</span>}
                  </span>
                  <span className="hub-account-windows">
                    {windows.length ? windows.map((w) => {
                      const pct = usedOf(w);
                      return (
                        <span className="hub-window" key={w.id}>
                          <span className="l"><span>{w.label}</span><span>{pct === undefined ? tr('未知') : `${pct}%`}</span></span>
                          <span className="hub-bar"><i className={pct !== undefined && pct > 90 ? 'warn' : ''} style={{ width: `${pct ?? 0}%` }} /></span>
                          <span className="s">{w.resetAt ? resetIn(w.resetAt) : tr('重置时间未知')}</span>
                        </span>
                      );
                    }) : <span className="hub-muted hub-sml">{tr('额度未知')}</span>}
                    {a.quota?.credits && (a.quota.credits.remaining !== undefined || a.quota.credits.total !== undefined) && (
                      <span className="hub-window">
                        <span className="l"><span>{tr('积分')}</span><span>{a.quota.credits.remaining ?? '—'} / {a.quota.credits.total ?? '—'}</span></span>
                      </span>
                    )}
                  </span>
                  <span className={clsx('hub-chip', a.health === 'ok' ? 'green' : a.health === 'cooling' || a.health === 'unknown' ? 'warn' : a.enabled ? 'danger' : '')}>
                    {a.health === 'ok' ? tr('正常') : a.health === 'cooling' ? tr('冷却中') : a.health === 'expired' ? tr('已过期') : a.health === 'disabled' ? tr('已停用') : a.health === 'error' ? tr('出错') : tr('未检查')}
                  </span>
                  <span className="hub-account-actions">
                    <button className="btn sm ghost" disabled={busy} onClick={() => void run(tr('已检查'), () => ws.request({ kind: 'upstreams.probe', id: a.id }))}>{tr('检查')}</button>
                    {a.kind === 'gemini' && canSignIn() && <button className="btn sm ghost" disabled={busy} onClick={() => void signIn(a)}>{tr('重新登录')}</button>}
                    <button className="btn sm ghost" disabled={busy} onClick={() => void run(a.enabled ? tr('已停用') : tr('已启用'), () => ws.request({ kind: 'upstreams.update', id: a.id, patch: { enabled: !a.enabled } }))}>{a.enabled ? tr('停用') : tr('启用')}</button>
                    <button className="icon-btn xs" aria-label={tr('删除账号')} title={tr('删除')} disabled={busy} onClick={() => void removeAccount(a)}><Icon name="trash" size={13} /></button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="hub-card">
        <div className="hd"><h3>{tr('模型')}</h3></div>
        <div className="bd hub-models">
          {card.source?.models.map((m) => (
            <span className="hub-model" key={m.id}>
              <code>{m.id}</code>
              {m.capabilities.tools && <span className="hub-chip">{tr('工具')}</span>}
              {m.capabilities.images && <span className="hub-chip">{tr('图片')}</span>}
              {m.capabilities.reasoning && <span className="hub-chip">{tr('思考')}</span>}
              {m.free && <span className="hub-chip green">{tr('免费')}</span>}
            </span>
          ))}
          {!card.source?.models.length && modelIds.map((id) => <span className="hub-model" key={id}><code>{id}</code></span>)}
          {provider?.models?.length && !card.source?.models.length ? provider.models.map((id) => (
            <span className="hub-model" key={id}>
              <code>{id}</code>
              {provider.modelContext?.[id] && <span className="hub-chip">{`${Math.round(provider.modelContext[id]! / 1000)}K`}</span>}
            </span>
          )) : null}
          {!card.source?.models.length && !modelIds.length && !provider?.models?.length && <div className="hub-empty-inline">{tr('还没读到模型列表。刷新后再看一次。')}</div>}
        </div>
      </section>

      <section className="hub-card">
        <div className="hd"><h3>{tr('最近调用')}</h3><span className="hub-grow" /><span className="hub-muted hub-sml">{tr('只记录模型、状态和耗时，不记录提示词和回复')}</span></div>
        <div className="bd">
          <table className="hub-table">
            <thead><tr><th>{tr('时间')}</th><th>{tr('模型')}</th><th>{tr('状态')}</th><th>{tr('延迟')}</th></tr></thead>
            <tbody>
              {calls.map((l, i) => (
                <tr key={`${l.ts}-${i}`}>
                  <td className="hub-mono">{new Date(l.ts).toLocaleString(dateLocale(), { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td title={l.model}>{l.model}</td>
                  <td><span className={clsx('hub-chip', l.status >= 400 ? 'danger' : 'green')}>{l.status}</span></td>
                  <td className="hub-mono">{l.ms}ms</td>
                </tr>
              ))}
              {!calls.length && <tr><td colSpan={4} className="hub-empty-cell">{tr('还没有记录')}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {addKind && <AddAccountWizard kind={addKind} onClose={() => { setAddKind(null); void load(); }} />}
    </div>
  );
}

/**
 * 上游 (spec §6.2 + §6.4): the filter chips on the left, one card per source built from the saved providers and the
 * upstream accounts, the add-source wizard, and a detail view with each account's quota windows.
 */
export function SourcesPage() {
  const accounts = useGateway((s) => s.accounts);
  const providers = useStore((s) => s.providers);
  const sources = useGateway((s) => s.sources);
  const catalog = useGateway((s) => s.catalog);
  const pools = useGateway((s) => s.pools);
  const status = useGateway((s) => s.status);
  const logs = useGateway((s) => s.logs);
  const loaded = useGateway((s) => s.loaded);
  const toast = useStore((s) => s.toast);
  const openSettings = useStore((s) => s.openSettings);
  const [filter, setFilter] = useState<HubKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loginProvider, setLoginProvider] = useState<{ id: string; name: string } | null>(null);
  const addSource = () => openAddSource(undefined, () => { void useGateway.getState().load().catch(() => {}); });
  /** A preset card's 添加: go straight to its catalog form when one exists, otherwise open the right group. */
  const addCard = (c: HubCard) => {
    const pid = c.source?.providerId ?? '';
    const id = CATALOG_ALIAS[pid] ?? c.source?.catalogId ?? pid;
    if (id && catalog.some((x) => x.id === id)) { openAddSourceEntry(id); return; }
    // a subscription descriptor (Codex / Copilot / OpenCode …): the generic provider-login wizard knows whether a
    // real flow exists and says why when it does not
    if (pid && c.kind === 'subscription') { setLoginProvider({ id: pid, name: c.name }); return; }
    openAddSource(c.kind === 'subscription' ? 'login' : c.kind === 'local' ? 'local' : 'api', () => { void useGateway.getState().load().catch(() => {}); });
  };

  const cards = useMemo<HubCard[]>(() => {
    const out: HubCard[] = [];
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const callsOf = (names: string[]) => logs.filter((l) => l.ts >= todayStart.getTime() && names.includes(l.member)).length;

    for (const kind of ['claude', 'gemini', 'workbuddy'] as const) {
      const mine = accounts.filter((a) => a.kind === kind);
      const src = sources.find((s) => s.upstreamKind === kind || s.id === `upstream:${kind}`);
      const myPools = pools.filter((p) => p.kind === kind);
      const ids = familyModels(mine.map((a) => a.id), myPools.map((p) => p.id), status?.poolModels);
      const names = [...mine.map((a) => a.name), ...myPools.map((p) => p.name), src?.name ?? FAMILY_LABEL[kind]];
      const st: { l: string; c: Tone } = mine.length === 0
        ? { l: tr('未登录'), c: 'off' }
        : src
          ? healthOf(src)
          : mine.some((a) => a.enabled && a.health === 'ok') ? { l: tr('可用'), c: '' } : { l: tr('需要处理'), c: 'warn' };
      out.push({
        id: `family:${kind}`,
        name: FAMILY_LABEL[kind],
        kind: 'subscription',
        icon: FAMILY_ICON[kind],
        accounts: mine,
        source: src,
        models: src?.models.length ? src.models.length : ids.length,
        status: st,
        quota: quotaBits(mine),
        lastCheck: mine.reduce<number | undefined>((t, a) => Math.max(t ?? 0, a.lastOkAt ?? a.quota?.checkedAt ?? 0) || undefined, undefined),
        calls: callsOf(names),
        canRemove: src?.actions.canRemove,
      });
    }

    for (const p of providers) {
      const src = sources.find((s) => s.providerId === p.id);
      const kind = providerKind(p);
      const models = p.models?.length ?? src?.models.length ?? 0;
      out.push({
        id: `provider:${p.id}`,
        name: p.name,
        kind,
        icon: PROVIDER_ICONS.find(([re]) => re.test(p.name) || re.test(p.baseUrl ?? ''))?.[1],
        accounts: [],
        provider: p,
        source: src,
        models,
        status: p.modelsError ? { l: tr('读取失败'), c: 'warn' } : models || src?.health === 'ready' ? { l: tr('可用'), c: '' } : src?.health === 'attention' ? { l: tr('需要处理'), c: 'warn' } : { l: tr('模型待读取'), c: '' },
        detail: p.baseUrl || undefined,
        quota: [],
        lastCheck: p.modelsAt,
        calls: callsOf([p.name, ...(src ? [src.name] : [])]),
        canRemove: src?.actions.canRemove,
      });
    }

    // P2: provider presets that exist before anything is configured — the whole point of 上游 being a catalog.
    for (const s of sources) {
      if (s.kind !== 'provider' || !s.providerKind || out.some((c) => c.id === s.id)) continue;
      if (FAMILY_DESCRIPTORS.has(s.providerId ?? '')) continue;
      const kind: HubKind = s.providerKind === 'subscription' ? 'subscription'
        : s.providerKind === 'local' ? 'local'
          : s.providerKind === 'custom' ? 'custom'
            : s.providerKind === 'remote' ? 'remote' : 'api';
      const mine = accountsOf(s, accounts);
      const models = new Set(mine.flatMap((a) => a.models ?? [])).size;
      out.push({
        id: s.id,
        name: s.name,
        kind,
        icon: PROVIDER_ICONS.find(([re]) => re.test(s.providerId ?? '') || re.test(s.name))?.[1],
        accounts: mine,
        source: s,
        models,
        status: !mine.length ? { l: tr('未配置'), c: 'off' }
          : mine.some((a) => a.enabled && a.health === 'ok') ? { l: tr('可用'), c: '' }
            : { l: tr('需要处理'), c: 'warn' },
        detail: mine.find((a) => a.identity?.email)?.identity?.email ?? AUTH_LABEL[s.auth ?? ''] ?? s.loginHint ?? s.detail,
        quota: quotaBits(mine),
        lastCheck: mine.reduce<number | undefined>((t, a) => Math.max(t ?? 0, a.lastOkAt ?? a.quota?.checkedAt ?? 0) || undefined, undefined),
        calls: callsOf([s.name, ...mine.map((a) => a.name)]),
        canRemove: false,
        unconfigured: !mine.length,
        free: s.free,
      });
    }

    for (const s of sources) {
      if (s.kind !== 'engine') continue;
      out.push({
        id: s.id,
        name: s.name,
        kind: 'local',
        icon: 'machine',
        accounts: [],
        source: s,
        models: s.models.length,
        status: healthOf(s),
        detail: s.engine?.running ? tr('运行中') : s.engine?.installed ? tr('未运行') : tr('未安装'),
        quota: [],
        lastCheck: undefined,
        calls: callsOf([s.name]),
        canRemove: s.actions.canRemove,
      });
    }
    return out;
  }, [accounts, providers, sources, pools, status, logs]);

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: cards.length };
    for (const f of FILTERS) if (f.id !== 'all') m[f.id] = cards.filter((c) => c.kind === f.id).length;
    return m;
  }, [cards]);
  const q = query.trim().toLowerCase();
  const shown = cards.filter((c) => (filter === 'all' || c.kind === filter) && (!q || c.name.toLowerCase().includes(q) || (c.detail ?? '').toLowerCase().includes(q)));
  const card = selected ? cards.find((c) => c.id === selected) : undefined;

  useEffect(() => { if (selected && !card) setSelected(null); }, [selected, card]);

  const refreshCard = async (c: HubCard) => {
    try {
      if (c.source && c.source.kind !== 'engine') await ws.request<ChannelStatus>({ kind: 'channels.refresh', id: c.source.id });
      for (const a of c.accounts) await ws.request({ kind: 'upstreams.probe', id: a.id }).catch(() => {});
      await useGateway.getState().load();
      toast(tr('已刷新'), true);
    } catch (e: any) { toast(e.message); }
  };
  const refreshAll = async () => {
    setBusy(true);
    try {
      for (const s of sources) {
        if (s.kind === 'provider' || s.kind === 'engine') await ws.request<ChannelStatus>({ kind: 'channels.refresh', id: s.id }).catch(() => {});
      }
      for (const a of accounts) await ws.request({ kind: 'upstreams.probe', id: a.id }).catch(() => {});
      await useGateway.getState().load();
      toast(tr('已刷新'), true);
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const editCard = (c: HubCard) => {
    if (c.provider) openSettings({ section: 'providers' });
    else setSelected(c.id);
  };
  const removeCard = async (c: HubCard) => {
    if (!c.source?.actions.canRemove) return;
    if (!(await dlg.confirm(tr('移除「{name}」？', { name: c.name }), { danger: true, okLabel: tr('移除') }))) return;
    try {
      await ws.request({ kind: 'channels.remove', id: c.source.id });
      await useGateway.getState().load();
      toast(tr('已移除'), true);
    } catch (e: any) { toast(e.message); }
  };

  if (card) return <div className="hub-body"><SourceDetailPanel card={card} onBack={() => setSelected(null)} onAdd={() => addCard(card)} /></div>;

  return (
    <div className="hub-body">
      <div className="hub-toolbar">
        <span className="hub-search">
          <Icon name="search" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('搜索来源')} aria-label={tr('搜索来源')} />
        </span>
        <span className="hub-grow" />
        <button className="btn" onClick={addSource}><Icon name="plus" size={13} /> {tr('添加上游')}</button>
        <button className="btn ghost" onClick={() => setImporting(true)}><Icon name="files" size={13} /> {tr('导入…')}</button>
        <button className="btn ghost" disabled={busy} onClick={() => void refreshAll()}><Icon name="refresh" size={13} /> {busy ? tr('刷新中…') : tr('刷新全部')}</button>
      </div>

      <div className="hub-sources">
        <div className="hub-card hub-filters" role="tablist" aria-label={tr('来源分类')}>
          {FILTERS.map((f) => (
            <button key={f.id} data-id={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
              <Icon name={f.icon} size={13} />
              {f.label}
              <span className="n">{counts[f.id] ?? 0}</span>
            </button>
          ))}
        </div>

        <div>
          {!loaded ? (
            <div className="hub-empty"><b>{tr('正在读取来源…')}</b><span>{tr('订阅登录、API Key、本机程序都可以接进来。')}</span></div>
          ) : shown.length > 0 ? (
            <div className="hub-pgrid">
              {shown.map((c) => (
                <ProviderCard
                  key={c.id}
                  c={c}
                  onOpen={() => setSelected(c.id)}
                  onRefresh={() => void refreshCard(c)}
                  onEdit={() => editCard(c)}
                  onRemove={() => void removeCard(c)}
                  onAdd={() => addCard(c)}
                />
              ))}
            </div>
          ) : (
            <div className="hub-empty">
              <b>{loaded ? tr('这一类里还没有来源') : tr('正在读取来源…')}</b>
              <span>{tr('订阅登录、API Key、本机程序都可以接进来。')}</span>
              <button className="btn" onClick={addSource}><Icon name="plus" size={13} /> {tr('添加上游')}</button>
            </div>
          )}
        </div>
      </div>

      {importing && <ImportDialog only="provider" onClose={() => { setImporting(false); void useGateway.getState().load().catch(() => {}); }} />}
      {loginProvider && (
        <ProviderLoginWizard
          providerId={loginProvider.id}
          providerName={loginProvider.name}
          onClose={() => { setLoginProvider(null); void useGateway.getState().load().catch(() => {}); }}
        />
      )}
    </div>
  );
}
