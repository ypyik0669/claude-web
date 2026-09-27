// Minimal `codex app-server` stand-in for tests: thread/start, turn/start with a command approval, token usage,
// plus the library-facing thread/* endpoints (thread/list, thread/turns/list, rename/archive/delete/fork).
import fs from 'node:fs';
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let nextId = 500;
const pending = new Map();
const req = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

// Bumped once per `initialize` call — read back via `debug/initCount` so tests can tell whether
// LazyRpc actually spawned a fresh process after an idle kill. Each spawn is a brand-new Node
// process (its own in-memory counter would always read back 1), so when CW_INIT_COUNT_FILE is set
// the counter is persisted there instead, and survives across respawns of the mock.
let initCount = 0;
const countFile = process.env.CW_INIT_COUNT_FILE;
function bumpInitCount() {
  if (!countFile) return ++initCount;
  let n = 0;
  try { n = parseInt(fs.readFileSync(countFile, 'utf8'), 10) || 0; } catch { /* first run */ }
  n++;
  fs.writeFileSync(countFile, String(n));
  return n;
}
function readInitCount() {
  if (!countFile) return initCount;
  try { return parseInt(fs.readFileSync(countFile, 'utf8'), 10) || 0; } catch { return 0; }
}

// A page of turns for the long thread, generated rather than written out as a literal.
function makeTurns(threadId, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `turn-${threadId}-${i}`,
      status: 'completed',
      error: null,
      items: [
        { type: 'userMessage', id: `um-${threadId}-${i}`, content: [{ type: 'text', text: `msg ${i}` }] },
        { type: 'agentMessage', id: `am-${threadId}-${i}`, text: `reply ${i}` },
      ],
    });
  }
  return out;
}

const nowSec = Math.floor(Date.now() / 1000);
// 4 threads: 'thr-a' (a few turns), 'thr-b' (250 turns, for read pagination), 'thr-c' (a subAgent
// thread — real Codex v2 shape `{subAgent:{thread_spawn:{parent_thread_id}}}`, not a bare string; its
// parentThreadId is null, as the real app-server returns it under `modelProviders: []` — the parent
// is only in the source object), 'thr-d' (a custom-tool thread, `{custom:'my-tool'}`, oldest so existing pagination
// assertions on thr-a/b/c stay unaffected and only the tail page grows).
const threads = new Map([
  ['thr-a', { id: 'thr-a', name: null, preview: 'first thread preview text', cwd: 'C:/proj', createdAt: nowSec - 300, updatedAt: nowSec - 100, source: 'cli', parentThreadId: null, gitInfo: { branch: 'main' }, archived: false, turns: makeTurns('thr-a', 3) }],
  ['thr-b', { id: 'thr-b', name: null, preview: 'second thread, long history', cwd: 'C:/proj', createdAt: nowSec - 200, updatedAt: nowSec - 50, source: 'cli', parentThreadId: null, gitInfo: { branch: 'dev' }, archived: false, turns: makeTurns('thr-b', 250) }],
  ['thr-c', { id: 'thr-c', name: null, preview: 'sub agent thread', cwd: 'C:/proj', createdAt: nowSec - 90, updatedAt: nowSec - 10, source: { subAgent: { thread_spawn: { parent_thread_id: 'thr-a', depth: 1, agent_path: null, agent_nickname: 'Mock', agent_role: 'worker' } } }, parentThreadId: null, gitInfo: {}, archived: false, turns: makeTurns('thr-c', 1) }],
  ['thr-d', { id: 'thr-d', name: null, preview: 'custom tool thread', cwd: 'C:/proj', createdAt: nowSec - 400, updatedAt: nowSec - 150, source: { custom: 'my-tool' }, parentThreadId: null, gitInfo: {}, archived: false, modelProvider: 'other-relay', turns: makeTurns('thr-d', 1) }],
]);
let forkSeq = 0;

function threadSummary(t) {
  return { id: t.id, name: t.name, preview: t.preview, cwd: t.cwd, createdAt: t.createdAt, updatedAt: t.updatedAt, source: t.source, parentThreadId: t.parentThreadId, gitInfo: t.gitInfo };
}

rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) { pending.get(m.id)?.(m.result); pending.delete(m.id); return; }
  // CW_MOCK_RPC_LOG: append every incoming request (method + params) so an e2e check can see what the
  // server actually sent (e.g. which threadId thread/resume carried).
  if (process.env.CW_MOCK_RPC_LOG) { try { fs.appendFileSync(process.env.CW_MOCK_RPC_LOG, JSON.stringify({ method: m.method, params: m.params }) + '\n'); } catch { /* best effort */ } }
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize': bumpInitCount(); reply({ userAgent: 'mock-codex', codexHome: 'x' }); break;
    case 'initialized': break;
    case 'debug/initCount': reply({ count: readInitCount() }); break;
    case 'thread/list': {
      if (process.env.CW_FAIL_LIST === '1') { fail(-32000, 'mock thread/list failure'); break; }
      const { limit = 20, cursor, archived = false, sortDirection = 'desc' } = m.params ?? {};
      // real app-server: modelProviders omitted → only the *current* provider's threads; [] → every provider
      // (thr-d was recorded under another provider, so a client that forgets `modelProviders: []` misses it)
      const providers = m.params?.modelProviders;
      let list = [...threads.values()].filter((t) => !!t.archived === !!archived)
        .filter((t) => (Array.isArray(providers) ? providers.length === 0 || providers.includes(t.modelProvider ?? 'openai') : (t.modelProvider ?? 'openai') === 'openai'));
      list.sort((a, b) => (sortDirection === 'desc' ? b.updatedAt - a.updatedAt : a.updatedAt - b.updatedAt));
      let start = 0;
      if (cursor) { const idx = list.findIndex((t) => t.id === cursor); start = idx >= 0 ? idx + 1 : 0; }
      const page = list.slice(start, start + limit);
      const nextCursor = start + limit < list.length ? page[page.length - 1].id : null;
      reply({ data: page.map(threadSummary), nextCursor, backwardsCursor: null });
      break;
    }
    case 'thread/turns/list': {
      if (process.env.CW_FAIL_LIST === '1') { fail(-32000, 'mock thread/turns/list failure'); break; }
      const { threadId, limit = 20, cursor, sortDirection = 'desc' } = m.params ?? {};
      const t = threads.get(threadId);
      if (!t) { fail(-32000, `unknown thread ${threadId}`); break; }
      let list = sortDirection === 'desc' ? t.turns.slice().reverse() : t.turns.slice();
      let start = 0;
      if (cursor) { const idx = list.findIndex((tn) => tn.id === cursor); start = idx >= 0 ? idx + 1 : 0; }
      const page = list.slice(start, start + limit);
      const nextCursor = start + limit < list.length ? page[page.length - 1].id : null;
      reply({ data: page, nextCursor, backwardsCursor: null });
      break;
    }
    case 'thread/name/set': { const t = threads.get(m.params?.threadId); if (!t) { fail(-32000, 'not found'); break; } t.name = m.params.name; reply({}); break; }
    case 'thread/archive': { const t = threads.get(m.params?.threadId); if (!t) { fail(-32000, 'not found'); break; } t.archived = true; reply({}); break; }
    case 'thread/unarchive': { const t = threads.get(m.params?.threadId); if (!t) { fail(-32000, 'not found'); break; } t.archived = false; reply({}); break; }
    case 'thread/delete': { threads.delete(m.params?.threadId); reply({}); break; }
    case 'thread/fork': {
      const src = threads.get(m.params?.threadId);
      if (!src) { fail(-32000, 'not found'); break; }
      const id = `thr-fork-${++forkSeq}`;
      const nowS = Math.floor(Date.now() / 1000);
      threads.set(id, { id, name: null, preview: src.preview, cwd: src.cwd, createdAt: nowS, updatedAt: nowS, source: src.source, parentThreadId: src.id, gitInfo: src.gitInfo, archived: false, turns: m.params?.excludeTurns ? [] : src.turns.slice() });
      reply({ thread: { id } });
      break;
    }
    case 'thread/start': reply({ thread: { id: 'thr-1', sessionId: 'thr-1', preview: '' }, model: 'gpt-5-codex', modelProvider: 'openai', cwd: m.params.cwd, approvalPolicy: m.params.approvalPolicy ?? 'untrusted', sandbox: {}, reasoningEffort: null }); break;
    case 'thread/resume': reply({ thread: { id: m.params.threadId }, model: 'gpt-5-codex' }); break;
    case 'model/list': reply({ data: [{ id: 'gpt-5-codex', model: 'gpt-5-codex', displayName: 'GPT-5 Codex', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], isDefault: true }], nextCursor: null }); break;
    case 'turn/start': {
      const threadId = m.params.threadId;
      const text = m.params.input.map((i) => i.text ?? '').join('');
      reply({ turn: { id: 'turn-1', items: [], status: 'inProgress' } });
      notify('turn/started', { threadId, turn: { id: 'turn-1' } });
      notify('item/started', { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'am-1', text: '' } });
      notify('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'am-1', delta: `Codex says: ${text}` });
      if (text.includes('run')) {
        notify('item/started', { threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command: 'echo hi', cwd: 'C:/x', status: 'inProgress', commandActions: [] } });
        const a = await req('item/commandExecution/requestApproval', { threadId, turnId: 'turn-1', itemId: 'cmd-1', command: 'echo hi', cwd: 'C:/x' });
        const ok = a?.decision === 'accept' || a?.decision === 'acceptForSession';
        notify('item/commandExecution/outputDelta', { threadId, turnId: 'turn-1', itemId: 'cmd-1', delta: ok ? 'hi\n' : '' });
        notify('item/completed', { threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command: 'echo hi', cwd: 'C:/x', status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'hi\n' : '', exitCode: ok ? 0 : 1, commandActions: [] } });
      }
      notify('thread/tokenUsage/updated', { threadId, turnId: 'turn-1', tokenUsage: { total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 }, last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 }, modelContextWindow: 200000 } });
      notify('item/completed', { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'am-1', text: `Codex says: ${text}` } });
      notify('turn/completed', { threadId, turn: { id: 'turn-1', items: [], status: 'completed', error: null } });
      break;
    }
    case 'turn/interrupt': reply({}); break;
    default: if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
