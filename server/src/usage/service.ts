import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { projectsDir } from '../sessions/service.js';
import type { ProviderType } from '../protocol.js';
import { claudePrice, inputIncludesCacheRead } from './pricing.js';

export interface UsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  costUsd: number;
}

/** The profile a transcript's session runs on (from meta), for per-provider buckets and usage fix-ups. */
export type SessionProviderLookup = (sessionId: string) => { type?: ProviderType; name?: string } | undefined;

const empty = (): UsageBucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0 });
const ACCOUNT = 'Claude 账号';

export interface SessionUsage {
  total: UsageBucket;
  byModel: Record<string, UsageBucket>;
  /** `<profile name> · <model>` (sessions without a profile: `Claude 账号 · <model>`) */
  byProvider: Record<string, UsageBucket>;
  turns: { ts: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }[];
}

async function scanFile(file: string, type: ProviderType | undefined, onTurn: (t: SessionUsage['turns'][number]) => void) {
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  const seen = new Set<string>();
  const dedupe = inputIncludesCacheRead(type);
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'assistant' || !rec.message?.usage) continue;
    // streaming writes several records per API message; count each message id once
    const id = rec.message.id ?? rec.uuid;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const u = rec.message.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const input = u.input_tokens ?? 0;
    const b = { input: dedupe ? Math.max(0, input - cacheRead) : input, output: u.output_tokens ?? 0, cacheRead, cacheWrite: u.cache_creation_input_tokens ?? 0 };
    const model = rec.message.model ?? 'unknown';
    onTurn({ ts: rec.timestamp, model, ...b, costUsd: claudePrice(model, b) });
  }
}

function add(b: UsageBucket, t: SessionUsage['turns'][number]) {
  b.input += t.input;
  b.output += t.output;
  b.cacheRead += t.cacheRead;
  b.cacheWrite += t.cacheWrite;
  b.turns++;
  b.costUsd += t.costUsd;
}

const sessionIdOf = (file: string) => path.basename(file).replace(/\.jsonl$/, '');

export class UsageService {
  private globalCache = new Map<string, { mtime: number; type?: ProviderType; turns: SessionUsage['turns'] }>();

  constructor(private lookup?: SessionProviderLookup) {}

  private provider(file: string) {
    return this.lookup?.(sessionIdOf(file));
  }

  async session(file: string): Promise<SessionUsage> {
    const out: SessionUsage = { total: empty(), byModel: {}, byProvider: {}, turns: [] };
    const p = this.provider(file);
    await scanFile(file, p?.type, (t) => {
      out.turns.push(t);
      add(out.total, t);
      add((out.byModel[t.model] ??= empty()), t);
      add((out.byProvider[`${p?.name ?? ACCOUNT} · ${t.model}`] ??= empty()), t);
    });
    return out;
  }

  async global(days = 30) {
    const since = Date.now() - days * 86400_000;
    const byDay: Record<string, UsageBucket> = {};
    const byModel: Record<string, UsageBucket> = {};
    const byProject: Record<string, UsageBucket> = {};
    const byProvider: Record<string, UsageBucket> = {};
    const total = empty();
    const dirs = await fs.readdir(projectsDir).catch(() => []);
    for (const d of dirs) {
      const dir = path.join(projectsDir, d);
      const files = await fs.readdir(dir).catch(() => []);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(dir, f);
        const st = await fs.stat(file).catch(() => null);
        if (!st || st.mtimeMs < since) continue;
        const p = this.provider(file);
        let entry = this.globalCache.get(file);
        if (!entry || entry.mtime !== st.mtimeMs || entry.type !== p?.type) {
          const turns: SessionUsage['turns'] = [];
          await scanFile(file, p?.type, (t) => turns.push(t));
          entry = { mtime: st.mtimeMs, type: p?.type, turns };
          this.globalCache.set(file, entry);
        }
        for (const t of entry.turns) {
          if (!t.ts || Date.parse(t.ts) < since) continue;
          const day = t.ts.slice(0, 10);
          add(total, t);
          add((byDay[day] ??= empty()), t);
          add((byModel[t.model] ??= empty()), t);
          add((byProject[d] ??= empty()), t);
          add((byProvider[`${p?.name ?? ACCOUNT} · ${t.model}`] ??= empty()), t);
        }
      }
    }
    return { days, total, byDay, byModel, byProject, byProvider };
  }
}
