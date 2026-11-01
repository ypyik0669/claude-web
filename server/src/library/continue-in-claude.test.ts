import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionSummary, SourceCaps, SourceStatus } from '../protocol.js';
import type { SessionSource } from './types.js';
import { LibraryIndex } from './index-db.js';
import { MetaStore } from '../meta/store.js';
import { LibraryService } from './service.js';
import { continuationEntries, replayEvents } from './continue-in-claude.js';
import { claudeProjectDir } from '../runtime/transcript-file.js';

const long = 'x'.repeat(20_000);
// what DshSource.read gives back (SDK-shaped)
const messages = [
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '看看这些 PDF' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: '我先列一下' }, { type: 'tool_use', id: 'c1', name: 'pwsh', input: { command: 'ls D:\\pdf' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'denied', is_error: true }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: long }] } },
];

describe('replaying another tool\'s conversation into Claude', () => {
  it('keeps everything said at full length, tool calls as notes, no thinking', () => {
    const ev = replayEvents(messages);
    expect(ev.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(ev[0]).toMatchObject({ kind: 'user', text: '看看这些 PDF\n［图片］' });
    expect(ev[2]).toMatchObject({ kind: 'tool', name: 'pwsh', ok: false });
    expect((ev[3] as { text: string }).text).toHaveLength(20_000);
    expect(JSON.stringify(ev)).not.toContain('secret');
  });

  it('makes a chained transcript of the new conversation', () => {
    const rows = continuationEntries(messages, { cwd: 'D:\\论文', sessionId: 'new-1' });
    expect(rows.map((r) => r.type)).toEqual(['user', 'assistant']);
    expect(rows[1].parentUuid).toBe(rows[0].uuid);
    expect(rows.every((r) => r.sessionId === 'new-1' && r.cwd === 'D:\\论文')).toBe(true);
    const said = JSON.stringify(rows[1]);
    expect(said).toContain('我先列一下');
    expect(said).toContain('（pwsh ls D:');
  });

  it('names the project folder as the CLI does', () => {
    expect(path.basename(claudeProjectDir('C:\\Users\\YPY\\claude-web'))).toBe('C--Users-YPY-claude-web');
    expect(path.basename(claudeProjectDir('D:\\论文\\价值共创+案例'))).toBe(`D${'-'.repeat(12)}`);
    const deep = `C:\\${'a'.repeat(250)}`;
    expect(path.basename(claudeProjectDir(deep))).toMatch(/^C--a{197}-[0-9a-z]+$/);
  });
});

describe('LibraryService.continuation', () => {
  let dir: string;
  let prev: { web?: string; cfg?: string };
  let index: LibraryIndex;
  let meta: MetaStore;
  let lib: LibraryService;
  const CAPS: SourceCaps = { resume: true, rename: false, archive: false, delete: false, fork: false, continueInClaude: true };
  const summary: SessionSummary = { sessionId: 'claudeai-s1', title: 'PDF 文献清单整理', cwd: '', lastModified: 1, agent: 'claudeai', caps: CAPS };
  let read: ReturnType<typeof vi.fn>;
  /** what claude.ai has now */
  let said: any[];
  /** the Claude conversations the claude source lists */
  let claudeItems: SessionSummary[];

  beforeEach(async () => {
    said = messages;
    claudeItems = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-cont-'));
    prev = { web: process.env.CLAUDE_WEB_DIR, cfg: process.env.CLAUDE_CONFIG_DIR };
    process.env.CLAUDE_WEB_DIR = dir;
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
    summary.cwd = path.join(dir, 'work');
    index = new LibraryIndex(path.join(dir, 'library.db'));
    meta = new MetaStore(path.join(dir, 'meta.json'));
    await meta.load();
    await meta.setSetting('library.joined', ['claudeai']);
    // pages as a source does: the newest first, the cursor walking back
    read = vi.fn(async (_id: string, o: { cursor?: string }) => (o?.cursor ? { messages: said.slice(0, 2) } : { messages: said.slice(2), next: 'older' }));
    const cai = {
      kind: 'claudeai', caps: CAPS,
      status: async (): Promise<SourceStatus> => ({ kind: 'claudeai', name: 'claude.ai', installed: true, detected: true, joined: true, enabled: true }),
      list: async () => ({ items: [summary] }),
      read,
      close: async () => {},
    } as unknown as SessionSource;
    const claude = { kind: 'claude', caps: CAPS, status: cai.status, list: async () => ({ items: claudeItems }), read: async () => ({ messages: [] }), close: async () => {} } as unknown as SessionSource;
    lib = new LibraryService([claude, cai], index, meta, { trashDir: path.join(dir, 'trash') });
  });

  afterEach(() => {
    lib.dispose();
    index.close();
    for (const [k, v] of [['CLAUDE_WEB_DIR', prev.web], ['CLAUDE_CONFIG_DIR', prev.cfg]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('only for sources that go on in Claude', () => {
    expect(lib.continuesInClaude('claudeai-s1')).toBe(true);
    expect(lib.continuesInClaude('c1')).toBe(false);
  });

  it('writes one Claude conversation that replays it, titled like it, and reuses it after', async () => {
    const [a, b] = await Promise.all([lib.continuation('claudeai-s1'), lib.continuation('claudeai-s1')]);
    expect(a).toEqual(b);
    expect(a.created).toBe(true);
    expect(a.cwd).toBe(summary.cwd);
    const file = path.join(claudeProjectDir(summary.cwd), `${a.sessionId}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const turns = lines.filter((l) => l.type === 'user' || l.type === 'assistant');
    expect(turns.map((l) => l.type)).toEqual(['user', 'assistant']);
    // in the order it was said: the question, then the answer (tool note, then the long text)
    expect(JSON.stringify(turns[0])).toContain('看看这些 PDF');
    expect(JSON.stringify(turns[1]).indexOf('我先列一下')).toBeLessThan(JSON.stringify(turns[1]).indexOf('xxxx'));
    expect(lines.some((l) => l.type === 'custom-title' && l.customTitle === 'PDF 文献清单整理')).toBe(true);
    expect(meta.sessionMeta('claudeai-s1').continuedAs).toBe(a.sessionId);
    const again = await lib.continuation('claudeai-s1');
    expect(again).toEqual({ sessionId: a.sessionId, cwd: summary.cwd, created: false });
    expect(read).toHaveBeenCalledTimes(2);
    // its transcript gone (deleted in Claude): a fresh one next time
    fs.rmSync(file);
    const fresh = await lib.continuation('claudeai-s1');
    expect(fresh.created).toBe(true);
    expect(fresh.sessionId).not.toBe(a.sessionId);
  });

  // one conversation, one row: the claude.ai row would be a second one with the same title
  it('lists the Claude conversation in place of the one it goes on from', async () => {
    const before = await lib.list();
    expect(before.map((s) => s.sessionId)).toContain('claudeai-s1');
    const a = await lib.continuation('claudeai-s1');
    claudeItems = [{ sessionId: a.sessionId, title: 'PDF 文献清单整理', cwd: summary.cwd, lastModified: 5, agent: 'claude' }];
    summary.lastModified = 9; // said something new on claude.ai since
    const after = await lib.list();
    expect(after.map((s) => s.sessionId)).toEqual([a.sessionId]);
    expect(after[0].lastModified).toBe(9);
    // still known for a send through its old id (a tab left on it)
    expect(lib.continuesInClaude('claudeai-s1')).toBe(true);
    expect((await lib.continuation('claudeai-s1')).sessionId).toBe(a.sessionId);
    // the Claude one deleted: the claude.ai row is back
    fs.rmSync(path.join(claudeProjectDir(summary.cwd), `${a.sessionId}.jsonl`));
    claudeItems = [];
    lib.invalidate('claude'); // the transcript watcher does this
    expect((await lib.list()).map((s) => s.sessionId)).toEqual(['claudeai-s1']);
  });
});
