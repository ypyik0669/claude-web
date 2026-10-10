// What a step row says (UI refresh §6): its state, its verb, how long it took, and the label of a merged row.
// Pure — the rows are ToolCard.tsx (`ToolHead`) and ChatView.tsx (`Steps`); which steps merge is `groupSteps` in
// model/turn.ts.
import type { ToolUseBlock } from '@/model/conversation';
import { fmtDuration } from '@/model/turn';

/** done · active (running, or its input still streaming) · pending (called, not started) · failed · waiting on the user */
export type StepState = 'done' | 'active' | 'pending' | 'failed' | 'waiting';

export function stepState(t: Pick<ToolUseBlock, 'id' | 'status'>, waiting?: ReadonlySet<string>): StepState {
  if (t.status === 'error') return 'failed';
  if (t.status !== 'done' && waiting?.has(t.id)) return 'waiting';
  if (t.status === 'running' || t.status === 'streaming') return 'active';
  if (t.status === 'pending') return 'pending';
  return 'done';
}

/** Not finished one way or the other. */
export const stepBusy = (st: StepState): boolean => st === 'active' || st === 'pending' || st === 'waiting';

// the registry's verbs name their object (「读取文件:」); in a row the object is the chip next to the verb
const SHORT_VERB: Record<string, string> = { '读取文件': '读取', '写入文件': '写入', '编辑文件': '编辑', '运行命令': '运行', '列出文件': '列出', '搜索文本': '搜索' };

/** The verb as a row shows it: 「读取文件:」 → 「读取」, 「搜索网页:」 → 「搜索网页」, 「Fetch」 → 「Fetch」. */
export function shortVerb(verb: string): string {
  const v = verb.replace(/\s*[:：]\s*$/, '').trim();
  return SHORT_VERB[v] ?? v;
}

/** `0.4 秒` · `9.9 秒` · `12 秒` · `1 分 42 秒` — one decimal under ten seconds, then like the turn summary. */
export function fmtStepDuration(ms: number): string {
  const tenths = Math.round(ms / 100);
  if (tenths < 100) return `${(Math.max(1, tenths) / 10).toFixed(1)} 秒`;
  return fmtDuration(ms);
}

/** A merged row, read out: 「读取 ×3 · a.ts 等」 (the row shows the same three parts: verb ×N, then the first target). */
export function mergedLabel(verb: string, count: number, target: string): string {
  const head = `${verb} ×${count}`.trim();
  return target ? `${head} · ${target} 等` : head;
}

/** The chip of a merged row: the first step's target, 「等」 after it. */
export const mergedTarget = (target: string): string => (target ? `${target} 等` : '');

interface Clock { from: number; st: StepState; whole: boolean; ms?: number }
// by the step object: a reloaded conversation has new objects, and nothing measured for them
const clocks = new WeakMap<object, Clock>();

/**
 * A step's own clock, for the ones this page watched run: call it whenever the row renders, with the step's state
 * now. `arrived`: the row is being drawn because the step just arrived (only read the first time) — a step first
 * seen already under way (a running conversation that was loaded) was not watched from its start, and gets no time.
 * Returns how long the step took once it is over: from when the call appeared (`startedAt`) to the first time it
 * was seen finished, not counting the time it waited on the user (the clock starts again when the wait ends).
 * Undefined for a step first seen finished (history), or not watched whole.
 */
export function watchStep(t: { startedAt?: number }, st: StepState, now: number, arrived = true): number | undefined {
  const busy = stepBusy(st);
  const c = clocks.get(t);
  if (!c) {
    if (busy) clocks.set(t, { from: Math.min(t.startedAt ?? now, now), st, whole: arrived });
    return undefined;
  }
  if (!busy && c.ms === undefined && stepBusy(c.st)) {
    // last seen waiting, now over: answered and run between two looks — how long the run took was not seen
    if (c.st === 'waiting') c.whole = false;
    c.ms = Math.max(0, now - c.from);
  } else if (busy && c.st === 'waiting' && st !== 'waiting') c.from = now;
  c.st = st;
  return c.whole ? c.ms : undefined;
}

/** Whether this page saw the step unfinished (so its finishing, or its merging into a row, happened in view). */
export const watchedStep = (t: object): boolean => clocks.has(t);

const DAY = 24 * 3_600_000;

/**
 * How long a finished step took, when something says so. First what this page measured (`watched`, see `watchStep`)
 * or the agent's own last progress report, whichever is longer: one clock, and no time spent waiting on the user.
 * Else a transcript's times — `start`, when the call was written (`stepStarts`: only known exactly for some calls),
 * to the result's own time; that is from the call to its result, a wait for the user's answer included. Undefined
 * when nothing says: the row then ends without a time, rather than with a guess.
 */
export function stepDurationMs(t: Pick<ToolUseBlock, 'result' | 'progress'>, o: { start?: number; watched?: number }): number | undefined {
  const reported = t.progress ? Math.round(t.progress.elapsed * 1000) : 0;
  if (o.watched !== undefined || reported > 0) return Math.max(reported, o.watched ?? 0);
  const end = t.result?.ts ? Date.parse(t.result.ts) : NaN;
  if (o.start !== undefined && !Number.isNaN(end) && end >= o.start && end - o.start < DAY) return end - o.start;
  return undefined;
}
