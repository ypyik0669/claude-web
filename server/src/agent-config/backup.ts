// Backups for every write the config center makes to another agent's files:
// `<dataDir>/config-backups/<agent>/<ts>-<file>` plus an `index.jsonl` that remembers where each copy came from.
// `writeChecked` / `guard` are the only write paths: lock the file → back up (bytes) → write atomically (or let
// the CLI write) → re-parse → roll back to the original bytes on failure.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfigBackup, AgentConfigKind } from './types.js';
import { parseConfig, type ConfigFormat } from './edit.js';

const KINDS: AgentConfigKind[] = ['codex', 'gemini', 'qwen', 'opencode'];
const DEFAULT_KEEP = 100; // per agent, not counting each file's first backup (kept forever)
const POSIX = process.platform !== 'win32';

export function formatOf(file: string): ConfigFormat {
  return /\.toml$/i.test(file) ? 'toml' : 'json';
}

async function readOrNull(file: string): Promise<Buffer | null> {
  try { return await fs.readFile(file); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WriteOptions {
  /** file mode when the target doesn't exist yet (an existing file keeps its own permission bits) */
  mode?: number;
  /** test seam: the rename that commits the write */
  rename?: (from: string, to: string) => Promise<void>;
  retryDelayMs?: number;
}

export const BUSY_MESSAGE = '文件被占用（可能有 agent 正在运行），请关闭后重试';

/** Where a write to `file` must land: through symlinks (a dotfiles-managed config stays a link). */
async function realTarget(file: string): Promise<string> {
  try { return await fs.realpath(file); } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e;
    // a dangling link: write where it points, not over the link itself
    const link = await fs.readlink(file).catch(() => null);
    return link ? path.resolve(path.dirname(file), link) : file;
  }
}

/**
 * Write via a temp file next to the real target + rename, so a reader (or a crash) never sees half a file.
 * Symlinks are followed (the link stays a link) and the target's permission bits are kept (new files: 0600).
 * Windows refuses the rename while another process has the target open (EPERM / EBUSY / EACCES): retry a
 * bit, then fail with BUSY_MESSAGE.
 */
export async function atomicWrite(file: string, data: Buffer | string, opts: WriteOptions = {}): Promise<void> {
  const target = await realTarget(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const mode = await fs.stat(target).then((s) => s.mode & 0o7777, () => opts.mode ?? 0o600);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.cw-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  await fs.writeFile(tmp, data, { mode });
  if (POSIX) await fs.chmod(tmp, mode).catch(() => {}); // the umask may have narrowed it
  const rename = opts.rename ?? fs.rename;
  for (let i = 0; ; i++) {
    try { await rename(tmp, target); return; } catch (e: any) {
      const busy = ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code);
      if (i >= 8 || !busy) {
        await fs.rm(tmp, { force: true });
        throw busy ? Object.assign(new Error(BUSY_MESSAGE), { code: e.code }) : e;
      }
      await sleep((opts.retryDelayMs ?? 25) * (i + 1));
    }
  }
}

/** Text of a file for a targeted edit — refused unless it round-trips as UTF-8 (else the edit would rewrite other bytes). */
function utf8Text(buf: Buffer | null): string {
  if (!buf) return '';
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error('文件不是 UTF-8 编码，未修改');
  return text;
}

/** Parse check that tolerates a missing file and invalid UTF-8 (decoded lossily — only structure matters here). */
function checkParses(buf: Buffer, file: string) {
  parseConfig(buf.toString('utf8'), formatOf(file));
}

export class BackupStore {
  private locks = new Map<string, Promise<unknown>>();
  private readonly keep: number;

  private readonly writeOpts: WriteOptions;

  constructor(private readonly root: string, opts: { keep?: number; rename?: WriteOptions['rename']; retryDelayMs?: number } = {}) {
    this.keep = opts.keep ?? DEFAULT_KEEP;
    this.writeOpts = { rename: opts.rename, retryDelayMs: opts.retryDelayMs };
  }

  private write(file: string, data: Buffer | string) { return atomicWrite(file, data, this.writeOpts); }

  private dir(agent: AgentConfigKind) { return path.join(this.root, agent); }

  /** Serialize everything that touches `file` (edits, CLI runs, restores) — keyed by the normalized path. */
  private async locked<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const key = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    try { return await run; } finally { if (this.locks.get(key) === tail) this.locks.delete(key); }
  }

  private async mkdirPrivate(dir: string) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (POSIX) await fs.chmod(this.root, 0o700).catch(() => {});
    if (POSIX) await fs.chmod(dir, 0o700).catch(() => {});
  }

  /** Copy `file` aside byte for byte (caller holds the lock). Returns null when it doesn't exist. */
  private async backupUnlocked(agent: AgentConfigKind, file: string, reason: string, bytes?: Buffer | null): Promise<AgentConfigBackup | null> {
    const data = bytes === undefined ? await readOrNull(file) : bytes;
    if (data === null) return null;
    const dir = this.dir(agent);
    await this.mkdirPrivate(dir);
    const base = path.basename(file).replace(/[^\w.-]/g, '_');
    let name = `${stamp()}-${base}`;
    for (let i = 1; await fs.stat(path.join(dir, name)).then(() => true, () => false); i++) name = `${stamp()}-${i}-${base}`;
    await fs.writeFile(path.join(dir, name), data, { mode: 0o600 });
    const first = !(await this.list(agent)).some((e) => path.resolve(e.path) === path.resolve(file));
    const entry: AgentConfigBackup = { id: `${agent}/${name}`, agent, path: file, at: Date.now(), reason, size: data.length, ...(first ? { first: true } : {}) };
    await fs.appendFile(path.join(dir, 'index.jsonl'), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
    await this.prune(agent);
    return entry;
  }

  /** Copy `file` aside. Returns null when it doesn't exist (nothing to protect). */
  backup(agent: AgentConfigKind, file: string, reason: string): Promise<AgentConfigBackup | null> {
    return this.locked(file, () => this.backupUnlocked(agent, file, reason));
  }

  /**
   * Rewrite `file` through `edit(current)`: back up, write atomically, re-parse; if the result doesn't parse,
   * put the original bytes back (or remove the file if there was none) and throw.
   */
  writeChecked(agent: AgentConfigKind, file: string, edit: (current: string) => string, reason: string): Promise<AgentConfigBackup | null> {
    return this.locked(file, async () => {
      const original = await readOrNull(file);
      const next = edit(utf8Text(original));
      const entry = await this.backupUnlocked(agent, file, reason, original);
      try { await this.write(file, next); } catch (e) {
        await this.discard(entry); // nothing was written: don't list a backup for it
        throw e;
      }
      await this.verify(file, original);
      return entry;
    });
  }

  /** Drop a backup taken for a write that never happened (file + index line). */
  private async discard(entry: AgentConfigBackup | null) {
    if (!entry) return;
    await fs.rm(path.join(this.root, entry.id), { force: true });
    const kept = (await this.list(entry.agent)).filter((e) => e.id !== entry.id).reverse();
    await atomicWrite(path.join(this.dir(entry.agent), 'index.jsonl'), kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600 });
  }

  /**
   * Let something else (the agent's CLI) write `file`, with the same lock + backup + parse-or-roll-back around
   * it — also when `op` fails. `fix(current)` then runs inside the same lock and may return corrected text
   * (e.g. undo a CLI's lossy argument parsing); a throwing fix rolls everything back.
   */
  guard<T>(agent: AgentConfigKind, file: string, reason: string, op: () => Promise<T>, fix?: (current: string) => string | null): Promise<{ result: T; backup: AgentConfigBackup | null }> {
    return this.locked(file, async () => {
      const original = await readOrNull(file);
      const backup = await this.backupUnlocked(agent, file, reason, original);
      let result: T;
      try { result = await op(); } catch (e) {
        await this.verify(file, original).catch(() => {}); // restores on a broken leftover; the op's error wins
        throw e;
      }
      await this.verify(file, original);
      if (fix) {
        let next: string | null;
        try { next = fix(utf8Text(await readOrNull(file))); } catch (e: any) {
          await this.rollback(file, original);
          throw new Error(`${path.basename(file)} 纠正失败，已回滚：${e?.message ?? e}`);
        }
        if (next !== null) { await this.write(file, next); await this.verify(file, original); }
      }
      return { result, backup };
    });
  }

  private async rollback(file: string, original: Buffer | null) {
    if (original === null) await fs.rm(await realTarget(file), { force: true }); else await this.write(file, original);
  }

  private async verify(file: string, original: Buffer | null) {
    const now = await readOrNull(file);
    if (now === null || (original && now.equals(original))) return;
    try { checkParses(now, file); } catch (e: any) {
      await this.rollback(file, original);
      throw new Error(`写入后 ${path.basename(file)} 无法解析，已回滚：${e?.message ?? e}`);
    }
  }

  async list(agent?: AgentConfigKind): Promise<AgentConfigBackup[]> {
    const out: AgentConfigBackup[] = [];
    for (const k of agent ? [agent] : KINDS) {
      const idx = await readOrNull(path.join(this.dir(k), 'index.jsonl'));
      for (const line of (idx?.toString('utf8') ?? '').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as AgentConfigBackup;
          if (await fs.stat(path.join(this.root, e.id)).then(() => true, () => false)) out.push(e);
        } catch { /* torn line */ }
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** Put a backup back in place. The current file is backed up first, and the restored bytes must parse. */
  async restore(id: string): Promise<AgentConfigBackup> {
    const m = /^([a-z]+)\/([\w.-]+)$/.exec(id);
    if (!m || !KINDS.includes(m[1] as AgentConfigKind) || m[2] === 'index.jsonl') throw new Error(`无效的备份 id：${id}`);
    const entry = (await this.list(m[1] as AgentConfigKind)).find((e) => e.id === id);
    if (!entry) throw new Error(`备份不存在：${id}`);
    const bytes = await fs.readFile(path.join(this.root, id));
    checkParses(bytes, entry.path); // never restore something that doesn't parse
    await this.locked(entry.path, async () => {
      const original = await readOrNull(entry.path);
      const before = await this.backupUnlocked(entry.agent, entry.path, `恢复 ${path.basename(id)} 之前`, original);
      try { await this.write(entry.path, bytes); } catch (e) { await this.discard(before); throw e; }
      await this.verify(entry.path, original);
    });
    return entry;
  }

  /** Keep the newest `keep` backups per agent, plus every file's first backup (the state before we ever touched it). */
  private async prune(agent: AgentConfigKind) {
    const all = await this.list(agent);
    const rest = all.filter((e) => !e.first);
    if (rest.length <= this.keep) return;
    const drop = new Set(rest.slice(this.keep).map((e) => e.id));
    for (const id of drop) await fs.rm(path.join(this.root, id), { force: true });
    const kept = all.filter((e) => !drop.has(e.id)).reverse();
    await atomicWrite(path.join(this.dir(agent), 'index.jsonl'), kept.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  }
}
