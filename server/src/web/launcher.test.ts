import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { egoReset, egoStatus } from './ego.js';
import { SERVER_GATED_TOOLS, serverGatedArgs } from './launcher.js';
import { EGO_TOOLS, TOOLS } from './mcp.js';
import { WEB_SEARCH_TOOL, configureWebMcp, setWebAgentBrowser, setWebMcpEnabled, sweepWebTokens, webAllowedTools, webClaudeMcpServer, webMcpEnabled, webMcpEntry } from './launcher.js';

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-webmcp-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { configureWebMcp(null, dir); setWebMcpEnabled(true); });

/** every built-in browser tool (mcp.ts TOOLS, browser_*): each one's server gate is the only card */
const BROWSER_TOOLS = [
  'browser_open', 'browser_read', 'browser_find', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_back',
  'browser_screenshot', 'browser_computer', 'browser_console', 'browser_network', 'browser_snapshot', 'browser_wait', 'browser_tabs',
  'browser_viewport', 'browser_hover', 'browser_drag', 'browser_select', 'browser_eval',
];
const target = { sessionId: 'sess-1' };
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SECRET = 'a'.repeat(64);

describe('server-gated tools: one card, the server\'s', () => {
  it('every built-in browser tool and ego_browser', () => {
    expect(SERVER_GATED_TOOLS).toEqual(['mcp__web__ego_browser', ...BROWSER_TOOLS.map((t) => `mcp__web__${t}`)]);
  });
  it('the table is each browser tool\'s own schema: the same argument keys, the same required ones', () => {
    const schema = new Map(TOOLS.map((t) => [t.name, t.inputSchema as { properties: Record<string, unknown>; required?: string[] }]));
    for (const t of ['ego_browser', ...BROWSER_TOOLS]) {
      const s = t === 'ego_browser' ? EGO_TOOLS.find((x) => x.name === t)!.inputSchema as any : schema.get(t);
      expect(s, t).toBeTruthy();
      const shape = serverGatedArgs(t)!;
      expect([...shape.keys].sort(), t).toEqual(Object.keys(s!.properties).sort());
      expect([...shape.required].sort(), t).toEqual([...(s!.required ?? [])].sort());
    }
    // every browser_* tool the server has is in it, nothing else of the web server's
    expect(TOOLS.filter((t) => t.name.startsWith('browser_')).map((t) => t.name).sort()).toEqual([...BROWSER_TOOLS].sort());
    for (const t of ['web_search', 'ego_browser_guide', 'character_assign', 'theme_apply', 'theme_delete', 'constructor']) expect(serverGatedArgs(t), t).toBeUndefined();
  });
});

