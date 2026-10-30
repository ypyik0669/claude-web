import { afterEach, describe, expect, it } from 'vitest';
import { acpMcpServers, claudeMcpServer, codexConfigArgs, insertCodexConfig, MEMORY_MCP_NAME, memoryMcpEnabled, setMemoryMcpEnabled } from './launcher.js';

const target = { cwd: 'C:\\repo\\app', sessionId: 's1', agent: 'codex' };

afterEach(() => setMemoryMcpEnabled(true));

describe('memory MCP launcher', () => {
  it('gives Claude a stdio server pointed at this session', () => {
    const s = claudeMcpServer(target, 'C:\\node.exe')['claude-web-memory']!;
    expect(s.type).toBe('stdio');
    expect(s.command).toBe('C:\\node.exe');
    expect(s.args).toContain('--cwd');
    expect(s.args).toContain('C:\\repo\\app');
    expect(s.args).toContain('s1');
    expect(s.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('the run of a bot gets --bot <id> (its own memory scope); others do not', () => {
    expect(claudeMcpServer({ ...target, botId: 'b1' }, 'C:\\node.exe')['claude-web-memory']!.args.slice(-2)).toEqual(['--bot', 'b1']);
    expect(claudeMcpServer(target, 'C:\\node.exe')['claude-web-memory']!.args).not.toContain('--bot');
  });

  it('gives ACP the same server with env as name/value pairs', () => {
    const [s] = acpMcpServers(target, 'C:\\node.exe');
    expect(s.name).toBe('claude-web-memory');
    expect(s.command).toBe('C:\\node.exe');
    expect(s.env).toEqual([{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }]);
  });

  it('gives Codex TOML-parseable -c overrides', () => {
    const a = codexConfigArgs(target, 'C:\\node.exe');
    expect(a.filter((x) => x === '-c')).toHaveLength(3);
    // a bare Windows path would not parse as TOML — the value has to be a quoted string
    expect(a).toContain('mcp_servers.claude-web-memory.command="C:\\\\node.exe"');
    const args = a.find((x) => x.startsWith('mcp_servers.claude-web-memory.args='))!;
    expect(() => JSON.parse(args.slice('mcp_servers.claude-web-memory.args='.length))).not.toThrow();
    expect(a.some((x) => x === 'mcp_servers.claude-web-memory.env={ELECTRON_RUN_AS_NODE = "1"}')).toBe(true);
  });

  // The official server-memory connector (in our own catalog) installs as `memory`; a host-passed server of the
  // same name replaces the user's, so ours must never be handed out under it — to any agent.
  it('never takes the name `memory` that the server-memory connector uses', () => {
    expect(MEMORY_MCP_NAME).not.toBe('memory');
    expect(Object.keys(claudeMcpServer(target))).toEqual([MEMORY_MCP_NAME]);
    expect(acpMcpServers(target).map((s) => s.name)).toEqual([MEMORY_MCP_NAME]);
    expect(codexConfigArgs(target).some((x) => x.startsWith('mcp_servers.memory.'))).toBe(false);
  });

  it('splices the overrides in front of the app-server subcommand', () => {
    const spliced = insertCodexConfig(['app-server'], target, 'C:\\node.exe');
    expect(spliced[0]).toBe('-c');
    expect(spliced[spliced.length - 1]).toBe('app-server');
    // a stand-in command with no subcommand is left exactly as configured
    expect(insertCodexConfig(['C:\\my-codex-shim.mjs'], target)).toEqual(['C:\\my-codex-shim.mjs']);
  });

  it('hands out nothing at all when the switch is off', () => {
    setMemoryMcpEnabled(false);
    expect(memoryMcpEnabled()).toBe(false);
    expect(claudeMcpServer(target)).toEqual({});
    expect(acpMcpServers(target)).toEqual([]);
    expect(codexConfigArgs(target)).toEqual([]);
  });
});
