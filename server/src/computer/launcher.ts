import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../files/service.js';
import { sweepWebTokens } from '../web/launcher.js';
import type { SessionFeatures } from '../protocol.js';
import { COMPUTER_SERVER } from './access.js';
import { TOOL_NAMES } from './tools.js';
import { agentDesktopSupported, ensureAgentDesktop } from './agent-desktop.js';
import { DESKTOP_SERVER, DESKTOP_TOOLS } from './desktop-mcp.js';

/**
 * How a Claude conversation with 「操控电脑」 on is handed the `computer` MCP server (computer/mcp.ts): through the
 * SDK's `mcpServers`, like the web and memory servers — nothing is written into the user's own config.
 *
 * The process asks this server before it grants anything (CW_COMPUTER_ASK_URL → POST /api/computer/ask → a card in
 * the app, computer/access.ts), presenting the per-start secret, handed over as a FILE for the reason given in
 * web/launcher.ts (the SDK puts `mcpServers` on the CLI's command line). Windows only; nothing is handed out before
 * `configureComputerMcp` (the server is listening).
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** Windows: the `computer` server (screenshots, mouse, keyboard) and `desktop` (agent-desktop's accessibility tree);
 *  macOS: `desktop` alone. */
export function computerSupported(platform: NodeJS.Platform = process.platform, arch: string = process.arch): boolean {
  return platform === 'win32' || agentDesktopSupported(platform, arch);
}
const classicSupported = (platform: NodeJS.Platform) => platform === 'win32';

/**
 * Capabilities a conversation gets when nobody chose any for it (the old `defaultFeatures` setting; conversations the
 * orchestrator, IM or a schedule open): never 操控电脑. It reaches the whole desktop, so it is switched on by the user,
 * for one conversation, in the + of that conversation's first message — not by a default.
 */
export function defaultFeaturesOf(stored: unknown): SessionFeatures | undefined {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined;
  const { computerUse: _never, ...rest } = stored as SessionFeatures;
  return rest;
}

interface Endpoint { url: string; token: string; tokenFile?: string }
let endpoint: Endpoint | null = null;

export function computerTokenDir(): string {
  return path.join(dataDir(), 'runtime', 'computer-mcp');
}

/** Called once the main listener has its port (null at shutdown): see `configureWebMcp`, the same arrangement. */
export function configureComputerMcp(e: { url: string; token: string } | null, dir = computerTokenDir()): void {
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
    console.warn(`[computer] could not write the MCP secret file (it is passed inline instead): ${(err as Error).message}`);
  }
  endpoint = { url: e.url, token: e.token, tokenFile };
}

/** Path to the MCP entry, whether we're running from src (tsx) or dist. */
export function computerEntry(name = 'mcp'): string {
  const compiled = path.join(here, `${name}.js`);
  if (fs.existsSync(compiled)) return compiled;
  const src = path.join(here, `${name}.ts`);
  return fs.existsSync(src) ? src : compiled;
}

function tsxLoader(): string {
  try { return import.meta.resolve('tsx'); } catch { return 'tsx'; }
}

/**
 * The desktop app's own executable — never a target of the agent's input. Only when this server runs inside the
 * app (Electron): under plain `node` the executable is node itself, which is not the app (there the window is a
 * browser tab titled "Claude Web", which the title check covers).
 */
export function selfExe(): string | undefined {
  return process.versions.electron ? process.execPath : undefined;
}

type StdioServer = { type: 'stdio'; command: string; args: string[]; env: Record<string, string> };

/** The `mcpServers` entry for the Agent SDK; {} when it is not to be handed out (another platform, not listening yet). */
export function computerClaudeMcpServer(t: { sessionId: string }, o: { execPath?: string; platform?: NodeJS.Platform; arch?: string } = {}): Record<string, StdioServer> {
  const platform = o.platform ?? process.platform;
  if (!endpoint || !computerSupported(platform, o.arch)) return {};
  const self = selfExe();
  const ep = endpoint;
  const server = (entry: string): StdioServer => ({
      type: 'stdio',
      command: o.execPath ?? process.execPath,
      args: entry.endsWith('.ts') ? ['--import', tsxLoader(), entry] : [entry],
      env: {
        // process.execPath is the Electron binary in a packaged build; the same trick `spawnClaude` uses
        ELECTRON_RUN_AS_NODE: '1',
        CW_COMPUTER_ASK_URL: ep.url,
        ...(ep.tokenFile ? { CW_COMPUTER_TOKEN_FILE: ep.tokenFile } : { CW_COMPUTER_TOKEN: ep.token }),
        CW_SESSION_ID: t.sessionId,
        CLAUDE_WEB_DIR: dataDir(),
        ...(self ? { CW_COMPUTER_SELF_EXE: self } : {}),
        ...(process.env.CW_AGENT_DESKTOP_BIN ? { CW_AGENT_DESKTOP_BIN: process.env.CW_AGENT_DESKTOP_BIN } : {}),
      },
  });
  const out: Record<string, StdioServer> = {};
  if (classicSupported(platform)) out[COMPUTER_SERVER] = server(computerEntry());
  if (agentDesktopSupported(platform, o.arch ?? process.arch)) {
    out[DESKTOP_SERVER] = server(computerEntry('desktop-mcp'));
    // fetched here (this process follows the user's proxy) while the conversation starts; the server waits for it
    if (!o.platform && !process.env.VITEST) void ensureAgentDesktop().catch((e) => console.warn(`[computer] agent-desktop: ${(e as Error).message}`));
  }
  return out;
}

/**
 * Its tools run without the agent's own permission prompt — all of them: `request_access` is answered by the user
 * in the app in every permission mode but 完全放开, which is granted unasked (access.ts), and what the others may do is decided by
 * the server's gate from what was granted. [] when the server is not handed out.
 */
export function computerAllowedTools(o: { platform?: NodeJS.Platform; arch?: string } = {}): string[] {
  const platform = o.platform ?? process.platform;
  if (!endpoint || !computerSupported(platform, o.arch)) return [];
  return [
    ...(classicSupported(platform) ? TOOL_NAMES.map((t) => `mcp__${COMPUTER_SERVER}__${t}`) : []),
    ...(agentDesktopSupported(platform, o.arch ?? process.arch) ? DESKTOP_TOOLS.map((t) => `mcp__${DESKTOP_SERVER}__${t.name}`) : []),
  ];
}
