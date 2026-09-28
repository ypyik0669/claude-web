// Minimal ACP agent used by tests: echoes prompts, runs one fake tool call with a permission request.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// So a test can prove a process it thought it killed is actually dead (AcpListSource's
// close()-during-in-flight-initialize race). Written immediately at startup, before initialize even
// arrives, matching how the real agent process exists the moment it's spawned.
if (process.env.MOCK_ACP_PIDFILE) fs.writeFileSync(process.env.MOCK_ACP_PIDFILE, String(process.pid));

const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let nextId = 100;
let lastMcp = [];
let sessionCwd = process.cwd();
const pending = new Map();
const req = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); });
const update = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });

rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) { pending.get(m.id)?.(m.result); pending.delete(m.id); return; }
  const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': {
      const agentCapabilities = process.env.MOCK_ACP_LIST === '1'
        ? { loadSession: false, sessionCapabilities: { list: {} } }
        : { loadSession: false };
      // MOCK_ACP_INIT_DELAY_MS (default 0, so every other test is unaffected) lets a test race
      // close() against an in-flight initialize.
      const delay = Number(process.env.MOCK_ACP_INIT_DELAY_MS ?? '0');
      setTimeout(() => reply({ protocolVersion: 1, agentCapabilities, agentInfo: { name: 'mock-acp', version: '0.0.1' } }), delay);
      break;
    }
    case 'session/list': {
      if (process.env.MOCK_ACP_LIST_FAIL === '1') { send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'mock session/list failure' } }); break; }
      // Only reachable when MOCK_ACP_LIST=1 advertised the capability above; two fixed sessions.
      reply({
        sessions: [
          { sessionId: 's1', cwd: '/work/one', title: 'Session One', updatedAt: '2026-01-01T00:00:00.000Z' },
          { sessionId: 's2', cwd: '/work/two', title: 'Session Two', updatedAt: 1780000000000 },
        ],
      });
      break;
    }
    case 'session/new': {
      const servers = m.params.mcpServers ?? [];
      // MOCK_REJECT_MCP simulates an agent that cannot take inline MCP servers, so the client's
      // retry-without-them path gets exercised
      if (process.env.MOCK_REJECT_MCP && servers.length) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'mcpServers unsupported' } }); break; }
      lastMcp = servers;
      sessionCwd = m.params.cwd ?? sessionCwd;
      reply({ sessionId: 'acp-sess-1' });
      update('acp-sess-1', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'mock help' }] });
      break;
    }
    case 'session/prompt': {
      const sid = m.params.sessionId;
      const text = m.params.prompt.map((p) => p.text ?? '').join('');
      update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it' } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Echo: ' } });
      update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      if (text.includes('tool')) {
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read package.json', kind: 'read', status: 'pending', locations: [{ path: 'C:/x/package.json' }] });
        const perm = await req('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'call-1', title: 'Read package.json', kind: 'read' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
        const allowed = perm?.outcome?.optionId === 'allow';
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? '{"name":"x"}' : 'denied' } }] });
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? ' (read ok)' : ' (denied)' } });
      }
      if (text.includes('mcp')) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` [mcp: ${lastMcp.map((s) => s.name).join(',') || 'none'}]` } });
      // 'slow' keeps a tool call running so the UI's mid-turn states can be looked at
      if (text.includes('slow')) {
        update(sid, { sessionUpdate: 'tool_call', toolCallId: 'slow-1', title: 'npm test -w server', kind: 'execute', status: 'in_progress' });
        await new Promise((r) => setTimeout(r, Number(process.env.MOCK_SLOW_MS ?? 25000)));
        update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'slow-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '61 passed' } }] });
      }
      // 'WRITE:<file>' writes <file> in the session cwd (content = MOCK_ACP_TAG) so orchestration e2e has a diff to merge
      for (const w of text.matchAll(/WRITE:([\w.-]+)/g)) fs.writeFileSync(path.join(sessionCwd, w[1]), `${process.env.MOCK_ACP_TAG ?? 'mock'}\n`);
      if (text.includes('plan')) update(sid, { sessionUpdate: 'plan', entries: [{ content: 'step one', status: 'completed', priority: 'high' }, { content: 'step two', status: 'in_progress', priority: 'medium' }] });
      reply({ stopReason: 'end_turn' });
      break;
    }
    case 'session/cancel': break;
    case 'session/set_model': reply(null); break;
    default: if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } });
  }
});
