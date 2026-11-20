// 更新内容 (spec 2026-10-16 pages §4; the official app's What's new): the newest versions of the app's own changelog,
// in the interface language. The two files sit at the app root (electron-builder `files`, the repository in dev).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// server/src/app (and server/dist/app once built) → the app root
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The first `n` version sections (`## [x.y.z] …` up to the next one), without the file's own heading and intro. A
 * section not released yet (`## [Unreleased]` / `## [未发布]`, renamed to its version when it ships) is left out:
 * 更新内容 is about versions people can have. It always sits on top, so the released ones are one run after it.
 */
export function latestSections(text: string, n = 5): string {
  const t = text.replace(/\r\n/g, '\n');
  const starts: number[] = [];
  for (const m of t.matchAll(/^## \[(?!Unreleased\]|未发布\])/gim)) starts.push(m.index!);
  if (!starts.length) return '';
  const end = starts.length > n ? starts[n] : t.length;
  return t.slice(starts[0], end).trim();
}

export function readChangelog(lang: string, n = 5, root = ROOT): string {
  const files = lang.startsWith('zh') ? ['CHANGELOG.zh-CN.md', 'CHANGELOG.md'] : ['CHANGELOG.md'];
  for (const f of files) {
    try { return latestSections(fs.readFileSync(path.join(root, f), 'utf8'), n); } catch { /* the next one */ }
  }
  return '';
}
