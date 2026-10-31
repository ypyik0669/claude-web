// The memory MCP server's tools (mcp.ts speaks the JSON-RPC around them). A bot's run (值班 Bot) is started with
// `--bot <id>`: it gets a `bot` scope keyed by its id — the scope the pipeline reads back into the bot's prompt.
import type { MemoryKind, MemoryScope, MemoryService } from './service.js';

export interface MemoryToolContext { cwd: string; sessionId?: string; agent?: string; botId?: string }

const KINDS = ['decision', 'constraint', 'fact', 'deadend', 'preference', 'note'];

export function memoryTools(botId?: string) {
  // a bot writes only its own memory: anything wider would reach every other conversation's prompt (the gate asks
  // before any other scope — bots/policy/classify.ts)
  const writeScopes = botId ? ['bot'] : ['global', 'project', 'session'];
  const listScopes = botId ? ['global', 'project', 'session', 'bot'] : writeScopes;
  return [
    {
      name: 'memory_search',
      description:
        'Search the shared cross-agent memory for this project. Call this BEFORE starting non-trivial work: it holds decisions already made, constraints to respect, and dead ends other agents already hit. Returns the most relevant entries, pinned first.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free text. Omit to list the most relevant recent memories.' },
          kind: { type: 'string', enum: KINDS },
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
          kind: { type: 'string', enum: KINDS, description: 'Default: note.' },
          scope: {
            type: 'string',
            enum: writeScopes,
            description: botId ? 'Your own memory, shown to you at every run.' : 'Default: project. Use global only for things true everywhere.',
          },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['text'],
      },
    },
    {
      name: 'memory_list',
      description: 'List stored memories for this project without searching (newest and pinned first).',
      inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: listScopes }, limit: { type: 'number' } } },
    },
  ];
}

const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

export function memoryCall(mem: Pick<MemoryService, 'search' | 'write'>, c: MemoryToolContext, name: string, args: Record<string, unknown>) {
  const { cwd, sessionId, botId } = c;
  switch (name) {
    case 'memory_search': {
      const rows = mem.search({ q: args.query as string | undefined, cwd, sessionId, botId, kind: args.kind as MemoryKind | undefined, limit: (args.limit as number) ?? 20 });
      if (!rows.length) return text('（这个项目还没有相关记忆）');
      return text(rows.map((m) => `- [${m.kind}] ${m.text}${m.tags.length ? `  (${m.tags.join(', ')})` : ''}`).join('\n'));
    }
    case 'memory_write': {
      // a bot writes only its own memory, whatever scope the model names (the bots' policy gate counts on it)
      const scope = botId ? 'bot' : (args.scope as MemoryScope | undefined) ?? 'project';
      if (scope === 'bot' && !botId) throw new Error('scope bot is only for a bot\'s run');
      const m = mem.write({
        text: String(args.text ?? ''),
        kind: args.kind as MemoryKind | undefined,
        scope,
        key: scope === 'session' ? sessionId ?? '' : scope === 'bot' ? botId! : cwd,
        tags: (args.tags as string[] | undefined) ?? [],
        sourceSession: sessionId,
        sourceAgent: c.agent,
      });
      return text(`已记住（${m.kind} · ${m.scope}）`);
    }
    case 'memory_list': {
      const rows = mem.search({ scope: args.scope as MemoryScope | undefined, cwd, sessionId, botId, limit: (args.limit as number) ?? 50 });
      return text(rows.length ? rows.map((m) => `- [${m.kind}] ${m.text}`).join('\n') : '（空）');
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
