import { useEffect, useMemo, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import type { AgentConfigBackup, AgentConfigFile, AgentConfigKind, AgentConfigState, AgentSettingField, ClaudeMcpEntry, McpSpec, McpSyncResult } from '@shared';
import { EMPTY_FORM, describeSpec, formFromCatalog, formToSpec, type McpForm } from './agent-config-form';
import { MCP_CATALOG } from './McpCatalog';

export const CONFIGURABLE: AgentConfigKind[] = ['codex', 'gemini', 'qwen', 'opencode'];
const NAMES: Record<AgentConfigKind, string> = { codex: 'Codex', gemini: 'Gemini', qwen: 'Qwen', opencode: 'OpenCode' };

/** Workspace the project-level instruction files belong to: the focused session's cwd, else the first workspace. */
function defaultCwd(): string {
  const st = useStore.getState();
  return st.sessions.find((s) => s.sessionId === st.activeId)?.cwd ?? st.workspaces[0]?.path ?? '';
}

function openDoc(path: string) {
  const st = useStore.getState();
  st.openTile({ id: `d${Date.now()}`, kind: 'doc', path }, 'tab');
  st.openSettings(null as any);
}

function FileRow({ f, onOpen }: { f: AgentConfigFile; onOpen: (f: AgentConfigFile) => void }) {
  return (
    <div className="row">
      <Icon name={f.kind === 'config' ? 'config' : 'read'} size={14} />
      <div className="grow">
        <div>{f.label} {!f.exists && <span className="badge">不存在</span>}</div>
        <div className="sub mono" title={f.path}>{f.path}</div>
      </div>
      <button className="btn sm ghost" onClick={() => onOpen(f)}>{f.exists ? '打开' : '创建并打开'}</button>
    </div>
  );
}

function SettingRow({ f, onSet }: { f: AgentSettingField; onSet: (v: string | null) => Promise<void> }) {
  const [v, setV] = useState(f.value ?? '');
  useEffect(() => setV(f.value ?? ''), [f.value]);
  const commit = (next: string) => { if (next !== (f.value ?? '')) void onSet(next.trim() ? next.trim() : null); };
  return (
    <label className="acfg-field">
      <span>{f.label} <span className="mono muted">{f.key}</span></span>
      {f.type === 'enum' ? (
        <select className="field" value={v} onChange={(e) => { setV(e.target.value); commit(e.target.value); }}>
          <option value="">（未设置，用默认）</option>
          {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <>
          <input className="field" value={v} list={f.suggestions?.length ? `acfg-${f.key}` : undefined} placeholder="（未设置，用默认）" onChange={(e) => setV(e.target.value)} onBlur={() => commit(v)} onKeyDown={(e) => { if (e.key === 'Enter') commit(v); }} />
          {!!f.suggestions?.length && <datalist id={`acfg-${f.key}`}>{f.suggestions.map((m) => <option key={m} value={m} />)}</datalist>}
        </>
      )}
      {f.hint && <span className="sub">{f.hint}</span>}
    </label>
  );
}

function McpAddForm({ state, onDone }: { state: AgentConfigState; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [f, setF] = useState<McpForm>({ ...EMPTY_FORM, transport: state.transports[0] });
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    let spec: McpSpec;
    try { spec = formToSpec(f); } catch (e: any) { toast(e.message); return; }
    setBusy(true);
    try { const msg = await ws.request<string>({ kind: 'agentConfig.mcp.add', agent: state.kind, spec, overwrite }); toast(msg, true); onDone(); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="acfg-form">
      <label>从目录填入
        <select className="field" value="" onChange={(e) => { const c = MCP_CATALOG.find((x) => x.id === e.target.value); if (c) setF(formFromCatalog(c.id, c.json as any, c.env)); }}>
          <option value="">（选一个常用服务器…）</option>
          {MCP_CATALOG.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.desc}</option>)}
        </select>
      </label>
      <label>名称<input className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="字母 / 数字 / _ / -" /></label>
      <label>传输
        <select className="field" value={f.transport} onChange={(e) => setF({ ...f, transport: e.target.value as McpSpec['transport'] })}>
          {state.transports.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      {f.transport === 'stdio' ? (
        <>
          <label className="wide">命令与参数<input className="field mono" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder='npx -y @modelcontextprotocol/server-filesystem "C:\My Docs"' /></label>
          <label className="wide">环境变量<textarea className="field" rows={2} value={f.env} onChange={(e) => setF({ ...f, env: e.target.value })} placeholder={'KEY=value\n每行一个'} /></label>
        </>
      ) : (
        <>
          <label className="wide">URL<input className="field mono" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…/mcp" /></label>
          <label className="wide">Header<textarea className="field" rows={2} value={f.headers} onChange={(e) => setF({ ...f, headers: e.target.value })} placeholder={'Authorization: Bearer …\n每行一个'} /></label>
        </>
      )}
      <div className="wide acfg-actions">
        <label className="chip"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> 覆盖同名</label>
        <span className="grow" />
        <button className="btn sm ghost" onClick={onDone}>取消</button>
        <button className="btn sm" disabled={busy} onClick={submit}>{busy ? '添加中…' : '添加'}</button>
      </div>
    </div>
  );
}

function SyncFromClaude({ state, cwd, onDone }: { state: AgentConfigState; cwd: string; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<ClaudeMcpEntry[] | null>(null);
  const [pick, setPick] = useState('');
  const [targets, setTargets] = useState<AgentConfigKind[]>([state.kind]);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<McpSyncResult[] | null>(null);
  useEffect(() => { ws.request<ClaudeMcpEntry[]>({ kind: 'agentConfig.claudeMcp', cwd: cwd || undefined }).then((l) => { setList(l); if (l[0]) setPick(l[0].spec.name); }).catch((e) => { toast(e.message); setList([]); }); }, [cwd]);
  const run = async () => {
    setBusy(true);
    try { setResults(await ws.request<McpSyncResult[]>({ kind: 'agentConfig.mcp.sync', source: { claude: pick, cwd: cwd || undefined }, targets, overwrite })); onDone(); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const names = [...new Set((list ?? []).map((e) => e.spec.name))];
  return (
    <div className="acfg-form">
      <label className="wide">Claude 的 MCP 服务器
        <select className="field" value={pick} onChange={(e) => setPick(e.target.value)} disabled={!list?.length}>
          {list === null && <option>读取中…</option>}
          {list?.length === 0 && <option>Claude 里还没有 MCP 服务器</option>}
          {names.map((n) => { const e = list!.filter((x) => x.spec.name === n); return <option key={n} value={n}>{n} · {e[0].spec.transport} · {e.map((x) => x.scope).join('/')} · {describeSpec(e[0].spec).slice(0, 60)}</option>; })}
        </select>
      </label>
      <div className="wide acfg-actions">
        <span className="muted">同步到</span>
        {CONFIGURABLE.map((k) => (
          <label key={k} className="chip"><input type="checkbox" checked={targets.includes(k)} onChange={(e) => setTargets(e.target.checked ? [...targets, k] : targets.filter((x) => x !== k))} /> {NAMES[k]}</label>
        ))}
        <label className="chip"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> 覆盖同名</label>
        <span className="grow" />
        <button className="btn sm" disabled={busy || !pick || !targets.length || !list?.length} onClick={run}>{busy ? '同步中…' : '同步'}</button>
      </div>
      {results && (
        <div className="wide acfg-results">
          {results.map((r) => (
            <div key={r.agent} className={clsx('acfg-result', r.ok ? 'ok' : 'err')}><Icon name={r.ok ? 'check' : 'alert'} size={12} /> <b>{NAMES[r.agent]}</b> {r.message}</div>
          ))}
        </div>
      )}
      <div className="wide sub">密钥类的值（env / header）由服务端按名字读取原配置直接写入目标，不经过浏览器。</div>
    </div>
  );
}

/** Settings → CLI Agents → an agent's 「配置中心」: instructions files, MCP servers, settings keys and backups. */
export function AgentConfigPanel({ kind }: { kind: AgentConfigKind }) {
  const toast = useStore((s) => s.toast);
  const workspaces = useStore((s) => s.workspaces);
  const [cwd, setCwd] = useState(defaultCwd);
  const [state, setState] = useState<AgentConfigState | null>(null);
  const [backups, setBackups] = useState<AgentConfigBackup[]>([]);
  const [mode, setMode] = useState<'none' | 'add' | 'sync'>('none');
  const [showBackups, setShowBackups] = useState(false);
  const [err, setErr] = useState('');
  const load = () => {
    ws.request<AgentConfigState>({ kind: 'agentConfig.get', agent: kind, cwd: cwd || undefined }).then((s) => { setState(s); setErr(''); }).catch((e) => setErr(e.message));
    ws.request<AgentConfigBackup[]>({ kind: 'agentConfig.backups', agent: kind }).then(setBackups).catch(() => {});
  };
  useEffect(load, [kind, cwd]);
  const cwdOptions = useMemo(() => [...new Set([cwd, ...workspaces.map((w) => w.path)].filter(Boolean))], [workspaces, cwd]);

  const openFile = async (f: AgentConfigFile) => {
    try {
      const p = f.exists ? f.path : await ws.request<string>({ kind: 'agentConfig.createFile', agent: kind, path: f.path, cwd: cwd || undefined });
      openDoc(p);
    } catch (e: any) { toast(e.message); }
  };
  const remove = async (s: McpSpec) => {
    if (!(await dlg.confirm(`从 ${state?.name} 删除 MCP「${s.name}」？`, { message: state?.mcpVia === 'cli' ? '通过它自己的 CLI 删除；删除前会备份配置文件。' : '直接改配置文件；删除前会备份。', danger: true, okLabel: '删除' }))) return;
    try { toast(await ws.request<string>({ kind: 'agentConfig.mcp.remove', agent: kind, name: s.name }), true); load(); } catch (e: any) { toast(e.message); }
  };
  const setField = async (f: AgentSettingField, value: string | null) => {
    try {
      const b = await ws.request<AgentConfigBackup | null>({ kind: 'agentConfig.set', agent: kind, key: f.key, value });
      toast(`${f.label} 已${value === null ? '清除' : '保存'}${b ? '（原文件已备份）' : ''}`, true);
      load();
    } catch (e: any) { toast(e.message); load(); }
  };
  const restore = async (b: AgentConfigBackup) => {
    if (!(await dlg.confirm('恢复这个备份？', { message: `${b.path}\n会被 ${new Date(b.at).toLocaleString()} 的版本（${b.reason}）覆盖；当前内容先另存一份备份。`, okLabel: '恢复' }))) return;
    try { await ws.request({ kind: 'agentConfig.restore', id: b.id }); toast('已恢复', true); load(); } catch (e: any) { toast(e.message); }
  };

  if (err) return <div className="acfg"><div className="empty">{err}</div></div>;
  if (!state) return <div className="acfg"><div className="empty">读取配置中…</div></div>;
  return (
    <div className="acfg">
      <div className="acfg-head">
        <h6>说明文件</h6>
        <span className="grow" />
        {cwdOptions.length > 0 && (
          <select className="field acfg-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} title="项目说明文件所在的工作区">
            {cwdOptions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        )}
      </div>
      <div className="list">{state.files.map((f) => <FileRow key={f.path} f={f} onOpen={openFile} />)}</div>

      <div className="acfg-head">
        <h6>MCP 服务器</h6>
        <span className="badge">{state.mcpVia === 'cli' ? `${kind} mcp` : '编辑配置文件'}</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => setMode(mode === 'sync' ? 'none' : 'sync')}><Icon name="claude" size={12} /> 从 Claude 同步</button>
        <button className="btn sm ghost" onClick={() => setMode(mode === 'add' ? 'none' : 'add')}><Icon name="plus" size={12} /> 添加</button>
      </div>
      {mode === 'add' && <McpAddForm state={state} onDone={() => { setMode('none'); load(); }} />}
      {mode === 'sync' && <SyncFromClaude state={state} cwd={cwd} onDone={load} />}
      {state.mcpError && <div className="acfg-error"><Icon name="alert" size={12} /> {state.mcpError}</div>}
      <div className="list">
        {state.mcp.map((s) => (
          <div key={s.name} className={clsx('row', s.enabled === false && 'muted')}>
            <Icon name="mcp" size={14} />
            <div className="grow">
              <div>{s.name} <span className="badge">{s.transport}</span>{s.enabled === false && <span className="badge">已停用</span>}</div>
              <div className="sub mono" title={describeSpec(s)}>{describeSpec(s)}{s.env && Object.keys(s.env).length ? `  · env ${Object.keys(s.env).join(', ')}` : ''}{s.headers && Object.keys(s.headers).length ? `  · header ${Object.keys(s.headers).join(', ')}` : ''}</div>
            </div>
            <button className="icon-btn xs" title="删除" aria-label={`删除 ${s.name}`} onClick={() => remove(s)}><Icon name="trash" size={12} /></button>
          </div>
        ))}
        {!state.mcp.length && !state.mcpError && <div className="empty">还没有 MCP 服务器</div>}
      </div>

      <div className="acfg-head"><h6>设置</h6><span className="sub mono" title={state.configPath}>{state.configPath}</span></div>
      {state.settingsError && <div className="acfg-error"><Icon name="alert" size={12} /> {state.settingsError}</div>}
      <div className="acfg-fields">{state.settings.map((f) => <SettingRow key={f.key} f={f} onSet={(v) => setField(f, v)} />)}</div>

      <div className="acfg-head">
        <h6>备份</h6>
        <span className="muted">{backups.length} 份</span>
        <span className="grow" />
        {backups.length > 0 && <button className="btn sm ghost" onClick={() => setShowBackups(!showBackups)}>{showBackups ? '收起' : '展开'}</button>}
      </div>
      {showBackups && (
        <div className="list">
          {backups.map((b) => (
            <div key={b.id} className="row">
              <Icon name="archive" size={14} />
              <div className="grow">
                <div>{new Date(b.at).toLocaleString()} <span className="muted">· {b.reason}</span></div>
                <div className="sub mono" title={b.path}>{b.path} · {b.size} B</div>
              </div>
              <button className="btn sm ghost" onClick={() => restore(b)}>恢复</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
