import { useEffect, useMemo, useState } from 'react';
import type { McpHealth, RegistryServer } from '@shared';
import { ws } from '@/ws/client';
import { useScopedSession, useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { mcpChanged, useMcpChanged } from '@/features/panels/ConfigPanel';
import { MCP_CATALOG } from '@/features/settings/mcp-catalog';
import { connectorLook } from './brands';
import { connectorNeeds, connectorStatus, filterCatalog, type Configured } from './connectors-model';

/** A connector's mark in its tile: the service's own, or one of our icons. */
export function ConnectorTile({ id, size = 36 }: { id: string; size?: number }) {
  const look = connectorLook(id);
  const g = Math.round(size * 0.5);
  if (look.brand) {
    return (
      <span className="tile-ic brand" style={{ width: size, height: size, ['--tint' as any]: look.brand.color }}>
        <svg width={g} height={g} viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d={look.brand.path} /></svg>
      </span>
    );
  }
  return <span className={clsx('tile-ic', `tint-${look.tint}`)} style={{ width: size, height: size }}><Icon name={look.icon} size={g} /></span>;
}

type Scope = 'user' | 'project' | 'local';
const SCOPE_LABEL: Record<Scope, string> = { user: '所有项目', project: '这个项目（写进 .mcp.json，跟着仓库走）', local: '这个项目（只在这台电脑）' };

/**
 * 连接器 (spec 2026-10-10-ui-structure §4): what is connected, then a directory to add from — each entry the
 * service's mark, its name, one line, one 「添加」. How an entry is launched (`npx …`, a URL) is a detail: it is the
 * row's tooltip, not its text. Searching the official registry and adding from a JSON config stay reachable at the
 * foot. The same requests as the settings page's MCP list (config.mcp, config.mcp.add / remove, mcp.registry, mcp.health).
 */
export function Connectors() {
  const active = useScopedSession();
  const toast = useStore((s) => s.toast);
  const cwd = active?.cwd;
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('全部');
  const [scope, setScope] = useState<Scope>('user');
  const [configured, setConfigured] = useState<Configured[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [reg, setReg] = useState<RegistryServer[] | null>(null);
  const [regBusy, setRegBusy] = useState(false);
  const [health, setHealth] = useState<Record<string, McpHealth> | null>(null);
  const [hBusy, setHBusy] = useState(false);

  const reload = () => ws.request<{ servers: Configured[] }>({ kind: 'config.mcp' })
    .then((r) => { setConfigured(r.servers ?? []); setErr(''); })
    .catch((e) => { setConfigured((c) => c ?? []); setErr(e.message); });
  useEffect(() => { void reload(); }, []);
  useMcpChanged(() => void reload());

  const names = useMemo(() => new Set((configured ?? []).map((s) => s.name)), [configured]);
  const cats = useMemo(() => ['全部', ...new Set(MCP_CATALOG.map((c) => c.cat))], []);
  const items = useMemo(() => filterCatalog(MCP_CATALOG, { cat, query: q }), [cat, q]);

  const add = async (name: string, json: Record<string, unknown>, env?: string[], oauth?: boolean) => {
    let cfg: Record<string, unknown> = { ...json };
    if (env?.length) {
      const vals: Record<string, string> = {};
      for (const k of env) {
        const v = await dlg.prompt(`「${name}」需要 ${k}`, '', { placeholder: k });
        if (v === null) return;
        if (v) vals[k] = v;
      }
      if (Object.keys(vals).length) cfg = { ...cfg, env: vals };
    }
    setBusy(name);
    try {
      await ws.request({ kind: 'config.mcp.add', name, json: JSON.stringify(cfg), scope, cwd });
      toast(`已添加 ${name}${oauth ? '。第一次用的时候，在对话里输入 /mcp 完成登录' : ''}`, true);
      mcpChanged();
    } catch (e: any) { toast(e.message); }
    setBusy(null);
  };
  const remove = async (name: string) => {
    if (!(await dlg.confirm(`移除连接器「${name}」？`, { danger: true }))) return;
    setBusy(name);
    try { await ws.request({ kind: 'config.mcp.remove', name }); mcpChanged(); } catch (e: any) { toast(e.message); }
    setBusy(null);
  };
  const searchRegistry = async () => {
    if (!q.trim()) return;
    setRegBusy(true);
    try { setReg(await ws.request<RegistryServer[]>({ kind: 'mcp.registry', query: q })); } catch (e: any) { toast(`官方目录：${e.message}`); setReg([]); }
    setRegBusy(false);
  };
  const checkHealth = async () => {
    setHBusy(true);
    try { const list = await ws.request<McpHealth[]>({ kind: 'mcp.health', cwd }); setHealth(Object.fromEntries(list.map((h) => [h.name, h]))); } catch (e: any) { toast(e.message); }
    setHBusy(false);
  };

  return (
    <div className="cx">
      <div className="cx-bar">
        <label className="cx-search">
          <Icon name="search" size={15} />
          <input value={q} placeholder="搜索连接器…" aria-label="搜索连接器" onChange={(e) => { setQ(e.target.value); setReg(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) void searchRegistry(); }} />
          {q && <button type="button" className="icon-btn xs" aria-label="清除" onClick={() => { setQ(''); setReg(null); }}><Icon name="close" size={12} /></button>}
        </label>
        <label className="cx-scope" title="新加的连接器给谁用">
          <span>添加到</span>
          <select className="field" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
            <option value="user">{SCOPE_LABEL.user}</option>
            <option value="project" disabled={!cwd}>{SCOPE_LABEL.project}</option>
            <option value="local" disabled={!cwd}>{SCOPE_LABEL.local}</option>
          </select>
        </label>
      </div>

      {configured && configured.length > 0 && (
        <section className="cx-sec" data-id="connected">
          <div className="cx-h">
            <h3>已连接</h3>
            <span className="n">{configured.length}</span>
            <span className="grow" />
            <button className="link" disabled={hBusy} title="挨个连一下，看哪个通、哪个要登录" onClick={checkHealth}>{hBusy ? '检查中…' : '检查连接'}</button>
          </div>
          <div className="cx-grid">
            {configured.map((s) => {
              const st = connectorStatus(s, health?.[s.name]);
              return (
                <div key={s.name} className="cx-row on" data-name={s.name} title={s.target}>
                  <ConnectorTile id={s.name} />
                  <span className="cx-tx">
                    <span className="cx-n">{MCP_CATALOG.find((c) => c.id === s.name)?.name ?? s.name}</span>
                    <span className={clsx('cx-st', st.tone)}><span className="cx-dot" />{st.text}</span>
                  </span>
                  <button className="icon-btn cx-rm" disabled={busy === s.name} title="移除" aria-label={`移除 ${s.name}`} onClick={() => void remove(s.name)}><Icon name="trash" size={15} /></button>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {err && <div className="cx-err" role="status"><Icon name="alert" size={14} />读不到已连接的列表：{err}</div>}

      <section className="cx-sec" data-id="directory">
        <div className="cx-h"><h3>目录</h3></div>
        <div className="cx-cats" role="tablist" aria-label="分类">
          {cats.map((c) => <button key={c} role="tab" aria-selected={cat === c} className={clsx('ht', cat === c && 'on')} onClick={() => setCat(c)}>{c}</button>)}
        </div>
        <div className="cx-grid">
          {items.map((c) => {
            const has = names.has(c.id);
            const needs = connectorNeeds(c);
            const j = c.json as { command?: string; args?: string[]; url?: string };
            return (
              <div key={c.id} className={clsx('cx-row', has && 'has')} data-connector={c.id} title={j.command ? `${j.command} ${(j.args ?? []).join(' ')}` : j.url}>
                <ConnectorTile id={c.id} />
                <span className="cx-tx">
                  <span className="cx-n">{c.name}{needs && <span className="cx-need" title={needs.title}>{needs.label}</span>}</span>
                  <span className="cx-d">{c.desc}</span>
                </span>
                {has
                  ? <span className="cx-added" title="已添加"><Icon name="check" size={16} /></span>
                  : <button className="icon-btn cx-add" disabled={busy === c.id} title={`添加 ${c.name}`} aria-label={`添加 ${c.name}`} onClick={() => void add(c.id, c.json, c.env, c.oauth)}>{busy === c.id ? <span className="spinner" /> : <Icon name="plus" size={17} />}</button>}
              </div>
            );
          })}
        </div>
        {!items.length && <div className="cx-none">目录里没有叫「{q}」的。</div>}
      </section>

      <div className="cx-foot">
        {q.trim()
          ? <button className="btn sm" disabled={regBusy} onClick={searchRegistry}><Icon name="search" size={13} />{regBusy ? '搜索中…' : `在官方目录里搜「${q.trim()}」`}</button>
          : <span className="cx-hint">没找到想要的？在上面输入名字，可以到官方目录里搜。</span>}
        <span className="grow" />
        <button className="link" onClick={() => useStore.getState().openSettings({ section: 'mcp-json' })}>用配置手动添加…</button>
      </div>
      {reg && (
        <section className="cx-sec" data-id="registry">
          <div className="cx-h"><h3>官方目录</h3><span className="n">{reg.length}</span></div>
          <div className="cx-grid one">
            {reg.map((r) => {
              const name = r.name.split('/').pop()!.replace(/[^\w.-]/g, '-');
              const has = names.has(name);
              return (
                <div key={r.name} className={clsx('cx-row', has && 'has')} title={r.install ? (r.install.command ? `${r.install.command} ${(r.install.args ?? []).join(' ')}` : r.install.url) : undefined}>
                  <ConnectorTile id={name} />
                  <span className="cx-tx">
                    <span className="cx-n">{r.name}</span>
                    <span className="cx-d">{r.description}</span>
                  </span>
                  {r.repo && <a className="icon-btn" href={r.repo} target="_blank" rel="noreferrer" title="它的仓库" aria-label="仓库"><Icon name="external" size={15} /></a>}
                  {has
                    ? <span className="cx-added" title="已添加"><Icon name="check" size={16} /></span>
                    : <button className="icon-btn cx-add" disabled={!r.install || busy === name} title={r.install ? `添加 ${name}` : '这一项没有可用的安装方式'} aria-label={`添加 ${name}`} onClick={() => r.install && void add(name, r.install.command ? { type: 'stdio', command: r.install.command, args: r.install.args } : { type: r.install.transport, url: r.install.url }, r.install.env)}>{busy === name ? <span className="spinner" /> : <Icon name="plus" size={17} />}</button>}
                </div>
              );
            })}
          </div>
          {!reg.length && <div className="cx-none">官方目录里也没有。</div>}
        </section>
      )}
    </div>
  );
}
