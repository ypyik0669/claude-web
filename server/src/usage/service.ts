import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { projectsDir } from '../sessions/service.js';
import { claudePrice, inputIncludesCacheRead, isClaudeModel } from './pricing.js';
import type { ProviderTimeline, TurnProvider } from './timeline.js';

export interface UsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  costUsd: number;
  /** turns whose cost is unknown (non-Claude models): costUsd leaves them out, the UI says 未知 rather than $0 */
  costUnknown: number;
}

/** Which profile answered each turn of a session (index.ts builds it from meta + the canonical switch marks). */
export type SessionProviderLookup = (sessionId: string) => Promise<ProviderTimeline | undefined>;

const empty = (): UsageBucket => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, costUsd: 0, costUnknown: 0 });
const ACCOUNT: TurnProvider = { name: 'Claude 账号' };

export interface SessionUsage {
  total: UsageBucket;
  byModel: Record<string, UsageBucket>;
  /** `<profile name> · <model>`, per turn (a session that switched profiles lands in several) */
  byProvider: Record<string, UsageBucket>;
  turns: { ts: string; model: string; provider: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; costUnknown: boolean }[];
}

async function scanFile(file: string, at: (ts: number) => TurnProvider, onTurn: (t: SessionUsage['turns'][number]) => void) {
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
    const p = at(rec.timestamp ? Date.parse(rec.timestamp) : Date.now());
    const u = rec.message.usage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const input = u.input_tokens ?? 0;
    const b = { input: inputIncludesCacheRead(p.type) ? Math.max(0, input - cacheRead) : input, output: u.output_tokens ?? 0, cacheRead, cacheWrite: u.cache_creation_input_tokens ?? 0 };
    const model = rec.message.model ?? 'unknown';
    const tokens = b.input + b.output + b.cacheRead + b.cacheWrite;
    onTurn({ ts: rec.timestamp, model, provider: p.name, ...b, costUsd: claudePrice(model, b), costUnknown: tokens > 0 && !isClaudeModel(model) });
  }
}

function add(b: UsageBucket, t: SessionUsage['turns'][number]) {
  b.input += t.input;
  b.output += t.output;
  b.cacheRead += t.cacheRead;
  b.cacheWrite += t.cacheWrite;
  b.turns++;
  b.costUsd += t.costUsd;
  if (t.costUnknown) b.costUnknown++;
}

const sessionIdOf = (file: string) => path.basename(file).replace(/\.jsonl$/, '');

export class UsageService {
  private globalCache = new Map<string, { mtime: number; key: string; turns: SessionUsage['turns'] }>();

  constructor(private lookup?: SessionProviderLookup) {}

  private async timeline(file: string): Promise<ProviderTimeline> {
    return (await this.lookup?.(sessionIdOf(file)).catch(() => undefined)) ?? { at: () => ACCOUNT, key: '' };
  }

  async session(file: string): Promise<SessionUsage> {
    const out: SessionUsage = { total: empty(), byModel: {}, byProvider: {}, turns: [] };
    const tl = await this.timeline(file);
    await scanFile(file, tl.at, (t) => {
      out.turns.push(t);
      add(out.total, t);
      add((out.byModel[t.model] ??= empty()), t);
      add((out.byProvider[`${t.provider} · ${t.model}`] ??= empty()), t);
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
        const tl = await this.timeline(file);
        let entry = this.globalCache.get(file);
        if (!entry || entry.mtime !== st.mtimeMs || entry.key !== tl.key) {
          const turns: SessionUsage['turns'] = [];
          await scanFile(file, tl.at, (t) => turns.push(t));
          entry = { mtime: st.mtimeMs, key: tl.key, turns };
          this.globalCache.set(file, entry);
        }
        for (const t of entry.turns) {
          if (!t.ts || Date.parse(t.ts) < since) continue;
          const day = t.ts.slice(0, 10);
          add(total, t);
          add((byDay[day] ??= empty()), t);
          add((byModel[t.model] ??= empty()), t);
          add((byProject[d] ??= empty()), t);
          add((byProvider[`${t.provider} · ${t.model}`] ??= empty()), t);
        }
      }
    }
    return { days, total, byDay, byModel, byProject, byProvider };
  }
}
