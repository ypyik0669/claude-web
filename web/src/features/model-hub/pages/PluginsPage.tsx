import { useEffect, useState } from 'react';
import type { PluginInstallCheck, PluginInstallResult, PluginListResult, PluginMarketEntry, PluginMarketStatus, PluginPermissions, PluginView } from '@shared';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { dlg } from '@/ui/dialog';
import { Icon, type IconName } from '@/ui/icons';
import { clsx } from '@/util';
import { tr } from '@/i18n';
import { showHubPage } from '../state';

type PlugTab = 'plugins' | 'core' | 'market';

interface CoreFeature {
  id: string;
  name: string;
  desc: string;
  icon: IconName;
  page: 'privacy' | 'usage' | 'routing' | 'overview';
}

const CORE: CoreFeature[] = [
  { id: 'privacy', name: tr('隐私遮盖'), desc: tr('把密钥、个人信息和自定义词换成占位符，回复里再还原。'), icon: 'shield', page: 'privacy' },
  { id: 'gateway-log', name: tr('网关日志'), desc: tr('记录每次调用的模型、账号、延迟与路由轨迹。'), icon: 'gateway', page: 'usage' },
  { id: 'usage', name: tr('用量统计'), desc: tr('按 Agent / 模型 / 供应商统计 Token 与费用。'), icon: 'usage', page: 'usage' },
  { id: 'routing', name: tr('路由'), desc: tr('路由组、规则、意图判断与实时舞台。'), icon: 'orchestra', page: 'routing' },
  { id: 'sessions', name: tr('对话'), desc: tr('列出本机 Agent 的对话并按项目归档。'), icon: 'chat', page: 'overview' },
];

function permissionTags(p: { permissions: PluginPermissions }): string[] {
  const out: string[] = [];
  if (p.permissions.network?.length) out.push(tr('网络 {n}', { n: p.permissions.network.length }));
  if (p.permissions.fileRead?.length) out.push(tr('读文件 {n}', { n: p.permissions.fileRead.length }));
  if (p.permissions.fileWrite?.length) out.push(tr('写文件 {n}', { n: p.permissions.fileWrite.length }));
  if (p.permissions.secrets?.length) out.push(tr('密钥 {n}', { n: p.permissions.secrets.length }));
  if (p.permissions.childProcess) out.push(tr('启动程序'));
  if (p.permissions.workers) out.push(tr('后台线程'));
  return out;
}

function permissionList(p: PluginView): string {
  const lines: string[] = [];
  if (p.permissions.network?.length) lines.push(tr('能访问：{list}', { list: p.permissions.network.join('、') }));
  if (p.permissions.fileRead?.length) lines.push(tr('能读：{list}', { list: p.permissions.fileRead.join('、') }));
  if (p.permissions.fileWrite?.length) lines.push(tr('能写：{list}', { list: p.permissions.fileWrite.join('、') }));
  if (p.permissions.secrets?.length) lines.push(tr('能取密钥：{list}', { list: p.permissions.secrets.join('、') }));
  if (p.permissions.childProcess) lines.push(tr('能启动别的程序（命令行、可执行文件）'));
  if (p.permissions.workers) lines.push(tr('能开后台线程'));
  return lines.join('\n');
}

function categoryLabel(c: PluginMarketEntry['categories'][number]): string {
  switch (c) {
    case 'provider': return tr('来源');
    case 'middleware': return tr('中间层');
    case 'tool': return tr('工具');
    case 'page': return tr('页面');
    case 'theme': return tr('主题');
  }
}

function MarketCard({ e, installed, busy, installing, onInstall }: { e: PluginMarketEntry; installed: boolean; busy: boolean; installing: boolean; onInstall(): void }) {
  return (
    <div className="hub-card hub-plug">
      <div className="top">
        <span className="hub-ic"><Icon name="puzzle" size={15} /></span>
        <div>
          <h4>{e.name}</h4>
          <div className="hub-meta">{e.author} · v{e.version} · {e.kind === 'declarative' ? tr('声明式 · 只提供来源') : tr('可执行 · 独立进程')}</div>
        </div>
        <span className="hub-grow" />
        <button className="btn sm" disabled={busy || installed} onClick={onInstall}>
          {installed ? tr('已安装') : installing ? tr('安装中…') : tr('安装')}
        </button>
      </div>
      {e.description && <p>{e.description}</p>}
      <div className="hub-row" style={{ flexWrap: 'wrap', marginTop: 2 }}>
        {e.categories.map((c) => <span className="hub-chip" key={c}>{categoryLabel(c)}</span>)}
        {permissionTags(e).map((t) => <span className="hub-chip" key={t}>{t}</span>)}
        {e.hooks.map((h) => <span className="hub-chip" key={h}>{h}</span>)}
      </div>
      <div className="foot">
        <span className="hub-meta">{tr('{n} 次安装', { n: e.downloads })}</span>
        <span className="hub-grow" />
        {e.sha256 && <span className="hub-chip" title={e.sha256}>{tr('有校验值')}</span>}
        {e.verified
          ? <span className="hub-chip green">{tr('已验证')}</span>
          : <span className="hub-chip warn" title={tr('没有用你配置的公钥验证过；安装前会再问一次')}>{tr('未验证')}</span>}
      </div>
    </div>
  );
}

