import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';

interface Plugin { id: string; version?: string; scope?: string; enabled?: boolean; manifest?: { name?: string; description?: string }; components?: { skills?: number; commands?: number; agents?: number; hooks?: boolean; mcp?: boolean } }
interface Market { name: string; source?: { source?: string; repo?: string; url?: string; path?: string } }

/** 「3 个 Skill · 2 条命令 · 1 个子代理 · 连接器」 — what a plugin brings, only the parts it has. */
export function pluginParts(c: Plugin['components']): string {
  if (!c) return '';
  const out: string[] = [];
  if (c.skills) out.push(`${c.skills} 个 Skill`);
  if (c.commands) out.push(`${c.commands} 条命令`);
  if (c.agents) out.push(`${c.agents} 个子代理`);
  if (c.hooks) out.push('Hooks');
  if (c.mcp) out.push('连接器');
  return out.join(' · ');
}

/**
 * 插件 on the 扩展 page (spec 2026-10-10-ui-structure §4): the ones installed (on / off, uninstall), installing one
 * by its `name@marketplace`, and the marketplaces they come from. The same requests as the settings page's list
 * (config.plugins / plugin.toggle / plugin.install / plugin.uninstall / marketplaces / marketplace.add).
 */
export function PluginsView() {
  const toast = useStore((s) => s.toast);
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [spec, setSpec] = useState('');
  const [mkSrc, setMkSrc] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const reload = () => {
    ws.request<{ plugins: Plugin[] }>({ kind: 'config.plugins' }).then((r) => setPlugins(r.plugins ?? [])).catch((e) => { setPlugins((p) => p ?? []); toast(e.message); });
    ws.request<{ marketplaces: unknown }>({ kind: 'config.marketplaces' }).then((r) => {
      const m = r.marketplaces;
      setMarkets(Array.isArray(m) ? (m as Market[]) : m && typeof m === 'object' ? Object.entries(m as Record<string, object>).map(([name, v]) => ({ name, ...v })) : []);
    }).catch(() => {});
  };
  useEffect(reload, []);
  const run = async (key: string, req: Record<string, unknown>, said?: string) => {
    setBusy(key);
    try {
      const r = await ws.request<{ code?: number; stderr?: string } | undefined>(req as never);
      if (r && r.code) toast((r.stderr || '').trim().split('\n').pop() || '没有成功');
      else if (said) toast(said, true);
    } catch (e: any) { toast(e.message); }
    setBusy(null);
    reload();
  };

  return (
    <div className="cx">
      <section className="cx-sec" data-id="installed">
        <div className="cx-h"><h3>已安装</h3>{plugins && <span className="n">{plugins.length}</span>}</div>
        <div className="cx-grid one">
          {(plugins ?? []).map((p) => {
            const [name, market] = p.id.split('@');
            const parts = pluginParts(p.components);
            return (
              <div key={p.id} className={clsx('cx-row on', !p.enabled && 'off')} title={p.id}>
                <span className="tile-ic tint-info"><Icon name="artifact" size={18} /></span>
                <span className="cx-tx">
                  <span className="cx-n">{p.manifest?.name ?? name}<span className="cx-ver">{[p.version && `v${p.version}`, market].filter(Boolean).join(' · ')}</span></span>
                  <span className="cx-d">{[p.manifest?.description, parts].filter(Boolean).join(' — ') || '（没有写说明）'}</span>
                </span>
                <button className="icon-btn cx-rm" disabled={!!busy} title="卸载" aria-label={`卸载 ${name}`} onClick={async () => { if (await dlg.confirm(`卸载插件「${p.manifest?.name ?? name}」？`, { danger: true })) void run(`rm:${p.id}`, { kind: 'config.plugin.uninstall', name: p.id }); }}><Icon name="trash" size={15} /></button>
                <button className={clsx('toggle', p.enabled && 'on')} role="switch" aria-checked={!!p.enabled} disabled={!!busy} title={p.enabled ? '停用' : '启用'} aria-label={`${p.enabled ? '停用' : '启用'} ${name}`} onClick={() => void run(`tg:${p.id}`, { kind: 'config.plugin.toggle', name: p.id, enable: !p.enabled })} />
              </div>
            );
          })}
        </div>
        {!plugins && <div className="cx-none">读取中…</div>}
        {plugins && !plugins.length && <div className="cx-none">还没有插件。在下面按「名字@市场」装一个。</div>}
        {plugins && plugins.length > 0 && <div className="cx-hint">启用、停用或安装之后，已经在跑的对话要重新开始才用得上（对话右上角 ··· →「结束进程」，再发一条消息）。</div>}
      </section>

      <section className="cx-sec" data-id="install">
        <div className="cx-h"><h3>安装插件</h3></div>
        <div className="cx-form">
          <input className="field" value={spec} placeholder="名字@市场，例如 superpowers@claude-plugins-official" aria-label="插件" onChange={(e) => setSpec(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && spec.trim()) void run('install', { kind: 'config.plugin.install', spec: spec.trim() }, '装好了').then(() => setSpec('')); }} />
          <button className="btn primary" disabled={!!busy || !spec.trim()} onClick={() => void run('install', { kind: 'config.plugin.install', spec: spec.trim() }, '装好了').then(() => setSpec(''))}>{busy === 'install' ? '安装中…' : '安装'}</button>
        </div>
      </section>

      <section className="cx-sec" data-id="markets">
        <div className="cx-h"><h3>市场</h3><span className="n">{markets.length}</span></div>
        <div className="cx-grid">
          {markets.map((m) => (
            <div key={m.name} className="cx-row">
              <span className="tile-ic tint-ink"><Icon name="library" size={18} /></span>
              <span className="cx-tx"><span className="cx-n">{m.name}</span><span className="cx-d">{m.source?.repo ?? m.source?.url ?? m.source?.path ?? m.source?.source ?? ''}</span></span>
            </div>
          ))}
        </div>
        <div className="cx-form">
          <input className="field" value={mkSrc} placeholder="添加市场：owner/repo、git 地址，或本机的文件夹路径" aria-label="市场来源" onChange={(e) => setMkSrc(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent) && mkSrc.trim()) void run('market', { kind: 'config.marketplace.add', source: mkSrc.trim() }, '已添加').then(() => setMkSrc('')); }} />
          <button className="btn" disabled={!!busy || !mkSrc.trim()} onClick={() => void run('market', { kind: 'config.marketplace.add', source: mkSrc.trim() }, '已添加').then(() => setMkSrc(''))}>{busy === 'market' ? '添加中…' : '添加市场'}</button>
        </div>
      </section>
    </div>
  );
}
