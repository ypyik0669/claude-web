import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchTree, type TreeWatcher } from './watch-tree.js';
import { transcriptEvent } from '../sessions/service.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 5_000) {
  const t0 = Date.now();
  while (!ok() && Date.now() - t0 < ms) await sleep(25);
  return ok();
}

describe('watchTree', () => {
  let dir: string;
  let w: TreeWatcher | undefined;
  afterEach(() => {
    w?.close();
    w = undefined;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('reports a change deep in the tree with its relative path', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wt-'));
    fs.mkdirSync(path.join(dir, 'a', 'b', 'c', 'd'), { recursive: true });
    const seen: (string | null)[] = [];
    w = watchTree(dir, (rel) => seen.push(rel));
    await sleep(100);
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c', 'd', 'x.jsonl'), '{}\n');
    expect(await until(() => seen.some((r) => r !== null && r.replace(/\\/g, '/').endsWith('a/b/c/d/x.jsonl')))).toBe(true);
  });

  it('a directory that does not exist yet is watched once it appears; close stops everything', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wt-'));
    const target = path.join(dir, 'later');
    const seen: (string | null)[] = [];
    w = watchTree(target, (rel) => seen.push(rel), { pollMs: 50 });
    await sleep(120);
    expect(seen).toEqual([]);
    fs.mkdirSync(target);
    expect(await until(() => seen.includes(null))).toBe(true);
    fs.writeFileSync(path.join(target, 'y.jsonl'), '{}\n');
    expect(await until(() => seen.some((r) => r !== null && r.endsWith('y.jsonl')))).toBe(true);
    w.close();
    const n = seen.length;
    fs.writeFileSync(path.join(target, 'z.jsonl'), '{}\n');
    await sleep(300);
    expect(seen.length).toBe(n);
  });
});

describe('transcriptEvent', () => {
  it('counts project dirs, transcripts and session dirs directly in a project — nothing deeper, no memory', () => {
    expect(transcriptEvent('C--proj')).toBe(true);
    expect(transcriptEvent('C--proj\\3a8a4593.jsonl')).toBe(true);
    expect(transcriptEvent('C--proj/3a8a4593.jsonl')).toBe(true);
    expect(transcriptEvent('C--proj\\3a8a4593')).toBe(true);
    expect(transcriptEvent('C--proj\\3a8a4593\\subagents\\agent-1.jsonl')).toBe(false);
    expect(transcriptEvent('C--proj\\3a8a4593\\tool-results\\x.txt')).toBe(false);
    expect(transcriptEvent('C--proj\\notes.md')).toBe(false);
    expect(transcriptEvent('C--proj\\memory')).toBe(false);
    expect(transcriptEvent('C--proj\\memory\\MEMORY.md')).toBe(false);
    expect(transcriptEvent('')).toBe(false);
  });
});
