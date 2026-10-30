import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { BotStore } from './store.js';
import { Inbox } from './inbox.js';

describe('Inbox', () => {
  let root: string; let inbox: Inbox;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-inbox-')); inbox = new Inbox(new BotStore(root)); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('adds items newest first, counts only pending, emits on add and answer', async () => {
    const seen: string[] = []; inbox.on('item', (i) => seen.push(`${i.kind}:${i.done ? 'done' : 'open'}`));
    await inbox.add({ kind: 'finding', botId: 'b1', title: 'A' });
    const b = await inbox.add({ kind: 'approval', botId: 'b1', title: 'B', toolName: 'Bash', input: { command: 'git push' }, cls: 'send' });
    expect(inbox.list().map((i) => i.title)).toEqual(['B', 'A']);
    expect(inbox.pendingCount('b1')).toBe(2);
    const done = await inbox.answer({ id: b.id, answer: 'approve' });
    expect(done.done?.answer).toBe('approve');
    expect(inbox.pendingCount()).toBe(1);
    expect(inbox.list(undefined, true)).toHaveLength(2);
    expect(seen).toEqual(['finding:open', 'approval:open', 'approval:done']);
  });
  it('never expires: an item from long ago is still pending', async () => {
    await new BotStore(root).setInbox([{ id: 'i_old', kind: 'approval', botId: 'b1', title: 'old', at: 1 }]);
    const fresh = new Inbox(new BotStore(root));
    expect(fresh.list().map((i) => i.id)).toEqual(['i_old']);
    expect(fresh.pendingCount('b1')).toBe(1);
    expect(fresh.get('i_old')?.done).toBeUndefined();
  });
  it('answering twice or an unknown id throws', async () => {
    const i = await inbox.add({ kind: 'approval', botId: 'b1', title: 'x' });
    await inbox.answer({ id: i.id, answer: 'reject' });
    await expect(inbox.answer({ id: i.id, answer: 'approve' })).rejects.toThrow();
    await expect(inbox.answer({ id: 'nope', answer: 'approve' })).rejects.toThrow();
  });
  it('concurrent adds and answers all land on disk', async () => {
    const first = await inbox.add({ kind: 'approval', botId: 'b1', title: 'first' });
    await Promise.all([
      inbox.add({ kind: 'finding', botId: 'b1', title: 'one' }),
      inbox.add({ kind: 'draft', botId: 'b2', title: 'two' }),
      inbox.answer({ id: first.id, answer: 'approve' }),
      inbox.add({ kind: 'proposal', botId: 'b1', title: 'three' }),
    ]);
    const onDisk = new Inbox(new BotStore(root));
    expect(onDisk.list(undefined, true).map((i) => i.title).sort()).toEqual(['first', 'one', 'three', 'two']);
    expect(onDisk.get(first.id)?.done?.answer).toBe('approve');
  });
  it('a failed answer does not block later updates', async () => {
    await expect(inbox.answer({ id: 'nope', answer: 'approve' })).rejects.toThrow();
    await inbox.add({ kind: 'finding', botId: 'b1', title: 'after' });
    expect(new Inbox(new BotStore(root)).list().map((i) => i.title)).toEqual(['after']);
  });
});
