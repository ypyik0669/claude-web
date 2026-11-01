import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { ws } from '@/ws/client';
import { clsx } from '@/util';
import type { Provider, ProviderType } from '@shared';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import { EnvEditor } from '@/features/settings/EnvEditor';
import { ModelPicker, pickedOf, withPicked } from '@/features/settings/ModelPicker';
import { connectModel } from '@/features/providers/ConnectModel';
import { ImportDialog } from '@/features/providers/ImportDialog';
import { McpEditDialog } from '@/features/extensions/McpEditDialog';
import { REGION_BLOCKED, REGION_RE } from '@/features/providers/quick';
import { contextWindowFor, contextWindowSource } from '../../../../server/src/models/context-window';
import { tr } from '@/i18n';
import { Select } from '@/ui/Select';
import { SwitchLine } from '@/ui/Switch';
import { CompactAt } from '@/features/settings/CompactAt';
import { compactWindowOfProvider } from '@/features/settings/compact-model';

type Tab = 'overview' | 'providers' | 'plugins' | 'mcp' | 'skills' | 'agents' | 'hooks' | 'settings';
const TABS: { id: Tab; l: string }[] = [
  { id: 'overview', l: tr('概览') },
  { id: 'providers', l: tr('供应商 / 环境') },
  { id: 'plugins', l: tr('插件') },
  { id: 'mcp', l: 'MCP' },
  { id: 'skills', l: 'Skills' },
  { id: 'agents', l: 'Agents' },
  { id: 'hooks', l: 'Hooks' },
  { id: 'settings', l: tr('设置') },
];

