import { useEffect, useState } from 'react';
import { useActive } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';

type Tab = 'overview' | 'plugins' | 'mcp' | 'skills' | 'agents' | 'hooks' | 'settings';
const TABS: { id: Tab; l: string }[] = [
  { id: 'overview', l: '概览' },
  { id: 'plugins', l: '插件' },
  { id: 'mcp', l: 'MCP' },
  { id: 'skills', l: 'Skills' },
  { id: 'agents', l: 'Agents' },
  { id: 'hooks', l: 'Hooks' },
  { id: 'settings', l: '设置' },
];

function useReq<T>(req: any, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [n, setN] = useState(0);
  useEffect(() => {
    setErr('');
    ws.request<T>(req).then(setData).catch((e) => setErr(e.message));
  }, [...deps, n]);
  return { data, err, reload: () => setN((x) => x + 1) };
}

function Cmd({ r }: { r: { code: number; stdout: string; stderr: string } | null }) {
  if (!r) return null;
  return <pre className="mono" style={{ fontSize: 11.5, color: r.code ? 'var(--red)' : 'var(--fg-1)', padding: '6px 12px', whiteSpace: 'pre-wrap' }}>{(r.stdout + '\n' + r.stderr).trim()}</pre>;
}

function Overview() {
  const { data, err } = useReq<any>({ kind: 'config.overview' });
  const [doctor, setDoctor] = useState<string | null>(null);
  if (err) return <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>;
  if (!data) return <div className="empty">加载中…</div>;
  return (
    <>
      <div className="kv">
        <span className="k">登录</span><span>{data.auth.loggedIn ? `已登录 (${data.auth.authMethod}${data.auth.email ? ` · ${data.auth.email}` : ''})` : '未登录 — 在终端面板运行 /login'}</span>
        <span className="k">API 提供方</span><span>{data.auth.apiProvider ?? '-'}</span>
        <span className="k">配置目录</span><span className="mono">{data.claudeDir}</span>
        <span className="k">插件</span><span>{data.pluginCount}</span>
        <span className="k">Skills</span><span>{data.skillCount}</span>
        <span className="k">Agents</span><span>{data.agentCount}</span>
        <span className="k">Hooks</span><span>{data.hookCount}</span>
      </div>
      <div className="section">
        <button className="btn sm" onClick={() => { setDoctor('运行 claude doctor…'); ws.request<any>({ kind: 'config.doctor' }).then((r) => setDoctor(r.output)).catch((e) => setDoctor(e.message)); }}>运行 doctor</button>
        {doctor && <pre className="mono" style={{ fontSize: 11.5, marginTop: 8, whiteSpace: 'pre-wrap' }}>{doctor}</pre>}
      </div>
    </>
  );
}

function Plugins() {
  const { data, err, reload } = useReq<{ plugins: any[]; stderr?: string }>({ kind: 'config.plugins' });
  const mk = useReq<{ marketplaces: any }>({ kind: 'config.marketplaces' });
  const [spec, setSpec] = useState('');
  const [mkSrc, setMkSrc] = useState('');
  const [out, setOut] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const run = async (req: any) => { setBusy(true); try { setOut(await ws.request(req)); } catch (e: any) { setOut({ code: 1, stdout: '', stderr: e.message }); } setBusy(false); reload(); mk.reload(); };
  const markets = mk.data?.marketplaces;
  const marketList: any[] = Array.isArray(markets) ? markets : markets ? Object.entries(markets).map(([name, v]: any) => ({ name, ...v })) : [];
  return (
    <>
      {err && <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>}
      <div className="list">
        {(data?.plugins ?? []).map((p) => (
          <div key={p.id} className="row">
            <div className="grow">
              <div>{p.manifest?.name ?? p.id.split('@')[0]} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>v{p.version} · {p.id.split('@')[1]} · {p.scope}</span></div>
              <div className="sub">{p.manifest?.description ?? ''} {p.components ? `· skills ${p.components.skills} / commands ${p.components.commands} / agents ${p.components.agents}${p.components.hooks ? ' / hooks' : ''}${p.components.mcp ? ' / mcp' : ''}` : ''}</div>
            </div>
            <button className={clsx('toggle', p.enabled && 'on')} title={p.enabled ? '禁用' : '启用'} disabled={busy} onClick={() => run({ kind: 'config.plugin.toggle', name: p.id, enable: !p.enabled })} />
            <button className="btn sm danger" disabled={busy} onClick={() => confirm(`卸载 ${p.id}?`) && run({ kind: 'config.plugin.uninstall', name: p.id })}>卸载</button>
          </div>
        ))}
        {data && !data.plugins.length && <div className="empty">没有安装插件</div>}
      </div>
      <div className="section">
        <h5>安装插件</h5>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="plugin@marketplace" style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 8px' }} />
          <button className="btn sm" disabled={busy || !spec} onClick={() => run({ kind: 'config.plugin.install', spec })}>安装</button>
        </div>
        <h5>市场 ({marketList.length})</h5>
        {marketList.map((m: any) => <div key={m.name} className="row"><div className="grow"><div>{m.name}</div><div className="sub">{m.source?.source ?? ''} {m.source?.repo ?? m.source?.url ?? m.source?.path ?? ''}</div></div></div>)}
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input value={mkSrc} onChange={(e) => setMkSrc(e.target.value)} placeholder="owner/repo 或 git URL 或本地路径" style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 8px' }} />
          <button className="btn sm" disabled={busy || !mkSrc} onClick={() => run({ kind: 'config.marketplace.add', source: mkSrc })}>添加市场</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-2)', marginTop: 6 }}>启停/安装后需要重启会话进程（顶栏 ■ 再 ▶）才会生效</div>
      </div>
      <Cmd r={out} />
    </>
  );
}

