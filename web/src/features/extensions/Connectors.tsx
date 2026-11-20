import { useEffect, useMemo, useRef, useState } from 'react';
import { ImportDialog } from '@/features/providers/ImportDialog';
import type { McpHealth, RegistryServer } from '@shared';
import { ws } from '@/ws/client';
import { useScopedSession, useStore } from '@/store';
import { clsx } from '@/util';
import { Icon } from '@/ui/icons';
import { dlg } from '@/ui/dialog';
import { imeComposing } from '@/ui/ime';
import { McpAddJson, mcpChanged, useMcpChanged } from '@/features/settings/config-parts';
import { MCP_CATALOG } from '@/features/settings/mcp-catalog';
import { connectorLook } from './brands';
import { McpEditDialog } from './McpEditDialog';
import { useExtensions } from './state';
import { addedMessage, connectorNeeds, connectorStatus, downloadsOnFirstStart, filterCatalog, type Configured } from './connectors-model';
import { tr } from '@/i18n';
import { Select } from '@/ui/Select';

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
const SCOPE_LABEL: Record<Scope, string> = { user: tr('所有项目'), project: tr('这个项目（写进 .mcp.json，跟着仓库走）'), local: tr('这个项目（只在这台电脑）') };

/**
 * 连接器 (spec 2026-10-10-ui-structure §4): what is connected, then a directory to add from — each entry the
 * service's mark, its name, one line, one 「添加」. How an entry is launched (`npx …`, a URL) is a detail: it is the
 * row's tooltip, not its text. Searching the official registry and adding from a JSON config stay reachable at the
 * foot (the JSON form opens under it: since the redesign 2026-11 stage 2 the settings have no MCP page — the old id
 * `mcp-json` opens this tab with the form). Requests: config.mcp, config.mcp.add / remove, mcp.registry, mcp.health.
 */
