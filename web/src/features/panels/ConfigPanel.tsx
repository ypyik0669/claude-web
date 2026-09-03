import { useEffect, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import type { Provider, ProviderType } from '@shared';

type Tab = 'overview' | 'providers' | 'plugins' | 'mcp' | 'skills' | 'agents' | 'hooks' | 'settings';
const TABS: { id: Tab; l: string }[] = [
  { id: 'overview', l: '概览' },
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
  const engine = useStore((s) => s.engine);
  const loadEngine = useStore((s) => s.loadEngine);
  const toast = useStore((s) => s.toast);
  const [doctor, setDoctor] = useState<string | null>(null);
  const [upd, setUpd] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const update = async () => {
    setBusy(true);
    try { setUpd(await ws.request({ kind: 'engine.update' })); await loadEngine(); } catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  if (err) return <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>;
  if (!data) return <div className="empty">加载中…</div>;
  return (
    <>
      <div className="kv">
        <span className="k">引擎</span>
        <span>
          {engine ? <>Claude Web 引擎 v{engine.version ?? '?'} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{engine.runtime === 'ccb' ? 'claude-code-best' : '官方 Claude Code（ccb 不可用时的兜底）'} · {engine.source === 'bundled' ? '内置' : engine.source === 'global' ? '全局 npm' : '环境变量'}{engine.fallback ? ` · 兜底 ${engine.fallback.runtime} v${engine.fallback.version ?? '?'}` : ''}</span></> : '检测中…'}
          {' '}<button className="btn sm ghost" disabled={busy} onClick={update} title="npm i -g claude-code-best@latest（全局安装会优先于内置版本）">{busy ? '更新中…' : '更新'}</button>
        </span>
        <span className="k">登录</span><span>{data.auth.loggedIn ? `已登录 (${data.auth.authMethod}${data.auth.email ? ` · ${data.auth.email}` : ''})` : '未登录 — 在终端面板运行 /login，或在「供应商」里添加第三方端点'}</span>
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
      <Cmd r={upd} />
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
  const active = useScopedSession();
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

/** UI preferences stored in meta.json (survive the desktop's per-launch origin). */
function UiSettings() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const rows: { key: string; l: string; hint: string; def?: boolean }[] = [
    { key: 'ui.singleWindow', l: '单窗格模式', hint: '隐藏分组与分屏，所有会话在同一个窗格里切换（像 Mirasim 的「单窗口」）' },
    { key: 'ui.autoSave', l: '编辑器自动保存', hint: '停止输入 0.8 秒后写回磁盘；关闭后用 Ctrl+S 保存', def: true },
    { key: 'ui.showThinking', l: '显示思考过程', hint: '在对话里展开模型的 thinking 块' },
    { key: 'autoContinueOnReset', l: '额度恢复后自动继续', hint: '被限流时到重置时间自动重发上一条' },
  ];
  return (
    <div className="section">
      <h5>界面</h5>
      {rows.map((r) => (
        <div key={r.key} className="row">
          <button className={clsx('toggle', (settings[r.key] ?? r.def ?? false) && 'on')} onClick={() => void setSetting(r.key, !(settings[r.key] ?? r.def ?? false))} />
          <div className="grow"><div>{r.l}</div><div className="sub">{r.hint}</div></div>
        </div>
      ))}
    </div>
  );
}

function Settings() {
  const active = useScopedSession();
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

const PROVIDER_TYPES: { v: ProviderType; l: string; hint: string }[] = [
  { v: 'anthropic', l: 'Anthropic 兼容', hint: 'https://api.anthropic.com 或中转站（如 https://api.super-nb.me）' },
  { v: 'openai', l: 'OpenAI 兼容', hint: 'https://api.openai.com/v1 · DeepSeek / Groq / Qwen / OpenRouter…' },
  { v: 'gemini', l: 'Gemini', hint: '留空用官方 generativelanguage.googleapis.com' },
  { v: 'grok', l: 'Grok (xAI)', hint: '留空用 https://api.x.ai' },
];

type Draft = Partial<Provider> & { apiKey: string };
const emptyDraft = (): Draft => ({ name: '', type: 'anthropic', baseUrl: '', apiKey: '', defaultModel: '', modelMap: {} });

/** Third-party endpoint profiles. Keys live in ~/.claude-web/meta.json and are injected per session — settings.json is never touched. */
function ProviderProfiles() {
  const providers = useStore((s) => s.providers);
  const loadProviders = useStore((s) => s.loadProviders);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; models: string[]; error?: string; ms: number; status?: number; chat?: { ok: boolean; runtime: string; model: string; error?: string; ms: number; switched?: boolean } } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const def = settings.defaultProviderId as string | undefined;

  const startEdit = (p?: Provider) => { setEditing(p ? { ...p, modelMap: { ...(p.modelMap ?? {}) } } : emptyDraft()); setProbe(p?.models?.length ? { ok: true, models: p.models, ms: 0 } : null); setShowKey(false); };
  const test = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const r: any = await ws.request({ kind: 'providers.probe', id: editing.id, provider: { type: editing.type, baseUrl: editing.baseUrl, apiKey: editing.apiKey, defaultModel: editing.defaultModel, modelMap: editing.modelMap, runtime: editing.runtime } });
      setProbe(r);
      if (r.chat?.switched) setEditing((e) => (e ? { ...e, runtime: 'claude' } : e));
    } catch (e: any) { setProbe({ ok: false, models: [], error: e.message, ms: 0 }); }
    setBusy(false);
  };
  const save = async () => {
    if (!editing) return;
    if (!editing.name?.trim()) return toast('请填名称');
    if ((editing.type === 'anthropic' || editing.type === 'openai') && !editing.baseUrl?.trim()) return toast('请填 Base URL');
    if (!editing.id && !editing.apiKey.trim()) return toast('请填 API Key');
    setBusy(true);
    try {
      const models = probe?.ok && probe.models.length ? probe.models : editing.models;
      const saved = await ws.request<Provider>({ kind: 'providers.upsert', provider: { ...editing, models } });
      await loadProviders();
      toast(`已保存供应商「${saved.name}」`, true);
      setEditing(null);
    } catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  const remove = async (p: Provider) => {
    if (!confirm(`删除供应商「${p.name}」？已用它创建的会话恢复时会退回 Claude 账号。`)) return;
    await ws.request({ kind: 'providers.remove', id: p.id }).catch((e) => toast(e.message));
    await loadProviders();
  };
  const models = probe?.ok ? probe.models : editing?.models ?? [];
  const modelPick = (label: string, key: 'defaultModel' | 'haiku' | 'sonnet' | 'opus') => {
    const val = key === 'defaultModel' ? editing!.defaultModel ?? '' : editing!.modelMap?.[key] ?? '';
    const set = (v: string) => setEditing(key === 'defaultModel' ? { ...editing!, defaultModel: v } : { ...editing!, modelMap: { ...(editing!.modelMap ?? {}), [key]: v } });
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
        <span style={{ minWidth: 110, fontSize: 12, color: 'var(--fg-2)' }}>{label}</span>
        <input className="field" style={{ flex: 1 }} list={`models-${key}`} value={val} onChange={(e) => set(e.target.value)} placeholder={key === 'defaultModel' ? '不填 = 端点默认 / 输入框里再选' : `别名 ${key} 映射到的模型`} />
        <datalist id={`models-${key}`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
      </div>
    );
  };
  return (
    <div className="section">
      <h5 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>供应商档案 <span className="grow" /><button className="btn sm" onClick={() => startEdit()}>＋ 添加</button></h5>
      <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 8 }}>每个会话可以选一个档案（首页输入框「Claude 账号 ▾」）。密钥只注入到那个会话的进程环境，不写 <code>~/.claude/settings.json</code>，claude.ai 登录照常可用。</div>
      <div className="list">
        <div className="row">
          <span className="dot idle" />
          <div className="grow"><div>Claude 账号</div><div className="sub">claude.ai 登录（终端面板 /login）· 订阅额度</div></div>
          <button className={clsx('btn sm', !def && 'primary')} onClick={() => setSetting('defaultProviderId', undefined)}>{!def ? '默认' : '设为默认'}</button>
        </div>
        {providers.map((p) => (
          <div key={p.id} className="row">
            <span className={clsx('dot', p.models?.length ? 'idle' : 'waiting')} title={p.models?.length ? `已测试 · ${p.models.length} 个模型` : '未测试连接'} />
            <div className="grow">
              <div>{p.name} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{PROVIDER_TYPES.find((t) => t.v === p.type)?.l}{p.runtime === 'claude' ? ' · 强制官方二进制' : ''}</span></div>
              <div className="sub mono">{p.baseUrl || '（默认端点）'} · {p.apiKey || '无 key'}{p.defaultModel ? ` · ${p.defaultModel}` : ''}</div>
            </div>
            <button className={clsx('btn sm', def === p.id && 'primary')} onClick={() => setSetting('defaultProviderId', p.id)}>{def === p.id ? '默认' : '设为默认'}</button>
            <button className="btn sm ghost" onClick={() => startEdit(p)}>编辑</button>
            <button className="btn sm danger" onClick={() => remove(p)}>删除</button>
          </div>
        ))}
      </div>
      {editing && (
        <div className="section" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginTop: 8 }}>
          <h5>{editing.id ? `编辑「${editing.name}」` : '新供应商'}</h5>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input className="field" style={{ flex: 1 }} placeholder="名称，如 super-nb" value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <select className="field" value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as ProviderType })}>{PROVIDER_TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}</select>
          </div>
          <input className="field" style={{ width: '100%', marginBottom: 6 }} placeholder={`Base URL · ${PROVIDER_TYPES.find((t) => t.v === editing.type)?.hint}`} value={editing.baseUrl ?? ''} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} />
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input className="field" style={{ flex: 1 }} type={showKey ? 'text' : 'password'} placeholder={editing.id ? `API Key（留空保持 ${editing.apiKey || '现有值'}）` : 'API Key'} value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} autoComplete="off" />
            <button className="icon-btn" onClick={() => setShowKey(!showKey)}>{showKey ? '🙈' : '👁'}</button>
            <button className="btn sm" disabled={busy} onClick={test}>{busy ? '测试中…' : '测试连接'}</button>
          </div>
          {probe && (
            <div style={{ fontSize: 12, marginBottom: 6, color: probe.ok ? 'var(--green)' : 'var(--red)' }}>
              {probe.models.length > 0 ? `模型列表 ${probe.models.length} 个` : probe.ok ? '连接正常' : `失败${probe.status ? ` HTTP ${probe.status}` : ''}：${probe.error}`}
              {probe.chat && (probe.chat.ok
                ? ` · 对话测试通过（${probe.chat.model} · ${probe.chat.runtime === 'claude' ? '官方二进制' : 'ccb'} · ${(probe.chat.ms / 1000).toFixed(1)}s）`
                : ` · 对话测试失败：${probe.chat.error}`)}
              {probe.chat?.switched && <div style={{ color: 'var(--yellow)' }}>这个端点拒绝 ccb 的请求，已自动改为官方 Claude Code 二进制（ccb 专属功能在该供应商的会话里不可用）</div>}
            </div>
          )}
          {modelPick('默认模型', 'defaultModel')}
          {modelPick('haiku →', 'haiku')}
          {modelPick('sonnet →', 'sonnet')}
          {modelPick('opus →', 'opus')}
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--fg-2)', margin: '6px 0' }}>
            <input type="checkbox" checked={editing.runtime === 'claude'} onChange={(e) => setEditing({ ...editing, runtime: e.target.checked ? 'claude' : (null as any) })} />
            这个端点只认官方 Claude Code 二进制（被拒时再勾）
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm primary" disabled={busy} onClick={save}>保存</button>
            <button className="btn sm ghost" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

