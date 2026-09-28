// One turn of a conversation as the chat shows it after redesign phase 5 (spec §5.3): the user's message, the work
// folded into one line — 「已处理 1 分 42 秒 · 读了 4 个文件 · 改了 2 个 · 运行 2 条命令」 — the answer, and a card of
// the files it changed. Pure (no React, no tool registry) so it can be replayed against captured streams.
import type { AssistantItem, Item, ResultItem, UserItem } from './conversation';
import { fileChanges, pathKey } from './diffstat';

/** A user message and everything up to the next one (meta messages — reminders, command output — stay inside). */
export interface Turn {
  /** the user message's id; for a page that starts mid-turn, the first item's */
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
    if (!cur) { cur = { id: `pre-${it.id}`, body: [] }; out.push(cur); }
    cur.body.push(it);
    if (it.kind === 'result') cur.result = it;
  }
  return out;
}

export interface TurnSummary {
  durationMs?: number;
  /** distinct files read (Read / NotebookRead), top level */
  reads: number;
  /** distinct files changed — the change card's rows (successful edits, subagents included) */
  edits: number;
  /** shell commands run, top level */
  commands: number;
  /** Glob / Grep, top level */
  searches: number;
  /** every other top-level tool call (web, plan, subagents, MCP, …) */
  others: number;
  /** all top-level tool calls */
  tools: number;
}

const READ = new Set(['Read', 'NotebookRead']);
const EDIT = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SHELL = new Set(['Bash', 'PowerShell', 'BashOutput']);
const SEARCH = new Set(['Glob', 'Grep', 'LS']);

const tsOf = (it: Item): number => {
  const ts = it.kind === 'assistant' || it.kind === 'user' || it.kind === 'system' ? it.ts : undefined;
  const t = ts ? Date.parse(ts) : NaN;
  return Number.isNaN(t) ? NaN : t;
};

/** How long the turn took: the result's own number, else the user message's time to the last thing that happened. */
export function turnDuration(t: Turn): number | undefined {
  if (t.result && typeof t.result.durationMs === 'number' && t.result.durationMs > 0) return t.result.durationMs;
  const start = t.user ? tsOf(t.user) : NaN;
  if (Number.isNaN(start)) return undefined;
  let end = NaN;
  for (const it of t.body) {
    let e = tsOf(it);
    if (it.kind === 'assistant') for (const b of it.blocks) if (b.type === 'tool_use' && b.result?.ts) { const r = Date.parse(b.result.ts); if (!Number.isNaN(r) && (Number.isNaN(e) || r > e)) e = r; }
    if (!Number.isNaN(e) && (Number.isNaN(end) || e > end)) end = e;
  }
  return Number.isNaN(end) || end < start ? undefined : end - start;
}

export function turnSummary(t: Turn): TurnSummary {
  const reads = new Set<string>();
  let commands = 0, searches = 0, others = 0, tools = 0;
  for (const it of t.body) {
    if (it.kind !== 'assistant') continue;
    for (const b of it.blocks) {
      if (b.type !== 'tool_use') continue;
      tools++;
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
  return { ...(durationMs !== undefined ? { durationMs } : {}), reads: reads.size, edits: fileChanges(t.body).length, commands, searches, others, tools };
}

/** `1 秒` · `42 秒` · `1 分 42 秒` · `2 分钟` · `1 小时 5 分` */
export function fmtDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** The folded turn's one line: 「已处理 1 分 42 秒 · 读了 4 个文件 · 改了 2 个 · 运行 2 条命令」. */
export function turnSummaryText(s: TurnSummary): string {
  const parts = [s.durationMs !== undefined ? `已处理 ${fmtDuration(s.durationMs)}` : '已处理'];
  if (s.reads) parts.push(`读了 ${s.reads} 个文件`);
  if (s.edits) parts.push(`改了 ${s.edits} 个${s.reads ? '' : '文件'}`);
  if (s.searches) parts.push(`搜索 ${s.searches} 次`);
  if (s.commands) parts.push(`运行 ${s.commands} 条命令`);
  if (s.others) parts.push(`其它 ${s.others} 步`);
  return parts.join(' · ');
}

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

/** A changed file's row: its folder (relative to the project, forward slashes) in grey, then its name. */
export function displayPath(path: string, cwd: string): { dir: string; name: string } {
  const p = path.replace(/\\/g, '/');
  const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const rel = root && p.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? p.slice(root.length + 1) : p;
  const at = rel.lastIndexOf('/');
  return at < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, at + 1), name: rel.slice(at + 1) };
}
