import { afterEach, describe, expect, it } from 'vitest';
import { claudeMcpServer, MEMORY_MCP_NAME, memoryMcpEnabled, setMemoryMcpEnabled } from './launcher.js';

const target = { cwd: 'C:\\repo\\app', sessionId: 's1', agent: 'claude' };

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

  // The official server-memory connector (in our own catalog) installs as `memory`; a host-passed server of the
  // same name replaces the user's, so ours must never be handed out under it.
  it('never takes the name `memory` that the server-memory connector uses', () => {
    expect(MEMORY_MCP_NAME).not.toBe('memory');
    expect(Object.keys(claudeMcpServer(target))).toEqual([MEMORY_MCP_NAME]);
  });

  it('hands out nothing at all when the switch is off', () => {
    setMemoryMcpEnabled(false);
    expect(memoryMcpEnabled()).toBe(false);
    expect(claudeMcpServer(target)).toEqual({});
  });
});
