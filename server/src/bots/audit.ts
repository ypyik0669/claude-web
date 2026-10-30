import type { AuditRow } from '../protocol.js';
import type { BotStore } from './store.js';

/** One row per tool call. What the UI shows as "the bot did X" comes from here, never from the bot's own account. */
export class AuditLog {
  constructor(private store: BotStore) {}
  /** `at` defaults to now; the gate passes its own clock so the day a row counts for is the day it decided on */
  async add(row: Omit<AuditRow, 'at'> & { at?: number }): Promise<AuditRow> {
    const full: AuditRow = { ...row, at: row.at ?? Date.now() };
    await this.store.appendAudit(row.botId, row.runId, full);
    return full;
  }
}
