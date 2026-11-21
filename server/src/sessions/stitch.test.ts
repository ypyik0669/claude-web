// A reopened compacted conversation shows all of it (sessions/stitch.ts). The fixtures are transcripts in the line
// shapes the two runtimes write — ccb 2.8.4 (compaction at the start of a turn, the new message before the boundary)
// and the official binary 2.1.3xx (the last messages kept word for word, request copies and bookkeeping in between) —
// read through the SDK's own loader.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compactedHistory, parseTranscript, sdkRead, stitch } from './stitch.js';
import { pageOf, withTurnStats } from './history.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const SID = '5e55a1d0-c0de-4c0d-8e00-000000000001';

const entriesOf = async (name: string) => parseTranscript(await fs.readFile(path.join(FIX, name)));
const read = (lines: any[]) => sdkRead(SID, lines);
const historyOf = async (name: string) => stitch(await entriesOf(name), read);
const ids = (msgs: any[]) => msgs.map((m) => m.uuid);
const noTwice = (msgs: any[]) => expect(new Set(ids(msgs)).size).toBe(msgs.length);

describe('stitch: a compacted conversation with what came before each compaction', () => {
  it('one compaction (ccb, at the start of a turn): the earlier messages, the compaction line, the summary as a meta line, then what followed', async () => {
    const entries = await entriesOf('compact-once.jsonl');
    // what a reopen showed until now: the SDK stops at the boundary
    expect(ids(await read(entries))).toEqual(['b1', 's1', 'a3', 'u4', 'a4']);
    const msgs = await stitch(entries, read);
    expect(ids(msgs)).toEqual(['u1', 'a1', 'r1', 'a1b', 'u2', 'a2', 'u3', 'b1', 's1', 'a3', 'u4', 'a4']);
    // the live stream's shapes: the chat draws 「上下文已自动压缩（55K tok）」 and the summary as a meta line
    expect(msgs[7]).toMatchObject({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 55321 } });
    expect(msgs[8]).toMatchObject({ type: 'user', isCompactSummary: true, isSynthetic: true });
    // everything else exactly as the SDK reads it (a tool call and its result, timestamps)
    expect(msgs[1].message.content[0]).toMatchObject({ type: 'tool_use', id: 'toolu_1' });
    expect(msgs[2].message.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(msgs.every((m) => typeof m.timestamp === 'string')).toBe(true);
  });

  it('two compactions chain — the second one a /compact with no logicalParentUuid; a sub-agent line and a torn last line are not shown', async () => {
    const msgs = await historyOf('compact-twice.jsonl');
    expect(ids(msgs)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'b1', 's1', 'a3', 'u4', 'a4', 'r4', 'a4b', 'b2', 's2', 'u5', 'a5']);
    expect(msgs.filter((m) => m.subtype === 'compact_boundary').map((m) => m.compact_metadata)).toEqual([{ trigger: 'auto', pre_tokens: 98019 }, { trigger: 'manual', pre_tokens: 120747 }]);
    expect(msgs.filter((m) => m.isCompactSummary).every((m) => m.isSynthetic)).toBe(true);
    noTwice(msgs);
  });

  it('messages kept word for word (preservedSegment / preservedMessages) come once, after the summary, through two such compactions', async () => {
    const entries = await entriesOf('compact-kept.jsonl');
    // the request copies are not even parsed
    expect(entries.some((e) => e.type === 'api-request-blob')).toBe(false);
    // the SDK hangs the kept ones (q1, q2) under the last summary
    expect(ids(await read(entries))).toEqual(['b2', 's2', 'q1', 'q2', 'a5']);
    const windows: number[] = [];
    const msgs = await stitch(entries, (lines) => { windows.push(lines.length); return read(lines); });
    expect(ids(msgs)).toEqual(['u1', 'a1', 'a1b', 'r1', 'a1c', 'u2', 'b1', 's1', 'k1', 'k2', 'u3', 'a3', 'u4', 'b2', 's2', 'q1', 'q2', 'a5']);
    noTwice(msgs);
    expect(msgs.find((m) => m.uuid === 'b1').compact_metadata).toEqual({ trigger: 'auto', pre_tokens: 667893, post_tokens: 19437, duration_ms: 71848 });
    // the window for the part before b2 starts at the messages b1 kept (written before b1): one read per part, no
    // second read of everything before b2
    expect(windows).toHaveLength(3);
    expect(windows[1]).toBeLessThan(entries.findIndex((e) => e.uuid === 'b2'));
  });

  it('a compaction written again with the same uuids (going back past a later /compact): the branch left behind is not shown', async () => {
    const msgs = await historyOf('compact-rewritten.jsonl');
    expect(ids(msgs)).toEqual(['u1', 'a1', 'u2', 'b1', 's1', 'k1', 'u5', 'a5']);
    expect(msgs.find((m) => m.uuid === 'k1').message.content[0].text).toBe('第二句的回答（会原样保留）');
  });

  // lines built here, for the cases with no fixture of their own
  let n = 0;
  const line = (uuid: string, parentUuid: string | null, o: Record<string, unknown> = {}) => ({ parentUuid, isSidechain: false, sessionId: SID, type: 'user', message: { role: 'user', content: uuid }, uuid, timestamp: new Date(Date.UTC(2026, 10, 21, 3, 0, 0) + ++n * 1000).toISOString(), ...o });
  const said = (uuid: string, parent: string | null) => line(uuid, parent);
  const answer = (uuid: string, parent: string) => line(uuid, parent, { type: 'assistant', message: { id: `msg_${uuid}`, role: 'assistant', content: [{ type: 'text', text: uuid }], stop_reason: 'end_turn' } });
  const boundary = (uuid: string, lp?: string) => line(uuid, null, { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', ...(lp ? { logicalParentUuid: lp } : {}), compactMetadata: { trigger: 'auto', preTokens: 100_000 } });
  const summary = (uuid: string, parent: string) => line(uuid, parent, { isCompactSummary: true, isVisibleInTranscriptOnly: true });

  it('gone back past a compaction and compacted again: the branch with the first one is not shown', async () => {
    const entries = [
      said('u1', null), answer('a1', 'u1'), said('u2', 'a1'), answer('a2', 'u2'),
      boundary('b1', 'a2'), summary('s1', 'b1'), answer('a3', 's1'),
      // a rewind to a1, then on from there
      said('u3', 'a1'), answer('a4', 'u3'), said('u4', 'a4'),
      boundary('b2', 'u4'), summary('s2', 'b2'), answer('a5', 's2'),
    ];
    expect(ids(await stitch(entries, read))).toEqual(['u1', 'a1', 'u3', 'a4', 'u4', 'b2', 's2', 'a5']);
  });

  it('only a preservedSegment (head / anchor / tail, no preservedMessages), twice: each kept message once, after its summary', async () => {
    const kept = (uuid: string, head: string, anchor: string, tail: string) => ({ ...boundary(uuid), compactMetadata: { trigger: 'auto', preTokens: 100_000, preservedSegment: { headUuid: head, anchorUuid: anchor, tailUuid: tail } } });
    const entries = [
      said('u1', null), answer('a1', 'u1'), said('u2', 'a1'), answer('a2', 'u2'),
      kept('b1', 'u2', 's1', 'a2'), summary('s1', 'b1'), said('u3', 's1'), answer('a3', 'u3'),
      kept('b2', 'u3', 's2', 'a3'), summary('s2', 'b2'), said('u4', 's2'), answer('a4', 'u4'),
    ];
    expect(ids(await read(entries))).toEqual(['b2', 's2', 'u3', 'a3', 'u4', 'a4']);
    expect(ids(await stitch(entries, read))).toEqual(['u1', 'a1', 'b1', 's1', 'u2', 'a2', 'b2', 's2', 'u3', 'a3', 'u4', 'a4']);
  });

  it('a /compact right after an automatic one: both lines, both summaries', async () => {
    const entries = [said('u1', null), answer('a1', 'u1'), boundary('b1', 'a1'), summary('s1', 'b1'), boundary('b2', 's1'), summary('s2', 'b2'), said('u2', 's2'), answer('a2', 'u2')];
    expect(ids(await stitch(entries, read))).toEqual(['u1', 'a1', 'b1', 's1', 'b2', 's2', 'u2', 'a2']);
  });

  it('compacted 200 times: each part reads its own window of lines, not everything before it', async () => {
    const entries: any[] = [];
    let prev: string | null = null;
    for (let k = 0; k < 200; k++) {
      if (k) { entries.push(boundary(`b${k}`, prev!), summary(`s${k}`, `b${k}`)); prev = `s${k}`; }
      for (let i = 0; i < 5; i++) { entries.push(said(`u${k}-${i}`, prev), answer(`a${k}-${i}`, `u${k}-${i}`)); prev = `a${k}-${i}`; }
    }
    let lines = 0;
    const msgs = await stitch(entries, (part) => { lines += part.length; return read(part); });
    expect(msgs).toHaveLength(entries.length);
    expect(ids(msgs)).toEqual(ids(entries));
    expect(lines).toBeLessThan(entries.length * 3);
  });

  it('no compaction: the SDK reading as it is', async () => {
    const entries = (await entriesOf('compact-once.jsonl')).filter((e) => e.uuid !== 'b1' && e.uuid !== 's1').map((e) => (e.uuid === 'a3' ? { ...e, parentUuid: 'u3' } : e));
    expect(await stitch(entries, read)).toEqual(await read(entries));
  });

  it('pages: the newest from the last compaction on, the older ones before it, each once', async () => {
    const msgs = withTurnStats(await historyOf('compact-twice.jsonl'), []);
    // room for the last turn only
    const lastTurn = msgs.slice(msgs.findIndex((m) => m.uuid === 'u5'));
    const budget = lastTurn.reduce((n, m) => n + JSON.stringify(m).length, 0) + 10;
    const pages: any[][] = [];
    let cursor: string | undefined;
    do {
      const p = pageOf(msgs, cursor, budget);
      pages.push(p.messages);
      cursor = p.next;
    } while (cursor && pages.length < 20);
    expect(ids(pages[0])).toEqual(['u5', 'a5', 'cw-turn-u5']);
    // the page before it carries the second compaction, the one before that the first one
    // (a turn's stats right after its last answer, before the compaction that opened the next turn)
    expect(ids(pages[1])).toEqual(['u4', 'a4', 'r4', 'a4b', 'cw-turn-u4', 'b2', 's2']);
    expect(ids(pages[2])).toEqual(['u3', 'b1', 's1', 'a3', 'cw-turn-u3']);
    expect(pages.slice().reverse().flat()).toEqual(msgs);
  });
});

describe('parseTranscript', () => {
  it('skips the request copies and file snapshots without parsing them, keeps every other kind, leaves out torn lines', async () => {
    const lines = [
      '{"type":"queue-operation","operation":"enqueue","sessionId":"s"}',
      '{"type":"api-request-blob","blob":"' + 'x'.repeat(100) + '"}',
      '{"type":"api-request","requestId":"r"}',
      '{"type":"file-history-snapshot","messageId":"m"}',
      '{"type":"frame-link","sessionId":"s"}',
      '{"parentUuid":null,"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}',
      '',
      '{"type":"assistant","uuid":"a1","parentUuid":"u1","message":{"id":"m1","role":"assistant","content":[]}}\r',
      '[1,2]',
      '{"parentUuid":"a1","type":"user","uuid":"u2","mess',
    ];
    const out = await parseTranscript(Buffer.from(lines.join('\n')));
    expect(out.map((e) => e.uuid ?? e.type)).toEqual(['queue-operation', 'frame-link', 'u1', 'a1']);
  });
});

describe('compactedHistory / SessionService.history', () => {
  let tmp: string;
  let file: string;
  let SessionService: typeof import('./service.js').SessionService;
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-stitch-'));
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude');
    const dir = path.join(tmp, '.claude', 'projects', 'C--work-demo');
    await fs.mkdir(dir, { recursive: true });
    file = path.join(dir, `${SID}.jsonl`);
    await fs.copyFile(path.join(FIX, 'compact-kept.jsonl'), file);
    ({ SessionService } = await import('./service.js'));
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('a transcript without a compaction is left to the usual reading (null)', async () => {
    const plain = path.join(tmp, 'plain.jsonl');
    const text = (await fs.readFile(path.join(FIX, 'compact-once.jsonl'), 'utf8')).split('\n').filter((l) => !l.includes('"b1"') && !l.includes('"s1"')).join('\n');
    await fs.writeFile(plain, text);
    expect(await compactedHistory(plain, SID)).toBeNull();
  });

  it('the stitched messages, a fresh array each time; a changed file is read again', async () => {
    const a = await compactedHistory(file, SID);
    expect(ids(a!)).toEqual(['u1', 'a1', 'a1b', 'r1', 'a1c', 'u2', 'b1', 's1', 'k1', 'k2', 'u3', 'a3', 'u4', 'b2', 's2', 'q1', 'q2', 'a5']);
    a!.length = 0;
    expect((await compactedHistory(file, SID))!.length).toBe(18);
    // a turn more
    await fs.appendFile(file, `${JSON.stringify({ parentUuid: 'a5', isSidechain: false, type: 'user', message: { role: 'user', content: '还有吗' }, uuid: 'u6', timestamp: '2026-11-21T02:00:00.000Z', sessionId: SID, cwd: 'C:\\work\\demo' })}\n`);
    expect(ids((await compactedHistory(file, SID))!).slice(-2)).toEqual(['a5', 'u6']);
  });

  it('history() is the whole conversation for the view; transcript() — what a model is sent of it — still starts at the last compaction', async () => {
    const svc = new SessionService();
    const view = await svc.history(SID);
    expect(ids(view).slice(0, 3)).toEqual(['u1', 'a1', 'a1b']);
    expect(ids(view)).toContain('b1');
    expect(ids(await svc.transcript(SID)).slice(0, 2)).toEqual(['b2', 's2']);
  });
});