describe('web MCP launcher', () => {
  it('hands out nothing before the server is listening, and nothing while the switch is off', () => {
    expect(webClaudeMcpServer(target)).toEqual({});
    expect(webAllowedTools()).toEqual([]);
    configureWebMcp({ url: 'http://127.0.0.1:3090', token: SECRET }, dir);
    expect(Object.keys(webClaudeMcpServer(target))).toEqual(['web']);
    setWebMcpEnabled(false);
    expect(webMcpEnabled()).toBe(false);
    expect(webClaudeMcpServer(target)).toEqual({});
    expect(webAllowedTools()).toEqual([]);
  });

  it('gives Claude a stdio server that knows where this server is and which conversation it serves', () => {
    configureWebMcp({ url: 'http://127.0.0.1:51234', token: SECRET }, dir);
    const s = webClaudeMcpServer(target, NODE).web;
    expect(s.type).toBe('stdio');
    expect(s.command).toBe(NODE);
    expect(s.args[s.args.length - 1]).toBe(webMcpEntry());
    expect(path.basename(webMcpEntry())).toMatch(/^mcp\.(js|ts)$/);
    const tokenFile = path.join(dir, `${process.pid}.token`);
    expect(s.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', CW_WEB_URL: 'http://127.0.0.1:51234', CW_WEB_TOKEN_FILE: tokenFile, CW_SESSION_ID: 'sess-1' });
    // the SDK puts this object on the CLI's command line: the secret must not be in it
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(fs.readFileSync(tokenFile, 'utf8')).toBe(SECRET);
    // pre-allowed: searching, the guides / drafts, and every tool the server asks about itself (all the browser's: 允许的网站 + scripts)
    expect(webAllowedTools()).toEqual(['mcp__web__web_search', 'mcp__web__ego_browser_guide', 'mcp__web__ego_browser', 'mcp__web__browser_open', 'mcp__web__browser_read', 'mcp__web__browser_find', 'mcp__web__browser_click', 'mcp__web__browser_type', 'mcp__web__browser_press_key', 'mcp__web__browser_scroll', 'mcp__web__browser_back', 'mcp__web__browser_screenshot', 'mcp__web__browser_computer', 'mcp__web__browser_console', 'mcp__web__browser_network', 'mcp__web__browser_snapshot', 'mcp__web__browser_wait', 'mcp__web__browser_tabs', 'mcp__web__browser_viewport', 'mcp__web__browser_hover', 'mcp__web__browser_drag', 'mcp__web__browser_select', 'mcp__web__browser_eval', 'mcp__web__character_guide', 'mcp__web__character_draft', 'mcp__web__character_save', 'mcp__web__character_list', 'mcp__web__theme_guide', 'mcp__web__theme_draft', 'mcp__web__theme_get', 'mcp__web__theme_save', 'mcp__web__theme_list']);
    expect(WEB_SEARCH_TOOL).toBe('mcp__web__web_search');
    // a conversation whose id is not known yet still gets the server
    expect(webClaudeMcpServer({}, NODE).web.env.CW_SESSION_ID).toBe('');
  });

  it('the secret file goes with the server, a restart replaces it, and files of servers that are gone are swept', () => {
    const mine = path.join(dir, `${process.pid}.token`);
    // a pid that cannot be a live process, and a file that is not one of ours
    const stale = path.join(dir, '999999999.token');
    const foreign = path.join(dir, 'notes.txt');
    fs.writeFileSync(stale, 'old');
    fs.writeFileSync(foreign, 'keep');
    configureWebMcp({ url: 'http://127.0.0.1:1', token: 'first' }, dir);
    expect(fs.readFileSync(mine, 'utf8')).toBe('first');
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
    configureWebMcp({ url: 'http://127.0.0.1:2', token: 'second' }, dir);
    expect(fs.readFileSync(mine, 'utf8')).toBe('second');
    expect(webClaudeMcpServer(target).web.env.CW_WEB_URL).toBe('http://127.0.0.1:2');
    configureWebMcp(null, dir);
    expect(fs.existsSync(mine)).toBe(false);
    expect(webClaudeMcpServer(target)).toEqual({});
    sweepWebTokens(path.join(dir, 'no-such-folder')); // nothing to sweep is not an error
    fs.rmSync(foreign);
  });

  it('when the secret file cannot be written the secret is passed inline, and a line says so', () => {
    const blocked = path.join(dir, 'a-file');
    fs.writeFileSync(blocked, 'x'); // a file where the folder should be: mkdir fails
    const warn = console.warn;
    const said: string[] = [];
    console.warn = (...a: unknown[]) => { said.push(a.join(' ')); };
    try { configureWebMcp({ url: 'http://127.0.0.1:3', token: SECRET }, blocked); } finally { console.warn = warn; }
    expect(said.join('\n')).toContain('[web]');
    expect(said.join('\n')).not.toContain(SECRET);
    const env = webClaudeMcpServer(target).web.env;
    expect(env.CW_WEB_TOKEN).toBe(SECRET);
    expect(env.CW_WEB_TOKEN_FILE).toBeUndefined();
    configureWebMcp(null, blocked);
    fs.rmSync(blocked);
  });

  it('ego lite: CW_WEB_BROWSER=ego only when its command was found and the setting is not the built-in browser', async () => {
    configureWebMcp({ url: 'http://127.0.0.1:3090', token: SECRET }, dir);
    const bin = path.join(dir, 'egobin');
    fs.mkdirSync(bin, { recursive: true });
    const fake = '#!/usr/bin/env node\nprocess.stdout.write("[ego-browser:skill] ego-browser v1.0.0\\n");\n';
    fs.writeFileSync(path.join(bin, 'ego-browser.js'), fake);
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'ego-browser.cmd'), '@ECHO off\r\nnode "%~dp0\\ego-browser.js" %*\r\n');
    else { fs.writeFileSync(path.join(bin, 'ego-browser'), fake); fs.chmodSync(path.join(bin, 'ego-browser'), 0o755); }
    const old = process.env.PATH;
    try {
      egoReset();
      process.env.PATH = path.join(dir, 'nothing-here');
      await egoStatus(false);
      expect(webClaudeMcpServer(target, NODE).web.env.CW_WEB_BROWSER).toBeUndefined();
      egoReset();
      process.env.PATH = `${bin}${path.delimiter}${old}`;
      await egoStatus(false);
      expect(webClaudeMcpServer(target, NODE).web.env.CW_WEB_BROWSER).toBe('ego');
      setWebAgentBrowser('builtin');
      expect(webClaudeMcpServer(target, NODE).web.env.CW_WEB_BROWSER).toBeUndefined();
    } finally {
      process.env.PATH = old;
      setWebAgentBrowser('auto');
      egoReset();
    }
  });
});
