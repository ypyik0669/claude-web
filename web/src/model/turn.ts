// One turn of a conversation as the chat shows it after redesign phase 5 (spec §5.3): the user's message, the work
// folded into one line — 「已处理 1 分 42 秒 · 读了 4 个文件 · 改了 2 个 · 运行 2 条命令」 — the answer, and a card of
// the files it changed. Pure (no React, no tool registry) so it can be replayed against captured streams.
import type { AssistantItem, Item, ResultItem, UserItem } from './conversation';
import { fileChanges, pathKey, type FileChange } from './diffstat';

/**
 * A user message and everything up to the next one (meta messages — reminders, command output — stay inside), or a
 * headless round: the SDK and the agents never echo a user message, so only what THIS window sent is in the list. A
 * round started elsewhere — a goal's 「继续」, IM, a schedule, the orchestra, another window — arrives as a second run
 * of assistant messages after the first one's `result`; that is a turn of its own (`cont-<id>`), with its own summary,
 * time and change card (review I1).
 */
export interface Turn {
  /** the user message's id; a page that starts mid-turn: `pre-<first item>`; a round after a result: `cont-<first item>` */
  id: string;
  user?: UserItem;
  body: Item[];
  /** the turn's `result` (absent while it runs, and in transcripts: Claude Code does not write result lines) */
  result?: ResultItem;
}

export function groupTurns(items: Item[]): Turn[] {
  const out: Turn[] = [];
  let cur: Turn | null = null;
  for (const it of items) {
    if (it.kind === 'user' && !it.meta) {
      cur = { id: it.id, user: it, body: [] };
      out.push(cur);
      continue;
    }
    if (!cur || cur.result) { cur = { id: `${cur ? 'cont' : 'pre'}-${it.id}`, body: [] }; out.push(cur); }
    cur.body.push(it);
    if (it.kind === 'result') cur.result = it;
  }
  return out;
}

const unfinished = (t: Turn): boolean => t.body.some((it) => it.kind === 'assistant' && (it.streaming || it.blocks.some((b) => b.type === 'tool_use' && (b.status === 'pending' || b.status === 'running' || b.status === 'streaming'))));

/**
 * Whether a turn is over (and may fold). While the conversation runs, the last turn never is — even with a result:
 * the next round can follow it at once — and an earlier one is not while a step of it still runs or its text still
 * streams (a steer message starts a new turn in the middle of it). With nothing running, every turn is.
 */
export function turnDone(t: Turn, o: { last: boolean; live: boolean }): boolean {
  if (!o.live) return true;
  return !o.last && !unfinished(t);
}

export interface TurnSummary {
  durationMs?: number;
  /** distinct files read (Read / NotebookRead) that worked, top level */
  reads: number;
  /** distinct files changed — the change card's rows (successful edits, subagents included) */
  edits: number;
  /** shell commands that ran (Bash / PowerShell), top level */
  commands: number;
  /** Glob / Grep, top level */
  searches: number;
  /** every other top-level tool call that worked (web, plan, subagents, MCP, a background shell's output, …) */
  others: number;
  /** top-level calls that failed or were refused — not counted as read / run / changed */
  failed: number;
  /** all top-level tool calls */
  tools: number;
}

const READ = new Set(['Read', 'NotebookRead']);
const EDIT = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SHELL = new Set(['Bash', 'PowerShell']);
const SEARCH = new Set(['Glob', 'Grep', 'LS']);

const tsOf = (it: Item): number => {
  const ts = it.kind === 'assistant' || it.kind === 'user' || it.kind === 'system' ? it.ts : undefined;
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(t) ? NaN : t;
};

/** How long the turn took: the result's own number, else the user message's time to the last thing that happened. */
export function turnDuration(t: Turn): number | undefined {
  if (t.result && typeof t.result.durationMs === 'number' && t.result.durationMs > 0) return t.result.durationMs;
  // a headless round starts with its first message
  const first = t.user ?? t.body[0];
  const start = first ? tsOf(first) : NaN;
  if (Number.isNaN(start)) return undefined;
  let end = NaN;
  for (const it of t.body) {
    let e = tsOf(it);
    if (it.kind === 'assistant') for (const b of it.blocks) if (b.type === 'tool_use' && b.result?.ts) { const r = Date.parse(b.result.ts); if (!Number.isNaN(r) && (Number.isNaN(e) || r > e)) e = r; }
    if (!Number.isNaN(e) && (Number.isNaN(end) || e > end)) end = e;
  }
  return Number.isNaN(end) || end < start ? undefined : end - start;
}

/**
 * The folded turn's numbers. Only this turn's own top-level calls that worked are 「读了 / 运行 / 搜索 / 其它」; a call
 * that failed or was refused is 「失败 N 个」 instead (review M1). 「改了 N 个」 is the change card's rows: successful
 * edits, a subagent's included (they are this turn's changes, and the card and the header count them) — a subagent's
 * own reads and commands are not counted.
 */
