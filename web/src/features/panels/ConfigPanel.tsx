import { useEffect, useState } from 'react';
import { useActive, useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';

type Tab = 'overview' | 'engines' | 'providers' | 'plugins' | 'mcp' | 'skills' | 'agents' | 'hooks' | 'settings';
const TABS: { id: Tab; l: string }[] = [
  { id: 'overview', l: '概览' },
  { id: 'engines', l: '引擎' },
  { id: 'providers', l: '供应商 / 环境' },
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

function Engines() {
  const engines = useStore((s) => s.engines);
  const loadEngines = useStore((s) => s.loadEngines);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<any>(null);
  const install = async () => {
    setBusy(true);
    try { setOut(await ws.request({ kind: 'engines.install', id: 'ccb' })); await loadEngines(); } catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  const def = (settings.defaultEngine as string) ?? 'claude';
  return (
    <>
      <div className="list">
        {engines.map((e) => (
          <div key={e.id} className="row">
            <span className={clsx('dot', e.installed ? 'idle' : 'error')} />
            <div className="grow">
              <div>{e.label} {e.version && <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>v{e.version} · {e.source === 'bundled' ? '内置' : e.source === 'global' ? '全局 npm' : '环境变量'}</span>}</div>
              <div className="sub">{e.installed ? e.path : e.note}</div>
            </div>
            {e.installed ? (
              <button className={clsx('btn sm', def === e.id && 'primary')} onClick={() => setSetting('defaultEngine', e.id)}>{def === e.id ? '默认' : '设为默认'}</button>
            ) : e.id === 'ccb' ? (
              <button className="btn sm" disabled={busy} onClick={install}>{busy ? '安装中…' : '安装'}</button>
            ) : null}
            {e.id === 'ccb' && e.installed && <button className="btn sm ghost" disabled={busy} onClick={install} title="npm i -g claude-code-best@latest">更新</button>}
          </div>
        ))}
        {!engines.length && <div className="empty">检测中…</div>}
      </div>
      <div className="section" style={{ fontSize: 12, color: 'var(--fg-2)' }}>
        两个引擎共用同一套 <code>~/.claude</code>（登录、配置、会话记录），会话可以互相 resume。ccb 额外提供 Goal / Artifacts / Ultracode / Pipe IPC / 自定义供应商 / Web Search / 频道 / Computer Use / 协调者 / 主动模式 / /dream 等；在首页输入框的「引擎」和「功能」里选择。
      </div>
      <Cmd r={out} />
    </>
  );
}

const ENV_GROUPS: { title: string; tag?: string; keys: { k: string; hint: string; secret?: boolean }[] }[] = [
  { title: 'Anthropic 兼容端点', keys: [{ k: 'ANTHROPIC_BASE_URL', hint: 'https://…（第三方 Anthropic 兼容 API）' }, { k: 'ANTHROPIC_AUTH_TOKEN', hint: 'Bearer token', secret: true }, { k: 'ANTHROPIC_API_KEY', hint: 'sk-ant-…（设置后不再用 claude.ai 登录）', secret: true }, { k: 'ANTHROPIC_MODEL', hint: '默认模型名' }] },
  { title: 'OpenAI 兼容（ccb）', tag: 'ccb', keys: [{ k: 'OPENAI_BASE_URL', hint: 'https://api.openai.com/v1 或 DeepSeek/Groq/Qwen…' }, { k: 'OPENAI_API_KEY', hint: 'sk-…', secret: true }, { k: 'OPENAI_DEFAULT_OPUS_MODEL', hint: '映射到 opus 的模型' }, { k: 'OPENAI_DEFAULT_SONNET_MODEL', hint: '映射到 sonnet 的模型' }, { k: 'OPENAI_DEFAULT_HAIKU_MODEL', hint: '映射到 haiku 的模型' }] },
  { title: 'Gemini（ccb）', tag: 'ccb', keys: [{ k: 'GEMINI_API_KEY', hint: 'AIza…', secret: true }, { k: 'GEMINI_BASE_URL', hint: '可选' }] },
  { title: 'Web Search（ccb）', tag: 'ccb', keys: [{ k: 'BRAVE_API_KEY', hint: 'Brave Search API key', secret: true }, { k: 'WEB_SEARCH_PROVIDER', hint: 'api | bing | brave' }] },
  { title: 'Artifacts 上传（ccb）', tag: 'ccb', keys: [{ k: 'ARTIFACTS_URL', hint: '自托管 Worker 地址，默认官方公共实例' }, { k: 'ARTIFACTS_TOKEN', hint: '上传令牌', secret: true }] },
  { title: 'Langfuse 监控（ccb）', tag: 'ccb', keys: [{ k: 'LANGFUSE_PUBLIC_KEY', hint: 'pk-lf-…' }, { k: 'LANGFUSE_SECRET_KEY', hint: 'sk-lf-…', secret: true }, { k: 'LANGFUSE_BASE_URL', hint: 'https://cloud.langfuse.com' }] },
  { title: 'Sentry（ccb）', tag: 'ccb', keys: [{ k: 'SENTRY_DSN', hint: 'https://…@sentry.io/…', secret: true }] },
  { title: '语音（ccb TUI）', tag: 'ccb', keys: [{ k: 'VOICE_PROVIDER', hint: 'doubao …' }, { k: 'VOICE_STREAM_BASE_URL', hint: 'wss://…' }] },
];

/** Edits the `env` block of ~/.claude/settings.json — both engines read it (ccb's /login writes the same keys). */
function Providers() {
  const { data, err, reload } = useReq<{ path: string; text: string }>({ kind: 'config.settings.read', scope: 'user' });
  const [env, setEnv] = useState<Record<string, string>>({});
  const [modelType, setModelType] = useState('');
  const [msg, setMsg] = useState('');
  const [show, setShow] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { const j = JSON.parse(data?.text || '{}'); setEnv(j.env ?? {}); setModelType(j.modelType ?? ''); } catch { /* keep */ }
  }, [data]);
  const save = async () => {
    try {
      const j = JSON.parse(data?.text || '{}');
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) if (v?.trim()) cleaned[k] = v.trim();
      j.env = { ...(j.env ?? {}), ...cleaned };
      for (const k of Object.keys(j.env)) if (!(k in cleaned) && ENV_GROUPS.some((g) => g.keys.some((x) => x.k === k))) delete j.env[k];
      if (modelType) j.modelType = modelType; else delete j.modelType;
      await ws.request({ kind: 'config.settings.write', scope: 'user', json: JSON.stringify(j, null, 2) });
      setMsg('已保存到 ~/.claude/settings.json，新会话生效');
      reload();
    } catch (e: any) { setMsg(e.message); }
  };
  if (err) return <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>;
  return (
    <div className="section">
      <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 8 }}>写入 <code>settings.json</code> 的 <code>env</code>，两个引擎都读。留空表示不设置。</div>
      <label style={{ fontSize: 12, color: 'var(--fg-2)' }}>modelType（ccb 的供应商类型）</label>
      <select className="field" value={modelType} onChange={(e) => setModelType(e.target.value)} style={{ display: 'block', marginBottom: 10 }}>
        <option value="">默认（Anthropic / claude.ai 登录）</option>
        <option value="anthropic">anthropic（兼容端点）</option>
        <option value="openai">openai（OpenAI 兼容）</option>
        <option value="gemini">gemini</option>
        <option value="bedrock">bedrock</option>
        <option value="vertex">vertex</option>
      </select>
      {ENV_GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: 10 }}>
          <h5>{g.title} {g.tag && <span className="badge">{g.tag}</span>}</h5>
          {g.keys.map(({ k, hint, secret }) => (
            <div key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
              <code style={{ minWidth: 200, fontSize: 11.5, color: 'var(--fg-1)' }}>{k}</code>
              <input className="field" style={{ flex: 1 }} type={secret && !show[k] ? 'password' : 'text'} placeholder={hint} value={env[k] ?? ''} onChange={(e) => setEnv({ ...env, [k]: e.target.value })} />
              {secret && <button className="icon-btn" onClick={() => setShow({ ...show, [k]: !show[k] })}>{show[k] ? '🙈' : '👁'}</button>}
            </div>
          ))}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
      {tab === 'engines' && <Engines />}
      {tab === 'providers' && <Providers />}
      {tab === 'plugins' && <Plugins />}
      {tab === 'mcp' && <Mcp />}
      {tab === 'skills' && <SimpleList kind="config.skills" render={(s) => <div className="grow"><div>/{s.name} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{s.source}</span></div><div className="sub">{s.description}</div></div>} />}
      {tab === 'agents' && <SimpleList kind="config.agents" render={(a) => <div className="grow"><div>{a.name} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{a.source}{a.model ? ` · ${a.model}` : ''}</span></div><div className="sub">{a.description}</div></div>} />}
      {tab === 'hooks' && <SimpleList kind="config.hooks" render={(h) => <div className="grow"><div>{h.event} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{h.matcher ? `matcher: ${h.matcher}` : ''} · {h.source}</span></div><div className="sub">{(h.hooks ?? []).map((x: any) => x.command ?? x.type).join(' ; ')}</div></div>} />}
      {tab === 'settings' && <Settings />}
    </div>
  );
}