function useReq<T>(req: any, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [n, setN] = useState(0);
  const depKey = JSON.stringify(deps);
  const lastKey = useRef(depKey);
  useEffect(() => {
    setErr('');
    // different target (e.g. settings scope user → project): drop the old data so nothing can be
    // edited / saved against the wrong file while the new one loads
    if (lastKey.current !== depKey) { lastKey.current = depKey; setData(null); }
    let live = true; // an out-of-order response for the previous target must not land here
    ws.request<T>(req).then((d) => live && setData(d)).catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [...deps, n]);
  return { data, err, reload: () => setN((x) => x + 1) };
}

function Cmd({ r }: { r: { code: number; stdout: string; stderr: string } | null }) {
  if (!r) return null;
  return <pre className="mono" style={{ fontSize: 12, color: r.code ? 'var(--red)' : 'var(--fg-1)', padding: '6px 12px', whiteSpace: 'pre-wrap' }}>{(r.stdout + '\n' + r.stderr).trim()}</pre>;
}

/**
 * Runtime + login overview. `part="engine"` is the 运行内核 half only (settings → 账号与登录 → 更多选项; the login
 * state is at the top of that page already); the dock's 配置中心 shows both.
 */
export function Overview({ part = 'all' }: { part?: 'all' | 'engine' }) {
  const { data, err } = useReq<any>({ kind: 'config.overview' });
  const engine = useStore((s) => s.engine);
  const [doctor, setDoctor] = useState<string | null>(null);
  if (err) return <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>;
  if (!data) return <div className="empty">{tr('加载中…')}</div>;
  return (
    <>
      <div className="kv">
        <span className="k">{tr('运行内核')}</span>
        <span>
          {engine ? <>v{engine.version ?? '?'} <span style={{ color: 'var(--fg-2)', fontSize: 12 }} title={tr('运行内核随应用一起更新')}>{tr('官方 Claude Code')} · {engine.source === 'bundled' ? tr('内置') : engine.source === 'global' ? tr('全局 npm') : tr('环境变量')}</span></> : tr('检测中…')}
        </span>
        {part === 'all' && <>
          <span className="k">{tr('登录')}</span><span>{data.auth.loggedIn ? tr('已登录 ({authMethod}{v})', { authMethod: data.auth.authMethod, v: data.auth.email ? ` · ${data.auth.email}` : '' }) : tr('未登录 — 在终端里运行 claude auth login，或在「供应商」里添加第三方端点')}</span>
          <span className="k">{tr('API 提供方')}</span><span>{data.auth.apiProvider ?? '-'}</span>
        </>}
        <span className="k">{tr('配置目录')}</span><span className="mono">{data.claudeDir}</span>
        <span className="k">{tr('插件')}</span><span>{data.pluginCount}</span>
        <span className="k">Skills</span><span>{data.skillCount}</span>
        <span className="k">Agents</span><span>{data.agentCount}</span>
        <span className="k">Hooks</span><span>{data.hookCount}</span>
      </div>
      <div className="section">
        <button className="btn sm" onClick={() => { setDoctor(tr('运行 claude doctor…')); ws.request<any>({ kind: 'config.doctor' }).then((r) => setDoctor(r.output)).catch((e) => setDoctor(e.message)); }}>{tr('运行 doctor')}</button>
        {doctor && <pre className="mono" style={{ fontSize: 12, marginTop: 8, whiteSpace: 'pre-wrap' }}>{doctor}</pre>}
      </div>
    </>
  );
}

export function Plugins() {
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
              <div>{p.manifest?.name ?? p.id.split('@')[0]} <span style={{ color: 'var(--fg-2)', fontSize: 12 }}>v{p.version} · {p.id.split('@')[1]} · {p.scope}</span></div>
              <div className="sub">{p.manifest?.description ?? ''} {p.components ? `· skills ${p.components.skills} / commands ${p.components.commands} / agents ${p.components.agents}${p.components.hooks ? ' / hooks' : ''}${p.components.mcp ? ' / mcp' : ''}` : ''}</div>
            </div>
            <button className={clsx('toggle', p.enabled && 'on')} title={p.enabled ? tr('禁用') : tr('启用')} disabled={busy} onClick={() => run({ kind: 'config.plugin.toggle', name: p.id, enable: !p.enabled })} />
            <button className="btn sm danger" disabled={busy} onClick={async () => { if (await dlg.confirm(tr('卸载 {id}?', { id: p.id }), { danger: true })) void run({ kind: 'config.plugin.uninstall', name: p.id }); }}>{tr('卸载')}</button>
          </div>
        ))}
        {data && !data.plugins.length && <div className="empty">{tr('没有安装插件')}</div>}
      </div>
      <div className="section">
        <h5>{tr('安装插件')}</h5>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="field" style={{ flex: 1, minWidth: 0 }} aria-label={tr('安装插件')} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="plugin@marketplace" />
          <button className="btn sm" disabled={busy || !spec} onClick={() => run({ kind: 'config.plugin.install', spec })}>{tr('安装')}</button>
        </div>
        <h5>{tr('市场 ({marketListCount})', { marketListCount: marketList.length })}</h5>
        {marketList.map((m: any) => <div key={m.name} className="row"><div className="grow"><div>{m.name}</div><div className="sub">{m.source?.source ?? ''} {m.source?.repo ?? m.source?.url ?? m.source?.path ?? ''}</div></div></div>)}
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input className="field" style={{ flex: 1, minWidth: 0 }} value={mkSrc} onChange={(e) => setMkSrc(e.target.value)} placeholder={tr('owner/repo 或 git URL 或本地路径')} aria-label={tr('owner/repo 或 git URL 或本地路径')} />
          <button className="btn sm" disabled={busy || !mkSrc} onClick={() => run({ kind: 'config.marketplace.add', source: mkSrc })}>{tr('添加市场')}</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-2)', marginTop: 6 }}>{tr('启停 / 安装后要重启对话进程才生效（对话右上角 ··· →「结束进程」，再发一条消息继续）')}</div>
      </div>
      <Cmd r={out} />
    </>
  );
}

/**
 * The MCP list, the JSON form and the catalog are separate parts (settings → MCP 与插件 puts the form under 更多选项):
 * whoever adds or removes a server says so, every list on screen reloads.
 */
const MCP_CHANGED = 'cw:mcp-changed';
export function mcpChanged() { window.dispatchEvent(new Event(MCP_CHANGED)); }
export function useMcpChanged(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => { const on = () => ref.current(); window.addEventListener(MCP_CHANGED, on); return () => window.removeEventListener(MCP_CHANGED, on); }, []);
}

