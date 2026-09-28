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
/** a store hook call, with optional type arguments: `useStore(`, `useStore<State, X>(` */
const HOOK = /\b(useStore|useOrch|useOrchBusy|useDialogStore)\s*(?:<[^()]*?>)?\s*\(/g;
/** at the top level of an expression (callback bodies collapsed away): something that builds a new value */
const FRESH_TOP = /\?\?\s*[[{]|\|\|\s*[[{]|[?:]\s*[[{]|\.(filter|map|flatMap|slice|concat|sort|reverse|toSorted|toReversed|toSpliced|with)\(|\bObject\.(values|keys|entries|fromEntries|assign)\(|\bArray\.(from|of)\(|\bnew (Set|Map|Array|Date|URL)\b|\bstructuredClone\(|\bJSON\.parse\(/;

const OPEN = '([{';
const CLOSE = ')]}';

/** Index just past the string literal starting at `i` (quotes, template literals with `${}`). */
function skipString(s: string, i: number): number {
  const q = s[i];
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (q === '`' && s[k] === '$' && s[k + 1] === '{') { k = matchClose(s, k + 1) - 1; continue; }
    if (s[k] === q) return k + 1;
  }
  return s.length;
}

/** `s[i]` is an opening bracket: index just past its matching close (strings skipped). */
function matchClose(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'" || c === '`') { k = skipString(s, k) - 1; continue; }
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c) && --depth === 0) return k + 1;
  }
  return s.length;
}

/** Top-level shape of an expression: bracket contents collapsed to `…`, strings to `''`, whitespace squeezed. */
function collapse(e: string): string {
  let out = '';
  for (let k = 0; k < e.length; k++) {
    const c = e[k];
    if (c === '"' || c === "'" || c === '`') { k = skipString(e, k) - 1; out += "''"; continue; }
    if (OPEN.includes(c)) { const end = matchClose(e, k); out += `${c}…${e[end - 1] ?? ''}`; k = end - 1; continue; }
    out += c;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Index of `needle` at bracket depth 0 of `s` (strings skipped), or -1. */
function topIndexOf(s: string, needle: string, from = 0): number {
  for (let k = from; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'" || c === '`') { k = skipString(s, k) - 1; continue; }
    if (OPEN.includes(c)) { k = matchClose(s, k) - 1; continue; }
    if (s.startsWith(needle, k)) return k;
  }
  return -1;
}

/** Does evaluating `expr` hand back a value that is new on every call (and not a primitive)? */
function freshExpr(expr: string): boolean {
  const e = expr.trim().replace(/;$/, '');
  if (/^\(\s*\{/.test(e) || /^[[{]/.test(e) || /^\(\s*\[/.test(e)) return true; // an object / array literal
  const top = collapse(e);
  if (/^\(…\)$/.test(top)) return freshExpr(e.slice(1, -1)); // parenthesised expression
  // derivations that end in a primitive: a count, a boolean, a string / number fallback
  if (/^!|===|!==|==|!=|<=|>=|\s[<>]\s|\btypeof\b/.test(top)) return false;
  if (/\.(length|size)(\s*\?\?\s*\d+)?$/.test(top)) return false;
  if (/\.(some|every|includes|has|startsWith|endsWith|test)\(…\)$/.test(top)) return false;
  if (/\?\?\s*(''|-?\d+|true|false|null|undefined)$/.test(top)) return false;
  return FRESH_TOP.test(top);
}

/** The expressions a block body returns (`return x;` anywhere inside it). */
function returnedExprs(block: string): string[] {
  const out: string[] = [];
  for (const m of block.matchAll(/\breturn\b/g)) {
    const from = m.index! + 6;
    const semi = topIndexOf(block, ';', from);
    const end = semi >= 0 ? semi : block.length - 1;
    if (block.slice(from, end).trim()) out.push(block.slice(from, end));
  }
  return out;
}

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__fixtures__' ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Selectors in `src` that return a fresh array / object on every call (inline arrow selectors only). */
let scanned = 0;
function freshSelectorLines(src: string): { line: number; body: string }[] {
  const out: { line: number; body: string }[] = [];
  for (const m of src.matchAll(HOOK)) {
    const open = m.index! + m[0].length - 1;
    const arg = src.slice(open + 1, matchClose(src, open) - 1);
    const arrow = topIndexOf(arg, '=>'); // `(s) =>`, `(s: State) =>`, `({ open }) =>`; none: a named selector or useShallow(…)
    if (arrow < 0) continue;
    scanned++;
    const body = arg.slice(arrow + 2).trim();
    const fresh = body.startsWith('{') ? returnedExprs(body.slice(1, -1)).some(freshExpr) : freshExpr(body);
    if (fresh) out.push({ line: src.slice(0, m.index).split('\n').length, body: body.replace(/\s+/g, ' ') });
  }
  return out;
}

describe('zustand selectors return stable references', () => {
  it('no selector builds a fresh array / object per call', () => {
    const bad: string[] = [];
    scanned = 0;
    for (const f of files(SRC)) for (const { line, body } of freshSelectorLines(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(SRC, f)}:${line}  ${body.slice(0, 140)}`);
    expect(scanned).toBeGreaterThan(200); // the scan really parsed the codebase's selectors
    expect(bad, `selectors returning a new value every call (use a constant, useMemo or useShallow):\n${bad.join('\n')}`).toEqual([]);
  });

  // one selector per line; the comment says whether the scan must flag it
  const CASES = `
const a = useStore((s) => (s.settings['x'] as string[] | undefined) ?? []);        // fresh
const b = useStore((s) => ({ a: s.a, b: s.b }));                                   // fresh
const c = useStore((s) => [s.a, s.b]);                                             // fresh
const d = useStore((s: State) => s.list.filter((x) => x.on));                      // fresh
const e = useStore((s) => s.x ?? { a: 1 });                                        // fresh
const f = useStore((s) => Object.assign({}, s.a));                                 // fresh
const g = useStore((state) => { const o = state.open; return { n: o }; });         // fresh
const h = useStore(({ open }) => Object.values(open));                             // fresh
const i = useStore((s) => s.list.filter((x) => x.tags.includes(t)));               // fresh
const j = useStore((s) => (s.on ? s.list : []));                                   // fresh
const k = useStore((s: State) => [...s.a]);                                        // fresh
const l = useStore<State, string[]>((s) => s.a.map((x) => x.id));                  // fresh
const m = useStore((s) => s.x ?? NONE);                                            // stable
const n = useStore((s) => Object.values(s.open).filter(Boolean).length);           // stable
const o = useStore((s) => s.layout.groups.find((g) => g.id === s.id)?.name ?? ''); // stable
const p = useStore((s: State) => s.sessions.some((x) => x.sessionId === id));      // stable
const q = useStore((s) => s.toast);                                                // stable
const r = useStore((s) => { for (const x of s.list) if (x.id === id) return x; return undefined; }); // stable
const u = useStore(useShallow((s) => ({ a: s.a, b: s.b })));                       // stable
const v = useStore((s) => s.list.filter((x) => x.on).length > 0);                  // stable
const w = useStore((s) => (s.settings['k'] as string | undefined) ?? 'default');   // stable
`;
  it('the scan itself flags every fresh form and none of the stable ones', () => {
    const lines = CASES.split('\n');
    const want = lines.flatMap((l, i) => (/\/\/ fresh$/.test(l) ? [i + 1] : []));
    expect(freshSelectorLines(CASES).map((h) => h.line)).toEqual(want);
  });
});
