// What the status tab on the composer's top edge (RunCard) says while a turn is in flight, and when it is on screen.
// Pure: the tab itself is RunCard.tsx, the tool vocabulary comes in as a function (tools/registry draws components).
import type { Conversation } from '@/model/conversation';
import { basename } from '@/util';

/** A tool call in a few words: its verb, its argument, and what kind of tool it is (the registry's category). */
export type StepLabeler = (name: string, input: Record<string, unknown>) => { verb?: string; arg?: string; category?: string } | null;

export interface RunStatus {
  kind: 'compacting' | 'waiting' | 'tool' | 'thinking';
  /** what it is doing: 压缩上下文 / 等待你的确认 / the running step's verb (its name without one) / 思考中 */
  text: string;
  /** the running step's object: a file's name for a read or an edit, the argument as it is otherwise */
  target: string;
  /** this turn's steps so far, counted the way the timeline counts them (finished or failed = done) */
  done: number;
  total: number;
  /** sub-agents still running */
  tasks: number;
  /** client clock the elapsed time counts from */
  since?: number;
  /** the words on the tab; other words = another key (the new ones come in with the swap animation) */
  key: string;
}

export function runStatus(c: Conversation, state: string, label: StepLabeler): RunStatus {
  const rt = c.runningTool ? c.toolIndex.get(c.runningTool.id) : undefined;
  const l = rt ? label(rt.name, rt.input) : null;

  let kind: RunStatus['kind'], text: string, target = '';
  if (c.compacting) { kind = 'compacting'; text = '压缩上下文'; }
  else if (state === 'waiting') { kind = 'waiting'; text = '等待你的确认'; }
  else if (rt) {
    kind = 'tool';
    text = l?.verb || rt.name;
    target = l?.arg ? (l.category === 'read' || l.category === 'edit' ? basename(l.arg) : l.arg) : '';
  } else { kind = 'thinking'; text = '思考中'; }

  // how much of this turn is behind us
  let done = 0, total = 0;
  for (const it of c.items) {
    if (it.kind === 'user' && !it.meta) { done = 0; total = 0; continue; }
    if (it.kind !== 'assistant') continue;
    for (const b of it.blocks) if (b.type === 'tool_use') { total++; if (b.status === 'done' || b.status === 'error') done++; }
  }
  let tasks = 0;
  for (const t of c.tasks.values()) if (t.status === 'running') tasks++;

  return { kind, text, target, done, total, tasks, since: c.turnStartedAt ?? c.runningTool?.since ?? c.lastEventAt, key: JSON.stringify([kind, text, target]) };
}

/** 「0:12」, 「1:05」, 「62:05」 — how long the turn has been going: a clock (the steps and the summary spell their
 *  durations out — 「12 秒」; this one ticks every second in a fixed width). */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How long the tab's coming and leaving take (styles/composer.css plays them; the tab is unmounted after the second). */
export const RUN_TAB_IN_MS = 300;
export const RUN_TAB_OUT_MS = 160;

export type LingerPhase = 'enter' | 'in' | 'out' | 'gone';
/**
 * Where something that slides in and out is: `on` = it should be there, `shown` = it is still in the page (there, or
 * leaving), `entering` = it came while the page was up (not: it was already there when the page was drawn — that one
 * just is there, without a slide).
 */
export function lingerPhase(s: { on: boolean; shown: boolean; entering: boolean }): LingerPhase {
  if (s.on) return s.entering ? 'enter' : 'in';
  return s.shown ? 'out' : 'gone';
}

/**
 * Counts the changes of the tab's words: 0 = the words it was first drawn with (no animation: the tab itself comes
 * in, or was simply there), n ≥ 1 = the n-th change (animated). Returns `prev` itself when the words are the same.
 */
export function swapCount(prev: { key: string; n: number } | undefined, key: string): { key: string; n: number } {
  if (!prev) return { key, n: 0 };
  return prev.key === key ? prev : { key, n: prev.n + 1 };
}
