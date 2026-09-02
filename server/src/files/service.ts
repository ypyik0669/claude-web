import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

const execFileAsync = promisify(execFile);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export interface ChangedFile {
  path: string;
  ops: number;
  tools: string[];
  lastTs?: string;
}

export class FilesService {
  /** Files touched by Edit/Write tools in a session transcript. */
  async changed(file: string): Promise<ChangedFile[]> {
    const m = new Map<string, ChangedFile>();
    const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"tool_use"')) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name)) continue;
        const p = b.input?.file_path ?? b.input?.notebook_path;
        if (!p) continue;
        const e: ChangedFile = m.get(p) ?? { path: p, ops: 0, tools: [] };
        e.ops++;
        if (!e.tools.includes(b.name)) e.tools.push(b.name);
        e.lastTs = rec.timestamp;
        m.set(p, e);
      }
    }
    return [...m.values()];
  }

  /** git diff for a file relative to HEAD; falls back to full content when not in a repo. */
  async diff(filePath: string) {
    const dir = path.dirname(filePath);
    try {
      const { stdout: root } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, windowsHide: true });
      const cwd = root.trim();
      const { stdout } = await execFileAsync('git', ['diff', '--no-color', 'HEAD', '--', filePath], { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      if (stdout.trim()) return { kind: 'diff' as const, text: stdout };
      // untracked?
      const { stdout: st } = await execFileAsync('git', ['status', '--porcelain', '--', filePath], { cwd, windowsHide: true });
      if (st.startsWith('??')) return { kind: 'new' as const, text: await fs.readFile(filePath, 'utf8') };
      return { kind: 'unchanged' as const, text: '' };
    } catch {
      const text = await fs.readFile(filePath, 'utf8').catch(() => '');
      return { kind: 'content' as const, text };
    }
  }

  async list(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.git'))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  async read(p: string) {
    const st = await fs.stat(p);
    if (st.size > 2 * 1024 * 1024) throw new Error('file too large');
    return fs.readFile(p, 'utf8');
  }
}
