// A compacted conversation as a window shows it (transcript.load): all of it, not only what came after the last
// compaction.
//
// A compaction writes a `compact_boundary` line with `parentUuid: null`, then the summary under it (`isCompactSummary`,
// transcript-only). The SDK's loader (getSessionMessages) walks `parentUuid` back from the newest message and stops at
// the boundary — right for what the model goes on with, but a reopened conversation showed only the summary and what
// followed, as if the rest had been deleted, where the live view had shown everything with 「上下文已自动压缩」 in the
// middle (2026-11-21, the packaged build on real relays; ccb and the official binary alike). The official binary may
// keep the last messages word for word (`compactMetadata.preservedSegment` / `preservedMessages`): on disk they keep
// their old parent, and the loader hangs them under the summary.
//
// So every part is the SDK's own reading of the lines before that compaction's boundary — what a reopen showed just
// before it happened — and the parts go in front of each other. A message a later part has (one kept word for word) is
// shown there only, after the summary. `logicalParentUuid` is not followed: 2.1.3xx can name a message it never wrote
// there (the last of `allUuids`), and the SDK picks the last message before the boundary the way it always does.
// Each part reads a window of lines — from the compaction before it, with the messages that one kept — so a
// conversation compacted a hundred times is still about one pass over its lines. A rewritten boundary (the same uuid
// again, after going back past a later compaction) counts from its first copy. The boundary and the summary get the
// live stream's shape: `subtype` + `compact_metadata` (the SDK's reader drops both), the summary `isSynthetic` — the
// chat draws the same compaction line and the same meta line as it did live.
//
// Only for the view: what a model is sent of a conversation (a hand-over, a briefing, the sessions tools) stays the
// SDK's reading — the last compaction on, as the model has it (SessionService.transcript).
import fs from 'node:fs/promises';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';

type Entry = any;
type Msg = any;

/**
 * Bulky line kinds the SDK's loader does not read, skipped unparsed: the official binary's copies of its requests are
 * a quarter of a long transcript (48 MB of a real 197 MB one). Any other kind is parsed.
 */
const SKIP = new Set(['api-request', 'api-request-blob', 'api-request-shape', 'file-history-snapshot', 'file-history-delta', 'attribution-snapshot']);
const TYPE_FIRST = Buffer.from('{"type":"');
const MARK = Buffer.from('"compact_boundary"');
/** a long transcript is 200 MB: the server goes on answering while it is parsed */
const YIELD_BYTES = 4 << 20;

/**
 * The lines of a transcript, in file order, for the SDK's loader: one that names its kind first and is one of `SKIP`
 * is not parsed, a torn one (being written) is left out.
 */
export async function parseTranscript(buf: Buffer): Promise<Entry[]> {
  const out: Entry[] = [];
  let at = 0;
  let pause = YIELD_BYTES;
  while (at < buf.length) {
    if (at >= pause) {
      await new Promise((r) => setImmediate(r));
      pause = at + YIELD_BYTES;
    }
    let end = buf.indexOf(0x0a, at);
    if (end < 0) end = buf.length;
    const from = at;
    at = end + 1;
    if (end - from < 2) continue;
    if (end - from > TYPE_FIRST.length && buf.compare(TYPE_FIRST, 0, TYPE_FIRST.length, from, from + TYPE_FIRST.length) === 0) {
      const q = buf.indexOf(0x22, from + TYPE_FIRST.length);
      if (q > 0 && q < end && q - from < 64 && SKIP.has(buf.toString('latin1', from + TYPE_FIRST.length, q))) continue;
    }
    try {
      const e = JSON.parse(buf.toString('utf8', from, end));
      if (e && typeof e === 'object' && typeof e.type === 'string') out.push(e);
    } catch { /* torn */ }
  }
  return out;
}

/** The SDK's own reading of these lines (getSessionMessages over a session store: nothing else read). */
export function sdkRead(sessionId: string, entries: Entry[]): Promise<Msg[]> {
  return getSessionMessages(sessionId, { includeSystemMessages: true, sessionStore: { append: async () => {}, load: async () => entries } }) as Promise<Msg[]>;
}

const isBoundary = (e: Entry) => e?.type === 'system' && e.subtype === 'compact_boundary' && typeof e.uuid === 'string';

/**
 * The first line of the messages a compaction kept word for word (they go on after it, but were written before it),
 * if it kept any. A window without all of them reads its part wrong, not short: the SDK leaves the relinking out
 * when one is missing and walks from the summary straight to the boundary.
 */
function keptFrom(b: Entry, firstAt: Map<string, number>): number | undefined {
  const m = b?.compactMetadata;
  const kept = [...(Array.isArray(m?.preservedMessages?.uuids) ? m.preservedMessages.uuids : []), m?.preservedSegment?.headUuid, m?.preservedSegment?.tailUuid];
  let from: number | undefined;
  for (const u of kept) {
    const at = typeof u === 'string' ? firstAt.get(u) : undefined;
    if (at !== undefined && (from === undefined || at < from)) from = at;
  }
  return from;
}

/**
 * The conversation with every compaction's earlier part in front of it. `read`: the SDK's reading of some lines
 * (`sdkRead`); `entries`: all of the transcript's lines (`parseTranscript`).
 */
