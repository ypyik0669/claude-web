// server/src/bots/runtime-hooks.ts
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/**
 * What a bot's main conversation (OpenSessionParams.botRole 'thread') gets from the bots side when its process starts:
 * the in-process server of the bot's own tools, and the section of the system prompt that says who it is. A registry
 * (like setSessionsDeps) so the runner doesn't import the bots service; a respawn asks again.
 */
export interface BotRuntime {
  /** this install's bot-self server name (selfServerName): the key the runner loads selfServer under */
  serverName: string;
  selfServer(botId: string, self: () => string): McpServerConfig;
  /** `tools`: the conversation has the bot-self tools (a 只聊天 / lean-tools one has none: the prompt must not promise them) */
  threadPrompt(botId: string, o?: { tools: boolean }): string;
}

/**
 * The bot-self MCP server's name: `cw-bot-<hex>`, made once per install and kept in the bots dir (selfServerName), so
 * a server in a project's or the user's MCP config can't take its name — the thread's gate lets exactly
 * `mcp__<that name>__<tool>` through, and only when the runner loaded the built-in server under it.
 */
export const BOT_SELF_PREFIX = 'cw-bot';
const SERVER_NAME = /^cw-bot-[0-9a-f]{12}$/;
/** the tools self-mcp.ts registers (re-exported there) */
export const BOT_SELF_TOOL_NAMES = ['bot_profile', 'routine_create', 'routine_update', 'routine_pause', 'routine_delete', 'routine_test', 'remember', 'propose_policy'] as const;
/** the names the model calls them by, on the server `server` */
export function selfToolNames(server: string): Set<string> { return new Set(BOT_SELF_TOOL_NAMES.map((n) => `mcp__${server}__${n}`)); }

/** this install's server name, from `<botsDir>/self-server.json` (made there the first time) */
export function selfServerName(botsDir: string): string {
  const file = path.join(botsDir, 'self-server.json');
  try {
    const n = JSON.parse(fs.readFileSync(file, 'utf8'))?.name;
    if (typeof n === 'string' && SERVER_NAME.test(n)) return n;
  } catch { /* none yet, or unreadable: a new one */ }
  const name = `${BOT_SELF_PREFIX}-${randomBytes(6).toString('hex')}`;
  fs.mkdirSync(botsDir, { recursive: true });
  // wx: two servers starting on one dir at once — the first one's name stands
  const text = `${JSON.stringify({ name })}\n`;
  try { fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); } catch {
    try { const n = JSON.parse(fs.readFileSync(file, 'utf8'))?.name; if (typeof n === 'string' && SERVER_NAME.test(n)) return n; } catch { /* below */ }
    fs.writeFileSync(file, text, { mode: 0o600 });
  }
  return name;
}

let current: BotRuntime | null = null;
export function setBotRuntime(r: BotRuntime | null): void { current = r; }
export function botRuntime(): BotRuntime | null { return current; }