export function turnSummary(t: Turn): TurnSummary {
  const reads = new Set<string>();
  let commands = 0, searches = 0, others = 0, failed = 0, tools = 0;
  for (const it of t.body) {
    if (it.kind !== 'assistant') continue;
    for (const b of it.blocks) {
      if (b.type !== 'tool_use') continue;
      tools++;
      if (b.status === 'error' || b.result?.isError) { failed++; continue; }
      if (READ.has(b.name)) {
        const p = String(b.input.file_path ?? b.input.notebook_path ?? b.input.path ?? '');
        if (p) reads.add(pathKey(p));
      } else if (EDIT.has(b.name)) { /* counted as changed files below */ }
      else if (SHELL.has(b.name)) commands++;
      else if (SEARCH.has(b.name)) searches++;
      else others++;
    }
  }
  const durationMs = turnDuration(t);
  return { ...(durationMs !== undefined ? { durationMs } : {}), reads: reads.size, edits: fileChanges(t.body).length, commands, searches, others, failed, tools };
}

/** `1 秒` · `42 秒` · `1 分 42 秒` · `2 分钟` · `1 小时 5 分` */
export function fmtDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/**
 * The folded turn's one line, in parts: 「已处理 1 分 42 秒 · 失败 1 个 · 读了 4 个文件 · 改了 2 个 · 运行 2 条命令」 (`err`:
 * shown in red). A failure comes first after the time, where it is seen (review M-7), not at the end of a long line.
 */
export function turnSummaryParts(s: TurnSummary): { text: string; err?: boolean }[] {
  const parts: { text: string; err?: boolean }[] = [{ text: s.durationMs !== undefined ? `已处理 ${fmtDuration(s.durationMs)}` : '已处理' }];
  if (s.failed) parts.push({ text: `失败 ${s.failed} 个`, err: true });
  if (s.reads) parts.push({ text: `读了 ${s.reads} 个文件` });
  if (s.edits) parts.push({ text: `改了 ${s.edits} 个${s.reads ? '' : '文件'}` });
  if (s.searches) parts.push({ text: `搜索 ${s.searches} 次` });
  if (s.commands) parts.push({ text: `运行 ${s.commands} 条命令` });
  if (s.others) parts.push({ text: `其它 ${s.others} 步` });
  return parts;
}

export const turnSummaryText = (s: TurnSummary): string => turnSummaryParts(s).map((p) => p.text).join(' · ');

/**
 * What a turn shows, worked out once and kept while nothing it depends on changed: the same items (by identity — a
 * reloaded conversation has the same content in new objects, and `loadSubagent` writes into the new ones: review I2),
 * the same `done`, the same subagent contents (`loadSubagent` fills a finished turn's Agent step in place — its
 * edits count toward 「改了 N 个」 and the change card: review M-1), and `stamp` (see `turnStamp`).
 */
export interface TurnMemo { first?: Item; lastItem?: Item; len: number; done: boolean; sub: number; stamp: number; parts: TurnParts; summary: TurnSummary | null; changes: FileChange[] }
export function turnMemo(prev: TurnMemo | undefined, t: Turn, done: boolean, stamp: number): TurnMemo {
  const first = t.body[0], lastItem = t.body[t.body.length - 1];
  const sub = subagentSig(t);
  if (prev && prev.first === first && prev.lastItem === lastItem && prev.len === t.body.length && prev.done === done && prev.sub === sub && prev.stamp === stamp) return prev;
  const parts = splitTurnBody(t.body);
  const fold = done && parts.work;
  return { first, lastItem, len: t.body.length, done, sub, stamp, parts, summary: fold ? turnSummary(t) : null, changes: fold ? fileChanges(t.body) : [] };
}

/** How much the turn's subagents hold (their messages, loaded on demand into the top-level Agent steps). */
export function subagentSig(t: Turn): number {
  let n = 0;
  for (const it of t.body) if (it.kind === 'assistant') for (const b of it.blocks) if (b.type === 'tool_use' && b.children.length) n += b.children.length;
  return n;
}

/**
 * `turnMemo`'s stamp: the conversation's version for a turn that can still change on any event (the last one, one
 * that is not done), 0 for a finished earlier one — which then is not worked out again on every streamed event of a
 * long conversation (review M-2: 200 finished turns cost ~10 ms per event when every turn was redone). What can still
 * change a finished turn is covered by `turnMemo`'s other keys (a reload: identity; a loaded subagent: `subagentSig`).
 */
export const turnStamp = (o: { last: boolean; done: boolean; version: number }): number => (o.last || !o.done ? o.version : 0);

