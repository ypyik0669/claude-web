import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { imeComposing } from './ime';

describe('imeComposing', () => {
  it('a composing keydown (Chrome / Firefox) belongs to the IME', () => {
    expect(imeComposing({ isComposing: true, keyCode: 229 })).toBe(true);
  });
  it("Safari's committing Enter — after compositionend, isComposing false — is still the IME's (keyCode 229)", () => {
    expect(imeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });
  it('a plain Enter / Escape is not', () => {
    expect(imeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(imeComposing({ isComposing: false, keyCode: 27 })).toBe(false);
    expect(imeComposing({})).toBe(false);
  });
});

describe('every IME check goes through imeComposing()', () => {
  it('no handler reads isComposing on its own (Safari needs the keyCode 229 check too)', () => {
    const src = path.resolve(__dirname, '..');
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && p !== path.join(src, 'ui', 'ime.ts')) {
          fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (/\bisComposing\b/.test(line)) bad.push(`${path.relative(src, p)}:${i + 1}`); });
        }
      }
    };
    walk(src);
    expect(bad).toEqual([]);
  });
});
