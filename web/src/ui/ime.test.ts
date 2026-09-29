import fs from 'node:fs';
import path from 'node:path';
import { parseAst } from 'vite';
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

const SRC = path.resolve(__dirname, '..');
const sources = (dir = SRC, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
};

describe('every IME check goes through imeComposing()', () => {
  it('no handler reads isComposing on its own (Safari needs the keyCode 229 check too)', () => {
    const bad: string[] = [];
    for (const p of sources()) {
      if (p === path.join(SRC, 'ui', 'ime.ts')) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (/\bisComposing\b/.test(line)) bad.push(`${path.relative(SRC, p)}:${i + 1}`); });
    }
    expect(bad).toEqual([]);
  });

  // macOS (Chrome and Safari): the Enter / Escape that commits or cancels pinyin arrives as key 'Enter' / 'Escape'
  // (Windows reports 'Process'), so a text field that acts on those keys must leave the IME's alone
  it("every <input> / <textarea> whose inline onKeyDown acts on Enter or Escape checks imeComposing()", () => {
    type N = { type?: string; start: number; end: number; [k: string]: any };
    const bad: string[] = [];
    let checked = 0;
    for (const p of sources()) {
      if (!p.endsWith('.tsx')) continue;
      const src = fs.readFileSync(p, 'utf8');
      const walk = (x: unknown): void => {
        if (!x || typeof x !== 'object') return;
        if (Array.isArray(x)) { for (const y of x) walk(y); return; }
        const n = x as N;
        if (n.type === 'JSXOpeningElement' && ['input', 'textarea'].includes(n.name?.name)) {
          for (const a of n.attributes ?? []) {
            const fn = a.type === 'JSXAttribute' && a.name?.name === 'onKeyDown' ? a.value?.expression : null;
            if (!fn || !/Function/.test(fn.type)) continue; // a named handler (the composer's onKey) is checked where it is written
            const text = src.slice(fn.start, fn.end);
            if (!/['"](Enter|Escape)['"]/.test(text)) continue;
            checked++;
            if (!/\bimeComposing\(/.test(text)) bad.push(`${path.relative(SRC, p)}:${src.slice(0, n.start).split('\n').length}`);
          }
        }
        for (const k of Object.keys(n)) if (k !== 'type' && k !== 'start' && k !== 'end') walk(n[k]);
      };
      walk(parseAst(src, { lang: 'tsx' }));
    }
    expect(checked).toBeGreaterThan(10); // the scan found the fields it is about
    expect(bad).toEqual([]);
  });
});
