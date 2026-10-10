import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { WEB_SEARCH_TOOL, configureWebMcp, insertWebCodexConfig, setWebMcpEnabled, sweepWebTokens, webAcpMcpServers, webAllowedTools, webClaudeMcpServer, webCodexConfigArgs, webMcpEnabled, webMcpEntry } from './launcher.js';

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-webmcp-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { configureWebMcp(null, dir); setWebMcpEnabled(true); });

const target = { sessionId: 'sess-1' };
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SECRET = 'a'.repeat(64);

describe('web MCP launcher', () => {
  it('hands out nothing before the server is listening, and nothing while the switch is off', () => {
    expect(webClaudeMcpServer(target)).toEqual({});
    expect(webAcpMcpServers(target)).toEqual([]);
    expect(webCodexConfigArgs(target)).toEqual([]);
    expect(insertWebCodexConfig(['app-server'], target)).toEqual(['app-server']);
    expect(webAllowedTools()).toEqual([]);
    configureWebMcp({ url: 'http://127.0.0.1:3090', token: SECRET }, dir);
    expect(Object.keys(webClaudeMcpServer(target))).toEqual(['web']);
    setWebMcpEnabled(false);
    expect(webMcpEnabled()).toBe(false);
    expect(webClaudeMcpServer(target)).toEqual({});
    expect(webAcpMcpServers(target)).toEqual([]);
    expect(webCodexConfigArgs(target)).toEqual([]);
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
    // searching is the one tool pre-allowed
    expect(webAllowedTools()).toEqual([WEB_SEARCH_TOOL]);
    expect(WEB_SEARCH_TOOL).toBe('mcp__web__web_search');
    // a conversation whose id is not known yet still gets the server
    expect(webClaudeMcpServer({}, NODE).web.env.CW_SESSION_ID).toBe('');
  });

  it('gives ACP the same server with env as name/value pairs', () => {
    configureWebMcp({ url: 'http://127.0.0.1:51234', token: SECRET }, dir);
    const [s] = webAcpMcpServers(target, NODE);
    expect(s.name).toBe('web');
    expect(s.command).toBe(NODE);
    expect(s.env).toContainEqual({ name: 'CW_WEB_URL', value: 'http://127.0.0.1:51234' });
    expect(s.env).toContainEqual({ name: 'CW_SESSION_ID', value: 'sess-1' });
    expect(s.env).toContainEqual({ name: 'ELECTRON_RUN_AS_NODE', value: '1' });
    expect(s.env.every((e) => typeof e.name === 'string' && typeof e.value === 'string')).toBe(true);
  });

  it('gives Codex -c overrides that parse as TOML (Windows paths, spaces), in front of app-server, without the secret', () => {
    configureWebMcp({ url: 'http://127.0.0.1:51234', token: SECRET }, dir);
    const a = webCodexConfigArgs(target, NODE);
    expect(a.filter((x) => x === '-c')).toHaveLength(3);
    const doc = parseToml(a.filter((x) => x !== '-c').join('\n')) as any;
    expect(doc.mcp_servers.web.command).toBe(NODE);
    expect(doc.mcp_servers.web.args[doc.mcp_servers.web.args.length - 1]).toBe(webMcpEntry());
    expect(doc.mcp_servers.web.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', CW_WEB_URL: 'http://127.0.0.1:51234', CW_WEB_TOKEN_FILE: path.join(dir, `${process.pid}.token`), CW_SESSION_ID: 'sess-1' });
    expect(a.join(' ')).not.toContain(SECRET);
    const spliced = insertWebCodexConfig(['-c', 'model="gpt-5"', 'app-server'], target, NODE);
    expect(spliced.slice(0, 2)).toEqual(['-c', 'model="gpt-5"']);
    expect(spliced[spliced.length - 1]).toBe('app-server');
    expect(spliced).toHaveLength(9);
    // a stand-in command with no subcommand is left exactly as configured
    expect(insertWebCodexConfig(['C:\\my-codex-shim.mjs'], target)).toEqual(['C:\\my-codex-shim.mjs']);
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
});