function PluginCard({ p, busy, onToggle, onRemove }: { p: PluginView; busy: boolean; onToggle(): void; onRemove(): void }) {
  return (
    <div className="hub-card hub-plug">
      <div className="top">
        <span className="hub-ic"><Icon name="puzzle" size={15} /></span>
        <div>
          <h4>{p.name}</h4>
          <div className="hub-meta">
            {p.kind === 'declarative' ? tr('声明式 · 只提供来源') : tr('可执行 · 独立进程')}
            {p.version ? ` · v${p.version}` : ''}
          </div>
        </div>
        <span className="hub-grow" />
        <button
          type="button"
          role="switch"
          aria-checked={p.enabled}
          aria-label={tr('{name} 开关', { name: p.name })}
          className={clsx('hub-switch', p.enabled && 'on')}
          disabled={busy}
          onClick={onToggle}
        />
      </div>
      {p.description && <p>{p.description}</p>}
      {p.kind === 'executable' && (
        <div className="hub-row" style={{ flexWrap: 'wrap', marginTop: 2 }}>
          {permissionTags(p).map((t) => <span className="hub-chip" key={t}>{t}</span>)}
          {p.hooks.map((h) => <span className="hub-chip" key={h}>{h}</span>)}
          {p.isolation && <span className="hub-chip">{p.isolation === 'permission' ? tr('权限隔离') : tr('进程隔离')}</span>}
        </div>
      )}
      {p.kind === 'declarative' && <div className="hub-meta">{tr('{sources} 个来源 · {models} 个模型', { sources: p.sources, models: p.models })}</div>}
      {p.error && <div className="hub-meta err" title={p.error}>{p.error}</div>}
      {p.lastOutput && <div className="hub-meta hub-mono" title={p.lastOutput}>{p.lastOutput.slice(0, 160)}</div>}
      <div className="foot">
        <span className={clsx('hub-chip', p.enabled && 'green')}>{p.enabled ? tr('已启用') : tr('已停用')}</span>
        {p.kind === 'executable' && !p.approved && p.enabled && <span className="hub-chip warn">{tr('待确认权限')}</span>}
        <span className="hub-grow" />
        <button className="btn sm ghost danger" disabled={busy} onClick={onRemove}>{tr('删除')}</button>
      </div>
    </div>
  );
}

function unverifiedReason(c: PluginInstallCheck): string {
  switch (c.reason) {
    case 'url': return tr('它是直接从地址下载的，没有可信的签名能证明是谁发布的。');
    case 'file': return tr('它是本机上的一个文件，没有可信的签名能证明是谁发布的。');
    default: return tr('插件市场没有配置公钥，目录和插件包都没法验证。');
  }
}

/**
 * The second confirmation before installing a package no trusted key verified (the server refuses those unless
 * the request says the user acknowledged it). Shows the SHA-256 of the exact bytes that will be installed.
 */
function confirmUnverified(c: PluginInstallCheck): Promise<boolean> {
  const name = c.name ?? c.id ?? c.source;
  const what = c.kind === 'executable'
    ? tr('这是没有经过验证的代码：启用后会在这台电脑上运行，能做它申请的权限允许的一切。只在你信任它的来源时安装。')
    : tr('这是没有经过验证的来源定义：启用后，你的请求和密钥会发到它写的地址。只在你信任它的来源时安装。');
  const lines = [
    what,
    unverifiedReason(c),
    '',
    tr('来源：{source}', { source: c.source }),
    tr('SHA-256：{hash}', { hash: c.sha256 }),
    tr('大小：{size} KB', { size: (c.size / 1024).toFixed(1) }),
  ];
  return dlg.confirm(tr('安装未经验证的插件「{name}」？', { name }), {
    message: lines.join('\n'),
    okLabel: tr('仍然安装'),
    danger: true,
    focusCancel: true,
  });
}

