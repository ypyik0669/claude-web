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
import { MemoryService, type MemoryKind, type MemoryScope } from './service.js';

const argOf = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'memory_search',
    description:
      'Search the shared cross-agent memory for this project. Call this BEFORE starting non-trivial work: it holds decisions already made, constraints to respect, and dead ends other agents already hit. Returns the most relevant entries, pinned first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text. Omit to list the most relevant recent memories.' },
        kind: { type: 'string', enum: ['decision', 'constraint', 'fact', 'deadend', 'preference', 'note'] },
        limit: { type: 'number', description: 'Max results (default 20).' },
      },
    },
  },
  {
    name: 'memory_write',
    description:
      'Record something worth remembering across sessions and across agents: a decision and its reason, a constraint, a non-obvious fact about this codebase, or an approach that was tried and failed. Do NOT record what the code or git history already says. Near-identical text is de-duplicated.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One fact, stated so it is useful months later. Include the why.' },
        kind: { type: 'string', enum: ['decision', 'constraint', 'fact', 'deadend', 'preference', 'note'], description: 'Default: note.' },
        scope: { type: 'string', enum: ['global', 'project', 'session'], description: 'Default: project. Use global only for things true everywhere.' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_list',
    description: 'List stored memories for this project without searching (newest and pinned first).',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['global', 'project', 'session'] }, limit: { type: 'number' } } },
  },
];

function main() {
  const cwd = argOf('cwd') ?? process.cwd();
  const sessionId = argOf('session');
  const agent = argOf('agent');
  const mem = new MemoryService(argOf('db'));

  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const ok = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, message: string) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });
  const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

  const call = (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case 'memory_search': {
        const rows = mem.search({ q: args.query as string | undefined, cwd, sessionId, kind: args.kind as MemoryKind | undefined, limit: (args.limit as number) ?? 20 });
        if (!rows.length) return text('（这个项目还没有相关记忆）');
        return text(rows.map((m) => `- [${m.kind}] ${m.text}${m.tags.length ? `  (${m.tags.join(', ')})` : ''}`).join('\n'));
      }
      case 'memory_write': {
        const m = mem.write({
          text: String(args.text ?? ''),
          kind: args.kind as MemoryKind | undefined,
          scope: (args.scope as MemoryScope | undefined) ?? 'project',
          key: (args.scope ?? 'project') === 'session' ? sessionId ?? '' : cwd,
          tags: (args.tags as string[] | undefined) ?? [],
          sourceSession: sessionId,
          sourceAgent: agent,
        });
        return text(`已记住（${m.kind} · ${m.scope}）`);
      }
      case 'memory_list': {
        const rows = mem.search({ scope: args.scope as MemoryScope | undefined, cwd, sessionId, limit: (args.limit as number) ?? 50 });
        return text(rows.length ? rows.map((m) => `- [${m.kind}] ${m.text}`).join('\n') : '（空）');
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  };

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
            ok(msg.id, { tools: TOOLS });
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
