import { useEffect, useState } from 'react';
import { useStore } from '@/store';
import { getToolDef } from './tools/registry';
import { basename, clsx } from '@/util';
import { Icon } from '@/ui/icons';

function dur(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Pinned above the composer for the whole time a turn is in flight: what is happening right now,
 * how long it has been going, and one button to stop it.
 *
 * The transcript scrolls; this does not. Without it you have to scroll back to find out whether the
 * run is alive, which is the single most common thing a person wants to know mid-turn (same reason
 * Cursor and Manus pin theirs). The exceptional states — stalls, rate limits, errors — stay in
 * `StatusStrip`; this card is only the ordinary "it is working" case.
 */
export function RunCard({ sessionId }: { sessionId: string }) {
  const o = useStore((s) => s.open[sessionId]);
  const interrupt = useStore((s) => s.interrupt);
  const [, tick] = useState(0);
  const running = !!o && (o.state === 'running' || o.state === 'waiting');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!o || !running) return null;

  const c = o.conv;
  const rt = c.runningTool ? c.toolIndex.get(c.runningTool.id) : undefined;
  const def = rt ? getToolDef(rt.name) : null;
  const label = rt && def ? def.label(rt.input as any) : null;
  const target = label?.arg ? (def!.category === 'read' || def!.category === 'edit' ? basename(label.arg) : label.arg) : '';

  // how much of this turn is behind us, counted the way the timeline counts it
  let done = 0, total = 0;
  for (const it of c.items) {
    if (it.kind === 'user' && !it.meta) { done = 0; total = 0; continue; }
    if (it.kind !== 'assistant') continue;
    for (const b of it.blocks) if (b.type === 'tool_use') { total++; if (b.status === 'done' || b.status === 'error') done++; }
  }
  const tasks = [...c.tasks.values()].filter((t) => t.status === 'running').length;
  const since = c.turnStartedAt ?? c.runningTool?.since ?? c.lastEventAt;

  return (
    <div className={clsx('run-card', o.state === 'waiting' && 'waiting')}>
      <span className="pip" />
      <span className="what">
        {c.compacting ? '压缩上下文'
          : o.state === 'waiting' ? '等待你的确认'
            : rt ? <>{label?.verb || rt.name}{target && <span className="tgt">{target}</span>}</>
              : '思考中'}
      </span>
      {total > 0 && <span className="meta">{done}/{total} 步</span>}
      {tasks > 0 && <span className="meta">{tasks} 个子代理</span>}
      <span className="grow" />
      {since && <span className="clock">{dur(Date.now() - since)}</span>}
      <button className="btn xs ghost" title="中断这一轮 (Esc)" onClick={() => interrupt(sessionId)}><Icon name="stop" size={11} /> 停止</button>
    </div>
  );
}
