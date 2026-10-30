import type { AuditRow } from '../protocol.js';
import type { BotStore } from './store.js';

/** One row per tool call. What the UI shows as "the bot did X" comes from here, never from the bot's own account. */
export class AuditLog {
  constructor(private store: BotStore) {}
  async add(row: Omit<AuditRow, 'at'>): Promise<AuditRow> {
    const full: AuditRow = { at: Date.now(), ...row };
    await this.store.appendAudit(row.botId, row.runId, full);
    return full;
  }
}
