import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AntigravitySource, antigravityRoots, mapTool, parseTime, searchRowsToMessages, stepsToMessages, uriToPath } from './antigravity-source.js';
import { scanLocalHistory } from './local-scan.js';

// A tiny protobuf writer for the fixtures: a number is a varint, a string / bytes length-delimited, an object a nested
// message, an array repeats the field.
function pb(fields: Record<number, unknown>): Uint8Array {
  const out: number[] = [];
  const varint = (n: bigint) => { do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n); };
  const put = (f: number, v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) put(f, x); return; }
    if (typeof v === 'number') { varint(BigInt(f) << 3n); varint(BigInt(v)); return; }
    const bytes = typeof v === 'string' ? Buffer.from(v, 'utf8') : v instanceof Uint8Array ? v : pb(v as Record<number, unknown>);
    varint((BigInt(f) << 3n) | 2n);
    varint(BigInt(bytes.length));
    out.push(...bytes);
  };
  for (const [f, v] of Object.entries(fields)) put(Number(f), v);
  return Uint8Array.from(out);
}

const W = process.platform === 'win32';
const URI = W ? 'file:///c%3A/Users/me/proj' : 'file:///Users/me/proj';
const CWD = W ? 'C:\\Users\\me\\proj' : '/Users/me/proj';
const OLD_URI = W ? 'file:///c:/old/proj' : 'file:///old/proj';
const OLD_CWD = W ? 'C:\\old\\proj' : '/old/proj';
const A = 'aaaaaaaa-1111-2222-3333-444444444444'; // a whole conversation
const B = 'bbbbbbbb-1111-2222-3333-444444444444'; // its db has no readable steps: the search text instead
const CHILD = 'cccccccc-1111-2222-3333-444444444444'; // a sub-agent's conversation
const GONE = 'dddddddd-1111-2222-3333-444444444444'; // a summary whose db was deleted
const OLD = 'eeeeeeee-1111-2222-3333-444444444444'; // an older build's folder (no summaries)
const EMPTY = 'ffffffff-1111-2222-3333-444444444444'; // nothing was ever said in it
const CONTENT = `export const jobs = [\n${'  { title: "Interactive Media Specialist", charImage: a },\n'.repeat(6)}];\n`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-antigravity-test-'));
const cur = path.join(home, '.gemini', 'antigravity');
const old = path.join(home, '.gemini', 'antigravity-ide');
const at = (s: number) => ({ 1: { 1: s } });

const stepsA = [
  { idx: 0, type: 14, p: { 1: 14, 4: 3, 5: at(1779418358), 19: { 2: 'swap the two images', 3: { 1: 'swap the two images' } } } },
  { idx: 1, type: 98, p: { 1: 98, 4: 3, 5: at(1779418358) } },
  { idx: 2, type: 15, p: { 1: 15, 5: at(1779418359), 20: { 1: 'I will read the jobs file.', 3: 'Where are the images set?', 7: [{ 1: 'ai2phbiz', 2: 'view_file', 3: JSON.stringify({ AbsolutePath: 'C:\\proj\\src\\jobs.ts', StartLine: 10, EndLine: 19, toolAction: 'Read file', toolSummary: 'Read jobs' }) }] } } },
  { idx: 3, type: 8, p: { 1: 8, 5: { ...at(1779418360), 4: { 1: 'ai2phbiz', 2: 'view_file', 3: '{"AbsolutePath":"C:\\\\proj\\\\src\\\\jobs.ts"}' }, 30: 'View file', 31: 'Read jobs data file' }, 14: { 1: 'file:///c:/proj/src/jobs.ts', 3: 157, 4: CONTENT } } },
  { idx: 4, type: 15, p: { 1: 15, 20: { 1: 'Swapping them now.', 7: [{ 1: 'pmxhjbfs', 2: 'multi_replace_file_content', 3: JSON.stringify({ TargetFile: 'C:\\proj\\src\\jobs.ts', ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'b' }, { TargetContent: 'c', ReplacementContent: 'd' }] }) }] } } },
  { idx: 5, type: 5, p: { 1: 5, 5: { 4: { 1: 'pmxhjbfs', 2: 'multi_replace_file_content', 3: '{}' }, 31: 'Swap job images' } } },
  { idx: 6, type: 15, p: { 1: 15, 20: { 7: [{ 1: 'ls1', 2: 'list_dir', 3: JSON.stringify({ DirectoryPath: 'C:\\proj' }) }] } } },
  { idx: 7, type: 9, p: { 1: 9, 5: { 4: { 1: 'ls1', 2: 'list_dir', 3: JSON.stringify({ DirectoryPath: 'C:\\proj' }) }, 30: 'Workspace list', 31: 'List directory contents' }, 15: { 1: 'file:///c:/proj', 3: [{ 1: 'AGENTS.md', 4: 93 }, { 1: '.dockerignore', 4: 93 }, { 1: 'src', 2: 1 }] } } },
  // a newer build's tool step (type 132) whose agent turn was not recorded: the call comes from the step itself
  { idx: 8, type: 132, p: { 1: 132, 5: { 4: { 1: 'call_1', 2: 'run_command', 3: JSON.stringify({ CommandLine: 'npm run build', Cwd: 'C:\\proj' }) } }, 140: { 1: [{ 1: 'CommandLine', 2: 'npm run build' }], 2: { 1: 'The command exited with code 0.\nOutput:\nbuilt' } } } },
  { idx: 9, type: 15, p: { 1: 15, 20: { 1: 'Done: swapped.', 8: 'Done: swapped.' } } },
];

