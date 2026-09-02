import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { projectsDir } from '../sessions/service.js';

export interface UsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  costUsd: number;
}

// USD per million tokens: [input, output, cacheWrite, cacheRead]. Best-effort estimate.
const PRICING: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [15, 75, 18.75, 1.5]],
  [/opus/, [15, 75, 18.75, 1.5]],
  [/sonnet/, [3, 15, 3.75, 0.3]],
  [/haiku/, [1, 5, 1.25, 0.1]],
];

function price(model: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  const p = PRICING.find(([re]) => re.test(model))?.[1] ?? [3, 15, 3.75, 0.3];
  return (u.input * p[0] + u.output * p[1] + u.cacheWrite * p[2] + u.cacheRead * p[3]) / 1e6;
}

const empty = (): UsageBucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0 });

export interface SessionUsage {
  total: UsageBucket;
  byModel: Record<string, UsageBucket>;
  turns: { ts: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }[];
}

async function scanFile(file: string, onTurn: (t: SessionUsage['turns'][number]) => void) {
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  const seen = new Set<string>();
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
    const b = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
    const model = rec.message.model ?? 'unknown';
    onTurn({ ts: rec.timestamp, model, ...b, costUsd: price(model, b) });
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

export class UsageService {
  private globalCache = new Map<string, { mtime: number; turns: SessionUsage['turns'] }>();

  async session(file: string): Promise<SessionUsage> {
    const out: SessionUsage = { total: empty(), byModel: {}, turns: [] };
    await scanFile(file, (t) => {
      out.turns.push(t);
      add(out.total, t);
      add((out.byModel[t.model] ??= empty()), t);
    });
    return out;
  }

  async global(days = 30) {
    const since = Date.now() - days * 86400_000;
    const byDay: Record<string, UsageBucket> = {};
    const byModel: Record<string, UsageBucket> = {};
    const byProject: Record<string, UsageBucket> = {};
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
        let entry = this.globalCache.get(file);
        if (!entry || entry.mtime !== st.mtimeMs) {
          const turns: SessionUsage['turns'] = [];
          await scanFile(file, (t) => turns.push(t));
          entry = { mtime: st.mtimeMs, turns };
          this.globalCache.set(file, entry);
        }
        for (const t of entry.turns) {
          if (!t.ts || Date.parse(t.ts) < since) continue;
          const day = t.ts.slice(0, 10);
          add(total, t);
          add((byDay[day] ??= empty()), t);
          add((byModel[t.model] ??= empty()), t);
          add((byProject[d] ??= empty()), t);
        }
      }
    }
    return { days, total, byDay, byModel, byProject };
  }
}