/**
 * 插件 (spec §6.10 / P7): the plugins actually installed under <data>/plugins (declarative sources and sandboxed
 * executables, from PluginService), the core capabilities that are always on, and the remote market (catalog +
 * one-click install).
 */
export function PluginsPage() {
  const toast = useStore((s) => s.toast);
  const [tab, setTab] = useState<PlugTab>('plugins');
  const [list, setList] = useState<PluginListResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [market, setMarket] = useState<PluginMarketStatus | null>(null);
  const [marketUrl, setMarketUrl] = useState('');
  const [marketKey, setMarketKey] = useState('');
  const [marketBusy, setMarketBusy] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [pkgUrl, setPkgUrl] = useState('');
  const [pkgSha, setPkgSha] = useState('');

  const load = async (reload = false) => {
    setBusy(true);
    try {
      setList(await ws.request<PluginListResult>({ kind: reload ? 'plugins.reload' : 'plugins.list' }));
    } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);

  // the market tab reads the cached catalog (no network) whenever it is opened
  useEffect(() => {
    if (tab !== 'market') return;
    let alive = true;
    setMarketBusy(true);
    ws.request<PluginMarketStatus>({ kind: 'plugins.market.status' })
      .then((m) => { if (alive) { setMarket(m); setMarketUrl(m.config.url ?? ''); setMarketKey(m.config.publicKey ?? ''); } })
      .catch((e: any) => { if (alive) toast(e.message); })
      .finally(() => { if (alive) setMarketBusy(false); });
    return () => { alive = false; };
  }, [tab]);

  const saveMarket = async (refresh: boolean) => {
    setMarketBusy(true);
    try {
      const saved = await ws.request<PluginMarketStatus>({ kind: 'plugins.market.set', config: { url: marketUrl.trim(), publicKey: marketKey.trim() } });
      setMarket(saved);
      if (!refresh) { toast(tr('插件市场设置已保存'), true); return; }
      if (!saved.config.url) { toast(tr('先填插件市场地址')); return; }
      const fresh = await ws.request<PluginMarketStatus>({ kind: 'plugins.market.refresh' });
      setMarket(fresh);
      toast(tr('市场已刷新'), true);
    } catch (e: any) { toast(e.message); setMarket((m) => (m ? { ...m, error: e.message } : m)); } finally { setMarketBusy(false); }
  };

  /**
   * Install a package. A verified catalog entry goes straight in; anything else is downloaded and checked first,
   * then confirmed (showing its SHA-256), and installed with that SHA-256 pinned so the confirmed bytes go in.
   */
  const installPackage = async (key: string, input: { id?: string; url?: string; sha256?: string }, verified: boolean): Promise<boolean> => {
    setInstalling(key);
    try {
      let req: { id?: string; url?: string; sha256?: string; acknowledgeUnverified?: boolean } = input;
      if (!verified) {
        const check = await ws.request<PluginInstallCheck>({ kind: 'plugins.install.check', ...input });
        if (!check.verified) {
          if (!(await confirmUnverified(check))) return false;
          req = { ...input, sha256: check.sha256, acknowledgeUnverified: true };
        }
      }
      const res = await ws.request<PluginInstallResult>({ kind: 'plugins.install', ...req });
      setList({ plugins: res.plugins, dir: res.dir, warnings: res.warnings });
      toast(tr('{name} 已安装', { name: res.installed.name }), true);
      return true;
    } catch (err: any) { toast(err.message); return false; } finally { setInstalling(null); }
  };
  const installFromMarket = (e: PluginMarketEntry) => installPackage(e.id, { id: e.id }, e.verified);
  const installFromUrl = async () => {
    const url = pkgUrl.trim();
    if (!url) return;
    const sha256 = pkgSha.trim();
    if (await installPackage(':url', { url, ...(sha256 ? { sha256 } : {}) }, false)) { setPkgUrl(''); setPkgSha(''); }
  };

  const plugins = list?.plugins ?? [];
  const toggle = async (p: PluginView) => {
    if (p.enabled) {
      setBusy(true);
      try { setList(await ws.request<PluginListResult>({ kind: 'plugins.disable', id: p.id })); toast(tr('{name} 已停用', { name: p.name }), true); }
      catch (e: any) { toast(e.message); } finally { setBusy(false); }
      return;
    }
    if (p.kind === 'executable') {
      const extra = permissionList(p);
      const ok = await dlg.confirm(tr('启用 {name}？', { name: p.name }), {
        message: tr('它会作为独立进程运行。{extra}', { extra: extra ? `\n${extra}` : tr('它没有申请额外权限。') }),
        okLabel: tr('启用'),
        danger: !!p.permissions.fileWrite?.length || !!p.permissions.secrets?.length || !!p.permissions.childProcess,
      });
      if (!ok) return;
    }
    setBusy(true);
    try { setList(await ws.request<PluginListResult>({ kind: 'plugins.enable', id: p.id, approve: true })); toast(tr('{name} 已启用', { name: p.name }), true); }
    catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const remove = async (p: PluginView) => {
    if (!(await dlg.confirm(tr('删除插件「{name}」？', { name: p.name }), { message: tr('会删掉目录 {file}；不可恢复。', { file: p.file }), danger: true, okLabel: tr('删除') }))) return;
    setBusy(true);
    try { setList(await ws.request<PluginListResult>({ kind: 'plugins.remove', id: p.id })); toast(tr('已删除'), true); }
    catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const openDir = async () => {
    if (!list?.dir) return;
    try { await ws.request({ kind: 'shell.open', path: list.dir }); } catch (e: any) { toast(e.message); }
  };

  return (
    <div className="hub-body">
      <div className="hub-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <div className="hub-seg" role="tablist" aria-label={tr('插件分类')}>
          <button role="tab" aria-selected={tab === 'plugins'} className={tab === 'plugins' ? 'on' : ''} onClick={() => setTab('plugins')}>{tr('已安装')}</button>
          <button role="tab" aria-selected={tab === 'core'} className={tab === 'core' ? 'on' : ''} onClick={() => setTab('core')}>{tr('核心能力')}</button>
          <button role="tab" aria-selected={tab === 'market'} className={tab === 'market' ? 'on' : ''} onClick={() => setTab('market')}>{tr('市场')}</button>
        </div>
        <span className="hub-grow" />
        <button className="btn sm ghost" disabled={busy} onClick={() => void openDir()}><Icon name="files" size={13} /> {tr('打开插件目录')}</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => void load(true)}><Icon name="refresh" size={13} /> {busy ? tr('刷新中…') : tr('重新加载')}</button>
      </div>

      {tab === 'plugins' && (
        <>
          {list?.warnings?.map((w) => <div className="hub-warn" key={w}><Icon name="alert" size={13} /><span>{w}</span></div>)}
          {plugins.length > 0 ? (
            <div className="hub-plugs">
              {plugins.map((p) => <PluginCard key={p.id} p={p} busy={busy} onToggle={() => void toggle(p)} onRemove={() => void remove(p)} />)}
            </div>
          ) : (
            <div className="hub-empty">
              <b>{list ? tr('还没有安装插件') : tr('正在读取插件…')}</b>
              <span>{tr('声明式插件只提供来源；可执行插件在独立进程里跑，权限要在启用时确认。')}</span>
              <div className="hub-row"><button className="btn sm" onClick={() => void openDir()}><Icon name="files" size={12} /> {tr('打开插件目录')}</button><button className="btn sm ghost" onClick={() => setTab('market')}>{tr('市场')}</button></div>
            </div>
          )}
        </>
      )}

      {tab === 'core' && (
        <div className="hub-plugs">
          {CORE.map((c) => (
            <div className="hub-card hub-plug" key={c.id}>
              <div className="top">
                <span className="hub-ic"><Icon name={c.icon} size={15} /></span>
                <div><h4>{c.name}</h4><div className="hub-meta">{tr('内置')} · {c.id}</div></div>
                <span className="hub-grow" />
                <span className="hub-chip green">{tr('一直启用')}</span>
              </div>
              <p>{c.desc}</p>
              <div className="foot"><span className="hub-meta">{tr('在对应页面设置')}</span><span className="hub-grow" /><button className="btn sm ghost" onClick={() => showHubPage(c.page)}>{tr('打开')}</button></div>
            </div>
          ))}
        </div>
      )}

      {tab === 'market' && (
        <>
        <section className="hub-card">
          <div className="bd">
            <div className="hub-row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
              <label className="field" style={{ flex: '1 1 320px', margin: 0 }}>
                <span>{tr('插件市场地址')}</span>
                <input className="input" value={marketUrl} onChange={(e) => setMarketUrl(e.target.value)} placeholder="https://example.com/plugins.json" spellCheck={false} />
              </label>
              <label className="field" style={{ flex: '1 1 220px', margin: 0 }}>
                <span>{tr('公钥（可选）')}</span>
                <input className="input" value={marketKey} onChange={(e) => setMarketKey(e.target.value)} placeholder={tr('Ed25519 公钥')} spellCheck={false} />
              </label>
            </div>
            <div className="hub-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
              <button className="btn sm" disabled={marketBusy} onClick={() => void saveMarket(true)}><Icon name="refresh" size={13} /> {marketBusy ? tr('刷新中…') : tr('刷新市场')}</button>
              <button className="btn sm ghost" disabled={marketBusy} onClick={() => void saveMarket(false)}>{tr('保存')}</button>
              <span className="hub-grow" />
              {market?.fetchedAt ? <span className="hub-meta">{tr('上次刷新：{time}', { time: new Date(market.fetchedAt).toLocaleString() })}</span> : null}
              {market?.signed && <span className="hub-chip green">{tr('已签名')}</span>}
            </div>
            {market?.error && <div className="hub-warn"><Icon name="alert" size={13} /><span>{market.error}</span></div>}
            {!!market?.errors.length && <div className="hub-warn"><Icon name="alert" size={13} /><span>{tr('目录里有 {n} 个条目没通过检查', { n: market.errors.length })}</span></div>}
            {!market ? (
              <div className="hub-empty" style={{ minHeight: 220, border: 0 }}><b>{tr('正在读取市场…')}</b></div>
            ) : !market.config.url ? (
              <div className="hub-empty" style={{ minHeight: 220, border: 0 }}>
                <b>{tr('还没有设置插件市场')}</b>
                <span>{tr('填一个市场目录地址（https），点「刷新市场」就能看到可安装的插件。也可以直接把插件文件夹放进插件目录。')}</span>
                <div className="hub-row"><button className="btn sm" onClick={() => void openDir()}><Icon name="files" size={12} /> {tr('打开插件目录')}</button></div>
              </div>
            ) : marketBusy && !market?.entries.length ? (
              <div className="hub-empty" style={{ minHeight: 220, border: 0 }}><b>{tr('正在刷新市场…')}</b></div>
            ) : market?.entries.length ? (
              <div className="hub-plugs">
                {market.entries.map((e) => (
                  <MarketCard
                    key={e.id}
                    e={e}
                    installed={plugins.some((p) => p.id === e.id)}
                    busy={installing !== null}
                    installing={installing === e.id}
                    onInstall={() => void installFromMarket(e)}
                  />
                ))}
              </div>
            ) : (
              <div className="hub-empty" style={{ minHeight: 220, border: 0 }}>
                <b>{tr('市场里还没有插件')}</b>
                <span>{tr('点「刷新市场」重新读取目录；如果刚填了地址，先确认地址是 https 的 JSON 目录。')}</span>
                <div className="hub-row"><button className="btn sm" disabled={marketBusy} onClick={() => void saveMarket(true)}><Icon name="refresh" size={12} /> {tr('刷新市场')}</button><button className="btn sm ghost" onClick={() => void openDir()}><Icon name="files" size={12} /> {tr('打开插件目录')}</button></div>
              </div>
            )}
          </div>
        </section>
        <section className="hub-card" style={{ marginTop: 12 }}>
          <div className="bd">
            <div className="hub-row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: '2 1 320px', margin: 0 }}>
                <span>{tr('从地址安装')}</span>
                <input className="input" value={pkgUrl} onChange={(e) => setPkgUrl(e.target.value)} placeholder="https://example.com/plugin.zip" spellCheck={false} />
              </label>
              <label className="field" style={{ flex: '1 1 220px', margin: 0 }}>
                <span>{tr('SHA-256（可选）')}</span>
                <input className="input" value={pkgSha} onChange={(e) => setPkgSha(e.target.value)} placeholder={tr('填了就必须一致')} spellCheck={false} />
              </label>
              <button className="btn sm" disabled={installing !== null || !pkgUrl.trim()} onClick={() => void installFromUrl()}>
                {installing === ':url' ? tr('安装中…') : tr('安装')}
              </button>
            </div>
            <div className="hub-meta" style={{ marginTop: 6 }}>{tr('从地址安装的插件没有经过验证，安装前会显示它的 SHA-256 并再问你一次。')}</div>
          </div>
        </section>
        </>
      )}
    </div>
  );
}
