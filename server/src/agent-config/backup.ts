// Backups for every write the config center makes to another agent's files:
// `<dataDir>/config-backups/<agent>/<ts>-<file>` plus an `index.jsonl` that remembers where each copy came from.
// `writeChecked` / `guard` are the only write paths: back up → write (or let the CLI write) → re-parse →
// roll back on failure.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfigBackup, AgentConfigKind } from './types.js';
import { parseConfig, type ConfigFormat } from './edit.js';

const KINDS: AgentConfigKind[] = ['codex', 'gemini', 'qwen', 'opencode'];
const KEEP = 100; // per agent

export function formatOf(file: string): ConfigFormat {
  return /\.toml$/i.test(file) ? 'toml' : 'json';
}

async function readOrNull(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

export class BackupStore {
  constructor(private readonly root: string) {}

  private dir(agent: AgentConfigKind) { return path.join(this.root, agent); }

  /** Copy `file` aside. Returns null when it doesn't exist (nothing to protect). */
  async backup(agent: AgentConfigKind, file: string, reason: string): Promise<AgentConfigBackup | null> {
    const text = await readOrNull(file);
    if (text === null) return null;
    const dir = this.dir(agent);
    await fs.mkdir(dir, { recursive: true });
    const base = path.basename(file).replace(/[^\w.-]/g, '_');
    let name = `${stamp()}-${base}`;
    for (let i = 1; await fs.stat(path.join(dir, name)).then(() => true, () => false); i++) name = `${stamp()}-${i}-${base}`;
    await fs.writeFile(path.join(dir, name), text, 'utf8');
    const entry: AgentConfigBackup = { id: `${agent}/${name}`, agent, path: file, at: Date.now(), reason, size: Buffer.byteLength(text) };
    await fs.appendFile(path.join(dir, 'index.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
    await this.prune(agent);
    return entry;
  }

  /**
   * Rewrite `file` through `edit(current)`: back up, write, re-parse; if the result doesn't parse, put the
   * original back (or remove the file if there was none) and throw.
   */
  async writeChecked(agent: AgentConfigKind, file: string, edit: (current: string) => string, reason: string): Promise<AgentConfigBackup | null> {
    const original = await readOrNull(file);
    const next = edit(original ?? '');
    const entry = await this.backup(agent, file, reason);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, next, 'utf8');
    await this.verify(file, original);
    return entry;
  }

  /** Let something else (the agent's CLI) write `file`, with the same backup + parse-or-roll-back around it. */
  async guard<T>(agent: AgentConfigKind, file: string, reason: string, op: () => Promise<T>): Promise<{ result: T; backup: AgentConfigBackup | null }> {
    const original = await readOrNull(file);
    const backup = await this.backup(agent, file, reason);
    const result = await op();
    await this.verify(file, original);
    return { result, backup };
  }

  private async verify(file: string, original: string | null) {
    const now = await readOrNull(file);
    if (now === null || now === original) return;
    try { parseConfig(now, formatOf(file)); } catch (e: any) {
      if (original === null) await fs.rm(file, { force: true }); else await fs.writeFile(file, original, 'utf8');
      throw new Error(`写入后 ${path.basename(file)} 无法解析，已回滚：${e?.message ?? e}`);
    }
  }

  async list(agent?: AgentConfigKind): Promise<AgentConfigBackup[]> {
    const out: AgentConfigBackup[] = [];
    for (const k of agent ? [agent] : KINDS) {
      const idx = await readOrNull(path.join(this.dir(k), 'index.jsonl'));
      for (const line of (idx ?? '').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as AgentConfigBackup;
          if (await fs.stat(path.join(this.root, e.id)).then(() => true, () => false)) out.push(e);
        } catch { /* torn line */ }
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** Put a backup back in place. The current file is backed up first, and the restored text must parse. */
  async restore(id: string): Promise<AgentConfigBackup> {
    const m = /^([a-z]+)\/([\w.-]+)$/.exec(id);
    if (!m || !KINDS.includes(m[1] as AgentConfigKind) || m[2] === 'index.jsonl') throw new Error(`无效的备份 id：${id}`);
    const entry = (await this.list(m[1] as AgentConfigKind)).find((e) => e.id === id);
    if (!entry) throw new Error(`备份不存在：${id}`);
    const text = await fs.readFile(path.join(this.root, id), 'utf8');
    parseConfig(text, formatOf(entry.path)); // never restore something that doesn't parse
    await this.writeChecked(entry.agent, entry.path, () => text, `恢复 ${path.basename(id)} 之前`);
    return entry;
  }

  private async prune(agent: AgentConfigKind) {
    const all = await this.list(agent);
    if (all.length <= KEEP) return;
    const keep = all.slice(0, KEEP);
    for (const e of all.slice(KEEP)) await fs.rm(path.join(this.root, e.id), { force: true });
    await fs.writeFile(path.join(this.dir(agent), 'index.jsonl'), keep.reverse().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }
}
