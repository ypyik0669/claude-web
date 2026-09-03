import { useEffect, useState } from 'react';
import { ws } from '@/ws/client';
import { useStore } from '@/store';
import { clsx } from '@/util';
import { dlg } from '@/ui/dialog';
import { Icon } from '@/ui/icons';
import type { MemoryItem } from '@shared';

const AGENTS = [
  { l: 'Claude', how: 'Agent SDK 的 mcpServers（进程内注入）' },
  { l: 'Codex', how: '-c mcp_servers.memory.* 命令行覆盖' },
  { l: 'Gemini / Qwen / Kimi / 任何 ACP agent', how: 'session/new 的 mcpServers 字段' },
];

/**
 * Settings for the shared memory store.
 *
 * The one thing worth being loud about: every agent gets the store through the process WE spawn, so
 * nothing is written into the user's own `~/.claude`, `~/.codex` or `~/.gemini` config.
 */
export function MemorySettings() {
  const on = (useStore((s) => s.settings['memory.mcp']) ?? true) as boolean;
  const setSetting = useStore((s) => s.setSetting);
  const dispatch = useStore((s) => s.dispatchLayout);
  const toast = useStore((s) => s.toast);
  const [stats, setStats] = useState<{ total: number; byScope: Record<string, number> } | null>(null);

  const load = () => ws.request<{ total: number; byScope: Record<string, number> }>({ kind: 'memory.stats' }).then(setStats).catch(() => {});
  useEffect(() => { void load(); const off = ws.on((e) => { if (e.kind === 'memory.changed') void load(); }); return () => { off(); }; }, []);

  const clear = async () => {
    if (!await dlg.confirm(`删除全部 ${stats?.total ?? 0} 条记忆？无法撤销。`, { danger: true })) return;
    const all = await ws.request<MemoryItem[]>({ kind: 'memory.search', limit: 5000 });
    for (const m of all) await ws.request({ kind: 'memory.remove', id: m.id }).catch(() => {});
    toast('记忆已清空', true);
  };

  return (
    <div className="sec">
      <div className="row">
        <div className="grow">
          <div>把记忆开放给所有 agent</div>
          <div className="sub">关掉之后 agent 不再看到 memory_search / memory_write 工具，记忆面板仍然可用。改动在下次开会话时生效。</div>
        </div>
        <button className={clsx('toggle', on && 'on')} onClick={() => void setSetting('memory.mcp', !on)} />
      </div>

      <div className="label" style={{ marginTop: 14 }}>注入方式</div>
      {AGENTS.map((a) => (
        <div key={a.l} className="row">
          <div className="grow"><div>{a.l}</div><div className="sub">{a.how}</div></div>
        </div>
      ))}
      <div className="sub" style={{ marginTop: 8 }}>
        一律只作用在我们启动的进程上：<code>~/.claude</code>、<code>~/.codex</code>、<code>~/.gemini</code> 里的配置一个字都不改，卸载 claude-web 不留痕迹。
      </div>

      <div className="label" style={{ marginTop: 14 }}>存储</div>
      <div className="row">
        <div className="grow">
          <div>{stats ? `共 ${stats.total} 条` : '读取中…'}</div>
          <div className="sub">~/.claude-web/memory.db（SQLite + FTS5）{stats ? ` · 全局 ${stats.byScope.global ?? 0} · 项目 ${stats.byScope.project ?? 0} · 会话 ${stats.byScope.session ?? 0}` : ''}</div>
        </div>
        <button className="btn sm ghost" onClick={() => dispatch({ t: 'dock.show', panel: 'memory' })}><Icon name="memory" size={13} /> 打开面板</button>
        <button className="btn sm danger" disabled={!stats?.total} onClick={clear}>清空</button>
      </div>
    </div>
  );
}
