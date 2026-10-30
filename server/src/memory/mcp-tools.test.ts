import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryService } from './service.js';
import { memoryCall, memoryTools } from './mcp-tools.js';

describe('memory MCP tools', () => {
  let dir: string;
  let mem: MemoryService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-memtools-'));
    mem = new MemoryService(path.join(dir, 'memory.db'));
  });
  afterEach(() => {
    mem.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('a bot run writes to its own bot scope by default — what the pipeline reads back into its prompt', () => {
    memoryCall(mem, { cwd: '/repo', sessionId: 's1', botId: 'b1' }, 'memory_write', { text: '周报发给 #team 频道' });
    // the pipeline's read (bots/service.ts memories)
    expect(mem.search({ scope: 'bot', botId: 'b1', q: '周报', limit: 8 }).map((m) => m.text)).toEqual(['周报发给 #team 频道']);
    expect(mem.search({ scope: 'bot', botId: 'b2', limit: 8 })).toEqual([]);
    // and its own search / list see it
    const found = memoryCall(mem, { cwd: '/elsewhere', botId: 'b1' }, 'memory_search', { query: '周报' });
    expect(found.content[0].text).toContain('周报发给');
    expect(memoryCall(mem, { cwd: '/elsewhere', botId: 'b1' }, 'memory_list', { scope: 'bot' }).content[0].text).toContain('周报发给');
  });

  it('only a bot run has the bot scope', () => {
    expect(JSON.stringify(memoryTools('b1'))).toContain('"bot"');
    const write = memoryTools('b1').find((t) => t.name === 'memory_write')!;
    expect((write.inputSchema.properties as any).scope.enum).toEqual(['bot']);
    expect(JSON.stringify(memoryTools())).not.toContain('"bot"');
    expect(() => memoryCall(mem, { cwd: '/repo' }, 'memory_write', { text: 'x', scope: 'bot' })).toThrow(/bot/);
    memoryCall(mem, { cwd: '/repo' }, 'memory_write', { text: 'plain' });
    expect(mem.search({ scope: 'project', cwd: '/repo' }).map((m) => m.text)).toEqual(['plain']);
  });
});