function conversationDb(file: string, steps: { idx: number; type: number; p: Record<number, unknown> }[], workspace?: string) {
  const db = new DatabaseSync(file);
  db.exec('create table steps (idx integer primary key, step_type integer not null default 0, status integer not null default 0, has_subtrajectory numeric not null default false, metadata blob, error_details blob, permissions blob, task_details blob, render_info blob, step_payload blob, step_format integer not null default 0)');
  db.exec("create table trajectory_metadata_blob (id text default 'main' primary key, data blob)");
  const ins = db.prepare('insert into steps (idx, step_type, status, step_payload) values (?, ?, 3, ?)');
  for (const s of steps) ins.run(s.idx, s.type, pb(s.p));
  if (workspace) db.prepare("insert into trajectory_metadata_blob (id, data) values ('main', ?)").run(pb({ 1: { 1: workspace, 2: workspace }, 7: workspace }));
  db.close();
}

const OLDTIME = new Date('2026-01-01T00:00:00Z');
let before: string[] = [];
const snapshot = () => {
  const out: string[] = [];
  const walk = (d: string) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else out.push(`${path.relative(home, p)} ${st.size} ${st.mtimeMs}`); } };
  walk(path.join(home, '.gemini'));
  return out.sort();
};

beforeAll(() => {
  fs.mkdirSync(path.join(cur, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(old, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-browser-profile'), { recursive: true });
  conversationDb(path.join(cur, 'conversations', `${A}.db`), stepsA, URI);
  conversationDb(path.join(cur, 'conversations', `${B}.db`), [], URI);
  conversationDb(path.join(cur, 'conversations', `${CHILD}.db`), stepsA.slice(0, 3));
  // the summaries db, as the current builds keep it
  const db = new DatabaseSync(path.join(cur, 'conversation_summaries.db'));
  db.exec("create table conversation_summaries (conversation_id text primary key, title text not null default '', preview text not null default '', step_count integer not null default 0, last_modified_time datetime not null, workspace_uris text not null, status text not null default '', parent_conversation_id text not null default '')");
  const row = db.prepare('insert into conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, parent_conversation_id) values (?, ?, ?, ?, ?, ?, ?)');
  row.run(A, '', 'Swap Careers Page Images', 10, '2026-05-22 02:55:15.0824688+00:00', JSON.stringify([URI]), '');
  row.run(B, 'Fix Rust Compilation Errors', 'ignored preview', 5, '2026-05-20 11:27:17.7348638+00:00', JSON.stringify([URI]), '');
  row.run(CHILD, 'browser task', '', 3, '2026-05-23 01:00:00+00:00', '[]', A);
  row.run(GONE, 'deleted in Antigravity', '', 3, '2026-05-24 01:00:00+00:00', '[]', '');
  db.exec('create virtual table conversations_fts using fts5(conversation_id UNINDEXED, chunk_index UNINDEXED, chunk_first_step UNINDEXED, chunk_last_step UNINDEXED, last_modified_time UNINDEXED, step_count UNINDEXED, last_step_created_at UNINDEXED, archived UNINDEXED, user_step_byte_offsets UNINDEXED, agent_step_byte_offsets UNINDEXED, title, workspace, project, user_body, agent_body)');
  const fts = db.prepare('insert into conversations_fts (conversation_id, chunk_index, user_step_byte_offsets, agent_step_byte_offsets, title, user_body, agent_body) values (?, ?, ?, ?, ?, ?, ?)');
  fts.run(B, -1, Buffer.from(''), Buffer.from(''), 'Fix Rust Compilation Errors', '', '');
  fts.run(B, 0, Buffer.from('[[0,0]]'), Buffer.from('[[2,0],[4,12]]'), 'Fix Rust Compilation Errors', 'cargo build fails', 'first reply\nsecond reply');
  db.close();
  // an older build's folder: no summaries, the title is what was said first
  conversationDb(path.join(old, 'conversations', `${OLD}.db`), [
    { idx: 0, type: 14, p: { 1: 14, 5: at(1777000000), 19: { 2: '我要 upload 什么' } } },
    { idx: 1, type: 15, p: { 1: 15, 20: { 1: '用 WinSCP 传上去。' } } },
  ], OLD_URI);
  conversationDb(path.join(old, 'conversations', `${EMPTY}.db`), [{ idx: 0, type: 98, p: { 1: 98 } }], OLD_URI);
  conversationDb(path.join(old, 'conversations', `${A}.db`), stepsA.slice(0, 1), OLD_URI); // the same id in both: the current wins
  fs.writeFileSync(path.join(old, 'conversations', '01fd611b-b6b8-4ef1-adea-11d4eb36d8c7.pb'), Buffer.from([0x2e, 0xf2, 0xe5, 0xf1, 0x55, 0x90])); // encrypted
  for (const dir of [path.join(cur, 'conversations'), path.join(old, 'conversations')]) for (const n of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, n), OLDTIME, OLDTIME);
  before = snapshot();
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('Antigravity conversations (read from its own files)', () => {
  it('finds the folders that hold conversations, the current build first', () => {
    expect(antigravityRoots(home)).toEqual([cur, old]);
    expect(antigravityRoots(path.join(home, 'nowhere'))).toEqual([]);
  });

  it('lists the summaries and the older folder: titles, folders and times, no sub-agent, deleted or empty one', async () => {
    const src = new AntigravitySource(() => antigravityRoots(home));
    const { items } = await src.list({ limit: 50 });
    expect(items.map((i) => i.sessionId)).toEqual([`antigravity-${A}`, `antigravity-${B}`, `antigravity-${OLD}`]);
    const [a, b, o] = items;
    expect(a).toMatchObject({ title: 'Swap Careers Page Images', cwd: CWD, lastModified: Date.UTC(2026, 4, 22, 2, 55, 15, 82), agent: 'antigravity', source: 'Antigravity' });
    expect(a.caps).toEqual({ resume: true, rename: false, archive: false, delete: false, fork: false, continueInClaude: true });
    expect(b.title).toBe('Fix Rust Compilation Errors');
    expect(o).toMatchObject({ title: '我要 upload 什么', firstPrompt: '我要 upload 什么', cwd: OLD_CWD, lastModified: OLDTIME.getTime(), createdAt: 1777000000 * 1000 });
    expect(await src.status()).toMatchObject({ kind: 'antigravity', name: 'Antigravity', installed: true, count: 3 });
  });

  it('reads a conversation: what was said, thinking, the tools as cards with their results', async () => {
    const src = new AntigravitySource(() => antigravityRoots(home));
    const { messages, next } = await src.read(A, { limit: 50 });
    expect(next).toBeUndefined();
    const sid = `antigravity-${A}`;
    const c = (i: number) => messages[i].message.content;
    expect(messages.map((m) => m.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(messages[0]).toEqual({ type: 'user', uuid: `${sid}-0`, session_id: sid, timestamp: new Date(1779418358 * 1000).toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'swap the two images' }] } });
    expect(c(1)).toEqual([
      { type: 'thinking', thinking: 'Where are the images set?' },
      { type: 'text', text: 'I will read the jobs file.' },
      { type: 'tool_use', id: 'ai2phbiz', name: 'Read', input: { file_path: 'C:\\proj\\src\\jobs.ts', offset: 10, limit: 10 } },
    ]);
    // a file's contents: the one long text of the step's own field
    expect(c(2)).toEqual([{ type: 'tool_result', tool_use_id: 'ai2phbiz', content: CONTENT }]);
    expect(c(3)[1]).toEqual({ type: 'tool_use', id: 'pmxhjbfs', name: 'MultiEdit', input: { file_path: 'C:\\proj\\src\\jobs.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] } });
    // nothing but the summary to show for it
    expect(c(4)).toEqual([{ type: 'tool_result', tool_use_id: 'pmxhjbfs', content: 'Swap job images' }]);
    expect(c(5)).toEqual([{ type: 'tool_use', id: 'ls1', name: 'Glob', input: { pattern: '*', path: 'C:\\proj' } }]);
    // a listing: its entries' names (an entry is a message that is also valid text), not the arguments echoed
    expect(c(6)).toEqual([{ type: 'tool_result', tool_use_id: 'ls1', content: 'AGENTS.md\n.dockerignore\nsrc' }]);
    expect(messages[7].uuid).toBe(`${sid}-8-c`);
    expect(c(7)).toEqual([{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'npm run build', cwd: 'C:\\proj' } }]);
    expect(c(8)).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: 'The command exited with code 0.\nOutput:\nbuilt' }]);
    expect(c(9)).toEqual([{ type: 'text', text: 'Done: swapped.' }]);
  });

  it('pages newest first', async () => {
    const src = new AntigravitySource(() => antigravityRoots(home));
    const p1 = await src.read(A, { limit: 4 });
    expect(p1.messages.map((m) => m.uuid.slice(-4))).toEqual(['-7-r', '-8-c', '-8-r', `${A.slice(-2)}-9`]);
    expect(p1.next).toBe('6');
    const p2 = await src.read(A, { cursor: p1.next, limit: 4 });
    expect(p2.messages).toHaveLength(4);
    expect(p2.next).toBe('2');
  });

  it('falls back to the search text when its own db gives nothing', async () => {
    const src = new AntigravitySource(() => antigravityRoots(home));
    const { messages } = await src.read(B, { limit: 50 });
    expect(messages.map((m) => [m.type, m.message.content[0].text])).toEqual([['user', 'cargo build fails'], ['assistant', 'first reply'], ['assistant', 'second reply']]);
  });

  it('says so for a conversation that is not there', async () => {
    const src = new AntigravitySource(() => antigravityRoots(home));
    await expect(src.read(GONE, { limit: 10 })).rejects.toThrow(/Antigravity/);
  });

  it('never touches Antigravity\'s files: no log, no lock file, nothing rewritten', async () => {
    const src = new AntigravitySource(() => antigravityRoots(home));
    await src.list({ limit: 50 });
    await src.read(A, { limit: 50 });
    await src.read(OLD, { limit: 50 });
    expect(snapshot()).toEqual(before);
  });

  it('is listed as readable on this computer', async () => {
    const found = await scanLocalHistory({}, Date.now(), home);
    expect(found.find((x) => x.id === 'antigravity')).toMatchObject({ name: 'Antigravity', readable: true, path: path.join(cur, 'conversations') });
  });
});

describe('Antigravity mapping helpers', () => {
  it('maps its tools to the cards the app draws, keeps the rest as they are', () => {
    expect(mapTool('view_file', JSON.stringify({ AbsolutePath: '/a/b.ts', toolAction: 'x', toolSummary: 'y' }))).toEqual({ name: 'Read', input: { file_path: '/a/b.ts' } });
    expect(mapTool('grep_search', JSON.stringify({ Query: 'foo', SearchPath: '/a', Includes: ['*.ts', '*.tsx'], CaseInsensitive: true }))).toEqual({ name: 'Grep', input: { pattern: 'foo', path: '/a', glob: '*.ts,*.tsx', '-i': true } });
    expect(mapTool('replace_file_content', JSON.stringify({ TargetFile: '/a', TargetContent: 'x', ReplacementContent: 'y' }))).toEqual({ name: 'Edit', input: { file_path: '/a', old_string: 'x', new_string: 'y' } });
    expect(mapTool('multi_replace_file_content', JSON.stringify({ TargetFile: '/a', ReplacementChunks: JSON.stringify([{ TargetContent: 'x', ReplacementContent: 'y' }]) })).input).toEqual({ file_path: '/a', edits: [{ old_string: 'x', new_string: 'y' }] });
    expect(mapTool('write_to_file', JSON.stringify({ TargetFile: '/a', CodeContent: 'z' }))).toEqual({ name: 'Write', input: { file_path: '/a', content: 'z' } });
    expect(mapTool('search_web', '{"query":"q"}')).toEqual({ name: 'WebSearch', input: { query: 'q' } });
    expect(mapTool('read_url_content', '{"Url":"https://x"}')).toEqual({ name: 'WebFetch', input: { url: 'https://x' } });
    expect(mapTool('manage_task', JSON.stringify({ Action: 'list', toolSummary: 's' }))).toEqual({ name: 'manage_task', input: { Action: 'list' } });
    expect(mapTool('odd', 'not json')).toEqual({ name: 'odd', input: { arguments: 'not json' } });
  });

  it('reads its times and folders', () => {
    expect(parseTime('2026-05-20 11:27:17.7348638+00:00')).toBe(Date.UTC(2026, 4, 20, 11, 27, 17, 734));
    expect(parseTime('')).toBeUndefined();
    expect(parseTime('garbage')).toBeUndefined();
    expect(uriToPath(URI)).toBe(CWD);
    expect(uriToPath('https://x')).toBeUndefined();
    expect(uriToPath(undefined)).toBeUndefined();
  });

  it('skips steps it cannot parse', () => {
    expect(stepsToMessages([{ idx: 0, step_type: 14, step_payload: Uint8Array.from([0xff, 0xff]) }, { idx: 1, step_type: 14, step_payload: null }], 's')).toEqual([]);
  });

  it('splits the search rows by their byte offsets (multi-byte text too)', () => {
    const rows = [{ uo: Buffer.from('[[0,0],[3,6]]'), ao: '[[1,0]]', user_body: '你好再见', agent_body: 'hi' }];
    expect(searchRowsToMessages(rows, 's').map((m) => [m.type, m.message.content[0].text])).toEqual([['user', '你好'], ['assistant', 'hi'], ['user', '再见']]);
  });
});
