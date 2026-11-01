import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../files/service.js';
import { egoKnown, egoStatus } from './ego.js';

/**
 * How Claude is told about the `web` MCP server (web search + the built-in browser) — the same way as the shared
 * memory (memory/launcher.ts), and by the same rule: nothing is written into the user's own Claude config. Claude
 * gets it through the SDK's `mcpServers`.
 *
 * The MCP process reaches this server at CW_WEB_URL with the per-start secret. The secret is handed over as a FILE
 * (CW_WEB_TOKEN_FILE): the SDK puts `mcpServers` on the CLI's command line (`--mcp-config {json}`), and command lines
 * are readable by other users' `ps` on macOS / Linux.
 * Nothing is handed out before `configureWebMcp` (the server is listening) or while the switch `web.mcp` is off.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The tool an agent may use without being asked each time (spec §5.3): searching reads, it changes nothing. */
export const WEB_SEARCH_TOOL = 'mcp__web__web_search';
/** Reading ego lite's guide changes nothing. */
export const EGO_GUIDE_TOOL = 'mcp__web__ego_browser_guide';
/**
 * ego_browser acts with the user's sign-ins, so it IS asked about — by this server, on its own card
 * (service.ts egoGate, spec 14.1). Claude is told it is allowed so it does not raise a second card of its own.
 */
export const EGO_TOOL = 'mcp__web__ego_browser';
/**
 * The tools whose only card is this server's own (an unanswered card is a deny):
 * - ego_browser and browser_eval: a script, asked every time except in 完全放开 (site-gate.ts needsAsk `eval`);
 * - every other built-in browser tool: 允许的网站 is the only authority (the user's decision, 2026-10-27, spec 14.4) —
 *   opening a site not on the list (browser_open, browser_tabs new with an address) and changing a page of one
 *   (click / type / key / scroll / computer / hover / drag / select) is asked once on the server's site card, a site
 *   on the list is asked nothing; reading the page that is open (read / find / snapshot / screenshot / console /
 *   network / wait / back / viewport / tabs list / switch / close) is asked nothing (service.ts browse / gated).
 * Claude's own prompt for one is therefore never raised (they are in allowedTools), so there is at most one card, the
 * server's. Per tool, from its inputSchema in mcp.ts (launcher.test.ts checks they match): the argument keys it takes
 * and the ones it requires.
 * Not web_search (pre-allowed on its own, WEB_SEARCH_TOOL), not the guides, not the tools that change the user's
 * settings (character_assign, theme_apply, theme_delete: the agent's own card is the one there is).
 */
interface GatedShape { keys: ReadonlySet<string>; required: readonly string[] }
const shape = (keys: string[], required: string[] = []): GatedShape => ({ keys: new Set(keys), required });
const SERVER_GATED: ReadonlyMap<string, GatedShape> = new Map([
  ['ego_browser', shape(['script', 'timeout_ms'], ['script'])],
  ['browser_open', shape(['url'], ['url'])],
  ['browser_read', shape(['offset', 'max_chars'])],
  ['browser_find', shape(['query'], ['query'])],
  ['browser_click', shape(['ref'], ['ref'])],
  ['browser_type', shape(['ref', 'text', 'submit'], ['ref', 'text'])],
  ['browser_press_key', shape(['key'], ['key'])],
  ['browser_scroll', shape(['direction', 'amount'], ['direction'])],
  ['browser_back', shape([])],
  ['browser_screenshot', shape([])],
  ['browser_computer', shape(['action', 'coordinate', 'start_coordinate', 'text', 'scroll_direction', 'scroll_amount', 'duration'], ['action'])],
  ['browser_console', shape(['errors_only'])],
  ['browser_network', shape(['failed_only'])],
  ['browser_snapshot', shape([])],
  ['browser_wait', shape(['text', 'ref', 'timeoutMs'])],
  ['browser_tabs', shape(['action', 'id', 'url'], ['action'])],
  ['browser_viewport', shape(['preset'], ['preset'])],
  ['browser_hover', shape(['ref'], ['ref'])],
  ['browser_drag', shape(['from', 'to'], ['from', 'to'])],
  ['browser_select', shape(['ref', 'value'], ['ref', 'value'])],
  ['browser_eval', shape(['script'], ['script'])],
]);
export const SERVER_GATED_TOOLS: readonly string[] = [...SERVER_GATED.keys()].map((t) => `mcp__web__${t}`);
/** A server-gated tool's argument keys and required ones (tests compare them with mcp.ts); undefined for any other name. */
export function serverGatedArgs(tool: string): { keys: string[]; required: string[] } | undefined {
  const s = SERVER_GATED.has(tool) ? SERVER_GATED.get(tool)! : undefined;
  return s && { keys: [...s.keys], required: [...s.required] };
}
/** The env entry that gives a conversation's web server the ego tools (spawnShape). */
const EGO_ENV = { name: 'CW_WEB_BROWSER', value: 'ego' } as const;

let enabled = true;
/** Settings switch (`web.mcp`). Off = no conversation is told about the server; running conversations keep theirs. */
export function setWebMcpEnabled(on: boolean) { enabled = on; }
export function webMcpEnabled() { return enabled; }

/**
 * Setting `web.browser.agent`: which browser Claude acts in. 'auto' (default) = ego lite when its `ego-browser` command
 * was found (web/ego.ts), else the built-in one; 'builtin' = always the built-in one. New conversations only.
 */
let agentBrowser: 'auto' | 'builtin' = 'auto';
export function setWebAgentBrowser(v: unknown) { agentBrowser = v === 'builtin' ? 'builtin' : 'auto'; }
/** Does a conversation started now get ego lite? The last detection, refreshed in the background when stale. */
export function egoForNewConversations(): boolean {
  if (agentBrowser === 'builtin') return false;
  void egoStatus().catch(() => {});
  return egoKnown()?.found === true;
}

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
 * Running from source (`npm start` / `npm run dev`): the entry is TypeScript and needs tsx. Claude Code starts the MCP
 * process in the project's folder, where a bare `--import tsx` does not resolve — so the loader goes by its address.
 */
function tsxLoader(): string {
  try { return import.meta.resolve('tsx'); } catch { return 'tsx'; }
}

export interface WebMcpTarget { sessionId?: string }

/** How to start the stdio server. Null: not to be handed out. */
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
      ...(egoForNewConversations() ? { [EGO_ENV.name]: EGO_ENV.value } : {}),
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
  return enabled && endpoint ? [WEB_SEARCH_TOOL, EGO_GUIDE_TOOL, ...SERVER_GATED_TOOLS, ...CHARACTER_FREE_TOOLS, ...THEME_FREE_TOOLS] : [];
}

/** 网吧's character tools that only touch the character library (drafts the user watches, a save): not asked about one by
 *  one. Giving a character to someone changes the user's settings — character_assign is asked like any tool. */
export const CHARACTER_FREE_TOOLS = ['mcp__web__character_guide', 'mcp__web__character_draft', 'mcp__web__character_save', 'mcp__web__character_list'];
/** 字符画主题's tools that only touch the theme library (drafts, a save, reading): not asked about. theme_apply (the
 *  user's setting) and theme_delete are asked like any tool. */
export const THEME_FREE_TOOLS = ['mcp__web__theme_guide', 'mcp__web__theme_draft', 'mcp__web__theme_get', 'mcp__web__theme_save', 'mcp__web__theme_list'];
