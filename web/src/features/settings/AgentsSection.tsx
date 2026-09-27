import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import type { AgentInfo, AgentKind } from '@shared';
import { Icon } from '@/ui/icons';

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

function AgentCard({ a, onChange }: { a: AgentInfo; onChange: () => void }) {
  const [open, setOpen] = useState(false);
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
        <span className={clsx('dot', a.installed ? 'idle' : 'error')} />
        <span style={{ fontSize: 16 }}>{a.icon}</span>
        <div className="grow">
          <div>{a.name} <span className="mono muted" style={{ fontSize: 11.5 }}>{a.installed ? a.version : '未安装'}</span> <span className="badge" style={{ marginLeft: 6 }}>{PROTO_LABEL[a.protocol]}</span>{a.label && <span className="badge" style={{ marginLeft: 4, color: 'var(--blue)' }}>{a.label}</span>}</div>
          <div className="sub mono">{a.command} {a.args.join(' ')}</div>
        </div>
        {a.kind !== 'claude' && <label className="chip" title="关掉后新会话选择器里不再出现"><input type="checkbox" checked={a.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> 启用</label>}
        {!a.installed && a.install && <button className="btn sm" onClick={() => runInTerminal(a.install)} title={a.install}>安装</button>}
        {a.installed && a.login && <button className="btn sm ghost" onClick={() => runInTerminal(a.login)} title={a.login}>登录</button>}
        {a.docs && <a className="btn sm ghost" href={a.docs} target="_blank" rel="noreferrer">文档</a>}
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>{open ? '收起' : '配置'}</button>
      </div>
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
    const name = await dlg.prompt('自定义 ACP agent', '', { message: '任何实现 Agent Client Protocol 的命令行 agent（Hermes、OpenCode、自研…）。先起名字。' });
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
        <h5 style={{ margin: 0 }}>CLI agents</h5>
        <span className="muted" style={{ fontSize: 12 }}>同一个工作台跑多个 agent：新会话的「引擎」下拉里选择</span>
        <span className="grow" />
        <button className="btn sm ghost" onClick={addCustom}><Icon name="plus" size={12} /> 自定义 ACP</button>
        <button className="btn sm ghost" disabled={busy} onClick={() => reload(true)}>{busy ? '检测中…' : '重新检测'}</button>
      </div>
      <div className="list">
        {agents.map((a) => <AgentCard key={a.kind} a={a} onChange={() => reload(false)} />)}
        {agents.length === 0 && <div className="empty">检测中…</div>}
      </div>
      <div className="sub" style={{ marginTop: 8 }}>
        Codex 走 <code>codex app-server</code>（JSON-RPC），Gemini / Qwen / Kimi 和自定义 agent 走 ACP（<code>--acp</code> / <code>--experimental-acp</code>）。
        权限请求、工具卡片、Mission Control、账本对所有 agent 一致；会话记录存在 <code>~/.claude-web/agents/</code>。
      </div>
    </div>
  );
}