/**
 * What a finished turn shows where. `work`: the turn called tools — then `process` (every step, the thinking, the
 * text in between, retries, the stats line) goes into the fold, `final` (text after the last tool call, and any
 * message that errored) is the answer below it, and `tail` (errors: an error result, an error-level notice) stays
 * visible after it. Without tool calls there is nothing to fold: everything is `tail`, in order.
 * Assistant messages split between the two come back as copies holding only their part of the blocks.
 */
export interface TurnParts { work: boolean; process: Item[]; final: AssistantItem[]; tail: Item[] }

const alwaysShown = (it: Item) => (it.kind === 'result' && it.isError) || (it.kind === 'system' && (it.level === 'error' || it.subtype === 'rate_limit'));

export function splitTurnBody(body: Item[]): TurnParts {
  let lastItem = -1, lastBlock = -1;
  body.forEach((it, i) => {
    if (it.kind !== 'assistant') return;
    it.blocks.forEach((b, j) => { if (b.type === 'tool_use') { lastItem = i; lastBlock = j; } });
  });
  if (lastItem < 0) return { work: false, process: [], final: [], tail: [...body] };
  const process: Item[] = [], final: AssistantItem[] = [], tail: Item[] = [];
  body.forEach((it, i) => {
    if (alwaysShown(it)) { tail.push(it); return; }
    if (it.kind !== 'assistant') { process.push(it); return; }
    if (it.error && i >= lastItem) { final.push(it); return; }
    if (i < lastItem) { process.push(it); return; }
    const from = i === lastItem ? lastBlock + 1 : 0;
    const before = it.blocks.slice(0, from);
    const after = it.blocks.slice(from);
    const work = [...before, ...after.filter((b) => b.type !== 'text')];
    const answer = after.filter((b) => b.type === 'text');
    if (work.length) process.push(work.length === it.blocks.length ? it : { ...it, blocks: work });
    if (answer.length) final.push(answer.length === it.blocks.length ? it : { ...it, blocks: answer });
  });
  return { work: true, process, final, tail };
}

/** A row of the step list: one step, or a run of steps merged into 「读取 ×3 · a.ts 等」 that opens to each of them. */
export interface StepGroup<T> {
  /** the first step's id — the same row while the run grows at its end */
  key: string;
  steps: T[];
}

/** What `groupSteps` reads of a step (a `ToolUseBlock` has all of it). */
export interface StepLike {
  id: string;
  name: string;
  status: 'streaming' | 'pending' | 'running' | 'done' | 'error';
  result?: { isError: boolean };
  children: readonly unknown[];
}

/**
 * The rows of a run of steps (UI refresh §6): steps next to each other, of the same tool, that all finished and worked
 * are one row. A step that still runs (streaming / queued / running), failed or was refused, waits on the user
 * (`waiting`: the ids a permission card is asking about), or carries messages of its own (a subagent's) is never
 * merged: it is a row by itself, and so splits the run around it. Same tool = same name (Edit and MultiEdit are two).
 * The steps come back as the objects that went in, in order. What the turn summary counts is not touched by this.
 */
export function groupSteps<T extends StepLike>(steps: readonly T[], waiting?: ReadonlySet<string>): StepGroup<T>[] {
  const merges = (s: T) => s.status === 'done' && !s.result?.isError && s.children.length === 0 && !waiting?.has(s.id);
  const out: StepGroup<T>[] = [];
  let open: StepGroup<T> | null = null; // the row the next step may still join
  for (const s of steps) {
    if (!merges(s)) { out.push({ key: s.id, steps: [s] }); open = null; continue; }
    if (open && open.steps[0].name === s.name) { open.steps.push(s); continue; }
    open = { key: s.id, steps: [s] };
    out.push(open);
  }
  return out;
}

/**
 * When a tool call of these items was made, where a transcript says so exactly: a message's time is the time its
 * FIRST block was written, so only a call that is the first block of its message has one (a call after some text or
 * thinking, or a second call of the same message, was written later by an amount nothing records — a time counted
 * from the message would include the model still writing). With the result's own time that is how long the step
 * took, from the call to its result; see `stepDurationMs` in features/chat/step-view.ts.
 */
export function stepStarts(items: readonly Item[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (it.kind !== 'assistant' || !it.ts) continue;
    const first = it.blocks[0];
    if (first?.type !== 'tool_use') continue;
    const at = Date.parse(it.ts);
    if (!Number.isNaN(at)) out.set(first.id, at);
  }
  return out;
}

/** A changed file's row: its folder (relative to the project, forward slashes) in grey, then its name. */
export function displayPath(path: string, cwd: string): { dir: string; name: string } {
  const p = path.replace(/\\/g, '/');
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const rel = root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? p.slice(root.length + 1) : p;
  const at = rel.lastIndexOf('/');
  return at < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, at + 1), name: rel.slice(at + 1) };
}