const ENV_GROUPS: { title: string; keys: { k: string; hint: string; secret?: boolean }[] }[] = [
  { title: 'Web Search', keys: [{ k: 'BRAVE_API_KEY', hint: 'Brave Search API key', secret: true }, { k: 'WEB_SEARCH_PROVIDER', hint: 'api | bing | brave' }] },
  { title: 'Artifacts 上传', keys: [{ k: 'ARTIFACTS_URL', hint: '自托管 Worker 地址，默认官方公共实例' }, { k: 'ARTIFACTS_TOKEN', hint: '上传令牌', secret: true }] },
  { title: 'Langfuse 监控', keys: [{ k: 'LANGFUSE_PUBLIC_KEY', hint: 'pk-lf-…' }, { k: 'LANGFUSE_SECRET_KEY', hint: 'sk-lf-…', secret: true }, { k: 'LANGFUSE_BASE_URL', hint: 'https://cloud.langfuse.com' }] },
  { title: 'Sentry', keys: [{ k: 'SENTRY_DSN', hint: 'https://…@sentry.io/…', secret: true }] },
  { title: '语音（终端 /voice）', keys: [{ k: 'VOICE_PROVIDER', hint: 'doubao …' }, { k: 'VOICE_STREAM_BASE_URL', hint: 'wss://…' }] },
];

