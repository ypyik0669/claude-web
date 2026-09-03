// Minimal `codex app-server` stand-in for tests: thread/start, turn/start with a command approval, token usage.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let nextId = 500;
const pending = new Map();
const req = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) { pending.get(m.id)?.(m.result); pending.delete(m.id); return; }
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': reply({ userAgent: 'mock-codex', codexHome: 'x' }); break;
    case 'initialized': break;
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
