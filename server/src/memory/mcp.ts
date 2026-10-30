#!/usr/bin/env node
/**
 * The memory store as a stdio MCP server, so every agent reaches the same facts through its own
 * native tool mechanism — Claude via .mcp.json / SDK mcpServers, Codex via config.toml, Gemini and
 * Qwen via their settings. Nothing here is Claude-specific.
 *
 * Run standalone: `node server/dist/memory/mcp.js --cwd <project>` (the launcher below builds the
 * argv). Speaks bare JSON-RPC 2.0 over stdio — the protocol surface an MCP host needs is small
 * enough that pulling in the SDK would cost more than it saves, and this has to stay dependency-free
 * so it can be spawned from a packaged app.
 */
import { MemoryService } from './service.js';
import { memoryCall, memoryTools } from './mcp-tools.js';

const argOf = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const PROTOCOL_VERSION = '2025-06-18';

function main() {
  const cwd = argOf('cwd') ?? process.cwd();
  const sessionId = argOf('session');
  const agent = argOf('agent');
  const mem = new MemoryService(argOf('db'));

  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const ok = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, message: string) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
  const botId = argOf('bot');
  const tools = memoryTools(botId);
  const call = (name: string, args: Record<string, unknown>) => memoryCall(mem, { cwd, sessionId, agent, botId }, name, args);

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === undefined) continue; // a response to something we never send
      try {
        switch (msg.method) {
          case 'initialize':
            ok(msg.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'claude-web-memory', version: '1.0.0' } });
            break;
          case 'notifications/initialized':
            break;
          case 'tools/list':
            ok(msg.id, { tools });
            break;
          case 'tools/call':
            ok(msg.id, call(String(msg.params?.name), (msg.params?.arguments as Record<string, unknown>) ?? {}));
            break;
          case 'ping':
            ok(msg.id, {});
            break;
          default:
            if (msg.id !== undefined) fail(msg.id, `unknown method ${msg.method}`);
        }
      } catch (e) {
        if (msg.id !== undefined) fail(msg.id, (e as Error).message);
      }
    }
  });
  process.stdin.on('end', () => { mem.close(); process.exit(0); });
}

main();