export function Connectors() {
  const active = useScopedSession();
  const toast = useStore((s) => s.toast);
  const cwd = active?.cwd;
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(tr('全部'));
  const [scope, setScope] = useState<Scope>('user');
  const [configured, setConfigured] = useState<Configured[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [reg, setReg] = useState<RegistryServer[] | null>(null);
  const [regBusy, setRegBusy] = useState(false);
  const [health, setHealth] = useState<Record<string, McpHealth> | null>(null);
  const [hBusy, setHBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // 用配置手动添加…: the JSON form under the foot, opened by the link or asked for from outside (openExtensions json)
  const askJson = useExtensions((s) => s.askJson);
  const [jsonOpen, setJsonOpen] = useState(askJson > 0);
  const jsonRef = useRef<HTMLElement>(null);
  const seenAsk = useRef(askJson);
  useEffect(() => {
    if (askJson === seenAsk.current) return;
    seenAsk.current = askJson;
    setJsonOpen(true);
  }, [askJson]);
  useEffect(() => { if (jsonOpen) jsonRef.current?.scrollIntoView({ block: 'nearest' }); }, [jsonOpen, askJson]);

  const reload = () => ws.request<{ servers: Configured[] }>({ kind: 'config.mcp' })
    .then((r) => { setConfigured(r.servers ?? []); setErr(''); })
    .catch((e) => { setConfigured((c) => c ?? []); setErr(e.message); });
  useEffect(() => { void reload(); }, []);
  useMcpChanged(() => void reload());

  const names = useMemo(() => new Set((configured ?? []).map((s) => s.name)), [configured]);
  const cats = useMemo(() => [tr('全部'), ...new Set(MCP_CATALOG.map((c) => c.cat))], []);
  const items = useMemo(() => filterCatalog(MCP_CATALOG, { cat, query: q }), [cat, q]);

  const add = async (name: string, json: Record<string, unknown>, env?: string[], oauth?: boolean) => {
    let cfg: Record<string, unknown> = { ...json };
    if (env?.length) {
      const vals: Record<string, string> = {};
      for (const k of env) {
        const v = await dlg.prompt(tr('「{name}」需要 {k}', { name, k }), '', { placeholder: k });
        if (v === null) return;
        if (v) vals[k] = v;
      }
      if (Object.keys(vals).length) cfg = { ...cfg, env: vals };
    }
    setBusy(name);
    const key = `mcp-add-${name}`;
    // npx / uvx: the server runs it once so the package is downloaded before the status is asked (up to 2 minutes)
    if (downloadsOnFirstStart(cfg)) toast(tr('正在添加 {name}：第一次启动要先下载，可能要一两分钟…', { name }), true, 130_000, key);
    try {
      const r = await ws.request<{ warm?: { ok: boolean; timedOut?: boolean } }>({ kind: 'config.mcp.add', name, json: JSON.stringify(cfg), scope, cwd });
      toast(addedMessage(name, { oauth, warm: r?.warm }), true, r?.warm?.timedOut ? 12_000 : 5000, key);
      mcpChanged();
    } catch (e: any) { toast(e.message, false, 5000, key); }
    setBusy(null);
  };
  const remove = async (name: string) => {
    if (!(await dlg.confirm(tr('移除连接器「{name}」？', { name }), { danger: true }))) return;
    setBusy(name);
    try { await ws.request({ kind: 'config.mcp.remove', name }); mcpChanged(); } catch (e: any) { toast(e.message); }
    setBusy(null);
  };
  const searchRegistry = async () => {
    if (!q.trim()) return;
    setRegBusy(true);
    try { setReg(await ws.request<RegistryServer[]>({ kind: 'mcp.registry', query: q })); } catch (e: any) { toast(tr('官方目录：{message}', { message: e.message })); setReg([]); }
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
          <input value={q} placeholder={tr('搜索连接器…')} aria-label={tr('搜索连接器')} onChange={(e) => { setQ(e.target.value); setReg(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && !imeComposing(e.nativeEvent)) void searchRegistry(); }} />
          {q && <button type="button" className="icon-btn xs" aria-label={tr('清除')} onClick={() => { setQ(''); setReg(null); }}><Icon name="close" size={12} /></button>}
        </label>
        <label className="cx-scope" title={tr('新加的连接器给谁用')}>
          <span>{tr('添加到')}</span>
          <Select className="field" value={scope} onValueChange={(value) => setScope(String(value) as Scope)} aria-label={tr('新加的连接器给谁用')} options={[{ value: 'user', label: SCOPE_LABEL.user }, { value: 'project', label: SCOPE_LABEL.project, disabled: !cwd }, { value: 'local', label: SCOPE_LABEL.local, disabled: !cwd }]} />
        </label>
        <button type="button" className="btn sm" data-act="import" onClick={() => setImporting(true)} title={tr('把 Cursor、Claude Desktop、VS Code、Codex、Hermes 等工具里配好的 MCP 服务器拿过来（加给所有项目）')}>{tr('从其它工具导入…')}</button>
      </div>
      {importing && <ImportDialog only="mcp" onClose={() => { setImporting(false); void reload(); }} />}
      {editing && <McpEditDialog name={editing} cwd={cwd} onClose={() => setEditing(null)} />}

      {configured && configured.length > 0 && (
        <section className="cx-sec" data-id="connected">
          <div className="cx-h">
            <h3>{tr('已连接')}</h3>
            <span className="n">{configured.length}</span>
            <span className="grow" />
            <button className="link" disabled={hBusy} title={tr('挨个连一下，看哪个通、哪个要登录')} onClick={checkHealth}>{hBusy ? tr('检查中…') : tr('检查连接')}</button>
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
                  <button className="icon-btn cx-rm" data-act="edit" title={tr('编辑')} aria-label={tr('编辑 {name}', { name: s.name })} onClick={() => setEditing(s.name)}><Icon name="edit" size={15} /></button>
                  <button className="icon-btn cx-rm" disabled={busy === s.name} title={tr('移除')} aria-label={tr('移除 {name}', { name: s.name })} onClick={() => void remove(s.name)}><Icon name="trash" size={15} /></button>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {err && <div className="cx-err" role="status"><Icon name="alert" size={14} />{tr('读不到已连接的列表：{err}', { err })}</div>}

      <section className="cx-sec" data-id="directory">
        <div className="cx-h"><h3>{tr('目录')}</h3></div>
        <div className="cx-cats" role="tablist" aria-label={tr('分类')}>
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
                  ? <span className="cx-added" title={tr('已添加')}><Icon name="check" size={16} /></span>
                  : <button className="icon-btn cx-add" disabled={busy === c.id} title={tr('添加 {name}', { name: c.name })} aria-label={tr('添加 {name}', { name: c.name })} onClick={() => void add(c.id, c.json, c.env, c.oauth)}>{busy === c.id ? <span className="spinner" /> : <Icon name="plus" size={17} />}</button>}
              </div>
            );
          })}
        </div>
        {!items.length && <div className="cx-none">{tr('目录里没有叫「{q}」的。', { q })}</div>}
      </section>

      <div className="cx-foot">
        {q.trim()
          ? <button className="btn sm" disabled={regBusy} onClick={searchRegistry}><Icon name="search" size={13} />{regBusy ? tr('搜索中…') : tr('在官方目录里搜「{q}」', { q: q.trim() })}</button>
          : <span className="cx-hint">{tr('没找到想要的？在上面输入名字，可以到官方目录里搜。')}</span>}
        <span className="grow" />
        <button className="link" data-act="mcp-json" aria-expanded={jsonOpen} onClick={() => setJsonOpen(!jsonOpen)}>{tr('用配置手动添加…')}</button>
      </div>
      {jsonOpen && (
        <section className="cx-sec cx-json" data-id="json" ref={jsonRef}>
          <McpAddJson />
        </section>
      )}
      {reg && (
        <section className="cx-sec" data-id="registry">
          <div className="cx-h"><h3>{tr('官方目录')}</h3><span className="n">{reg.length}</span></div>
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
                  {r.repo && <a className="icon-btn" href={r.repo} target="_blank" rel="noreferrer" title={tr('它的仓库')} aria-label={tr('仓库')}><Icon name="external" size={15} /></a>}
                  {has
                    ? <span className="cx-added" title={tr('已添加')}><Icon name="check" size={16} /></span>
                    : <button className="icon-btn cx-add" disabled={!r.install || busy === name} title={r.install ? tr('添加 {name}', { name }) : tr('这一项没有可用的安装方式')} aria-label={tr('添加 {name}', { name })} onClick={() => r.install && void add(name, r.install.command ? { type: 'stdio', command: r.install.command, args: r.install.args } : { type: r.install.transport, url: r.install.url }, r.install.env)}>{busy === name ? <span className="spinner" /> : <Icon name="plus" size={17} />}</button>}
                </div>
              );
            })}
          </div>
          {!reg.length && <div className="cx-none">{tr('官方目录里也没有。')}</div>}
        </section>
      )}
    </div>
  );
}
