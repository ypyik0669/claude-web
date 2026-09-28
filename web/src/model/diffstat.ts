// How much a conversation changed on disk, from its own file-editing tool calls: the session header's
// 「改动 +N −M」 button. Pure; reads the SDK's structured output (`structuredPatch`) when there is one and
// falls back to the tool input (other agents' normalised Edit / Write carry only that).
import { walkTools, type Item, type ToolUseBlock } from './conversation';

export interface DiffStat { files: number; added: number; removed: number }

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

interface Hunk { lines?: unknown }

function countHunks(hunks: Hunk[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const h of hunks) {
    if (!Array.isArray(h?.lines)) continue;
    for (const l of h.lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}

const lines = (s: unknown): string[] => (typeof s === 'string' && s.length ? s.replace(/\n$/, '').split('\n') : []);

/** Lines changed between two snippets, ignoring the shared head and tail (good enough for an edit's old / new string). */
function snippetDelta(oldS: unknown, newS: unknown): { added: number; removed: number } {
  const a = lines(oldS), b = lines(newS);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

function toolDelta(t: ToolUseBlock): { path: string; added: number; removed: number } | null {
  const inp = t.input as Record<string, unknown>;
  const path = String(inp.file_path ?? inp.notebook_path ?? inp.path ?? '');
  if (!path) return null;
  const st = t.result?.structured as { structuredPatch?: Hunk[]; type?: string; content?: string } | undefined;
  if (Array.isArray(st?.structuredPatch) && st!.structuredPatch.length) return { path, ...countHunks(st!.structuredPatch) };
  if (t.name === 'Write') {
    // a create has an empty patch and the whole content as added lines; an overwrite without a patch is unknown → count the content
    return { path, added: lines(st?.content ?? inp.content).length, removed: 0 };
  }
  if (t.name === 'MultiEdit' && Array.isArray(inp.edits)) {
    let added = 0, removed = 0;
    for (const e of inp.edits as Record<string, unknown>[]) { const d = snippetDelta(e.old_string, e.new_string); added += d.added; removed += d.removed; }
    return { path, added, removed };
  }
  if (t.name === 'NotebookEdit') return { path, ...snippetDelta((st as any)?.old_source, inp.new_source) };
  return { path, ...snippetDelta(inp.old_string, inp.new_string) };
}

/** One file a conversation (or one turn of it) changed: its path as the last edit named it, and its lines. */
export interface FileChange { path: string; added: number; removed: number }

/** The same path however it was spelled (`C:\w\a.ts` / `c:/w/a.ts`). */
export const pathKey = (p: string) => p.replace(/\\/g, '/').toLowerCase();

/**
 * Per file, the successful edits in `items` (subagents included), in the order the files were first touched —
 * the rows of a turn's 「改动了 N 个文件」 card (redesign phase 5). Same counting as the header's total.
 */
export function fileChanges(items: Item[]): FileChange[] {
  const byKey = new Map<string, FileChange>();
  for (const { tool } of walkTools(items)) {
    if (!EDIT_TOOLS.has(tool.name) || tool.status !== 'done' || tool.result?.isError) continue;
    const d = toolDelta(tool);
    if (!d) continue;
    const k = pathKey(d.path);
    const row = byKey.get(k);
    if (row) { row.path = d.path; row.added += d.added; row.removed += d.removed; }
    else byKey.set(k, { path: d.path, added: d.added, removed: d.removed });
  }
  return [...byKey.values()];
}

/** Files touched and lines added / removed by the conversation's successful edits (subagents included). */
export function sessionDiffStat(items: Item[]): DiffStat {
  let added = 0, removed = 0;
  const rows = fileChanges(items);
  for (const r of rows) { added += r.added; removed += r.removed; }
  return { files: rows.length, added, removed };
}
