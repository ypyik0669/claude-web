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

/** Indices of the depth-0 characters of `s` (strings and bracket contents skipped). */
function topChars(s: string): number[] {
  const out: number[] = [];
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'" || c === '`') { k = skipString(s, k) - 1; continue; }
    if (OPEN.includes(c)) { k = matchClose(s, k) - 1; continue; }
    out.push(k);
  }
  return out;
}

/** `cond ? a : b` at the top level → [a, b] (nested ternaries in b stay in b), else null. `?.` / `??` are not it. */
function splitTernary(e: string): [string, string] | null {
  const at = topChars(e);
  const isQ = (k: number) => e[k] === '?' && e[k + 1] !== '.' && e[k + 1] !== '?' && e[k - 1] !== '?';
  const q = at.find(isQ);
  if (q === undefined) return null;
  let depth = 0;
  for (const k of at) {
    if (k <= q) continue;
    if (isQ(k)) depth++;
    else if (e[k] === ':' && depth-- === 0) return [e.slice(q + 1, k), e.slice(k + 1)];
  }
  return null;
}

/** Split at every top-level occurrence of one of `ops` (longest first): `a || b ?? c` → [a, b, c]. */
function splitTop(e: string, ops: string[]): string[] {
  const parts: string[] = [];
  let from = 0;
  const at = topChars(e);
  for (let i = 0; i < at.length; i++) {
    const k = at[i];
    if (k < from) continue;
    const op = ops.find((o) => e.startsWith(o, k) && at.includes(k + o.length - 1));
    if (op) { parts.push(e.slice(from, k)); from = k + op.length; }
  }
  parts.push(e.slice(from));
  return parts;
}

// a `.slice(…)` on something that is plainly a string (ids, names, paths…) makes a string, not a new array
const STRINGISH = /(?:^|[^A-Za-z0-9_$])(?:[a-z]*(?:[Ii]d|ID|[Nn]ame|[Tt]itle|[Tt]ext|[Pp]ath|[Cc]wd|[Uu]rl|URL|[Mm]essage|[Ll]abel|[Mm]odel|[Vv]ersion|[Kk]ey|[Dd]raft|[Qq]uery|[Pp]rompt|[Ss]tr)|String\(…\)|''|\.(?:toString|trim|toLowerCase|toUpperCase|join)\(…\))$/;
// methods whose result is a primitive (boolean / number / string)
const PRIMITIVE_TAIL = /(?:\.(?:length|size)|\.(?:some|every|includes|has|startsWith|endsWith|test|indexOf|lastIndexOf|findIndex|join|toString|toFixed|trim|trimStart|trimEnd|toLowerCase|toUpperCase|padStart|padEnd|repeat|replace|replaceAll|charAt|normalize|localeCompare)\(…\))$/;

/** Does evaluating `expr` hand back a value that is new on every call (and not a primitive)? */
function freshExpr(expr: string): boolean {
  const e = expr.trim().replace(/;$/, '').trim();
  if (!e) return false;
  // `c ? a : b` — either branch may be what the selector returns (the condition never is)
  const tern = splitTernary(e);
  if (tern) return tern.some(freshExpr);
  // `a || b` / `a ?? b` — any alternative may be returned; `a && b` — only b can be an object
  const alts = splitTop(e, ['||', '??']);
  const ands = alts.map((a) => splitTop(a, ['&&']));
  if (alts.length > 1 || ands[0].length > 1) return ands.some((parts) => freshExpr(parts[parts.length - 1]));
  if (/^\(\s*\{/.test(e) || /^[[{]/.test(e) || /^\(\s*\[/.test(e)) return true; // an object / array literal
  const top = collapse(e);
  if (/^\(…\)$/.test(top)) return freshExpr(e.slice(1, -1)); // parenthesised expression
  // a primitive: negation / comparison / typeof (no top-level `?` is left to confuse it), a primitive-returning tail
  if (/^!|===|!==|==|!=|<=|>=|\s[<>]\s|\btypeof\b/.test(top)) return false;
  if (PRIMITIVE_TAIL.test(top)) return false;
  const slice = /^(.*?)\??\.slice\(…\)$/.exec(top);
  if (slice && STRINGISH.test(slice[1])) return false;
  return FRESH_TOP.test(top);
}

/** Is the `{` at `k` the body of a function (arrow, `function`, method shorthand) rather than a control-flow block? */
function isFunctionBody(s: string, k: number): boolean {
  const before = s.slice(0, k).trimEnd();
  if (before.endsWith('=>')) return true;
  if (!before.endsWith(')')) return false;
  // find the `(` that opens this parameter / condition list
  let depth = 0;
  let i = before.length - 1;
  for (; i >= 0; i--) {
    if (before[i] === ')') depth++;
    else if (before[i] === '(' && --depth === 0) break;
  }
  const head = before.slice(0, Math.max(0, i)).trimEnd();
  if (/\bfunction\s*\*?\s*[\w$]*$/.test(head)) return true;
  const word = /([\w$]+)$/.exec(head)?.[1];
  return !!word && !['if', 'for', 'while', 'switch', 'catch', 'with'].includes(word); // `name(args) {` = a method
}

/** The expressions a block body itself returns — not the returns of callbacks / functions nested in it. */
function returnedExprs(block: string): string[] {
  const out: string[] = [];
  for (let k = 0; k < block.length; k++) {
    const c = block[k];
    if (c === '"' || c === "'" || c === '`') { k = skipString(block, k) - 1; continue; }
    if (c === '{' && isFunctionBody(block, k)) { k = matchClose(block, k) - 1; continue; }
    if (block.startsWith('return', k) && !/[\w$]/.test(block[k - 1] ?? '') && !/[\w$]/.test(block[k + 6] ?? '')) {
      // the expression runs to `;` at its own level, or to the `}` / `)` that closes the enclosing block
      let depth = 0;
      let end = k + 6;
      for (; end < block.length; end++) {
        const ch = block[end];
        if (ch === '"' || ch === "'" || ch === '`') { end = skipString(block, end) - 1; continue; }
        if (OPEN.includes(ch)) depth++;
        else if (CLOSE.includes(ch) && --depth < 0) break;
        else if (ch === ';' && depth === 0) break;
      }
      if (block.slice(k + 6, end).trim()) out.push(block.slice(k + 6, end));
      k = end;
    }
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
const a2 = useStore((s) => (s.a === 1 ? [] : s.b));                                // fresh
const b2 = useStore((s) => s.mode !== 'x' ? s.list : s.list.filter(Boolean));      // fresh
const c2 = useStore((s) => s.n > 0 && s.list.map((x) => x.id));                    // fresh
const d2 = useStore((s) => s.count > 0 || Object.keys(s.map));                     // fresh
const e2 = useStore((s) => s.ready && { n: s.n });                                 // fresh
const f2 = useStore((s) => { if (s.a) { return [s.a]; } return NONE; });           // fresh
const g2 = useStore((s) => s.sessions.slice(0, 6));                                // fresh
const h2 = useStore((s) => s.list.filter(Boolean) || NONE);                        // fresh
const i2 = useStore((s) => s.activeId?.slice(0, 8));                               // stable
const j2 = useStore((s) => s.title.slice(0, 20).toUpperCase());                    // stable
const k2 = useStore((s) => { const hit = s.list.find((x) => { return [x]; }); return hit; }); // stable
const l2 = useStore((s) => { const f = function () { return {}; }; return f === null; }); // stable
const m2 = useStore((s) => (s.a === 1 ? 'a' : 'b'));                               // stable
const n2 = useStore((s) => (s.flag ? s.list : NONE));                              // stable
const o2 = useStore((s) => s.ok && s.list.length > 0);                             // stable
const p2 = useStore((s) => s.names.join(', '));                                    // stable
`;
  it('the scan itself flags every fresh form and none of the stable ones', () => {
    const lines = CASES.split('\n');
    const want = lines.flatMap((l, i) => (/\/\/ fresh$/.test(l) ? [i + 1] : []));
    expect(freshSelectorLines(CASES).map((h) => h.line)).toEqual(want);
  });
});
