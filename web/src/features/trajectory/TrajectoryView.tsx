import { useMemo, useState } from 'react';
import { useScopedSession, useStore } from '@/store';
import { walkTools } from '@/model/conversation';
import { groupTurns } from '@/model/turn';
import { toolSummary } from '@/util';
import { Icon } from '@/ui/icons';

export function TrajectoryView() {
  const active = useScopedSession();
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    if (!active) return [];
    // 「轮」 counts the conversation's turns as the chat draws them (`groupTurns`): a round after a result that no
    // message of this window started — a goal's 继续, IM, a schedule — is a round of its own (review M-11)
    const turnOf = new Map<string, number>();
    groupTurns(active.conv.items).forEach((t, i) => { for (const it of t.body) if (it.kind === 'assistant') turnOf.set(it.id, i + 1); });
    const out: { turn: number; depth: number; name: string; summary: string; status: string; ms?: number; id: string; error?: string }[] = [];
    let lastTurn = 0;
    for (const { tool, depth, item } of walkTools(active.conv.items)) {
      if (depth === 0) lastTurn = turnOf.get(item.id) ?? lastTurn;
      const s = toolSummary(tool.name, tool.input);
      if (q && !`${tool.name} ${s} ${tool.result?.content ?? ''}`.toLowerCase().includes(q.toLowerCase())) continue;
      const ms = item.ts && tool.result?.ts ? Date.parse(tool.result.ts) - Date.parse(item.ts) : undefined;
      out.push({ turn: lastTurn, depth, name: tool.name, summary: s, status: tool.status, ms, id: tool.id, error: tool.result?.isError ? tool.result.content.slice(0, 120) : undefined });
    }
    return out;
  }, [active?.version, q]);

  if (!active) return null;
  const counts = rows.reduce<Record<string, number>>((m, r) => ((m[r.name] = (m[r.name] ?? 0) + 1), m), {});
  return (
    <div className="chat">
      <div className="traj">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
          <input className="mono" placeholder="搜索工具调用…" value={q} onChange={(e) => setQ(e.target.value)} style={{ background: 'var(--bg-1)', border: '1px solid var(--line)', borderRadius: 4, padding: '4px 8px', width: 260 }} />
          <span style={{ color: 'var(--fg-2)', fontSize: 12 }}>{rows.length} 次调用</span>
          {Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([n, c]) => (
              <span key={n} className="badge" style={{ cursor: 'pointer' }} onClick={() => setQ(n)}>
                {n} {c}
              </span>
            ))}
        </div>
        <table>
          <thead>
            <tr>
              <th>轮</th>
              <th>工具</th>
              <th>参数</th>
              <th>状态</th>
              <th>耗时</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => useStore.setState({ inspect: { sessionId: active.sessionId, toolUseId: r.id } })}>
                <td>{r.turn}</td>
                <td style={{ paddingLeft: 8 + r.depth * 16 }}>
                  {r.depth > 0 && <span className="sub-mark">⤷ </span>}
                  {r.name}
                </td>
                <td>
                  <span className="mono" title={r.summary}>{r.summary}</span>
                  {r.error && <div style={{ color: 'var(--red)', fontSize: 11.5 }}>{r.error}</div>}
                </td>
                <td>
                  <span className={`badge ${r.status === 'done' ? 'ok' : r.status === 'error' ? 'err' : 'run'}`}>{r.status}</span>
                </td>
                <td>{r.ms !== undefined && r.ms >= 0 ? `${(r.ms / 1000).toFixed(1)}s` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="empty">还没有工具调用</div>}
      </div>
    </div>
  );
}
