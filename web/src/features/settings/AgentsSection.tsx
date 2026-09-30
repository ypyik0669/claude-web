import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import type { AgentConfigKind, AgentInfo, AgentKind } from '@shared';
import { ICON_NAMES, Icon, type IconName } from '@/ui/icons';
import { AgentConfigPanel, CONFIGURABLE } from './AgentConfigPanel';
import { TERMS } from '@/ui/terms';
import { ProviderSelect } from '@/features/providers/ProviderSelect';

const PROTO_LABEL: Record<AgentInfo['protocol'], string> = { claude: 'Claude Code', acp: 'ACP', codex: 'app-server' };

/** Opens a terminal tile in the focused pane and types a command into it (install / login flows are interactive). */
function runInTerminal(cmd: string) {
  const st = useStore.getState();
  const g = st.layout.groups.find((x) => x.id === st.layout.activeGroupId);
  const paneId = g?.focusedPaneId ?? g?.id;
  if (!g || !paneId) return;
  const cwd = st.workspaces[0]?.path ?? st.sessions[0]?.cwd ?? '';
  st.dispatchLayout({ t: 'tile.open', paneId, tile: { id: `t${Date.now()}`, kind: 'term', cwd, cmd, title: cmd.split(' ').slice(0, 2).join(' ') }, mode: 'tab' });
  st.openSettings(null as any);
}

/**
 * 「新对话用」: the provider this agent's new conversations run on (a relay's key instead of the agent's own
 * account) — also for IM bots, scheduled tasks, goals and hand-overs to it. What reaches the agent differs:
 * Codex gets its own provider override (through the local cache shim, which also serves relays that only have
 * chat/completions), Gemini CLI its API-key login, the others the OPENAI_* variables.
 */
function AgentProvider({ a, save }: { a: AgentInfo; save: (patch: Record<string, unknown>) => Promise<void> }) {
  const providers = useStore((s) => s.providers);
  const picked = a.providerId ? providers.find((p) => p.id === a.providerId) : undefined;
  const hint = !picked ? `用 ${a.name} 自己登录的账号${a.login ? `（${a.login}）` : ''}`
    : a.kind === 'codex' ? `Codex 连到「${picked.name}」：只有 chat/completions 的中转也能用（本机自动转换）`
    : a.kind === 'gemini' ? `Gemini CLI 用「${picked.name}」的 API Key 登录`
    : `把「${picked.name}」的地址和 Key 作为 OPENAI_BASE_URL / OPENAI_API_KEY 传给 ${a.name}；用不用由它自己决定`;
  return (
    <div className="agent-provider">
      <span className="sub">新对话用</span>
      <ProviderSelect agent={a.kind} value={a.providerId ?? ''} onChange={(v) => void save({ providerId: v })} first={{ label: '自己的登录', title: hint }} className="field" />
      <span className="sub" title={hint}>{hint}</span>
    </div>
  );
}

