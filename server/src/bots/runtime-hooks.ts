// server/src/bots/runtime-hooks.ts
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

/**
 * What a bot's main conversation (OpenSessionParams.botRole 'thread') gets from the bots side when its process starts:
 * the in-process server of the bot's own tools, and the section of the system prompt that says who it is. A registry
 * (like setSessionsDeps) so the runner doesn't import the bots service; a respawn asks again.
 */
export interface BotRuntime {
  selfServer(botId: string, self: () => string): McpServerConfig;
  /** `tools`: the conversation has the bot-self tools (a 只聊天 / lean-tools one has none: the prompt must not promise them) */
  threadPrompt(botId: string, o?: { tools: boolean }): string;
}

/** the bot-self MCP server's name: its tools are `mcp__cw-bot__*`, which the policy gate lets through (audited) */
export const BOT_SELF_SERVER = 'cw-bot';

let current: BotRuntime | null = null;
export function setBotRuntime(r: BotRuntime | null): void { current = r; }
export function botRuntime(): BotRuntime | null { return current; }
