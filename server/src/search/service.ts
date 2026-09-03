import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { SearchMatch, SearchOptions, SearchResult } from '../protocol.js';

const require = createRequire(import.meta.url);

/** ripgrep binary: ccb vendors one (dist/vendor/ripgrep/<arch>-<platform>/rg), else @vscode/ripgrep, else PATH. */
export function resolveRg(): string {
  const plat = `${process.arch}-${process.platform}`;
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  try {
    const pkg = require.resolve('claude-code-best/package.json');
    const p = path.join(path.dirname(pkg), 'dist', 'vendor', 'ripgrep', plat, exe);
    if (require('node:fs').existsSync(p)) return p;
  } catch { /* not installed */ }
  try {
    return require('@vscode/ripgrep').rgPath;
  } catch { /* not installed */ }
  return 'rg';
}

export class SearchService {
  private rg = resolveRg();

  /** Search files under `root`; returns matches grouped per file, capped by `maxResults` lines. */
  search(root: string, query: string, o: SearchOptions = {}): Promise<SearchResult> {
    return new Promise((resolve, reject) => {
      if (!query) return resolve({ files: [], total: 0, truncated: false });
      const args = ['--json', '--line-number', '--column', '--no-messages', '--max-columns', '400', '--max-columns-preview'];
      if (!o.regex) args.push('--fixed-strings');
      if (o.wholeWord) args.push('--word-regexp');
      args.push(o.caseSensitive ? '--case-sensitive' : '--ignore-case');
      if (o.includeHidden) args.push('--hidden');
      if (o.noIgnore) args.push('--no-ignore');
      for (const g of o.include ?? []) if (g.trim()) args.push('--glob', g.trim());
      for (const g of o.exclude ?? []) if (g.trim()) args.push('--glob', `!${g.trim()}`);
      args.push('--glob', '!.git', '--glob', '!node_modules', '-e', query, '--', root);
      const max = o.maxResults ?? 2000;
      const child = spawn(this.rg, args, { windowsHide: true });
      const files = new Map<string, SearchMatch[]>();
      let total = 0, truncated = false, buf = '';
      const onLine = (line: string) => {
        if (!line) return;
        let j: any;
        try { j = JSON.parse(line); } catch { return; }
        if (j.type !== 'match') return;
        const p = j.data.path.text as string;
        const text = (j.data.lines.text as string ?? '').replace(/\r?\n$/, '');
        const subs = (j.data.submatches as any[]).map((s) => ({ start: s.start as number, end: s.end as number }));
        const arr = files.get(p) ?? files.set(p, []).get(p)!;
        arr.push({ line: j.data.line_number as number, text, ranges: subs });
        total++;
        if (total >= max) { truncated = true; child.kill(); }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
      });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => reject(new Error(`ripgrep 不可用：${e.message}`)));
      child.on('close', (code) => {
        if (buf) onLine(buf);
        if (code !== 0 && code !== 1 && !truncated && err.trim()) return reject(new Error(err.trim().split('\n')[0]));
        resolve({ files: [...files].map(([p, matches]) => ({ path: p, matches })), total, truncated });
      });
    });
  }

  /** Replace matches. `targets` limits to specific files (and optionally lines); otherwise every match under root. */
  async replace(root: string, query: string, replacement: string, o: SearchOptions & { targets?: { path: string; lines?: number[] }[] } = {}): Promise<{ files: number; replacements: number }> {
    const res = await this.search(root, query, { ...o, maxResults: 100_000 });
    const want = o.targets ? new Map(o.targets.map((t) => [t.path, t.lines ? new Set(t.lines) : null])) : null;
    const flags = `g${o.caseSensitive ? '' : 'i'}`;
    const src = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(o.wholeWord ? `\\b(?:${src})\\b` : src, flags);
    let files = 0, replacements = 0;
    for (const f of res.files) {
      if (want && !want.has(f.path)) continue;
      const only = want?.get(f.path) ?? null;
      const raw = await fs.readFile(f.path, 'utf8');
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      const lines = raw.split(/\r?\n/);
      let changed = false;
      for (const m of f.matches) {
        if (only && !only.has(m.line)) continue;
        const idx = m.line - 1;
        if (idx >= lines.length) continue;
        const before = lines[idx];
        let n = 0;
        const after = before.replace(re, (...a) => { n++; return o.regex ? replacement.replace(/\$(\d)/g, (_, d) => a[Number(d)] ?? '') : replacement; });
        if (n) { lines[idx] = after; replacements += n; changed = true; }
      }
      if (changed) { await fs.writeFile(f.path, lines.join(eol), 'utf8'); files++; }
    }
    return { files, replacements };
  }
}
