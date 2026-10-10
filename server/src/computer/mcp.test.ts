import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_GRANT_TEXT } from './grants.js';
import { computerMcpEntry, createService } from './mcp.js';
import { UNSUPPORTED_TEXT } from './service.js';
import { TOOL_NAMES } from './tools.js';

/** The MCP server as a host starts it: a process, JSON-RPC lines over stdio. */
function start(env: Record<string, string> = {}) {
  const entry = computerMcpEntry();
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const child: ChildProcess = spawn(process.execPath, entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry], { cwd: serverDir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const got = new Map<number, any>();
  const waiters = new Map<number, (m: any) => void>();
  let buf = '';
  let stderr = '';
  child.stderr!.on('data', (d) => { stderr += String(d); });
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      got.set(m.id, m);
      waiters.get(m.id)?.(m);
    }
  });
  let seq = 0;
  const rpc = (method: string, params: unknown = {}) => {
    const id = ++seq;
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no answer to ${method} in 25s. stderr: ${stderr.slice(-400)}`)), 25_000);
      waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
      if (got.has(id)) { clearTimeout(t); resolve(got.get(id)); }
    });
  };
  const exited = new Promise<number | null>((r) => child.once('exit', (c) => r(c)));
  return { child, rpc, exited, stderr: () => stderr, notify: (method: string) => child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) };
}

describe('the computer MCP server over stdio', () => {
  it('handshakes, lists the tools, and before any grant captures and sends nothing', async () => {
    const m = start();
    try {
      const init = (await m.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })).result;
      expect(init.serverInfo.name).toBe('claude-web-computer');
      expect(init.capabilities).toEqual({ tools: {} });
      expect(init.instructions).toContain('untrusted');
      m.notify('notifications/initialized');
      expect((await m.rpc('ping')).result).toEqual({});
      const tools = (await m.rpc('tools/list')).result.tools;
      expect(tools.map((t: any) => t.name)).toEqual(TOOL_NAMES);
      for (const t of tools) expect(t.inputSchema.type).toBe('object');

      // none of these needs the helper: on Windows the gate answers, elsewhere the platform does
      const windows = process.platform === 'win32';
      const shot = (await m.rpc('tools/call', { name: 'screenshot', arguments: {} })).result;
      expect(shot.isError).toBe(true);
      expect(shot.content).toEqual([{ type: 'text', text: windows ? NO_GRANT_TEXT : UNSUPPORTED_TEXT }]);
      const click = (await m.rpc('tools/call', { name: 'left_click', arguments: { coordinate: [10, 10] } })).result;
      expect(click.isError).toBe(true);
      expect(click.content[0].text).toBe(windows ? NO_GRANT_TEXT : UNSUPPORTED_TEXT);
      const typed = (await m.rpc('tools/call', { name: 'type' })).result; // no arguments at all
      expect(typed.isError).toBe(true);
      const listed = (await m.rpc('tools/call', { name: 'list_granted_applications', arguments: {} })).result;
      if (windows) expect(JSON.parse(listed.content[0].text)).toMatchObject({ granted: [], platform: 'win32' });
      else expect(listed).toEqual({ content: [{ type: 'text', text: '操控电脑目前只支持 Windows。' }], isError: true });
      const batch = (await m.rpc('tools/call', { name: 'computer_batch', arguments: { actions: [{ action: 'screenshot' }] } })).result;
      expect(batch.isError).toBe(true);
      expect(batch.content.some((c: any) => c.type === 'image')).toBe(false);

      // what it does not know is a protocol error
      expect((await m.rpc('tools/call', { name: 'switch_display', arguments: { display: 'auto' } })).error.message).toContain('unknown tool');
      expect((await m.rpc('resources/list')).error.code).toBe(-32601);
      // the helper was never started
      expect(m.stderr()).not.toContain('helper ready');
    } finally {
      m.child.stdin!.end();
    }
    expect(await m.exited).toBe(0); // the host closing stdin ends it
  }, 60_000);
});

describe('the service for a platform', () => {
  it('anywhere but Windows there is no helper: the server lists its tools and every call says so', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const svc = createService({}, platform);
      for (const t of ['request_access', 'screenshot', 'left_click', 'wait', 'list_granted_applications', 'computer_batch']) {
        expect(await svc.call(t, { apps: ['Finder'], reason: 'r', duration: 0 }), `${platform} ${t}`).toEqual({ content: [{ type: 'text', text: '操控电脑目前只支持 Windows。' }], isError: true });
      }
      svc.close();
    }
  });

  it('on Windows it has one, started only when a call needs it', async () => {
    const svc = createService({ CW_COMPUTER_SELF_EXE: ' C:\\Program Files\\Claude Web\\Claude Web.exe ' }, 'win32');
    // nothing here reaches the helper: no PowerShell is started by this test
    const r = await svc.call('screenshot');
    expect(r).toEqual({ content: [{ type: 'text', text: NO_GRANT_TEXT }], isError: true });
    expect((await svc.call('request_access', { apps: ['Claude Web'], reason: '' })).isError).toBe(true); // refused for its arguments, before the helper
    svc.close();
  });
});
