import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store';
import { getToolDef } from './tools/registry';
import { clsx } from '@/util';
import { RUN_TAB_IN_MS, RUN_TAB_OUT_MS, elapsedText, lingerPhase, runStatus, swapCount, type LingerPhase, type RunStatus, type StepLabeler } from './run-status';

const stepLabel: StepLabeler = (name, input) => {
  const def = getToolDef(name);
  return { ...def.label(input), category: def.category };
};

/**
 * Keeps the tab in the page for as long as its leaving takes, and says whether it came while the page was up (then it
 * slides in) or was simply there when the conversation was drawn (then it does not) — see `lingerPhase`.
 */
function useLinger(on: boolean): LingerPhase {
  const [shown, setShown] = useState(on);
  const [entering, setEntering] = useState(false);
  // derived while rendering, not in an effect: the render in which `on` turns true already draws it entering
  if (on && !shown) { setShown(true); setEntering(true); }
  useEffect(() => {
    if (!entering) return;
    // a little longer than the slide, so the class never goes before the animation's last frame
    const t = setTimeout(() => setEntering(false), RUN_TAB_IN_MS + 60);
    return () => clearTimeout(t);
  }, [entering]);
  useEffect(() => {
    if (on || !shown) return;
    const t = setTimeout(() => setShown(false), RUN_TAB_OUT_MS);
    return () => clearTimeout(t);
  }, [on, shown]);
  return lingerPhase({ on, shown, entering });
}

/**
 * The status tab on the composer's top edge for the whole time a turn is in flight: what is happening right now,
 * how long it has been going, how far along it is, and one button to stop it (UI refresh §6 「状态页签」).
 *
 * The transcript scrolls; this does not. Without it you have to scroll back to find out whether the
 * run is alive, which is the single most common thing a person wants to know mid-turn (same reason
 * Cursor and Manus pin theirs). The exceptional states — stalls, rate limits, errors — stay in
 * `StatusStrip`; this is only the ordinary "it is working" case.
 *
 * It slides up from behind the composer when a turn starts and drops back when it ends (styles/composer.css:
 * `.run-card.enter` / `.run-card.out`); new words come in with a short blur and rise (`.what.swap`, re-triggered by
 * keying the node on the words).
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
  const phase = useLinger(running);
  // while it leaves, the tab keeps the turn's last words and time: the conversation itself has moved on (no step, no
  // turn start), and words changing on the way out would play the swap animation on a tab that is going
  const last = useRef<{ st: RunStatus; clock: string; waiting: boolean } | null>(null);
  const words = useRef<{ key: string; n: number } | undefined>(undefined);
  if (o && running) {
    const st = runStatus(o.conv, o.state, stepLabel);
    last.current = { st, clock: st.since ? elapsedText(Date.now() - st.since) : '', waiting: o.state === 'waiting' };
    words.current = swapCount(words.current, st.key);
  }
  const v = last.current;
  if (phase === 'gone' || !v) return null;
  const { st } = v;
  const leaving = phase === 'out';
  // the first words come with the tab (animated only when the tab itself slides in); every later change is animated
  const swap = phase === 'enter' || (words.current?.n ?? 0) > 0;

  return (
    <div className={clsx('run-card', v.waiting && 'waiting', phase === 'enter' && 'enter', leaving && 'out')} data-kind={st.kind} aria-hidden={leaving || undefined}>
      <span className="pip" aria-hidden />
      <span key={st.key} className={clsx('what', swap && 'swap')}>
        <span className="rc-words">{st.text}{st.target && <span className="tgt">{st.target}</span>}</span>
      </span>
      {st.total > 0 && <span className="meta">{st.done}/{st.total} 步</span>}
      {st.tasks > 0 && <span className="meta">{st.tasks} 个子代理</span>}
      <span className="grow" />
      {v.clock && <span className="clock">{v.clock}</span>}
      <button type="button" className="rc-stop" title="中断这一轮 (Esc)" tabIndex={leaving ? -1 : undefined} onClick={() => { if (!leaving) void interrupt(sessionId); }}>停止</button>
    </div>
  );
}
