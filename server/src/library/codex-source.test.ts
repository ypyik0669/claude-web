import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodexSource, desktopCodexBin, rolloutTurnOpen } from './codex-source.js';
import { libraryId } from './ids.js';
import { LazyRpc } from './lazy-rpc.js';
import { JsonRpcProcess } from '../agents/jsonrpc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mock = path.join(here, '..', 'agents', '__mocks__', 'codex-server.mjs');

/** no desktop app's Codex: these tests talk only to the mock (the real one may be installed on this machine) */
const none = () => undefined;

function launch() {
  return { command: process.execPath, args: [mock], env: {} };
}

describe('a thread stored by a newer Codex than the configured one (「paginated_threads is not supported yet」)', () => {
  const old = () => ({ ...launch(), env: { MOCK_CODEX_NO_PAGINATED: '1' } });
  it('is read with the desktop app\'s own Codex — pages and the delete backup alike', async () => {
    const src = new CodexSource(old, launch);
    try {
      const page = await src.read('thr-b', { limit: 20 });
      expect(page.messages.length).toBeGreaterThan(0);
      expect(page.next).toBeTruthy();
      expect(((await src.exportAll('thr-b')) as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await src.close();
    }
  });
  it('without a newer Codex on the machine: says what to do instead of Codex\'s own words', async () => {
    const src = new CodexSource(old, () => undefined);
    try {
      await expect(src.read('thr-b', { limit: 20 })).rejects.toThrow(/npm i -g @openai\/codex@latest/);
      await expect(src.exportAll('thr-b')).rejects.toThrow(/npm i -g @openai\/codex@latest/);
    } finally {
      await src.close();
    }
  });
  it('the desktop app\'s Codex gone since, or too old as well: the same advice — never an empty history', async () => {
    const alsoOld = () => ({ ...launch(), env: { MOCK_CODEX_NO_PAGINATED: '1', CW_SECOND: '1' } });
    for (const newer of [() => ({ command: 'definitely-not-a-real-codex-binary-xyz', args: [], env: {} }), alsoOld]) {
      const src = new CodexSource(old, newer);
      try {
        await expect(src.read('thr-b', { limit: 20 })).rejects.toThrow(/npm i -g @openai\/codex@latest/);
        await expect(src.exportAll('thr-b')).rejects.toThrow(/npm i -g @openai\/codex@latest/);
      } finally {
        await src.close();
      }
    }
  });
  it('the desktop app\'s Codex: the newest build under %LOCALAPPDATA%\\OpenAI\\Codex\\bin', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codexbin-'));
    try {
      const bin = path.join(root, 'OpenAI', 'Codex', 'bin');
      for (const [b, ago] of [['aaa', 3000], ['bbb', 1000], ['ccc', 2000]] as const) {
        await fs.mkdir(path.join(bin, b), { recursive: true });
        const f = path.join(bin, b, 'codex.exe');
        await fs.writeFile(f, '');
        const t = new Date(Date.now() - ago * 1000);
        await fs.utimes(f, t, t);
      }
      await fs.mkdir(path.join(bin, 'empty'), { recursive: true });
      expect(desktopCodexBin({ LOCALAPPDATA: root }, 'win32')).toBe(path.join(bin, 'bbb', 'codex.exe'));
      expect(desktopCodexBin({ LOCALAPPDATA: path.join(root, 'nope') }, 'win32')).toBeUndefined();
      expect(desktopCodexBin({}, 'linux')).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('CodexSource (mock app-server)', () => {
  it('lists threads newest-first, paginates, and maps a subAgent thread parentId', async () => {
    const src = new CodexSource(launch, none);
    try {
      const page1 = await src.list({ limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.next).toBeTruthy();
      // newest updatedAt first: thr-c, then thr-b (see mock fixtures)
      expect(page1.items[0].sessionId).toBe(libraryId('codex', 'thr-c'));
      expect(page1.items[1].sessionId).toBe(libraryId('codex', 'thr-b'));
      // the subAgent thread's parentId points at thr-a's library id
      expect(page1.items[0].parentId).toBe(libraryId('codex', 'thr-a'));
      // thr-c's wire source is the real object shape `{subAgent:{...}}`, not a bare string
      expect(page1.items[0].source).toBe('subAgent');
      expect(page1.items[0].agent).toBe('codex');

      // thr-a (plain 'cli' string) and thr-d (`{custom:'my-tool'}`, the oldest) make up the tail page
      const page2 = await src.list({ limit: 2, cursor: page1.next });
      expect(page2.items).toHaveLength(2);
      expect(page2.items[0].sessionId).toBe(libraryId('codex', 'thr-a'));
      expect(page2.items[0].source).toBe('cli');
      expect(page2.items[1].sessionId).toBe(libraryId('codex', 'thr-d'));
      expect(page2.items[1].source).toBe('my-tool');
      expect(page2.next).toBeUndefined();
    } finally {
      await src.close();
    }
  });

  it('reads a long thread in pages of turns, most-recent page first, older pages via next', async () => {
    const src = new CodexSource(launch, none);
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
    const src = new CodexSource(launch, none);
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

  it('not installed: status disabled, list() / read() empty (nothing to list, not a failure)', async () => {
    const src = new CodexSource(() => ({ command: 'definitely-not-a-real-codex-binary-xyz', args: [], env: {} }), none);
    try {
      const status = await src.status();
      expect(status.enabled).toBe(false);
      const listed = await src.list({ limit: 10 });
      expect(listed.items).toEqual([]);
      expect((await src.read('t', { limit: 10 })).messages).toEqual([]);
    } finally {
      await src.close();
    }
  });

  it('installed but thread/list errors: list() and read() reject so the library keeps its last good list', async () => {
    const src = new CodexSource(() => ({ ...launch(), env: { CW_FAIL_LIST: '1' } }), none);
    try {
      await expect(src.list({ limit: 10 })).rejects.toThrow(/mock thread\/list failure/);
      await expect(src.read('t', { limit: 10 })).rejects.toThrow(/failure/);
    } finally {
      await src.close();
    }
  });

  it('a thread Codex has no history for ("thread not loaded"): a clear error, not the raw one; a deleted file is not listed', async () => {
    const src = new CodexSource(() => ({ ...launch(), env: { MOCK_CODEX_DELETED: '1' } }), none);
    try {
      // listed by Codex's index, but its file is gone (user report: deleted conversations were listed)
      const all = (await src.list({ limit: 50 })).items.map((x) => x.sessionId);
      expect(all).toContain(libraryId('codex', 'thr-a'));
      expect(all).not.toContain(libraryId('codex', 'thr-x'));
      // reading one anyway (a list from before, an id from elsewhere): what that means, in words
      const err = await src.read('thr-x', { limit: 20 }).catch((e) => e);
      expect(err).toMatchObject({ code: 'THREAD_GONE' });
      expect(err.message).toMatch(/删除|还没保存第一条消息/);
      expect(err.message).not.toMatch(/thread not loaded/);
      await expect(src.read('never-existed', { limit: 20 })).rejects.toMatchObject({ code: 'THREAD_GONE' });
    } finally {
      await src.close();
    }
  });

  it('an app-server without the paged read (codex 0.130: "requires experimentalApi"): the whole thread from thread/read', async () => {
    const src = new CodexSource(() => ({ ...launch(), env: { MOCK_CODEX_OLD: '1' } }), none);
    try {
      const r = await src.read('thr-b', { limit: 20 });
      expect(r.next).toBeUndefined();
      const text = JSON.stringify(r.messages);
      expect(text).toContain('reply 249');
      expect(text).toContain('reply 0');
      expect(((await src.exportAll('thr-b')) as unknown[]).length).toBe(250); // the backup before a delete still works
    } finally {
      await src.close();
    }
  });

  it('installed but the process crashes: list() rejects', async () => {
    const src = new CodexSource(() => ({ command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} }), none);
    try {
      await expect(src.list({ limit: 10 })).rejects.toThrow();
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

describe('rolloutTurnOpen', () => {
  const ev = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } });
  it('the last turn started and has not ended yet', () => {
    expect(rolloutTurnOpen([ev('task_started'), ev('task_complete'), ev('task_started')].join(' '))).toBe(true);
    expect(rolloutTurnOpen([ev('task_started'), ev('task_complete')].join(' '))).toBe(false);
    expect(rolloutTurnOpen([ev('task_started'), ev('turn_aborted')].join(' '))).toBe(false);
    expect(rolloutTurnOpen(ev('token_count'))).toBe(false);
  });
});

describe("the list comes from the desktop app's Codex when it is there (an older `codex` on PATH misses what a newer one stored)", () => {
  // the configured one lists nothing (an old CLI that can't read the new storage), the desktop app's lists the threads
  const old = () => ({ ...launch(), env: { CW_FAIL_LIST: '1' } });
  it("lists with the desktop app's Codex, and its next page goes back to it", async () => {
    const src = new CodexSource(old, launch);
    try {
      const first = await src.list({ limit: 1 });
      expect(first.items.length).toBe(1);
      expect(first.next?.startsWith('desktop:')).toBe(true);
      const second = await src.list({ limit: 1, cursor: first.next });
      expect(second.items.length).toBe(1);
      expect(second.items[0].sessionId).not.toBe(first.items[0].sessionId);
    } finally {
      await src.close();
    }
  });
  it("the desktop app's Codex failing: the configured one lists", async () => {
    const src = new CodexSource(launch, () => ({ command: 'definitely-not-a-real-codex-binary-xyz', args: [], env: {} }));
    try {
      expect((await src.list({ limit: 5 })).items.length).toBeGreaterThan(0);
    } finally {
      await src.close();
    }
  });
});
