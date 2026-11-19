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

// Token usage the way Codex reports it: `inputTokens` includes the cached part, `total` is cumulative for the
// thread, `last` is only the latest model call. Each turn here makes two calls, and the second update is
// re-sent unchanged (Codex repeats the count with rate-limit refreshes). A resumed thread starts with
// earlier turns already in `total`. Per turn: input 50 (25 uncached), 23 cached, 2 cache-write, 14 out.
const bd = (input, cached, write, output) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: cached, cacheWriteInputTokens: write, outputTokens: output, reasoningOutputTokens: 0 });
const sum = (a, b) => bd(a.inputTokens + b.inputTokens, a.cachedInputTokens + b.cachedInputTokens, a.cacheWriteInputTokens + b.cacheWriteInputTokens, a.outputTokens + b.outputTokens);
let usageTotal = bd(0, 0, 0, 0);
const TURN_CALLS = [bd(20, 5, 0, 10), bd(30, 18, 2, 4)];

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
// MOCK_CODEX_DELETED=1: one more thread whose file on disk is gone (Codex's index still lists it) — like the real
// app-server, it reads as "thread not loaded"
if (process.env.MOCK_CODEX_DELETED === '1') threads.set('thr-x', { id: 'thr-x', name: '删掉的对话', preview: 'deleted', cwd: 'C:/proj', createdAt: nowSec - 30, updatedAt: nowSec - 5, source: 'cli', parentThreadId: null, gitInfo: {}, archived: false, path: 'C:/definitely/not/here/rollout-thr-x.jsonl', gone: true, turns: [] });
let forkSeq = 0;

function threadSummary(t) {
  return { id: t.id, name: t.name, preview: t.preview, cwd: t.cwd, createdAt: t.createdAt, updatedAt: t.updatedAt, source: t.source, parentThreadId: t.parentThreadId, gitInfo: t.gitInfo, path: t.path ?? null };
}

