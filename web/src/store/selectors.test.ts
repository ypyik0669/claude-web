import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression guard for React #185 ("Maximum update depth exceeded") white screens: a zustand selector
 * must return a stable reference. `useStore((s) => s.x ?? [])`, `.filter(…)`, `({ … })` etc. build a new
 * value on every call, zustand sees "changed" on every store update and re-renders forever.
 * Use a module-level constant (`?? NONE`), select the raw value and derive with useMemo, or `useShallow`.
 */
const SRC = path.resolve(__dirname, '..');
const HOOKS = /\b(useStore|useOrch|useOrchBusy|useDialogStore)\s*\(\s*\(?\s*\w+\s*\)?\s*=>/g;
const FRESH = /\?\?\s*\[\]|\?\?\s*\{\}|\|\|\s*\[\]|\|\|\s*\{\}|\.filter\(|\.map\(|Object\.(values|keys|entries|fromEntries)\(|=>\s*\(\{|=>\s*\[|\[\.\.\.|\.slice\(|\.concat\(|new (Set|Map)\b|\.sort\(|\.reverse\(/;
/** derivations that end in a primitive are fine: a count, a boolean, a string */
const PRIMITIVE = /(\.length|\.size)\s*$|^!!|\.(some|every|includes)\([^]*\)\s*$|\?\?\s*(''|0|false|null|undefined)\s*$/;

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** The selector's source text: from the arrow to the call's closing parenthesis. */
function selectorBodies(src: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  for (const m of src.matchAll(HOOKS)) {
    let depth = 1;
    let k = src.indexOf('(', m.index!) + 1;
    const start = k;
    for (; k < src.length && depth > 0; k++) {
      const c = src[k];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
    }
    const body = src.slice(start, k - 1).replace(/^\s*\(?\s*\w+\s*\)?\s*=>\s*/, '').replace(/\s+/g, ' ').trim();
    out.push({ line: src.slice(0, m.index).split('\n').length, body });
  }
  return out;
}

describe('zustand selectors return stable references', () => {
  it('no selector builds a fresh array / object per call', () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      for (const { line, body } of selectorBodies(fs.readFileSync(f, 'utf8'))) {
        if (FRESH.test(body) && !PRIMITIVE.test(body)) bad.push(`${path.relative(SRC, f)}:${line}  ${body.slice(0, 140)}`);
      }
    }
    expect(bad, `selectors returning a new value every call (use a constant, useMemo or useShallow):\n${bad.join('\n')}`).toEqual([]);
  });

  it('the scan itself catches the white-screen pattern', () => {
    const src = "const a = useStore((s) => (s.settings['x'] as string[] | undefined) ?? []);\nconst n = useStore((s) => Object.values(s.open).filter(Boolean).length);";
    const hits = selectorBodies(src).filter(({ body }) => FRESH.test(body) && !PRIMITIVE.test(body));
    expect(hits.map((h) => h.line)).toEqual([1]);
  });
});
