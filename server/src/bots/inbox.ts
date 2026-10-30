import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { InboxAnswer, InboxItem } from '../protocol.js';
import type { BotStore } from './store.js';
import { tr } from '../i18n/index.js';

/**
 * 收件箱: approvals, findings, drafts, proposals from every bot. Nothing here expires.
 * One instance per BotStore: it reads inbox.json once and then owns it, so a second Inbox on the same store
 * would overwrite the first one's items.
 */
export class Inbox extends EventEmitter {
  private items: InboxItem[];
  /** every update is check → write → commit on this chain, so two concurrent add() / answer() never lose an item */
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private store: BotStore) { super(); this.items = store.inbox(); }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  list(botId?: string, includeDone = false): InboxItem[] {
    return this.items.filter((i) => (!botId || i.botId === botId) && (includeDone || !i.done)).sort((a, b) => b.at - a.at);
  }
  pendingCount(botId?: string) { return this.list(botId).length; }
  get(id: string) { return this.items.find((i) => i.id === id); }

  add(item: Omit<InboxItem, 'id' | 'at'>): Promise<InboxItem> {
    return this.serial(async () => {
      const full: InboxItem = { id: `i_${randomBytes(4).toString('hex')}`, at: Date.now(), ...item };
      const next = [...this.items, full];
      await this.store.setInbox(next);
      this.items = next;
      this.emit('item', full);
      return full;
    });
  }

  /** marks the item done; throws when it is unknown or already answered */
  answer(a: InboxAnswer): Promise<InboxItem> {
    return this.serial(async () => {
      const i = this.get(a.id);
      if (!i) throw new Error(tr('收件箱里没有这一条'));
      if (i.done) throw new Error(tr('这一条已经处理过了'));
      const updated: InboxItem = { ...i, done: { at: Date.now(), answer: a.answer } };
      const next = this.items.map((x) => (x === i ? updated : x));
      await this.store.setInbox(next);
      this.items = next;
      this.emit('item', updated);
      return updated;
    });
  }
}
