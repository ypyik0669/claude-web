import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodexSource } from './codex-source.js';
import { libraryId } from './ids.js';
import { LazyRpc } from './lazy-rpc.js';
import { JsonRpcProcess } from '../agents/jsonrpc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = path.join(here, '..', 'agents', '__mocks__', 'codex-server.mjs');

function launch() {
  return { command: process.execPath, args: [mock], env: {} };
}

describe('CodexSource (mock app-server)', () => {
  it('lists threads newest-first, paginates, and maps a subAgent thread parentId', async () => {
    const src = new CodexSource(launch);
    try {
      const page1 = await src.list({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.next).toBeTruthy();
      // newest updatedAt first: thr-c, then thr-b (see mock fixtures)
      expect(page1.items[0].sessionId).toBe(libraryId('codex', 'thr-c'));
      expect(page1.items[1].sessionId).toBe(libraryId('codex', 'thr-b'));
      // the subAgent thread's parentId points at thr-a's library id
      expect(page1.items[0].parentId).toBe(libraryId('codex', 'thr-a'));
      expect(page1.items[0].source).toBe('subAgent');
      expect(page1.items[0].agent).toBe('codex');

      const page2 = await src.list({ limit: 2, cursor: page1.next });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].sessionId).toBe(libraryId('codex', 'thr-a'));
      expect(page2.next).toBeUndefined();
    } finally {
      await src.close();
    }
  });

  it('reads a long thread in pages of turns, most-recent page first, older pages via next', async () => {
    const src = new CodexSource(launch);
    try {
      const page1 = await src.read('thr-b', { limit: 20 });
      expect(page1.messages.length).toBeGreaterThan(0);
      expect(page1.next).toBeTruthy();
      // last turn in the thread is msg/reply 249 — the most-recent page should contain it
      const texts1 = JSON.stringify(page1.messages);
      expect(texts1).toContain('reply 249');

      const page2 = await src.read('thr-b', { limit: 20, cursor: page1.next });
      expect(page2.messages.length).toBeGreaterThan(0);
      const texts2 = JSON.stringify(page2.messages);
      // an older page: should not contain the newest reply, should contain an earlier one
      expect(texts2).not.toContain('reply 249');
      expect(texts2).toContain('reply 229');
    } finally {
      await src.close();
    }
  });

  it('renames, archives/unarchives, and forks a thread via the official thread/* API', async () => {
    const src = new CodexSource(launch);
    try {
      await src.rename!('thr-a', 'renamed title');
      const afterRename = await src.list({ limit: 10 });
      const a = afterRename.items.find((i) => i.sessionId === libraryId('codex', 'thr-a'));
      expect(a?.title).toBe('renamed title');

      await src.archive!('thr-a', true);
      const defaultList = await src.list({ limit: 10 });
      expect(defaultList.items.some((i) => i.sessionId === libraryId('codex', 'thr-a'))).toBe(false);
      const archivedList = await src.list({ limit: 10, archived: true });
      expect(archivedList.items.some((i) => i.sessionId === libraryId('codex', 'thr-a'))).toBe(true);

      await src.archive!('thr-a', false);
      const before = await src.list({ limit: 10 });
      const newId = await src.fork!('thr-a');
      expect(newId).toBeTruthy();
      const after = await src.list({ limit: 10 });
      expect(after.items.length).toBe(before.items.length + 1);
      expect(after.items.some((i) => i.sessionId === libraryId('codex', newId))).toBe(true);
    } finally {
      await src.close();
    }
  });

  it('reports a broken launch as not enabled, without throwing, and list() degrades to empty', async () => {
    const src = new CodexSource(() => ({ command: 'definitely-not-a-real-codex-binary-xyz', args: [], env: {} }));
    try {
      const status = await src.status();
      expect(status.enabled).toBe(false);
      const listed = await src.list({ limit: 10 });
      expect(listed.items).toEqual([]);
    } finally {
      await src.close();
    }
  });

  it('LazyRpc kills the idle process and respawns it on the next request', async () => {
    // Each spawn of the mock is a brand-new Node process with its own memory, so "was it restarted"
    // can't be read from an in-process counter — the mock persists initCount to this file instead,
    // so a genuine respawn shows up as the file's count going from 1 (first process) to 2 (second).
    const countFile = path.join(os.tmpdir(), `cw-lazyrpc-initcount-${process.pid}-${Date.now()}.txt`);
    let spawned = 0;
    const rpc = new LazyRpc(
      () => { spawned++; return new JsonRpcProcess(process.execPath, [mock], { env: { CW_INIT_COUNT_FILE: countFile } }); },
      async (p) => { await p.request('initialize', { clientInfo: { name: 'test' }, capabilities: null }, 10_000); p.notify('initialized', {}); },
      50,
    );
    try {
      await rpc.request('debug/initCount', {}, 10_000);
      expect(spawned).toBe(1);
      await new Promise((r) => setTimeout(r, 120));
      const r = await rpc.request<{ count: number }>('debug/initCount', {}, 10_000);
      expect(spawned).toBe(2); // LazyRpc spawned a second process
      expect(r.count).toBe(2); // ...and that second process really did run its own `initialize`
    } finally {
      await rpc.close();
      await fs.rm(countFile, { force: true });
    }
  });
});
