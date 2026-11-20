import { useMemo } from 'react';
import { agentColor, pillText } from './model';
import { openBackground, useBgSession } from './state';
import { tr } from '@/i18n';

/**
 * Over the composer while the conversation has something running besides its turn — a workflow, a sub-agent, a
 * background command — and still there after the turn ended (that is when it matters: the turn says nothing more).
 * A dot per agent at work, in its colour; a click opens 后台 on this conversation.
 */
export function BackgroundPill({ sessionId }: { sessionId: string }) {
  const s = useBgSession(sessionId);
  const text = pillText(s);
  const dots = useMemo(() => {
    const out: number[] = [];
    for (const t of s?.tasks ?? []) if (t.status === 'running') for (const a of t.agents) if (a.state === 'running') out.push(a.color);
    return out;
  }, [s]);
  if (!text) return null;
  return (
    <div className="bg-pill-row">
      <button className="bg-pill" data-id="bg-pill" title={tr('在 自动化 › 运行中 里看它们在做什么')} onClick={() => openBackground(sessionId)}>
        <span className="bg-pill-dots" aria-hidden>
          {dots.slice(0, 6).map((c, i) => <i key={i} style={{ background: agentColor(c) }} />)}
          {!dots.length && <i className="idle" />}
        </span>
        {text}
      </button>
    </div>
  );
}
