import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dataDir } from '../files/service.js';
import { egoKnown, egoStatus } from './ego.js';

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
/** Reading ego lite's guide changes nothing. */
export const EGO_GUIDE_TOOL = 'mcp__web__ego_browser_guide';
/**
 * ego_browser acts with the user's sign-ins, so it IS asked about — by this server, on its own card, for every agent
 * (service.ts egoGate, spec 14.1). Claude is told it is allowed so it does not raise a second card of its own.
 */
export const EGO_TOOL = 'mcp__web__ego_browser';
/**
 * The tools whose only card is this server's own, for every agent (an unanswered card is a deny):
 * - ego_browser and browser_eval: a script, asked every time except in 完全放开 (site-gate.ts needsAsk `eval`);
 * - every other built-in browser tool: 允许的网站 is the only authority (the user's decision, 2026-10-27, spec 14.4) —
 *   opening a site not on the list (browser_open, browser_tabs new with an address) and changing a page of one
 *   (click / type / key / scroll / computer / hover / drag / select) is asked once on the server's site card, a site
 *   on the list is asked nothing; reading the page that is open (read / find / snapshot / screenshot / console /
 *   network / wait / back / viewport / tabs list / switch / close) is asked nothing (service.ts browse / gated).
 * An agent's own prompt for one is therefore answered without a card (Claude: in allowedTools; ACP:
 * AcpDriver.onPermission; Codex: CodexDriver.onElicitation), so there is at most one card, the server's.
 * Per tool, from its inputSchema in mcp.ts (launcher.test.ts checks they match): the argument keys it takes (a call
 * carrying anything else is not ours), the ones it requires (a script tool's `script` must be a string), and whether
 * it exists only with the ego tools (CW_WEB_BROWSER=ego).
 * Not web_search (pre-allowed on its own, WEB_SEARCH_TOOL), not the guides, not the tools that change the user's
 * settings (character_assign, theme_apply, theme_delete: the agent's own card is the one there is).
 */
interface GatedShape { keys: ReadonlySet<string>; required: readonly string[]; script: boolean; needsEgo: boolean }
const shape = (keys: string[], required: string[] = [], o: { script?: boolean; needsEgo?: boolean } = {}): GatedShape =>
  ({ keys: new Set(keys), required, script: !!o.script, needsEgo: !!o.needsEgo });
const SERVER_GATED: ReadonlyMap<string, GatedShape> = new Map([
  ['ego_browser', shape(['script', 'timeout_ms'], ['script'], { script: true, needsEgo: true })],
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
  ['browser_eval', shape(['script'], ['script'], { script: true })],
]);
export const SERVER_GATED_TOOLS: readonly string[] = [...SERVER_GATED.keys()].map((t) => `mcp__web__${t}`);
/** A server-gated tool's argument keys and required ones (tests compare them with mcp.ts); undefined for any other name. */
export function serverGatedArgs(tool: string): { keys: string[]; required: string[] } | undefined {
  const s = SERVER_GATED.has(tool) ? SERVER_GATED.get(tool)! : undefined;
  return s && { keys: [...s.keys], required: [...s.required] };
}
/**
 * The exact names an agent gives one of those tools: our MCP name, the bare tool name, or the ACP title
 * `<tool> (web MCP Server)` (Gemini-style). Anchored and exact on purpose: an ACP title is built from the call
 * itself (a shell command's text, a file name), so anything looser lets a command that merely MENTIONS the tool
 * through without a card — and only our real call reaches the server's own card.
 */
const SERVER_GATED_NAME_RE = /^(?:mcp__web__)?([a-z_]+)(?: \(web MCP Server\))?$/;
/** The server-gated tool `name` is exactly one of the names of (see SERVER_GATED_NAME_RE); undefined for anything else. */
function serverGatedToolOf(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const t = SERVER_GATED_NAME_RE.exec(name)?.[1];
  return t !== undefined && SERVER_GATED.has(t) ? t : undefined;
}
/** Is `name` exactly one of our server-gated tools' names? Non-strings are no. */
export function isServerGatedTool(name: unknown): boolean {
  return serverGatedToolOf(name) !== undefined;
}
/** A plain JSON object (what a parsed message holds), not an array, a Date, a class instance. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
/**
 * Arguments shaped like `tool`'s: a plain object with no keys the tool does not take and every key it requires (a
 * script tool's `script` a string). What the values say is never looked at: the server checks and asks.
 */