/** Edits the `env` block of ~/.claude/settings.json for non-provider integrations. */
function EnvEditor() {
  const { data, err, reload } = useReq<{ path: string; text: string }>({ kind: 'config.settings.read', scope: 'user' });
  const [env, setEnv] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [show, setShow] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try { const j = JSON.parse(data?.text || '{}'); setEnv(j.env ?? {}); } catch { /* keep */ }
  }, [data]);
  const save = async () => {
    try {
      const j = JSON.parse(data?.text || '{}');
      const cleaned: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) if (v?.trim()) cleaned[k] = v.trim();
      j.env = { ...(j.env ?? {}), ...cleaned };
      for (const k of Object.keys(j.env)) if (!(k in cleaned) && ENV_GROUPS.some((g) => g.keys.some((x) => x.k === k))) delete j.env[k];
      await ws.request({ kind: 'config.settings.write', scope: 'user', json: JSON.stringify(j, null, 2) });
      setMsg('已保存到 ~/.claude/settings.json，新会话生效');
      reload();
    } catch (e: any) { setMsg(e.message); }
  };
  if (err) return <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>;
  return (
    <div className="section">
      <h5>其他环境变量</h5>
      <div style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 8 }}>写入 <code>settings.json</code> 的 <code>env</code>，所有会话生效。留空表示不设置。</div>
      {ENV_GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: 10 }}>
          <h5>{g.title}</h5>
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
  const want = useStore((s) => s.configTab);
  const [tab, setTab] = useState<Tab>((want as Tab) ?? 'overview');
  useEffect(() => { if (want) { setTab(want as Tab); useStore.setState({ configTab: null }); } }, [want]);
  return (
    <div>
      <div className="subtabs">{TABS.map((t) => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.l}</button>)}</div>
      {tab === 'overview' && <Overview />}
      {tab === 'providers' && <><ProviderProfiles /><EnvEditor /></>}
      {tab === 'plugins' && <Plugins />}
      {tab === 'mcp' && <Mcp />}
      {tab === 'skills' && <SimpleList kind="config.skills" render={(s) => <div className="grow"><div>/{s.name} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{s.source}</span></div><div className="sub">{s.description}</div></div>} />}
      {tab === 'agents' && <SimpleList kind="config.agents" render={(a) => <div className="grow"><div>{a.name} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{a.source}{a.model ? ` · ${a.model}` : ''}</span></div><div className="sub">{a.description}</div></div>} />}
      {tab === 'hooks' && <SimpleList kind="config.hooks" render={(h) => <div className="grow"><div>{h.event} <span style={{ color: 'var(--fg-2)', fontSize: 11 }}>{h.matcher ? `matcher: ${h.matcher}` : ''} · {h.source}</span></div><div className="sub">{(h.hooks ?? []).map((x: any) => x.command ?? x.type).join(' ; ')}</div></div>} />}
      {tab === 'settings' && <><UiSettings /><Settings /></>}
    </div>
  );
}