/** Configured MCP servers (and the current session's live ones). */
export function Mcp() {
  const active = useScopedSession();
  const { data, err, reload } = useReq<{ servers: any[]; userServers: any; projectServers: any; stderr?: string }>({ kind: 'config.mcp' });
  const [out, setOut] = useState<any>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useMcpChanged(reload);
  const live = active?.info?.mcpServers;
  const run = async (req: any) => { try { setOut(await ws.request(req)); } catch (e: any) { setOut({ code: 1, stdout: '', stderr: e.message }); } mcpChanged(); };
  return (
    <>
      {err && <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>}
      <div className="list">
        {live && (
          <>
            <h5 style={{ margin: '4px 8px', fontSize: 12, color: 'var(--fg-2)' }}>{tr('当前对话')}</h5>
            {live.map((s) => (
              <div key={s.name} className="row">
                <span className={clsx('dot', s.status === 'connected' ? 'idle' : s.status === 'failed' ? 'error' : 'waiting')} />
                <div className="grow"><div>{s.name}</div><div className="sub">{s.status} {s.error ?? ''} {s.tools?.length ? `· ${s.tools.length} tools` : ''}</div></div>
              </div>
            ))}
          </>
        )}
        <h5 style={{ margin: '8px 8px 4px', fontSize: 12, color: 'var(--fg-2)' }}>{tr('已配置')}</h5>
        {(data?.servers ?? []).map((s) => (
          <div key={s.name} className="row">
            <span className={clsx('dot', /Connected/.test(s.status) ? 'idle' : 'error')} />
            <div className="grow"><div>{s.name}</div><div className="sub">{s.target} · {s.status}</div></div>
            <button className="btn sm" data-act="edit" onClick={() => setEditing(s.name)}>{tr('编辑')}</button>
            <button className="btn sm danger" onClick={async () => { if (await dlg.confirm(tr('移除 MCP {name}?', { name: s.name }), { danger: true })) void run({ kind: 'config.mcp.remove', name: s.name }); }}>{tr('移除')}</button>
          </div>
        ))}
        {data && !data.servers.length && <div className="empty">{tr('没有配置 MCP server')}</div>}
      </div>
      {editing && <McpEditDialog name={editing} cwd={active?.cwd} onClose={() => setEditing(null)} />}
      <Cmd r={out} />
    </>
  );
}

/** Add a server from a JSON config (`claude mcp add-json`). */
export function McpAddJson() {
  const active = useScopedSession();
  const [name, setName] = useState('');
  const [json, setJson] = useState('{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}');
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const [out, setOut] = useState<any>(null);
  const run = async (req: any) => { try { setOut(await ws.request(req)); } catch (e: any) { setOut({ code: 1, stdout: '', stderr: e.message }); } mcpChanged(); };
  return (
    <>
      <div className="section">
        <h5>{tr('添加 MCP server（JSON）')}</h5>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input className="field" style={{ flex: 1, minWidth: 0 }} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('名称')} aria-label={tr('名称')} />
          <Select value={scope} onValueChange={(value) => setScope(String(value) as typeof scope)} aria-label={tr('装到哪个范围')} options={[{ value: 'user', label: 'user' }, { value: 'project', label: 'project' }, { value: 'local', label: 'local' }]} />
        </div>
        <textarea className="code" style={{ minHeight: 80 }} value={json} onChange={(e) => setJson(e.target.value)} />
        <button className="btn sm" style={{ marginTop: 6 }} disabled={!name} onClick={() => run({ kind: 'config.mcp.add', name, json, scope, cwd: active?.cwd })}>{tr('添加')}</button>
      </div>
      <Cmd r={out} />
    </>
  );
}

export function SimpleList({ kind, render, empty = tr('空') }: { kind: 'config.skills' | 'config.agents' | 'config.hooks'; render: (x: any) => React.ReactNode; empty?: string }) {
  const { data, err } = useReq<any[]>({ kind });
  if (err) return <div className="empty" style={{ color: 'var(--red)' }}>{err}</div>;
  if (!data) return <div className="empty">{tr('加载中…')}</div>;
  return <div className="list">{data.map((x, i) => <div key={i} className="row">{render(x)}</div>)}{!data.length && <div className="empty">{empty}</div>}</div>;
}