function isGatedArgs(tool: string, v: unknown): boolean {
  const s = SERVER_GATED.has(tool) ? SERVER_GATED.get(tool) : undefined;
  if (!s || !isPlainObject(v)) return false;
  if (!Object.keys(v).every((k) => s.keys.has(k))) return false;
  if (!s.required.every((k) => Object.prototype.hasOwnProperty.call(v, k) && v[k] !== undefined && v[k] !== null)) return false;
  return !s.script || typeof v.script === 'string';
}
/**
 * What a conversation was handed: our `web` server (`web`), and with it the ego tools (`ego`: started with
 * CW_WEB_BROWSER=ego). Without the web server no tool by our names is ours; without the ego tools no ego_browser is.
 */
export interface WebToolsGiven { web: boolean; ego: boolean }
/** Does `given` include `tool` (a SERVER_GATED key)? */
function hasGated(tool: string, given: WebToolsGiven): boolean {
  return given.web && (!SERVER_GATED.get(tool)?.needsEgo || given.ego);
}
/**
 * May an ACP agent's permission prompt be answered without a card, because the server asks on its own card when the
 * call runs? Only for one of our server-gated tools that this conversation was given (`given`), by its exact name (the
 * prompt's own title — not the name we derived for the call: mapToolName turns spaces into _, so 'ego browser' would
 * become ego_browser), its kind absent or `other` (never execute / edit / delete / move / fetch / read …: Gemini-style
 * agents register every MCP tool as kind other; fetch / read are the kinds of the agent's OWN web-fetch / file tools,
 * whose titles it builds — one named like ours must not slip through, it costs only an extra card if an agent ever
 * labels ours that way), and its raw input there, a plain object with only the tool's own keys and the ones it
 * requires (isGatedArgs). What the values say is never looked at (the server checks and asks). Anything else gets
 * the agent's card.
 */
export function isServerGatedAcpCall(tc: { title?: unknown; kind?: unknown; rawInput?: unknown }, given: WebToolsGiven): boolean {
  const tool = serverGatedToolOf(tc.title);
  if (tool === undefined || !hasGated(tool, given)) return false;
  if (tc.kind !== undefined && tc.kind !== null && tc.kind !== 'other') return false;
  return isGatedArgs(tool, tc.rawInput);
}

/** The env entry that gives a conversation's web server the ego tools (spawnShape), and how it is read back. */
const EGO_ENV = { name: 'CW_WEB_BROWSER', value: 'ego' } as const;
/** What the ACP `mcpServers` list handed to an agent gave it (webAcpMcpServers' shape: env as name/value pairs). */
export function acpWebToolsGiven(servers: readonly { name?: unknown; env?: unknown }[] | undefined): WebToolsGiven {
  const web = (servers ?? []).find((s) => s.name === 'web');
  const ego = !!web && Array.isArray(web.env) && web.env.some((e: any) => e?.name === EGO_ENV.name && e?.value === EGO_ENV.value);
  return { web: !!web, ego };
}
/** Codex `-c` overrides: the key prefixes, and one TOML inline-table entry (`K = "v"`), shared by builder and reader. */
const CODEX_WEB_COMMAND = 'mcp_servers.web.command=';
const CODEX_WEB_ENV = 'mcp_servers.web.env=';
const tomlEntry = (k: string, v: string) => `${k} = ${JSON.stringify(v)}`;
const ENTRY_SEP = ', ';
/** A TOML inline table of string values, as `mcp_servers.web.env=` takes it (values JSON-quoted: a bare path won't parse). */
function tomlInlineTable(env: Record<string, string>): string {
  return `{${Object.entries(env).map(([k, v]) => tomlEntry(k, v)).join(ENTRY_SEP)}}`;
}
/** The inline-table entry for the ego tools, exactly as webCodexConfigArgs writes it. */
export function codexEgoEnvEntry(): string { return tomlEntry(EGO_ENV.name, EGO_ENV.value); }
/**
 * What the Codex argv gave the conversation: read back from webCodexConfigArgs' own overrides (the same prefixes,
 * entry builder and separator), the ego entry as a whole entry of the inline table. A value cannot fake one: inside a
 * JSON-quoted value every `"` is escaped, and the entry has a bare `"` after `= `.
 */