export async function stitch(entries: Entry[], read: (lines: Entry[]) => Promise<Msg[]>): Promise<Msg[]> {
  const firstAt = new Map<string, number>();
  const bounds = new Map<string, Entry>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (typeof e?.uuid !== 'string') continue;
    if (!firstAt.has(e.uuid)) firstAt.set(e.uuid, i);
    if (isBoundary(e)) bounds.set(e.uuid, e);
  }
  const current = await read(entries);
  if (!bounds.size) return current;
  /** where each boundary was first written, in file order */
  const starts = [...bounds.keys()].map((u) => firstAt.get(u)!).sort((a, b) => a - b);
  const parts: Msg[][] = [current];
  const seen = new Set<string>(current.map((m) => m?.uuid));
  let head: Msg = current[0];
  let end = entries.length;
  while (head?.type === 'system' && bounds.has(head.uuid)) {
    const at = firstAt.get(head.uuid)!;
    if (at <= 0 || at >= end) break;
    end = at;
    // from the compaction before this one, with the messages it kept (written before it)
    let start = 0;
    for (let k = starts.length - 1; k >= 0; k--) if (starts[k] < end) { start = starts[k]; break; }
    if (start > 0) start = Math.min(start, keptFrom(bounds.get(entries[start].uuid), firstAt) ?? start);
    let part = await read(entries.slice(start, end));
    // the walk left the window (the conversation went back past a compaction once): every line before this one
    if (start > 0 && !(part[0]?.type === 'system' && bounds.has(part[0].uuid))) part = await read(entries.slice(0, end));
    const fresh = part.filter((m) => !seen.has(m?.uuid));
    for (const m of fresh) seen.add(m?.uuid);
    parts.unshift(fresh);
    head = part[0];
  }
  return parts.flat().map((m) => shaped(m, bounds));
}

/** A boundary and a summary as the live stream sends them; anything else as the SDK read it. */
function shaped(m: Msg, bounds: Map<string, Entry>): Msg {
  const b = m?.type === 'system' ? bounds.get(m.uuid) : undefined;
  if (b) return { ...m, subtype: 'compact_boundary', compact_metadata: compactMetadata(b.compactMetadata) };
  if (m?.type === 'user' && m.isCompactSummary) return { ...m, isSynthetic: true };
  return m;
}

/** The live stream's `compact_metadata` fields the chat reads, from the line's camelCase ones. */
function compactMetadata(cm: any): Record<string, unknown> {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const post = num(cm?.postTokens);
  const ms = num(cm?.durationMs);
  return {
    ...(typeof cm?.trigger === 'string' ? { trigger: cm.trigger } : {}),
    pre_tokens: num(cm?.preTokens) ?? 0,
    ...(post !== undefined ? { post_tokens: post } : {}),
    ...(ms !== undefined ? { duration_ms: ms } : {}),
  };
}

/** Whether the file has a compaction line at all — read 1 MiB at a time: one without is read by the SDK as before. */
async function hasCompaction(file: string): Promise<boolean> {
  const fh = await fs.open(file, 'r');
  try {
    const chunk = Buffer.alloc(1 << 20);
    let carry = 0;
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(chunk, carry, chunk.length - carry, pos);
      if (bytesRead <= 0) return false;
      pos += bytesRead;
      const len = carry + bytesRead;
      if (chunk.subarray(0, len).includes(MARK)) return true;
      // the marker may be cut by the next read: its start goes along
      carry = Math.min(MARK.length - 1, len);
      chunk.copy(chunk, 0, len - carry, len);
    }
  } finally {
    await fh.close();
  }
}

async function build(file: string, sessionId: string): Promise<Msg[] | null> {
  if (!(await hasCompaction(file))) return null;
  const msgs = await stitch(await parseTranscript(await fs.readFile(file)), (lines) => sdkRead(sessionId, lines));
  // nothing read this way (an SDK that no longer reads a store): the usual way
  return msgs.length ? msgs : null;
}

/** 「加载更早的记录」 asks for the next page of the same conversation, and each page is cut from the whole of it. */
const KEEP_MS = 60_000;
let last: { key: string; msgs: Promise<Msg[] | null>; timer?: ReturnType<typeof setTimeout> } | undefined;

/**
 * The whole of a compacted conversation's transcript `file` for the view, or null when it has no compaction (read it
 * the usual way then). The last one asked for is kept a minute while its file stays the same size and age.
 */
export async function compactedHistory(file: string, sessionId: string): Promise<Msg[] | null> {
  const st = await fs.stat(file);
  const key = `${file}\n${sessionId}\n${st.size}\n${st.mtimeMs}`;
  if (last?.key !== key) {
    if (last?.timer) clearTimeout(last.timer);
    last = { key, msgs: build(file, sessionId) };
  }
  const mine = last;
  if (mine.timer) clearTimeout(mine.timer);
  mine.timer = setTimeout(() => { if (last === mine) last = undefined; }, KEEP_MS);
  mine.timer.unref?.();
  try {
    const msgs = await mine.msgs;
    return msgs && msgs.slice();
  } catch (e) {
    if (last === mine) {
      clearTimeout(mine.timer);
      last = undefined;
    }
    throw e;
  }
}
