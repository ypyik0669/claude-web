import { afterAll, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computerAllowedTools, computerClaudeMcpServer, computerSupported, configureComputerMcp, defaultFeaturesOf } from './launcher.js';
import { TOOL_NAMES } from './tools.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-computer-launcher-'));
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
afterEach(() => { configureComputerMcp(null, tmp); });

describe('where 操控电脑 can run', () => {
  it('Windows, for now', () => {
    expect(computerSupported('win32')).toBe(true);
    for (const p of ['darwin', 'linux', 'freebsd'] as const) expect(computerSupported(p)).toBe(false);
  });
});

describe('capabilities nobody chose for a conversation', () => {
  it('never include 操控电脑: it is switched on by the user, for one conversation', () => {
    expect(defaultFeaturesOf({ computerUse: true, chrome: true, channels: ['server:x'] })).toEqual({ chrome: true, channels: ['server:x'] });
    expect(defaultFeaturesOf({ computerUse: true })).toEqual({});
    expect(defaultFeaturesOf({ brief: true })).toEqual({ brief: true });
    for (const v of [undefined, null, '', 'computerUse', 1, [{ computerUse: true }]]) expect(defaultFeaturesOf(v)).toBeUndefined();
  });
});

describe('what a Claude conversation with it on is handed', () => {
  const secret = 'f'.repeat(64);

  it('nothing before the server listens, and nothing on another platform', () => {
    expect(computerClaudeMcpServer({ sessionId: 's1' }, { platform: 'win32' })).toEqual({});
    expect(computerAllowedTools({ platform: 'win32' })).toEqual([]);
    configureComputerMcp({ url: 'http://127.0.0.1:3090', token: secret }, tmp);
    expect(computerClaudeMcpServer({ sessionId: 's1' }, { platform: 'darwin' })).toEqual({});
    expect(computerAllowedTools({ platform: 'linux' })).toEqual([]);
  });

  it('the server `computer`, told where to ask and whose conversation it is — the secret in a file, not on a command line', () => {
    configureComputerMcp({ url: 'http://127.0.0.1:3090', token: secret }, tmp);
    const file = path.join(tmp, `${process.pid}.token`);
    expect(fs.readFileSync(file, 'utf8')).toBe(secret);
    const handed = computerClaudeMcpServer({ sessionId: 'conv-1' }, { platform: 'win32', execPath: 'C:/app/node.exe' });
    expect(Object.keys(handed)).toEqual(['computer']); // (`computer-use` is a reserved name in both engines)
    const s = handed.computer;
    expect(s.type).toBe('stdio');
    expect(s.command).toBe('C:/app/node.exe');
    expect(s.args[s.args.length - 1]).toMatch(/computer[\\/]mcp\.(js|ts)$/);
    expect(s.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', CW_COMPUTER_ASK_URL: 'http://127.0.0.1:3090', CW_COMPUTER_TOKEN_FILE: file, CW_SESSION_ID: 'conv-1' });
    expect(s.env.CW_COMPUTER_TOKEN).toBeUndefined();
    expect(JSON.stringify(handed)).not.toContain(secret);
    // under plain node the executable is node, not the app: the app is then recognised by its window title
    expect(s.env.CW_COMPUTER_SELF_EXE).toBeUndefined();
  });

  it('all of its tools are let through the agent\'s own prompt: the user is asked by the app, the rest is the gate', () => {
    configureComputerMcp({ url: 'http://127.0.0.1:3090', token: secret }, tmp);
    const allowed = computerAllowedTools({ platform: 'win32' });
    expect(allowed).toHaveLength(TOOL_NAMES.length);
    expect(allowed).toHaveLength(23);
    expect(allowed.every((t) => t.startsWith('mcp__computer__'))).toBe(true);
    expect(allowed).toContain('mcp__computer__request_access');
  });

  it('at shutdown the secret file is removed and nothing is handed out any more', () => {
    configureComputerMcp({ url: 'http://127.0.0.1:3090', token: secret }, tmp);
    const file = path.join(tmp, `${process.pid}.token`);
    expect(fs.existsSync(file)).toBe(true);
    configureComputerMcp(null, tmp);
    expect(fs.existsSync(file)).toBe(false);
    expect(computerClaudeMcpServer({ sessionId: 's' }, { platform: 'win32' })).toEqual({});
  });
});