export function codexWebToolsGiven(args: readonly string[]): WebToolsGiven {
  const web = args.some((a) => a.startsWith(CODEX_WEB_COMMAND));
  const env = args.find((a) => a.startsWith(CODEX_WEB_ENV));
  if (!web || !env) return { web, ego: false };
  const table = env.slice(CODEX_WEB_ENV.length);
  const e = codexEgoEnvEntry();
  const ego = table === `{${e}}` || table.startsWith(`{${e}${ENTRY_SEP}`) || table.endsWith(`${ENTRY_SEP}${e}}`) || table.includes(`${ENTRY_SEP}${e}${ENTRY_SEP}`);
  return { web, ego };
}

/**
 * The tool a Codex MCP tool approval is about. Codex (codex-rs core/src/mcp_tool_call.rs, codex-cli 0.163) does not
 * send the tool's name on its own: it is in the fixed message `Allow the <server> MCP server to run tool "<tool>"?`.
 * Undefined when the message is not exactly that for this server.
 */
export function codexElicitationTool(p: { serverName?: unknown; message?: unknown }): string | undefined {
  if (typeof p.serverName !== 'string' || typeof p.message !== 'string') return undefined;
  const head = `Allow the ${p.serverName} MCP server to run tool "`;
  if (!p.message.startsWith(head) || !p.message.endsWith('"?')) return undefined;
  const tool = p.message.slice(head.length, -2);
  return /^[\w.-]+$/.test(tool) ? tool : undefined;
}
/** Is a Codex `mcpServer/elicitation/request` an approval for an MCP tool call (not a server's own question)? */
export function isCodexToolApproval(p: unknown): p is { serverName: string; message: string; _meta: Record<string, unknown> } {
  return isPlainObject(p) && p.mode === 'form' && isPlainObject(p._meta) && p._meta.codex_approval_kind === 'mcp_tool_call';
}
/**
 * May Codex's approval of an MCP tool call be accepted without a card, because the server asks on its own card when
 * the call runs? Only for our `web` server (the exact fixed message) and one of its server-gated tools this
 * conversation was given, with arguments shaped like that tool's (`_meta.tool_params`).
 */
export function isServerGatedCodexElicitation(p: unknown, given: WebToolsGiven): boolean {
  if (!isCodexToolApproval(p) || p.serverName !== 'web') return false;
  const tool = codexElicitationTool(p);
  if (tool === undefined || !SERVER_GATED.has(tool) || !hasGated(tool, given)) return false;
  return isGatedArgs(tool, p._meta.tool_params);
}

let enabled = true;
/** Settings switch (`web.mcp`). Off = no agent is told about the server; running conversations keep theirs. */
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
  return enabled && endpoint ? [WEB_SEARCH_TOOL, EGO_GUIDE_TOOL, ...SERVER_GATED_TOOLS, ...CHARACTER_FREE_TOOLS, ...THEME_FREE_TOOLS, ...OPENING_FREE_TOOLS] : [];
}

/** 网吧's character tools that only touch the character library (drafts the user watches, a save): not asked about one by
 *  one. Giving a character to someone changes the user's settings — character_assign is asked like any tool. */
export const CHARACTER_FREE_TOOLS = ['mcp__web__character_guide', 'mcp__web__character_draft', 'mcp__web__character_save', 'mcp__web__character_list'];
/** 字符画主题's tools that only touch the theme library (drafts, a save, reading): not asked about. theme_apply (the
 *  user's setting) and theme_delete are asked like any tool. */
export const THEME_FREE_TOOLS = ['mcp__web__theme_guide', 'mcp__web__theme_draft', 'mcp__web__theme_get', 'mcp__web__theme_save', 'mcp__web__theme_list'];
/** 开场动画's tools that only touch the opening library (drafts — played once in the user's window, a save, reading):
 *  not asked about. opening_apply (the user's setting) and opening_delete are asked like any tool. */
export const OPENING_FREE_TOOLS = ['mcp__web__opening_guide', 'mcp__web__opening_draft', 'mcp__web__opening_get', 'mcp__web__opening_save', 'mcp__web__opening_list'];

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
  return [
    '-c', `${CODEX_WEB_COMMAND}${JSON.stringify(s.command)}`,
    '-c', `mcp_servers.web.args=${JSON.stringify(s.args)}`,
    '-c', `${CODEX_WEB_ENV}${tomlInlineTable(s.env)}`,
  ];
}

/** Splice the overrides in front of the `app-server` subcommand; an argv without one (a stand-in command) is left alone. */
export function insertWebCodexConfig(args: string[], t: WebMcpTarget, execPath = process.execPath): string[] {
  const at = args.indexOf('app-server');
  if (at < 0) return args;
  return [...args.slice(0, at), ...webCodexConfigArgs(t, execPath), ...args.slice(at)];
}
