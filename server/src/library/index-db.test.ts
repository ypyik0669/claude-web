import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryIndex } from './index-db.js';
import type { SessionSummary } from '../protocol.js';

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    title: patch.title ?? id,
    cwd: patch.cwd ?? '/work/claude-web',
    lastModified: patch.lastModified ?? Date.now(),
    agent: patch.agent,
    ...patch,
  };
}

describe('LibraryIndex', () => {
  let dir: string;
  let idx: LibraryIndex;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-libidx-'));
    idx = new LibraryIndex(path.join(dir, 'library.db'));
  });
  afterEach(() => {
    idx.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('indexes English and Chinese sessions across agents', () => {
    idx.upsert(summary('s1', { agent: 'claude', cwd: '/work/claude-web' }), 'let us refactor the search index for speed');
    idx.upsert(summary('s2', { agent: 'claude', cwd: '/work/claude-web' }), '把最小化窗口改成托盘，这样点关闭就不会退出程序了');
    idx.upsert(summary('s3', { agent: 'codex', cwd: '/work/other' }), 'refactor the codex adapter to use the official API');

    const zh = idx.search('托盘', { limit: 10 });
    expect(zh).toHaveLength(1);
    expect(zh[0].id).toBe('s2');
    expect(zh[0].snippet).toContain('托盘');

    const codexOnly = idx.search('refactor', { limit: 10, agent: 'codex' });
    expect(codexOnly.map((r) => r.id)).toEqual(['s3']);
  });

  it('parses agent: and in: prefixes out of the raw query', () => {
    expect(LibraryIndex.parseQuery('agent:codex in:claude-web 登录')).toEqual({
      q: '登录',
      agent: 'codex',
      cwdLike: 'claude-web',
    });
  });

  it('updates indexedAt when the same id is upserted again', () => {
    idx.upsert(summary('s1', { lastModified: 1000 }), 'first pass text');
    expect(idx.indexedAt('s1')).toBe(1000);
    idx.upsert(summary('s1', { lastModified: 2000 }), 'second pass text, revised');
    expect(idx.indexedAt('s1')).toBe(2000);
  });

  it('recovers from a corrupt database file', () => {
    const file = path.join(dir, 'broken.db');
    fs.writeFileSync(file, 'not a sqlite file at all, just garbage bytes');
    const recovered = new LibraryIndex(file);
    recovered.upsert(summary('s1'), 'still works after recovery');
    expect(recovered.search('works', { limit: 10 })).toHaveLength(1);
    recovered.close();
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(backups.length).toBeGreaterThan(0);
  });

  it('removes a session from the index', () => {
    idx.upsert(summary('s1'), 'removable text about pandas');
    expect(idx.search('pandas', { limit: 10 })).toHaveLength(1);
    idx.remove('s1');
    expect(idx.search('pandas', { limit: 10 })).toHaveLength(0);
    expect(idx.indexedAt('s1')).toBeUndefined();
  });

  it('removeAgent drops all sessions from that source', () => {
    idx.upsert(summary('c1', { agent: 'codex' }), 'codex session one about builds');
    idx.upsert(summary('c2', { agent: 'codex' }), 'codex session two about builds');
    idx.upsert(summary('k1', { agent: 'claude' }), 'claude session about builds');
    idx.removeAgent('codex');
    expect(idx.search('builds', { limit: 10 }).map((r) => r.id).sort()).toEqual(['k1']);
    expect(idx.indexedAt('c1')).toBeUndefined();
    expect(idx.indexedAt('c2')).toBeUndefined();
  });

  it('returns no results for a query that is only punctuation', () => {
    idx.upsert(summary('s1'), 'hello world');
    expect(idx.search('"*-:', { limit: 10 })).toEqual([]);
  });

  it('filters by cwdLike case-insensitively', () => {
    idx.upsert(summary('s1', { cwd: '/work/Claude-Web' }), 'cwd filter test alpha');
    idx.upsert(summary('s2', { cwd: '/work/other-repo' }), 'cwd filter test beta');
    const hits = idx.search('filter', { limit: 10, cwdLike: 'claude-web' });
    expect(hits.map((r) => r.id)).toEqual(['s1']);
  });
});
