// How much a conversation changed on disk, from its own file-editing tool calls: the session header's
// 「改动 +N −M」 button. Pure; reads the SDK's structured output (`structuredPatch`) when there is one and
// falls back to the tool input (other agents' normalised Edit / Write carry only that).
import { walkTools, type Item, type ToolUseBlock } from './conversation';

export interface DiffStat { files: number; added: number; removed: number }

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

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

/** Files touched and lines added / removed by the conversation's successful edits (subagents included). */
export function sessionDiffStat(items: Item[]): DiffStat {
  const files = new Set<string>();
  let added = 0, removed = 0;
  for (const { tool } of walkTools(items)) {
    if (!EDIT_TOOLS.has(tool.name) || tool.status !== 'done' || tool.result?.isError) continue;
    const d = toolDelta(tool);
    if (!d) continue;
    files.add(d.path.replace(/\\/g, '/').toLowerCase());
    added += d.added;
    removed += d.removed;
  }
  return { files: files.size, added, removed };
}
