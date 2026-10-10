#!/usr/bin/env node
/**
 * 操控电脑 as a stdio MCP server (agents know it as `computer`): screenshots, mouse, keyboard, clipboard and opening applications
 * on the whole Windows desktop, under the tool names of Claude Code's built-in computer-use server.
 *
 * Bare JSON-RPC 2.0 over stdio, like web/mcp.ts and memory/mcp.ts — it starts from a packaged app with nothing to
 * install. The work is in service.ts (the gate and the tools) and helper-win.ts (one PowerShell process, started on
 * the first call that needs it). On other platforms the server still starts and lists its tools; every call answers
 * that computer use is Windows-only.
 *
 * Who approves: started by Claude Web (CW_COMPUTER_ASK_URL set), every `request_access` is put to the user by Claude
 * Web itself before anything is granted (`askHost` → POST /api/computer/ask → a card in the app, computer/access.ts) —
 * so it does not matter what the conversation's own permission mode lets through. Started by anything else, the
 * host is expected to ask the user before every `request_access` call. Either way the other tools can be let
 * through: what they may do is decided here, from what was granted (grants.ts).
 *
 * Env: CW_COMPUTER_ASK_URL + CW_COMPUTER_TOKEN_FILE (or CW_COMPUTER_TOKEN) + CW_SESSION_ID — where to ask, this
 * start's secret, and whose conversation this is. CW_COMPUTER_SELF_EXE — the Claude Web desktop executable, which is
 * never a target (optional: a window titled "Claude Web" never is either). CW_COMPUTER_DEBUG=1 — every helper
 * request and its duration on stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SELF_TITLE } from './grants.js';
import { WinHelper, computerDir } from './helper-win.js';
import { ComputerService, type AccessAsk, type AccessVerdict } from './service.js';
import { INSTRUCTIONS, SERVER_NAME, TOOLS } from './tools.js';

const PROTOCOL_VERSION = '2025-06-18';

/** How long the user has to answer (Claude Web gives up a little earlier and says so itself). */
const ASK_WAIT_MS = 5 * 60_000;

/**
 * Put a `request_access` to the user through Claude Web. Never throws: anything but a clear yes is a no, with the
 * reason for the model to read.
 */
export async function askHost(env: NodeJS.ProcessEnv, ask: AccessAsk, fetchFn: typeof fetch = fetch): Promise<AccessVerdict> {
  const no = (message: string): AccessVerdict => ({ granted: false, message });
  const url = env.CW_COMPUTER_ASK_URL?.trim();
  if (!url) return no('Claude Web cannot be asked (no address to ask at), so nothing was granted.');
  let token = env.CW_COMPUTER_TOKEN ?? '';
  if (!token && env.CW_COMPUTER_TOKEN_FILE) {
    try { token = fs.readFileSync(env.CW_COMPUTER_TOKEN_FILE, 'utf8').trim(); } catch { /* reported below */ }
  }
  if (!token) return no('Claude Web cannot be asked (its secret could not be read — it may have been restarted), so nothing was granted.');
  try {
    const res = await fetchFn(`${url.replace(/\/+$/, '')}/api/computer/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: env.CW_SESSION_ID ?? '', ...ask }),
      signal: AbortSignal.timeout(ASK_WAIT_MS),
    });
    if (res.status !== 200) return no(`Claude Web did not take the request (HTTP ${res.status}) — it may have been restarted. Nothing was granted.`);
    const j = (await res.json()) as { granted?: unknown; message?: unknown };
    if (j?.granted === true) return { granted: true };
    return no(typeof j?.message === 'string' && j.message ? j.message : 'The user declined. Nothing was granted.');
  } catch (e) {
    return no(`Claude Web could not be reached to ask the user (${(e as Error)?.name === 'TimeoutError' ? 'no answer in time' : (e as Error)?.message ?? e}). Nothing was granted.`);
  }
}

/** The service for this machine: a PowerShell helper on Windows, none elsewhere. */
export function createService(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ComputerService {
  const selfExe = env.CW_COMPUTER_SELF_EXE?.trim() || undefined;
  const helper = platform === 'win32' ? new WinHelper({ selfExe, selfTitle: SELF_TITLE, debug: env.CW_COMPUTER_DEBUG === '1' }) : null;
  const approve = env.CW_COMPUTER_ASK_URL?.trim() ? (ask: AccessAsk) => askHost(env, ask) : undefined;
  return new ComputerService({ helper, selfExe, shotsDir: path.join(computerDir(), 'shots'), approve });
}

function main() {
  const service = createService();
  const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const ok = (id: unknown, result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });
  let inFlight = 0;
  let ended = false;
  const maybeExit = () => {
    if (!ended || inFlight > 0) return;
    // closing the helper's stdin lets it release a held mouse button before it goes
    service.close();
    setTimeout(() => process.exit(0), 300);
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
      if (!msg || typeof msg !== 'object' || msg.method === undefined) continue; // a response to something we never send
      switch (msg.method) {
        case 'initialize':
          ok(msg.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: '1.0.0' }, instructions: INSTRUCTIONS });
          break;
        case 'notifications/initialized':
        case 'notifications/cancelled':
          break;
        case 'tools/list':
          ok(msg.id, { tools: TOOLS });
          break;
        case 'tools/call': {
          const name = String(msg.params?.name);
          if (!TOOLS.some((t) => t.name === name)) { fail(msg.id, -32602, `unknown tool ${name}`); break; }
          const args = msg.params?.arguments;
          inFlight++;
          void service.call(name, args && typeof args === 'object' ? (args as Record<string, unknown>) : {}).then((r) => { ok(msg.id, r); inFlight--; maybeExit(); });
          break;
        }
        case 'ping':
          ok(msg.id, {});
          break;
        default:
          if (msg.id !== undefined) fail(msg.id, -32601, `unknown method ${msg.method}`);
      }
    }
  });
  // the agent closed our stdin: finish what is under way, then go
  process.stdin.on('end', () => { ended = true; maybeExit(); });
}

/** Path to this entry, whether we are running from src (tsx) or dist — for whoever starts the server. */
export function computerMcpEntry(): string {
  return fileURLToPath(import.meta.url);
}

// started as a program (the host's argv, a test's spawn) — not when a test imports createService
const self = (() => { try { return fileURLToPath(import.meta.url); } catch { return ''; } })();
const started = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (started && (started === self || /[\\/]computer[\\/]mcp\.(js|ts)$/.test(started))) main();