function AgentCard({ a, onChange }: { a: AgentInfo; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [cfgOpen, setCfgOpen] = useState(false);
  const configurable = (CONFIGURABLE as string[]).includes(a.kind);
  const [busy, setBusy] = useState(false);
  const fromAgent = () => ({ command: a.command, args: a.args.join(' '), model: a.model, label: a.label, env: Object.entries(a.env).map(([k, v]) => `${k}=${v}`).join('\n') });
  const [f, setF] = useState(fromAgent);
  // reset only when the saved config really changed: every agents reload (another card's toggle,
  // 「重新检测」) hands us a new object, which used to wipe whatever was being typed here
  const savedKey = JSON.stringify(fromAgent());
  useEffect(() => { setF(fromAgent()); }, [savedKey]);
  const toast = useStore((s) => s.toast);
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try { await ws.request({ kind: 'agents.set', agent: a.kind, patch: patch as any }); onChange(); } catch (e: any) { toast(e.message); } finally { setBusy(false); }
  };
  const commit = () => {
    const env: Record<string, string> = {};
    for (const line of f.env.split('\n')) { const m = /^\s*([^=\s]+)\s*=\s*(.*)$/.exec(line); if (m) env[m[1]] = m[2]; }
    void save({ command: f.command.trim(), args: f.args.trim() ? f.args.trim().split(/\s+/) : [], model: f.model.trim(), label: f.label.trim(), env });
  };
  const remove = async () => {
    if (!(await dlg.confirm(`删除 agent「${a.name}」？`, { message: '只删除配置，不会卸载程序。', danger: true, okLabel: '删除' }))) return;
    void save(null as any);
  };
  return (
    <div className={clsx('row agent-card', !a.enabled && 'muted')} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className={clsx('dot', !a.installed ? 'error' : a.probeError ? 'waiting' : 'idle')} />
        {/* AgentInfo.icon is an icon name (custom ACP agents may still carry an old glyph) */}
        <Icon name={(ICON_NAMES as string[]).includes(a.icon) ? (a.icon as IconName) : 'agent'} size={16} />
        <div className="grow">
          <div title={`接入方式：${PROTO_LABEL[a.protocol]}`}>{a.name} <span className="mono muted" style={{ fontSize: 11.5 }}>{a.installed ? a.version || '已找到' : '未安装'}</span>{a.label && <span className="badge" style={{ marginLeft: 6, color: 'var(--blue)' }}>{a.label}</span>}</div>
          {/* where it was found: a copy inside the Codex desktop app / IDE extension is not on PATH, so say whose it is */}
          <div className="sub mono" title={a.path}>{a.from ? `用的是${a.from}自带的 ${a.command}` : `${a.command} ${a.args.join(' ')}`}{a.path && a.from ? ` · ${a.path}` : ''}</div>
          {a.probeError && <div className="sub agent-probe-err" data-probe-error title={a.probeError}>{a.probeError}</div>}
          {!a.installed && a.installNeeds && <div className="sub agent-probe-err">安装命令要用 {a.installNeeds.name}：先装好它，点「重新检测」，再点「安装」。</div>}
        </div>
        {a.kind !== 'claude' && <label className="chip" title="关掉后新对话的选择器里不再出现"><input type="checkbox" checked={a.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> 启用</label>}
        {!a.installed && a.installNeeds && <a className="btn sm" href={a.installNeeds.url} target="_blank" rel="noreferrer" title={a.installNeeds.url}>下载 {a.installNeeds.name}</a>}
        {!a.installed && a.install && <button className={clsx('btn sm', a.installNeeds && 'ghost')} onClick={() => runInTerminal(a.install)} title={a.install}>安装</button>}
        {a.installed && a.login && <button className="btn sm ghost" onClick={() => runInTerminal(a.login)} title={a.login}>登录</button>}
        {a.docs && <a className="btn sm ghost" href={a.docs} target="_blank" rel="noreferrer">文档</a>}
        {configurable && <button className={clsx('btn sm ghost', cfgOpen && 'on')} onClick={() => setCfgOpen(!cfgOpen)} title="说明文件 / MCP / 模型等设置 / 备份">配置中心</button>}
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>{open ? '收起' : '启动参数'}</button>
      </div>
      {a.kind !== 'claude' && <AgentProvider a={a} save={save} />}
      {cfgOpen && configurable && <AgentConfigPanel kind={a.kind as AgentConfigKind} />}
      {open && (
        <div className="agent-form">
          <label>命令<input className="field" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder="可执行文件名或完整路径" /></label>
          <label>参数<input className="field" value={f.args} onChange={(e) => setF({ ...f, args: e.target.value })} placeholder="空格分隔" /></label>
          <label>默认模型
            <input className="field" list={`models-${a.kind}`} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="留空用 agent 自己的默认" />
            <datalist id={`models-${a.kind}`}>{a.models.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <label>备注 / 账号<input className="field" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="例如 work@example.com" /></label>
          <label>环境变量<textarea className="field" rows={3} value={f.env} onChange={(e) => setF({ ...f, env: e.target.value })} placeholder={'KEY=value\n每行一个'} /></label>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            {!a.builtin && <button className="btn sm ghost danger" onClick={remove}>删除</button>}
            <span className="grow" />
            <button className="btn sm" disabled={busy} onClick={commit}>保存</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** CLI agents (Codex / Gemini / Qwen / Kimi / any ACP agent): detection, install, login, per-agent command & model. */
export function AgentsSection() {
  const agents = useStore((s) => s.agents);
  const loadAgents = useStore((s) => s.loadAgents);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const reload = (refresh = false) => { setBusy(true); loadAgents(refresh).catch((e) => toast(e.message)).finally(() => setBusy(false)); };
  useEffect(() => { reload(false); }, []);
  const addCustom = async () => {
    const name = await dlg.prompt('添加自定义 Agent', '', { message: '任何实现 Agent Client Protocol 的命令行 agent（Hermes、OpenCode、自研…）。先起名字。' });
    if (!name) return;
    const command = await dlg.prompt('启动命令', '', { message: '例如 `hermes --acp` 或 `node ./my-agent.js`；后面可在配置里改参数与环境变量。' });
    if (!command) return;
    const [cmd, ...args] = command.trim().split(/\s+/);
    const id = `acp:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || Date.now().toString(36)}` as AgentKind;
    try { await ws.request({ kind: 'agents.set', agent: id, patch: { name, command: cmd, args, protocol: 'acp' } }); reload(); } catch (e: any) { toast(e.message); }
  };
  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <h5 style={{ margin: 0 }}>{TERMS.agents}</h5>
        <span className="muted" style={{ fontSize: 12 }}>新对话在输入框的模型菜单里选；已有对话在右上角菜单里「{TERMS.handoff}」</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={addCustom} title="任何实现 Agent Client Protocol（ACP）的命令行 agent"><Icon name="plus" size={12} /> 自定义 Agent</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => reload(true)}>{busy ? '检测中…' : '重新检测'}</button>
      </div>
      <div className="list">
        {agents.map((a) => <AgentCard key={a.kind} a={a} onChange={() => reload(false)} />)}
        {agents.length === 0 && <div className="empty">检测中…</div>}
      </div>
      <div className="sub" style={{ marginTop: 8 }} title="Codex 走 codex app-server（JSON-RPC），Gemini / Qwen / Kimi 和自定义 agent 走 ACP（--acp / --experimental-acp）">
        权限确认、工具卡片、总览、账本对所有 Agent 一致；它们的对话记录存在 <code>~/.claude-web/agents/</code>。装好之后没检测到？点「重新检测」：会重新读取系统 PATH，也会找 Codex 桌面版 / IDE 扩展自带的 codex。
      </div>
    </div>
  );
}
