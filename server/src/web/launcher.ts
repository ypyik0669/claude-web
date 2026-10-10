import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../files/service.js';

/**
 * How each agent is told about the `web` MCP server (web search + the built-in browser) — the same three ways as the
 * shared memory (memory/launcher.ts), and by the same rule: nothing is written into the user's own agent config.
 * Claude gets it through the SDK's `mcpServers`, ACP agents inline at session/new, Codex as `-c mcp_servers.web.*`
 * in front of `app-server`.
 *
 * The MCP process reaches this server at CW_WEB_URL with the per-start secret. The secret is handed over as a FILE
 * (CW_WEB_TOKEN_FILE): the SDK puts `mcpServers` on the CLI's command line (`--mcp-config {json}`) and Codex's
 * overrides are command-line arguments too, and command lines are readable by other users' `ps` on macOS / Linux.
 * Nothing is handed out before `configureWebMcp` (the server is listening) or while the switch `web.mcp` is off.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The tool an agent may use without being asked each time (spec §5.3): searching reads, it changes nothing. */
export const WEB_SEARCH_TOOL = 'mcp__web__web_search';

let enabled = true;
/** Settings switch (`web.mcp`). Off = no agent is told about the server; running conversations keep theirs. */
export function setWebMcpEnabled(on: boolean) { enabled = on; }
export function webMcpEnabled() { return enabled; }

interface Endpoint { url: string; token: string; tokenFile?: string }
let endpoint: Endpoint | null = null;

export function webTokenDir(): string {
  return path.join(dataDir(), 'runtime', 'web-mcp');
}

/**
 * Called once the main listener has its port: where the MCP processes find this server and what they present.
 * Writes the secret to `<dataDir>/runtime/web-mcp/<server pid>.token` (0600 in a 0700 folder; files of servers that
 * are gone are swept); when that cannot be written the secret goes inline (CW_WEB_TOKEN) and a line says so.
 * Null: stop handing the server out (shutdown), and remove the file.
 */
export function configureWebMcp(e: { url: string; token: string } | null, dir = webTokenDir()): void {
  if (endpoint?.tokenFile) { try { fs.rmSync(endpoint.tokenFile, { force: true }); } catch { /* swept by the next server */ } }
  endpoint = null;
  if (!e) return;
  let tokenFile: string | undefined;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweepWebTokens(dir);
    tokenFile = path.join(dir, `${process.pid}.token`);
    fs.writeFileSync(tokenFile, e.token, { mode: 0o600 });
  } catch (err) {
    tokenFile = undefined;
    console.warn(`[web] could not write the MCP secret file (it is passed inline instead): ${(err as Error).message}`);
  }
  endpoint = { url: e.url, token: e.token, tokenFile };
}

/** Remove the secret files of servers that are no longer running (two servers may share the data folder). */
export function sweepWebTokens(dir = webTokenDir()): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const pid = Number(/^(\d+)\.token$/.exec(n)?.[1]);
    if (!pid || pid === process.pid || alive(pid)) continue;
    try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* still held */ }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // exists, someone else's
  }
}

/** Path to the compiled MCP entry, whether we're running from src (tsx) or dist. */
export function webMcpEntry(): string {
  const compiled = path.join(here, 'mcp.js');
  if (fs.existsSync(compiled)) return compiled;
  const src = path.join(here, 'mcp.ts');
  return fs.existsSync(src) ? src : compiled;
}

/**
 * Running from source (`npm start` / `npm run dev`): the entry is TypeScript and needs tsx. The agent starts the MCP
 * process in the project's folder, where a bare `--import tsx` does not resolve — so the loader goes by its address.
 */
function tsxLoader(): string {
  try { return import.meta.resolve('tsx'); } catch { return 'tsx'; }
}

export interface WebMcpTarget { sessionId?: string }

/** One place that knows how to start the stdio server, whatever is doing the starting. Null: not to be handed out. */
function spawnShape(t: WebMcpTarget, execPath: string): { command: string; args: string[]; env: Record<string, string> } | null {
  if (!enabled || !endpoint) return null;
  const entry = webMcpEntry();
  return {
    command: execPath,
    args: entry.endsWith('.ts') ? ['--import', tsxLoader(), entry] : [entry],
    env: {
      // process.execPath is the Electron binary in a packaged build; the same trick `spawnClaude` uses
      ELECTRON_RUN_AS_NODE: '1',
      CW_WEB_URL: endpoint.url,
      ...(endpoint.tokenFile ? { CW_WEB_TOKEN_FILE: endpoint.tokenFile } : { CW_WEB_TOKEN: endpoint.token }),
      CW_SESSION_ID: t.sessionId ?? '',
    },
  };
}

type StdioServer = { type: 'stdio'; command: string; args: string[]; env: Record<string, string> };

/** The `mcpServers` entry for the Agent SDK (Claude); merged with the memory one by the runner. */
export function webClaudeMcpServer(t: WebMcpTarget, execPath = process.execPath): Record<string, StdioServer> {
  const s = spawnShape(t, execPath);
  return s ? { web: { type: 'stdio', ...s } } : {};
}

/** Tools Claude runs without asking, as `allowedTools`: the search, only while the server is handed out. */
export function webAllowedTools(): string[] {
  return enabled && endpoint ? [WEB_SEARCH_TOOL] : [];
}

/** ACP `session/new` / `session/load` take the list inline, env as name/value pairs. */
export function webAcpMcpServers(t: WebMcpTarget, execPath = process.execPath) {
  const s = spawnShape(t, execPath);
  return s ? [{ name: 'web', command: s.command, args: s.args, env: Object.entries(s.env).map(([name, value]) => ({ name, value })) }] : [];
}

/**
 * Codex: `-c mcp_servers.web.*` overrides on the process we spawn (never ~/.codex/config.toml). The values are parsed
 * as TOML, hence the JSON quoting (a bare Windows path would not parse).
 */
export function webCodexConfigArgs(t: WebMcpTarget, execPath = process.execPath): string[] {
  const s = spawnShape(t, execPath);
  if (!s) return [];
  const inlineEnv = `{${Object.entries(s.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')}}`;
  return [
    '-c', `mcp_servers.web.command=${JSON.stringify(s.command)}`,
    '-c', `mcp_servers.web.args=${JSON.stringify(s.args)}`,
    '-c', `mcp_servers.web.env=${inlineEnv}`,
  ];
}

/** Splice the overrides in front of the `app-server` subcommand; an argv without one (a stand-in command) is left alone. */
export function insertWebCodexConfig(args: string[], t: WebMcpTarget, execPath = process.execPath): string[] {
  const at = args.indexOf('app-server');
  if (at < 0) return args;
  return [...args.slice(0, at), ...webCodexConfigArgs(t, execPath), ...args.slice(at)];
}
