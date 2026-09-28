import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { dataDir } from '../files/service.js';
import type { LedgerEntry, ProviderType } from '../protocol.js';
import { inputIncludesCacheRead, trustsCliCost } from './pricing.js';

/**
 * Traffic ledger: one line per model turn (`result` message) plus API retries / errors, appended to
 * ~/.claude-web/ledger.jsonl. Independent of the transcripts so it survives session deletion and captures
 * latency (duration_api_ms), cache hit sizes and failures that never reach a transcript.
 */
export class LedgerService {
  private file = path.join(dataDir(), 'ledger.jsonl');
  private queue: string[] = [];
  private flushing = false;

  /** providerType: a session's profile type by id (index.ts reads it from meta) — decides usage / cost fix-ups. */
  constructor(private providerType?: (providerId: string) => ProviderType | undefined) {}

  private async flush() {
    if (this.flushing || !this.queue.length) return;
    this.flushing = true;
    const chunk = this.queue.join('');
    this.queue = [];
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, chunk, 'utf8');
    } catch { /* ignore */ }
    this.flushing = false;
    if (this.queue.length) void this.flush();
  }

  record(e: LedgerEntry) {
    this.queue.push(JSON.stringify(e) + '\n');
    void this.flush();
  }

  /** Feed raw SDK messages of a session here. */
  observe(sessionId: string, m: any, providerId?: string) {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'result') {
      const u = m.usage ?? {};
      const models = m.modelUsage ? Object.keys(m.modelUsage) : [];
      const model = models[0] ?? '';
      const type = providerId ? this.providerType?.(providerId) : undefined;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const input = u.input_tokens ?? 0;
      const unknown = !!m.cost_unknown || !trustsCliCost(type, model);
      this.record({
        ts: Date.now(),
        sessionId,
        model,
        durationMs: m.duration_ms ?? 0,
        apiMs: m.duration_api_ms,
        input: inputIncludesCacheRead(type) ? Math.max(0, input - cacheRead) : input,
        output: u.output_tokens ?? 0,
        cacheRead,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        // ccb prices every model with Claude's table: meaningless for other vendors' models (0 + costUnknown)
        costUsd: unknown ? 0 : m.total_cost_usd ?? 0,
        ...(unknown ? { costUnknown: true } : {}),
        ok: !m.is_error,
        error: m.is_error ? (m.subtype ?? m.terminal_reason ?? 'error') : undefined,
        turns: m.num_turns,
        providerId,
      });
    } else if (m.type === 'system' && m.subtype === 'api_retry') {
      this.record({ ts: Date.now(), sessionId, model: '', durationMs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, ok: false, error: `retry ${m.error_status ?? ''} ${m.error ?? ''}`.trim(), providerId });
    }
  }

  async list(days = 7, sessionId?: string): Promise<LedgerEntry[]> {
    const since = Date.now() - days * 86400_000;
    const out: LedgerEntry[] = [];
    try {
      const rl = readline.createInterface({ input: createReadStream(this.file, 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        let e: LedgerEntry;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.ts < since) continue;
        if (sessionId && e.sessionId !== sessionId) continue;
        out.push(e);
      }
    } catch { /* no ledger yet */ }
    return out;
  }

  async exportCsv(days = 30): Promise<string> {
    const rows = await this.list(days);
    const head = ['time', 'sessionId', 'provider', 'model', 'ok', 'error', 'durationMs', 'apiMs', 'input', 'output', 'cacheRead', 'cacheWrite', 'costUsd', 'turns', 'source', 'gatewayMember', 'switches'];
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [head.join(','), ...rows.map((r) => [new Date(r.ts).toISOString(), r.sessionId, r.providerId ?? 'claude', r.model, r.ok, r.error, r.durationMs, r.apiMs, r.input, r.output, r.cacheRead, r.cacheWrite, r.costUsd, r.turns, r.kind ?? 'session', r.gateway?.member, r.gateway?.switches].map(esc).join(','))];
    const dir = path.join(dataDir(), 'exports');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `ledger-${new Date().toISOString().slice(0, 10)}.csv`);
    await fs.writeFile(file, '﻿' + lines.join('\n'), 'utf8');
    return file;
  }
}