function Mcp() {
  const active = useActive();
  const { data, err, reload } = useReq<{ servers: any[]; userServers: any; projectServers: any; stderr?: string }>({ kind: 'config.mcp' });
  const [name, setName] = useState('');
  const [json, setJson] = useState('{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}');
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const [out, setOut] = useState<any>(null);
  const live = active?.info?.mcpServers;
  const run = async (req: any) => { try { setOut(await ws.request(req)); } catch (e: any) { setOut({ code: 1, stdout: '', stderr: e.message }); } reload(); };
  return (
    <>
      {err && <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>}
      <div className="list">
        {live && (
          <>
            <h5 style={{ margin: '4px 8px', fontSize: 11.5, color: 'var(--fg-2)' }}>当前会话</h5>
            {live.map((s) => (
              <div key={s.name} className="row">
                <span className={clsx('dot', s.status === 'connected' ? 'idle' : s.status === 'failed' ? 'error' : 'waiting')} />
                <div className="grow"><div>{s.name}</div><div className="sub">{s.status} {s.error ?? ''} {s.tools?.length ? `· ${s.tools.length} tools` : ''}</div></div>
              </div>
            ))}
          </>
        )}
        <h5 style={{ margin: '8px 8px 4px', fontSize: 11.5, color: 'var(--fg-2)' }}>已配置</h5>
        {(data?.servers ?? []).map((s) => (
          <div key={s.name} className="row">
            <span className={clsx('dot', /Connected/.test(s.status) ? 'idle' : 'error')} />
            <div className="grow"><div>{s.name}</div><div className="sub">{s.target} · {s.status}</div></div>
            <button className="btn sm danger" onClick={() => confirm(`移除 MCP ${s.name}?`) && run({ kind: 'config.mcp.remove', name: s.name })}>移除</button>
          </div>
        ))}
        {data && !data.servers.length && <div className="empty">没有配置 MCP server</div>}
      </div>
      <div className="section">
        <h5>添加 MCP server（JSON）</h5>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" style={{ flex: 1, background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 8px' }} />
          <select value={scope} onChange={(e) => setScope(e.target.value as any)} style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 4 }}>
            <option value="user">user</option><option value="project">project</option><option value="local">local</option>
          </select>
        </div>
        <textarea className="code" style={{ minHeight: 80 }} value={json} onChange={(e) => setJson(e.target.value)} />
        <button className="btn sm" style={{ marginTop: 6 }} disabled={!name} onClick={() => run({ kind: 'config.mcp.add', name, json, scope, cwd: active?.cwd })}>添加</button>
      </div>
      <Cmd r={out} />
    </>
  );
}

function SimpleList({ kind, render }: { kind: 'config.skills' | 'config.agents' | 'config.hooks'; render: (x: any) => React.ReactNode }) {
  const { data, err } = useReq<any[]>({ kind });
  if (err) return <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>;
  if (!data) return <div className="empty">加载中…</div>;
  return <div className="list">{data.map((x, i) => <div key={i} className="row">{render(x)}</div>)}{!data.length && <div className="empty">空</div>}</div>;
}

function Settings() {
  const active = useActive();
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const { data, err, reload } = useReq<{ path: string; text: string }>({ kind: 'config.settings.read', scope, cwd: active?.cwd }, [scope, active?.cwd]);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => setText(data?.text ?? ''), [data]);
  const save = async () => {
    try { JSON.parse(text); await ws.request({ kind: 'config.settings.write', scope, cwd: active?.cwd, json: text }); setMsg('已保存'); reload(); } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="section">
      <div className="subtabs" style={{ padding: 0, border: 'none', marginBottom: 6 }}>
        {(['user', 'project', 'local'] as const).map((s) => <button key={s} className={scope === s ? 'active' : ''} onClick={() => setScope(s)} disabled={s !== 'user' && !active}>{s}</button>)}
      </div>
      <div className="mono" style={{ fontSize: 11, color: 'var(--fg-2)', marginBottom: 4 }}>{data?.path}</div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12 }}>{err}</div>}
      <textarea className="code" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button className="btn sm primary" onClick={save}>保存</button>
        <span style={{ fontSize: 12, color: 'var(--fg-2)' }}>{msg}</span>
      </div>
    </div>
  );
}

export function ConfigPanel() {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <div>
      <div className="subtabs">{TABS.map((t) => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.l}</button>)}</div>
      {tab === 'overview' && <Overview />}
      {tab === 'plugins' && <Plugins />}
      {tab === 'mcp' && <Mcp />}
      {tab === 'skills' && <SimpleList kind="config.skills" render={(s) => <div className="grow"><div>/{s.name} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{s.source}</span></div><div className="sub">{s.description}</div></div>} />}
      {tab === 'agents' && <SimpleList kind="config.agents" render={(a) => <div className="grow"><div>{a.name} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{a.source}{a.model ? ` · ${a.model}` : ''}</span></div><div className="sub">{a.description}</div></div>} />}
      {tab === 'hooks' && <SimpleList kind="config.hooks" render={(h) => <div className="grow"><div>{h.event} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{h.matcher ? `matcher: ${h.matcher}` : ''} · {h.source}</span></div><div className="sub">{(h.hooks ?? []).map((x: any) => x.command ?? x.type).join(' ; ')}</div></div>} />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}
