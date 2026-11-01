import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

/**
 * How Claude is told about the memory MCP server.
 *
 * The rule this file exists to enforce: we never edit the user's own global Claude config. Claude
 * gets it through the SDK's in-process `mcpServers` option, on the process WE spawn. If the user
 * later uninstalls claude-web, nothing of ours is left behind in ~/.claude.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

let enabled = true;
/** Config centre switch (`memory.mcp`). Off = no conversation is told about the store at all. */
export function setMemoryMcpEnabled(on: boolean) { enabled = on; }
export function memoryMcpEnabled() { return enabled; }

/**
 * The key our server is handed under (tools show up as `mcp__claude-web-memory__memory_search`).
 * Not `memory`: that is the name the official `@modelcontextprotocol/server-memory` connector is installed under
 * (our own connector catalog included), and a server passed through the SDK's `mcpServers` replaces the user's
 * server of the same name. So a user who added that connector saw it "connected" in settings and silently got ours
 * in every conversation. A name nobody else uses is the smallest fix: no reading of the user's config to detect
 * a clash, and nothing in the app keys on the server name (no allow-list, no tool-card registry entry).
 */
export const MEMORY_MCP_NAME = 'claude-web-memory';

/** Path to the compiled MCP entry, whether we're running from src (tsx) or dist. */
export function mcpEntry(): string {
  const compiled = path.join(here, 'mcp.js');
  if (fs.existsSync(compiled)) return compiled;
  const src = path.join(here, 'mcp.ts');
  return fs.existsSync(src) ? src : compiled;
}

export interface MemoryMcpTarget {
  cwd: string;
  sessionId?: string;
  agent?: string;
  dbFile?: string;
}

/** argv for spawning the memory MCP server for one session. */
export function memoryMcpArgs(t: MemoryMcpTarget): string[] {
  const args = [mcpEntry(), '--cwd', t.cwd];
  if (t.sessionId) args.push('--session', t.sessionId);
  if (t.agent) args.push('--agent', t.agent);
  if (t.dbFile) args.push('--db', t.dbFile);
  return args;
}

/**
 * The `mcpServers` entry to hand the Agent SDK (Claude) — a plain stdio server definition.
 * `command` is the node that is running us, so a packaged Electron build works via
 * ELECTRON_RUN_AS_NODE the same way `spawnClaude` already does.
 */
type StdioServer = { type: 'stdio'; command: string; args: string[]; env: Record<string, string> };
export function claudeMcpServer(t: MemoryMcpTarget, execPath = process.execPath): Record<string, StdioServer> {
  if (!enabled) return {};
  const { command, args, env } = spawnShape(t, execPath);
  return { [MEMORY_MCP_NAME]: { type: 'stdio', command, args, env } };
}

/** One place that knows how to start our stdio server, whatever is doing the starting. */
function spawnShape(t: MemoryMcpTarget, execPath: string) {
  const entry = mcpEntry();
  const useTsx = entry.endsWith('.ts');
  return {
    command: execPath,
    args: useTsx ? ['--import', 'tsx', ...memoryMcpArgs(t)] : memoryMcpArgs(t),
    // process.execPath is the Electron binary in a packaged build; the same trick `spawnClaude` uses.
    env: { ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>,
  };
}