/** `-c key=value` overrides from argv (values are TOML: JSON-quoted strings) → the cwgw provider, when selected. */
function providerOverride() {
  const kv = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length - 1; i++) if (argv[i] === '-c') { const m = /^([^=]+)=(.*)$/.exec(argv[i + 1]); if (m) { try { kv[m[1]] = JSON.parse(m[2]); } catch { kv[m[1]] = m[2]; } } }
  if (kv.model_provider !== 'cwgw' || !kv['model_providers.cwgw.base_url']) return null;
  return { base: kv['model_providers.cwgw.base_url'], key: process.env[kv['model_providers.cwgw.env_key']] ?? '', model: kv.model ?? 'gpt-5-codex' };
}
async function askProvider(p, text) {
  const r = await fetch(`${p.base.replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: p.model, instructions: 'You are Codex.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }], tools: [{ type: 'custom', name: 'apply_patch', description: 'Edit files' }], stream: true, store: false, prompt_cache_key: 'mock-thread' }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${body.slice(0, 200)}`);
  let out = '';
  for (const block of body.split('\n\n')) {
    const data = block.split('\n').find((l) => l.startsWith('data: '));
    if (!data) continue;
    try { const e = JSON.parse(data.slice(6)); if (e.type === 'response.output_text.delta') out += e.delta; } catch { /* skip */ }
  }
  return out;
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
      // MOCK_CODEX_OLD=1: an app-server from before the paged read (0.130 answers exactly this)
      if (process.env.MOCK_CODEX_OLD === '1') { fail(-32600, 'thread/turns/list requires experimentalApi capability'); break; }
      // MOCK_CODEX_NO_PAGINATED=1: a Codex too old for the threads its desktop app now stores (user report 2026-10-16)
      if (process.env.MOCK_CODEX_NO_PAGINATED === '1') { fail(-32600, 'paginated_threads is not supported yet'); break; }
      const { threadId, limit = 20, cursor, sortDirection = 'desc' } = m.params ?? {};
      const t = threads.get(threadId);
      // the real app-server's answer for an id it has no stored history for (codex 0.158)
      if (!t || t.gone) { fail(-32600, `thread not loaded: ${threadId}`); break; }
      let list = sortDirection === 'desc' ? t.turns.slice().reverse() : t.turns.slice();
      let start = 0;
      if (cursor) { const idx = list.findIndex((tn) => tn.id === cursor); start = idx >= 0 ? idx + 1 : 0; }
      const page = list.slice(start, start + limit);
      const nextCursor = start + limit < list.length ? page[page.length - 1].id : null;
      reply({ data: page, nextCursor, backwardsCursor: null });
      break;
    }
    case 'thread/read': {
      const t = threads.get(m.params?.threadId);
      if (!t || t.gone) { fail(-32600, `thread not loaded: ${m.params?.threadId}`); break; }
      if (process.env.MOCK_CODEX_NO_PAGINATED === '1' && m.params?.includeTurns) { fail(-32600, 'paginated_threads is not supported yet'); break; }
      reply({ thread: { ...threadSummary(t), ...(m.params?.includeTurns ? { turns: t.turns } : {}) } });
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
    case 'thread/resume': usageTotal = bd(900_000, 800_000, 0, 5_000); reply({ thread: { id: m.params.threadId }, model: 'gpt-5-codex' }); break;
    case 'model/list': reply({ data: [{ id: 'gpt-5-codex', model: 'gpt-5-codex', displayName: 'GPT-5 Codex', description: '', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], isDefault: true }], nextCursor: null }); break;
    case 'turn/start': {
      const threadId = m.params.threadId;
      const text = m.params.input.map((i) => i.text ?? '').join('');
      reply({ turn: { id: 'turn-1', items: [], status: 'inProgress' } });
      notify('turn/started', { threadId, turn: { id: 'turn-1' } });
      notify('item/started', { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'am-1', text: '' } });
      // started with a `-c model_providers.cwgw…` override (a provider picked in claude-web): ask it, like the real
      // Codex does — POST <base_url>/responses with the key from env_key — and answer with what it streamed back
      const provider = providerOverride();
      if (provider && text.includes('relay')) {
        const said = await askProvider(provider, text).catch((e) => `provider error: ${e.message}`);
        notify('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'am-1', delta: said });
        notify('item/completed', { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'am-1', text: said } });
        notify('turn/completed', { threadId, turn: { id: 'turn-1', items: [], status: 'completed', error: null } });
        break;
      }
      notify('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'am-1', delta: `Codex says: ${text}` });
      if (text.includes('run')) {
        notify('item/started', { threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command: 'echo hi', cwd: 'C:/x', status: 'inProgress', commandActions: [] } });
        const a = await req('item/commandExecution/requestApproval', { threadId, turnId: 'turn-1', itemId: 'cmd-1', command: 'echo hi', cwd: 'C:/x' });
        const ok = a?.decision === 'accept' || a?.decision === 'acceptForSession';
        notify('item/commandExecution/outputDelta', { threadId, turnId: 'turn-1', itemId: 'cmd-1', delta: ok ? 'hi\n' : '' });
        notify('item/completed', { threadId, turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd-1', command: 'echo hi', cwd: 'C:/x', status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'hi\n' : '', exitCode: ok ? 0 : 1, commandActions: [] } });
      }
      // 'MCPTOOL:<variant>': Codex asks before an MCP tool call through `mcpServer/elicitation/request` with
      // `_meta.codex_approval_kind = mcp_tool_call` (codex-rs core/src/mcp_tool_call.rs, codex-cli 0.163); 'form' is an
      // MCP server's own question, not an approval. The answer comes back in the text: accept / decline / cancel / error.
      let extra = '';
      const mcpVariant = /MCPTOOL:(\w+)/.exec(text)?.[1];
      if (mcpVariant) {
        const script = { script: "await p.goto('https://mail.example/')" };
        const approval = (server, tool, params) => ({ threadId, turnId: 'turn-1', serverName: server, mode: 'form', message: `Allow the ${server} MCP server to run tool "${tool}"?`, requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: params, tool_params_display: Object.entries(params).map(([name, value]) => ({ name, value, display_name: name })) } });
        const shapes = {
          ego: approval('web', 'ego_browser', script),
          click: approval('web', 'browser_click', { selector: '#go' }),
          othersrv: approval('evil', 'ego_browser', script),
          extraarg: approval('web', 'ego_browser', { ...script, command: 'x' }),
          eval: approval('web', 'browser_eval', { script: 'return document.title' }),
          evalextra: approval('web', 'browser_eval', { script: 'return 1', timeout_ms: 5000 }),
          // the built-in browser's other tools with their own arguments; one with a key its schema lacks is not ours
          open: approval('web', 'browser_open', { url: 'https://new.example/' }),
          scroll: approval('web', 'browser_scroll', { direction: 'down' }),
          clickref: approval('web', 'browser_click', { ref: '1' }),
          openextra: approval('web', 'browser_open', { url: 'https://new.example/', command: 'x' }),
          form: { threadId, turnId: 'turn-1', serverName: 'web', mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }, _meta: null },
        };
        const a = await req('mcpServer/elicitation/request', shapes[mcpVariant] ?? shapes.ego);
        extra = ` (mcp answer: ${a?.action ?? 'error'}${a?._meta?.persist ? ` persist=${a._meta.persist}` : ''})`;
        notify('item/agentMessage/delta', { threadId, turnId: 'turn-1', itemId: 'am-1', delta: extra });
      }
      // 'COMPACTAUTO': Codex compacts the thread itself in the middle of the turn — the contextCompaction item, and the
      // deprecated thread/compacted notification some versions send beside it (codex-cli 0.163 sends both)
      if (text.includes('COMPACTAUTO')) {
        notify('item/started', { threadId, turnId: 'turn-1', item: { type: 'contextCompaction', id: 'cc-1' } });
        notify('item/completed', { threadId, turnId: 'turn-1', item: { type: 'contextCompaction', id: 'cc-1' } });
        notify('thread/compacted', { threadId, turnId: 'turn-1' });
      }
      // a sub-agent thread's usage arrives on the same connection: it is not this thread's turn
      notify('thread/tokenUsage/updated', { threadId: 'thr-subagent', turnId: 'turn-x', tokenUsage: { total: bd(777_000, 1, 0, 5), last: bd(777_000, 1, 0, 5), modelContextWindow: 200000 } });
      for (const call of TURN_CALLS) {
        usageTotal = sum(usageTotal, call);
        notify('thread/tokenUsage/updated', { threadId, turnId: 'turn-1', tokenUsage: { total: usageTotal, last: call, modelContextWindow: 200000 } });
      }
      notify('thread/tokenUsage/updated', { threadId, turnId: 'turn-1', tokenUsage: { total: usageTotal, last: TURN_CALLS[1], modelContextWindow: 200000 } });
      notify('item/completed', { threadId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'am-1', text: `Codex says: ${text}${extra}` } });
      notify('turn/completed', { threadId, turn: { id: 'turn-1', items: [], status: 'completed', error: null } });
      break;
    }
    case 'turn/interrupt': reply({}); break;
    // the user's /compact: answered at once, then run as a turn of its own (as codex-cli 0.163 does: turn/started, the
    // contextCompaction item, a token count whose last call is 0, turn/completed)
    case 'thread/compact/start': {
      const threadId = m.params.threadId;
      reply({});
      notify('turn/started', { threadId, turn: { id: 'turn-c' } });
      notify('item/started', { threadId, turnId: 'turn-c', item: { type: 'contextCompaction', id: 'cc-m' } });
      notify('item/completed', { threadId, turnId: 'turn-c', item: { type: 'contextCompaction', id: 'cc-m' } });
      notify('thread/tokenUsage/updated', { threadId, turnId: 'turn-c', tokenUsage: { total: usageTotal, last: bd(0, 0, 0, 0), modelContextWindow: 200000 } });
      notify('turn/completed', { threadId, turn: { id: 'turn-c', items: [], status: 'completed', error: null } });
      break;
    }
    default: if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
