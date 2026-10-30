import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

/**
 * How each agent is told about the memory MCP server.
 *
 * The rule this file exists to enforce: we never edit the user's own global agent config. Claude
 * gets it through the SDK's in-process `mcpServers` option, and the CLI agents get it as an extra
 * argument on the process WE spawn. If the user later uninstalls claude-web, nothing of ours is
 * left behind in ~/.claude, ~/.codex or ~/.gemini.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

let enabled = true;
/** Config centre switch (`memory.mcp`). Off = no agent is told about the store at all. */
export function setMemoryMcpEnabled(on: boolean) { enabled = on; }
export function memoryMcpEnabled() { return enabled; }

/**
 * The key our server is handed to every agent under (tools show up as `mcp__claude-web-memory__memory_search`).
 * Not `memory`: that is the name the official `@modelcontextprotocol/server-memory` connector is installed under
 * (our own connector catalog included), and a server passed by the host replaces the user's server of the same
 * name — Claude via SDK `mcpServers`, Codex via `-c mcp_servers.<name>.*` (worse: field-by-field merge into theirs),
 * ACP via `session/new`. So a user who added that connector saw it "connected" in settings and silently got ours
 * in every conversation. A name nobody else uses is the smallest fix: no reading of each agent's config to detect
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
  /** a bot's run (值班 Bot): its own `bot` memory scope, keyed by the bot id */
  botId?: string;
}

/** argv for spawning the memory MCP server for one session. */
export function memoryMcpArgs(t: MemoryMcpTarget): string[] {
  const args = [mcpEntry(), '--cwd', t.cwd];
  if (t.sessionId) args.push('--session', t.sessionId);
  if (t.agent) args.push('--agent', t.agent);
  if (t.dbFile) args.push('--db', t.dbFile);
  if (t.botId) args.push('--bot', t.botId);
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

/** `--mcp-config` style JSON for CLI agents that accept an inline server map. */
export function inlineMcpConfig(t: MemoryMcpTarget, execPath = process.execPath): string {
  return JSON.stringify({ mcpServers: claudeMcpServer(t, execPath) });
}

/**
 * ACP's `session/new` / `session/load` take the server list inline (Gemini CLI, Qwen, Zed agents),
 * with env as name/value pairs rather than a map.
 */
export function acpMcpServers(t: MemoryMcpTarget, execPath = process.execPath) {
  if (!enabled) return [];
  const { command, args, env } = spawnShape(t, execPath);
  return [{ name: MEMORY_MCP_NAME, command, args, env: Object.entries(env).map(([name, value]) => ({ name, value })) }];
}

/**
 * Codex reads MCP servers from `~/.codex/config.toml`, which is the user's file — so instead we pass
 * `-c mcp_servers.claude-web-memory.*` overrides to the process we spawn. Values are parsed as TOML, hence the
 * JSON quoting (a bare Windows path would fail to parse and fall back to a literal).
 * The flags must come before the `app-server` subcommand.
 */
export function codexConfigArgs(t: MemoryMcpTarget, execPath = process.execPath): string[] {
  if (!enabled) return [];
  const { command, args, env } = spawnShape(t, execPath);
  const inlineEnv = `{${Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}}`;
  // `claude-web-memory` is a valid TOML bare key (letters, digits, `-`, `_`), so the dotted path needs no quoting.
  const key = `mcp_servers.${MEMORY_MCP_NAME}`;
  return [
    '-c', `${key}.command=${JSON.stringify(command)}`,
    '-c', `${key}.args=${JSON.stringify(args)}`,
    '-c', `${key}.env=${inlineEnv}`,
  ];
}

/**
 * Splice the overrides into a Codex argv. They are global flags, so they go in front of the
 * `app-server` subcommand — and an argv without one is left alone, so a custom command standing in
 * for Codex (or a test double) runs exactly as configured.
 */
export function insertCodexConfig(args: string[], t: MemoryMcpTarget, execPath = process.execPath): string[] {
  const at = args.indexOf('app-server');
  if (at < 0) return args;
  return [...args.slice(0, at), ...codexConfigArgs(t, execPath), ...args.slice(at)];
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