/** UI preferences stored in meta.json (survive the desktop's per-launch origin). */
export function UiSettings() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const rows: { key: string; l: string; hint: string; def?: boolean }[] = [
    { key: 'ui.workbench', l: tr('显示工作台工具'), hint: tr('一直显示分组栏、分屏标签条和右侧面板图标栏；关着时它们只在用到时出现') },
    { key: 'ui.autoSave', l: tr('编辑器自动保存'), hint: tr('停止输入 0.8 秒后写回磁盘；关闭后用 Ctrl+S 保存'), def: true },
    { key: 'ui.showThinking', l: tr('显示思考过程'), hint: tr('在对话里展开模型的 thinking 块') },
    { key: 'autoContinueOnReset', l: tr('额度恢复后自动继续'), hint: tr('被限流时到重置时间自动重发上一条') },
  ];
  return (
    <div className="section">
      <h5>{tr('界面')}</h5>
      {rows.map((r) => (
        <div key={r.key} className="row">
          <button className={clsx('toggle', (settings[r.key] ?? r.def ?? false) && 'on')} onClick={() => void setSetting(r.key, !(settings[r.key] ?? r.def ?? false))} />
          <div className="grow"><div>{r.l}</div><div className="sub">{r.hint}</div></div>
        </div>
      ))}
    </div>
  );
}

export function Settings() {
  const active = useScopedSession();
  const [scope, setScope] = useState<'user' | 'project' | 'local'>('user');
  const { data, err, reload } = useReq<{ path: string; text: string }>({ kind: 'config.settings.read', scope, cwd: active?.cwd }, [scope, active?.cwd]);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => setText(data?.text ?? ''), [data]);
  const save = async () => {
    if (!data) return; // not loaded (or loading another scope): the textarea isn't this file's content
    try { JSON.parse(text); await ws.request({ kind: 'config.settings.write', scope, cwd: active?.cwd, json: text }); setMsg(tr('已保存')); reload(); } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="section">
      <div className="subtabs" style={{ padding: 0, border: 'none', marginBottom: 6 }}>
        {(['user', 'project', 'local'] as const).map((s) => <button key={s} className={scope === s ? 'active' : ''} onClick={() => setScope(s)} disabled={s !== 'user' && !active}>{s}</button>)}
      </div>
      <div className="mono" style={{ fontSize: 12, color: 'var(--fg-2)', marginBottom: 4 }}>{data?.path}</div>
      {err && <div style={{ color: 'var(--red)', fontSize: 13 }}>{err}</div>}
      <textarea className="code" style={{ height: 'min(60vh, 560px)' }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button className="btn sm primary" disabled={!data} onClick={save}>{tr('保存')}</button>
        <span style={{ fontSize: 13, color: 'var(--fg-2)' }}>{msg}</span>
      </div>
    </div>
  );
}

const PROVIDER_TYPES: { v: ProviderType; l: string; hint: string }[] = [
  { v: 'anthropic', l: tr('Anthropic 兼容'), hint: tr('https://api.anthropic.com 或中转站（如 https://api.super-nb.me）') },
];

type Draft = Partial<Provider> & { apiKey: string };
const emptyDraft = (): Draft => ({ name: '', type: 'anthropic', baseUrl: '', apiKey: '', defaultModel: '', modelMap: {} });

