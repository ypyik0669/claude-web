import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryService } from './service.js';
import { harvest } from './extract.js';
import type { CanonicalEvent } from '../session/canonical.js';

describe('MemoryService', () => {
  let dir: string;
  let mem: MemoryService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mem-'));
    mem = new MemoryService(path.join(dir, 'memory.db'));
  });
  afterEach(() => {
    mem.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('finds a project memory by text and counts the hit', () => {
    mem.write({ scope: 'project', key: '/repo', kind: 'decision', text: '用 pnpm 而不是 npm，因为 workspace 链接更快' });
    const hits = mem.search({ q: 'pnpm', cwd: '/repo' });
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('decision');
    expect(mem.get(hits[0].id)!.hits).toBe(1);
  });

  it('scopes by project but always includes global', () => {
    mem.write({ scope: 'project', key: '/a', text: '只在 A 项目成立' });
    mem.write({ scope: 'project', key: '/b', text: '只在 B 项目成立' });
    mem.write({ scope: 'global', text: '到哪都成立' });
    const a = mem.search({ cwd: '/a' }).map((m) => m.text);
    expect(a).toContain('只在 A 项目成立');
    expect(a).toContain('到哪都成立');
    expect(a).not.toContain('只在 B 项目成立');
  });

  it('treats a restated fact as the same memory', () => {
    const first = mem.write({ scope: 'project', key: '/repo', text: '端口固定 3090' });
    const again = mem.write({ scope: 'project', key: '/repo', text: '端口固定 3090' });
    expect(again.id).toBe(first.id);
    expect(mem.stats().total).toBe(1);
    expect(mem.get(first.id)!.hits).toBe(1);
  });

  it('is case- and path-separator-insensitive about the project key', () => {
    mem.write({ scope: 'project', key: 'C:\\Repo\\App', text: 'windows 路径' });
    expect(mem.search({ cwd: 'c:/repo/app' }).map((m) => m.text)).toContain('windows 路径');
  });

  it('ranks pinned entries first', () => {
    mem.write({ scope: 'project', key: '/repo', text: '普通的一条' });
    mem.write({ scope: 'project', key: '/repo', text: '重要的一条', pinned: true });
    expect(mem.search({ cwd: '/repo' })[0].text).toBe('重要的一条');
  });

  it('matches a Chinese phrase in the middle of a sentence', () => {
    // FTS5's tokenizer makes the whole sentence one token, so this has to fall back to substring
    mem.write({ scope: 'project', key: '/repo', text: '停靠面板最小化时绝对不能卸载面板，否则终端会丢' });
    expect(mem.search({ q: '最小化', cwd: '/repo' })).toHaveLength(1);
    expect(mem.search({ q: '卸载面板', cwd: '/repo' })).toHaveLength(1);
    expect(mem.search({ q: '不存在的词', cwd: '/repo' })).toHaveLength(0);
  });

  it('survives punctuation that would break a raw FTS query', () => {
    mem.write({ scope: 'project', key: '/repo', text: 'grep 的 [/\\\\] 字符类会解析失败' });
    expect(() => mem.search({ q: '[/\\] "unbalanced', cwd: '/repo' })).not.toThrow();
    expect(mem.search({ q: 'grep', cwd: '/repo' })).toHaveLength(1);
  });

  it('updates and deletes', () => {
    const m = mem.write({ scope: 'project', key: '/repo', text: '旧的说法' });
    mem.update(m.id, { text: '新的说法', pinned: true, tags: ['x'] });
    expect(mem.get(m.id)).toMatchObject({ text: '新的说法', pinned: true, tags: ['x'] });
    expect(mem.remove(m.id)).toBe(true);
    expect(mem.get(m.id)).toBeUndefined();
  });
});

describe('harvest', () => {
  let dir: string;
  let mem: MemoryService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-mem2-'));
    mem = new MemoryService(path.join(dir, 'memory.db'));
  });
  afterEach(() => {
    mem.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const events: CanonicalEvent[] = [
    { t: 1, kind: 'user', text: '换个构建工具' },
    { t: 2, kind: 'tool', id: 'a', name: 'Bash', input: { command: 'npm run build' }, ok: false, result: 'ENOSPC: no space left on device' },
    { t: 3, kind: 'assistant', text: '我决定改用 vite，因为 webpack 的配置在这个仓库里已经无法维护。另外这里必须保留 CommonJS 入口，否则打包脚本会挂。' },
    { t: 4, kind: 'tool', id: 'b', name: 'Edit', input: { file_path: '/repo/vite.config.ts' }, ok: true },
    { t: 5, kind: 'result', ms: 100 },
  ];

  it('keeps dead ends, decisions and constraints — and nothing else', () => {
    const r = harvest(mem, events, { cwd: '/repo', sessionId: 's1', agent: 'claude' });
    expect(r.written).toBeGreaterThanOrEqual(3);
    const kinds = mem.search({ cwd: '/repo', limit: 50 }).map((m) => m.kind);
    expect(kinds).toContain('deadend');
    expect(kinds).toContain('decision');
    expect(kinds).toContain('constraint');
    // the successful edit is on disk already; it must not become a memory
    expect(mem.search({ q: 'vite.config', cwd: '/repo' })).toHaveLength(0);
  });

  it('caps how much one session can write', () => {
    const noisy: CanonicalEvent[] = Array.from({ length: 40 }, (_, i) => ({ t: i, kind: 'tool', id: `t${i}`, name: 'Bash', input: { command: `cmd-${i}` }, ok: false, result: `失败原因 ${i}` }));
    const r = harvest(mem, noisy, { cwd: '/repo', sessionId: 's2' });
    expect(r.written).toBe(12);
    expect(r.skipped).toBeGreaterThan(0);
  });
});
