// A list reload that nobody awaits fails with "connection closed" when the link drops before its reply — a phone in
// the shell opens and closes its tunnel, and the store reloads the lists on every connect. Unhandled, that is a console
// error (scripts/shell-smoke.cjs fails on any): each such call catches, the next connect loads the lists again.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [p] : [];
  });
}

describe('fire-and-forget list reloads catch their rejection', () => {
  it('no `void …refreshSessions()` / `void …loadMeta()` without .catch', () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/\bvoid\s+[\w.()]*\b(refreshSessions|loadMeta)\(\)(?!\.catch\()/.test(l)) bad.push(`${path.relative(SRC, f)}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