/** Third-party endpoint profiles. Keys live in ~/.claude-web/meta.json and are injected per session — settings.json is never touched. */
export function ProviderProfiles() {
  const [importing, setImporting] = useState(false);
  const all = useStore((s) => s.providers);
  // other Claude accounts are kept on 账号与登录 (their own dialog: a token, no endpoint, no model list)
  const providers = useMemo(() => all.filter((p) => p.type !== 'claude-account'), [all]);
  const accounts = all.length - providers.length;
  const loadProviders = useStore((s) => s.loadProviders);
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState<Draft | null>(null);
  type ChatCheck = { ok: boolean; model: string; error?: string; ms: number; status?: number };
  const [probe, setProbe] = useState<{ ok: boolean; models: string[]; modelNames?: Record<string, string>; modelEfforts?: Provider['modelEfforts']; modelContext?: Provider['modelContext']; error?: string; ms: number; status?: number; chat?: ChatCheck } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  // 「用哪些模型」: picked in this draft (null = untouched — what Settings → Models has), written on 保存
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [picking, setPicking] = useState(false);
  // opened by itself once per new provider: a 取消 there means 「all of them」, not 「ask again after every test」
  const autoPicked = useRef(false);
  const def = settings.defaultProviderId as string | undefined;

  // 自动压缩 (A7): why the typed point is not saved ('' = it is), and a fresh editor for every 编辑 / 添加
  const [compactErr, setCompactErr] = useState('');
  const [editSeq, setEditSeq] = useState(0);
  const startEdit = (p?: Provider) => { setCompactErr(''); setEditSeq((n) => n + 1); setEditing(p ? { ...p, modelMap: { ...(p.modelMap ?? {}) } } : emptyDraft()); setProbe(p?.models?.length ? { ok: true, models: p.models, modelNames: p.modelNames, modelEfforts: p.modelEfforts, modelContext: p.modelContext, ms: 0 } : null); setShowKey(false); setPicked(null); setPicking(false); autoPicked.current = false; };
  const test = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const r: any = await ws.request({ kind: 'providers.probe', id: editing.id, provider: { type: editing.type, baseUrl: editing.baseUrl, apiKey: editing.apiKey, defaultModel: editing.defaultModel, modelMap: editing.modelMap, authStyle: editing.authStyle } });
      setProbe(r);
      // a new service's list just came in: pick the ones to use, then save (忍冬 2026-10-14)
      if (!editing.id && r.ok && (r.models?.length ?? 0) > 3 && !picked && !autoPicked.current) { autoPicked.current = true; setPicking(true); }
    } catch (e: any) { setProbe({ ok: false, models: [], error: e.message, ms: 0 }); }
    setBusy(false);
  };
  const save = async () => {
    if (!editing) return;
    if (!editing.name?.trim()) return toast(tr('请填名称'));
    if (!editing.baseUrl?.trim()) return toast(tr('请填 Base URL'));
    if (!editing.id && !editing.apiKey.trim()) return toast(tr('请填 API Key'));
    // not a toast: toasts run failures through the error explainer, which reads 「上下文窗口」 as a too-long conversation
    if (compactErr) return void dlg.alert(tr('自动压缩'), { message: compactErr });
    setBusy(true);
    try {
      const fresh = !!(probe?.ok && probe.models.length);
      const models = fresh ? probe!.models : editing.models;
      // the display names come with the list they were read from (none in this list = none kept)
      const modelNames = fresh ? probe!.modelNames ?? (null as any) : editing.modelNames;
      const modelEfforts = fresh ? probe!.modelEfforts ?? (null as any) : editing.modelEfforts;
      const modelContext = fresh ? probe!.modelContext ?? (null as any) : editing.modelContext;
      const saved = await ws.request<Provider>({ kind: 'providers.upsert', provider: { ...editing, models, modelNames, modelEfforts, modelContext, contextWindows: editing.contextWindows && Object.keys(editing.contextWindows).length ? editing.contextWindows : (null as any) } });
      if (picked && models?.length) {
        const hidden = (useStore.getState().settings['ui.disabledModels'] as string[] | undefined) ?? [];
        await setSetting('ui.disabledModels', withPicked(hidden, saved.id, models, picked));
      }
      // the first provider of someone without a Claude login is what they will send with: the default for new
      // conversations (a default already set, or a logged-in account, stays)
      const st = useStore.getState();
      const hasDefault = !!def && st.providers.some((x) => x.id === def);
      if (!editing.id && !hasDefault && st.auth?.loggedIn === false) await setSetting('defaultProviderId', saved.id);
      await loadProviders();
      toast(tr('已保存供应商「{name}」', { name: saved.name }), true);
      setEditing(null);
    } catch (e: any) { toast(e.message); }
    setBusy(false);
  };
  const remove = async (p: Provider) => {
    if (!(await dlg.confirm(tr('删除供应商「{name}」？', { name: p.name }), { message: tr('用它开的对话恢复时会退回 Claude 账号。'), danger: true }))) return;
    await ws.request({ kind: 'providers.remove', id: p.id }).catch((e) => toast(e.message));
    await loadProviders();
  };
  const models = probe?.ok ? probe.models : editing?.models ?? [];
  const shownModels = picked ?? pickedOf((settings['ui.disabledModels'] as string[] | undefined) ?? [], editing?.id, models);
  const shownCount = models.filter((m) => shownModels.has(m)).length;
  const modelPick = (label: string, key: 'defaultModel' | 'haiku' | 'sonnet' | 'opus') => {
    const val = key === 'defaultModel' ? editing!.defaultModel ?? '' : editing!.modelMap?.[key] ?? '';
    const set = (v: string) => setEditing(key === 'defaultModel' ? { ...editing!, defaultModel: v } : { ...editing!, modelMap: { ...(editing!.modelMap ?? {}), [key]: v } });
    return (
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
        <span style={{ minWidth: 110, fontSize: 13, color: 'var(--fg-2)' }}>{label}</span>
        <input className="field" style={{ flex: 1 }} list={`models-${key}`} value={val} onChange={(e) => set(e.target.value)} placeholder={key === 'defaultModel' ? tr('不填 = 端点默认 / 输入框里再选') : tr('别名 {key} 映射到的模型', { key })} />
        <datalist id={`models-${key}`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
      </div>
    );
  };
  return (
    <div className="section">
      <h5 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{tr('全部供应商')} <span className="grow" /><button className="btn sm" data-act="quick" onClick={() => void connectModel({ reason: 'settings' })} title={tr('选来源、粘贴 Key：模型列表和接口格式自动读取')}>{tr('快速添加')}</button><button className="btn sm" data-act="import" onClick={() => setImporting(true)} title={tr('把 CC Switch、Hermes、编辑器等工具里配好的 Anthropic 兼容供应商和 MCP 服务器拿过来')}>{tr('从其它工具导入…')}</button><button className="btn sm ghost" onClick={() => startEdit()} title={tr('所有选项：地址、模型映射、缓存…')}><Icon name="plus" size={12} /> {tr('添加')}</button></h5>
      {importing && <ImportDialog only="provider" onClose={() => setImporting(false)} />}
      <div className="sub" style={{ marginBottom: 8 }}>{tr('每个对话用一个（输入框的模型菜单里换）。密钥只交给用它的那个对话，不写进')} <code>~/.claude/settings.json</code>{tr('，claude.ai 登录照常可用。')}</div>
      <div className="list">
        <div className="row">
          <span className="dot idle" />
          <div className="grow"><div>{tr('Claude 账号')}</div><div className="sub">{tr('claude.ai 登录（终端里运行 claude auth login）· 订阅额度')}</div></div>
          <button className={clsx('btn sm', !def && 'primary')} onClick={() => setSetting('defaultProviderId', undefined)}>{!def ? tr('默认') : tr('设为默认')}</button>
        </div>
        {accounts > 0 && (
          <div className="row">
            <span className="dot idle" />
            <div className="grow"><div>{tr('其它 Claude 账号')}</div><div className="sub">{tr('{accounts} 个，在「账号与登录」里管理', { accounts })}</div></div>
            <button className="btn sm ghost" onClick={() => useStore.getState().openSettings({ section: 'account' })}>{tr('管理')}</button>
          </div>
        )}
        {providers.map((p) => (
          <div key={p.id} className="row">
            <span className={clsx('dot', p.models?.length ? 'idle' : 'waiting')} title={p.models?.length ? tr('已测试 · {modelsCount} 个模型', { modelsCount: p.models.length }) : tr('未测试连接')} />
            <div className="grow">
              <div>{p.name}</div>
              <div className="sub mono">{p.baseUrl || tr('（默认端点）')} · {p.apiKey || tr('无 key')}{p.defaultModel ? ` · ${p.defaultModel}` : ''}</div>
            </div>
            <button className={clsx('btn sm', def === p.id && 'primary')} onClick={() => setSetting('defaultProviderId', p.id)}>{def === p.id ? tr('默认') : tr('设为默认')}</button>
            <button className="btn sm ghost" onClick={() => startEdit(p)}>{tr('编辑')}</button>
            <button className="btn sm danger" onClick={() => remove(p)}>{tr('删除')}</button>
          </div>
        ))}
      </div>
      {editing && (
        <div className="section" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginTop: 8 }}>
          <h5>{editing.id ? tr('编辑「{name}」', { name: editing.name }) : tr('新供应商')}</h5>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input className="field" style={{ flex: 1 }} placeholder={tr('名称，如 super-nb')} value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </div>
          <input className="field" style={{ width: '100%', marginBottom: 6 }} placeholder={`Base URL · ${PROVIDER_TYPES[0].hint}`} value={editing.baseUrl ?? ''} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} />
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <input className="field" style={{ flex: 1 }} type={showKey ? 'text' : 'password'} placeholder={editing.id ? tr('API Key（留空保持 {apiKey}）', { apiKey: editing.apiKey || tr('现有值') }) : 'API Key'} value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} autoComplete="off" />
            <button className="icon-btn" onClick={() => setShowKey(!showKey)} aria-label={tr('显示密钥')}><Icon name="eye" size={14} /></button>
            <button className="btn sm" disabled={busy} onClick={test}>{busy ? tr('测试中…') : tr('测试连接')}</button>
          </div>
          {probe && (
            <div style={{ fontSize: 13, marginBottom: 6, color: probe.ok ? 'var(--green)' : 'var(--red)' }}>
              {probe.models.length > 0 ? tr('模型列表 {modelsCount} 个', { modelsCount: probe.models.length }) : probe.ok ? tr('连接正常') : tr('失败{v}：{error}', { v: probe.status ? ` HTTP ${probe.status}` : '', error: probe.error })}
              {probe.chat && (probe.chat.ok
                ? tr(' · 对话测试通过（{model} · {ms}s）', { model: probe.chat.model, ms: (probe.chat.ms / 1000).toFixed(1) })
                : tr(' · 对话测试失败：{error}', { error: probe.chat.error }))}
              {REGION_RE.test(`${probe.ok ? '' : probe.error ?? ''} ${probe.chat?.ok ? '' : probe.chat?.error ?? ''}`) && <div style={{ color: 'var(--fg-1)' }}>{REGION_BLOCKED}</div>}
            </div>
          )}
          {models.length > 1 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              <span style={{ minWidth: 110, fontSize: 13, color: 'var(--fg-2)' }}>{tr('用哪些模型')}</span>
              <span className="sub" style={{ flex: 1 }}>{shownCount === models.length ? tr('全部 {count} 个都在模型菜单里', { count: models.length }) : tr('{n} / {count} 个在模型菜单里', { n: shownCount, count: models.length })}</span>
              <button className="btn sm" data-act="pick-models" onClick={() => setPicking(true)}>{tr('选择…')}</button>
            </div>
          )}
          {picking && <ModelPicker name={editing.name?.trim() || tr('新供应商')} models={models} names={probe?.ok ? probe.modelNames : editing.modelNames} initial={shownModels} onDone={(p) => { setPicking(false); if (p) setPicked(p); }} />}
          {modelPick(tr('默认模型'), 'defaultModel')}
          {modelPick('haiku →', 'haiku')}
          {modelPick('sonnet →', 'sonnet')}
          {modelPick('opus →', 'opus')}
          <ContextWindows editing={editing} models={models} listed={probe?.ok ? probe.modelContext : editing.modelContext} set={setEditing} />
          <CompactAt key={editSeq} value={editing.compactAt ?? undefined} window={compactWindowOfProvider({ ...editing, modelContext: probe?.ok ? probe.modelContext : editing.modelContext })}
            onChange={(v, e) => { setCompactErr(e ?? ''); setEditing((d) => (d ? { ...d, compactAt: v ?? (null as any) } : d)); }} />
          <CacheOptions editing={editing} set={setEditing} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm primary" disabled={busy} onClick={save}>{tr('保存')}</button>
            <button className="btn sm ghost" onClick={() => setEditing(null)}>{tr('取消')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 上下文窗口 per model (2026-10-14 user report: a relay's Claude compacted at 175K; aimami sets it per model). Empty =
 * the default it shows: what the model list said, else the family's full size (Claude 1M…), else the engine's 200K. The models in use (default, family map) first; with many, a filter.
 */
function ContextWindows({ editing, models, listed, set }: { editing: Draft; models: string[]; listed?: Record<string, number>; set: (d: Draft) => void }) {
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const used = [editing.defaultModel, ...Object.values(editing.modelMap ?? {})].filter((m): m is string => !!m && !!m.trim());
  const setOnes = Object.keys(editing.contextWindows ?? {});
  const ids = [...new Set([...used, ...setOnes, ...models])];
  const ql = q.trim().toLowerCase();
  const shown = ql ? ids.filter((m) => m.toLowerCase().includes(ql)) : all ? ids : ids.slice(0, 8);
  if (!ids.length) return null;
  const put = (m: string, v: string) => {
    const n = Math.round(Number(v.replace(/[,_\s]/g, '').replace(/k$/i, '000').replace(/m$/i, '000000')));
    const next = { ...(editing.contextWindows ?? {}) };
    if (!v.trim() || !Number.isFinite(n) || n <= 0) delete next[m];
    else next[m] = n;
    set({ ...editing, contextWindows: next });
  };
  return (
    <div className="ctx-win" style={{ margin: '8px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg-2)', marginBottom: 4 }}>
        <span title={tr('对话用到多少 token 时自动压缩，看的就是这个。空着 = 用默认：模型列表写的，否则按模型拉满（Claude 1M），都不知道就是 200K')}>{tr('上下文窗口')}</span>
        <span className="grow" />
        {ids.length > 8 && <input className="field" style={{ width: 160, height: 26 }} placeholder={tr('筛选模型')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={tr('筛选模型')} />}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px', gap: '4px 8px', alignItems: 'center' }}>
        {shown.map((m) => {
          const def = contextWindowFor({ modelContext: listed }, m);
          const src = contextWindowSource({ modelContext: listed }, m);
          return (
            <Fragment key={m}>
              <span className="mono" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m}>{m}</span>
              <input className="field mono" style={{ height: 26, fontSize: 12 }} inputMode="numeric" aria-label={tr('{m} 的上下文窗口', { m })}
                value={editing.contextWindows?.[m] ?? ''} onChange={(e) => put(m, e.target.value)}
                placeholder={tr('默认 {def}', { def: (def ?? 200_000).toLocaleString('en-US') })}
                title={src === 'list' ? tr('默认值来自模型列表') : src === 'known' ? tr('默认值按模型拉满') : tr('不认识的模型：引擎默认 200K')} />
            </Fragment>
          );
        })}
      </div>
      {!ql && ids.length > 8 && <button className="link" style={{ fontSize: 12, marginTop: 4 }} onClick={() => setAll(!all)}>{all ? tr('收起') : tr('显示全部 {idsCount} 个模型', { idsCount: ids.length })}</button>}
      <div className="sub" style={{ fontSize: 12, marginTop: 4 }}>{tr('可以写 272000、272k 或 1m。正在跑的对话要重新开始才用得上。')}</div>
    </div>
  );
}

/** Prompt-cache and auth switches of a profile. `null` = back to the default. */
function CacheOptions({ editing, set }: { editing: Draft; set: (d: Draft) => void }) {
  const row = { display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: 'var(--fg-2)', margin: '4px 0' } as const;
  return (
    <>
      <SwitchLine title={tr('ENABLE_PROMPT_CACHING_1H=1。写入按 2× 基础价（5 分钟是 1.25×），适合经常停下来超过 5 分钟的对话')} on={!!editing.cache1h} onChange={(on) => set({ ...editing, cache1h: on ? true : (null as any) })}>
        {tr('1 小时提示缓存（写入 2× 基础价）')}
      </SwitchLine>
      <label style={row} title={tr('Key 放在哪个请求头里：Authorization: Bearer、x-api-key，或两个都带。默认：对话用 Bearer，测试两个都带')}>
        {tr('鉴权方式')}
        <Select value={editing.authStyle ?? ''} onValueChange={(v) => set({ ...editing, authStyle: (String(v) || null) as any })} aria-label={tr('鉴权方式')} options={[{ value: '', label: tr('默认') }, { value: 'bearer', label: 'Authorization: Bearer' }, { value: 'x-api-key', label: 'x-api-key' }, { value: 'both', label: tr('两个都带') }]} />
      </label>
    </>
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
      {tab === 'mcp' && <><Mcp /><McpAddJson /></>}
      {tab === 'skills' && <SimpleList kind="config.skills" render={(s) => <div className="grow"><div>/{s.name} <span style={{ color: 'var(--fg-2)', fontSize: 12 }}>{s.source}</span></div><div className="sub">{s.description}</div></div>} />}
      {tab === 'agents' && <SimpleList kind="config.agents" render={(a) => <div className="grow"><div>{a.name} <span style={{ color: 'var(--fg-2)', fontSize: 12 }}>{a.source}{a.model ? ` · ${a.model}` : ''}</span></div><div className="sub">{a.description}</div></div>} />}
      {tab === 'hooks' && <SimpleList kind="config.hooks" render={(h) => <div className="grow"><div>{h.event} <span style={{ color: 'var(--fg-2)', fontSize: 12 }}>{h.matcher ? `matcher: ${h.matcher}` : ''} · {h.source}</span></div><div className="sub">{(h.hooks ?? []).map((x: any) => x.command ?? x.type).join(' ; ')}</div></div>} />}
      {tab === 'settings' && <><UiSettings /><Settings /></>}
    </div>
  );
}
