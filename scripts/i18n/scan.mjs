// Finds every `tr('…')` key in the sources: the Chinese text of each user-visible string. Shared by the coverage tests
// (web/src/i18n/coverage.test.ts) and the translation tooling (scripts/i18n/extract.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { parseAst } from 'vite';

/** The source trees that call tr() and the English catalog each one is held to. */
export const AREAS = [
  { dir: 'server/src', catalog: 'server/src/i18n/en.ts', export: 'EN_SERVER' },
  { dir: 'web/src', catalog: 'web/src/i18n/en.ts', export: 'EN_WEB' },
  { dir: 'desktop/src', catalog: 'desktop/src/en.ts', export: 'EN_DESKTOP' },
  { dir: 'site/src', catalog: 'site/src/i18n/en.ts', export: 'EN_SITE' },
];

const SKIP = /(\.test\.|\.generated\.|[\\/]node_modules[\\/]|[\\/]dist[\\/])/;

export function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !SKIP.test(p)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The area a file belongs to (the longest matching dir). */
export function areaOf(root, file) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  return AREAS.filter((a) => rel.startsWith(a.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
}

function walkAst(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walkAst(n, visit); return; }
  if (typeof node.type === 'string') visit(node);
  for (const k of Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    walkAst(node[k], visit);
  }
}

/** [{ key, file, pos, params }] of every tr() call with a literal first argument (a non-literal one is `dynamic`). */
export function keysIn(file, src) {
  const ast = parseAst(src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
  const out = [];
  const dynamic = [];
  walkAst(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee?.type !== 'Identifier' || n.callee.name !== 'tr') return;
    const a = n.arguments?.[0];
    const params = n.arguments?.[1]?.type === 'ObjectExpression' ? n.arguments[1].properties.map((p) => p.key?.name ?? p.key?.value).filter(Boolean) : [];
    if (a?.type === 'Literal' && typeof a.value === 'string') out.push({ key: a.value, file, pos: n.start, params });
    else if (a?.type === 'TemplateLiteral' && a.expressions.length === 0) out.push({ key: a.quasis[0].value.cooked, file, pos: n.start, params });
    else dynamic.push({ file, pos: n.start });
  });
  return { keys: out, dynamic };
}

/** Everything under the repo: Map area.export → Map key → [{file,pos,params}], and the non-literal calls. */
export function collectKeys(root) {
  const byArea = new Map();
  const dynamic = [];
  for (const a of AREAS) byArea.set(a.export, new Map());
  for (const area of AREAS) {
    for (const f of sourceFiles(path.join(root, area.dir))) {
      if (areaOf(root, f) !== area) continue;
      const { keys, dynamic: d } = keysIn(f, fs.readFileSync(f, 'utf8'));
      const m = byArea.get(area.export);
      for (const k of keys) {
        if (!m.has(k.key)) m.set(k.key, []);
        m.get(k.key).push({ file: path.relative(root, f).split(path.sep).join('/'), pos: k.pos, params: k.params });
      }
      for (const x of d) dynamic.push({ file: path.relative(root, f).split(path.sep).join('/'), pos: x.pos });
    }
  }
  return { byArea, dynamic };
}

const CJK = /[㐀-鿿]/;
const REGEX_CONTEXT = new Set(['RegExpLiteral']);

/**
 * Chinese text left outside tr(): string literals, template text and JSX text, not inside a tr() call (its placeholder
 * values are looked at) and not in a comment. [{ file, pos, text }]. A string used as data (a regex's source, a
 * comparison, an object key) is reported too: the allowlist in coverage.test.ts names the ones that are meant to stay.
 */
export function rawChinese(file, src) {
  const ast = parseAst(src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' });
  const out = [];
  const walk = (node, parent) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, parent); return; }
    if (typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && (node.callee.name === 'tr' || node.callee.name === 'trAs')) {
      for (const a of node.arguments.slice(node.callee.name === 'trAs' ? 2 : 1)) walk(a, node);
      return;
    }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'TSLiteralType') return;
    if (node.type === 'Literal' && typeof node.value === 'string' && CJK.test(node.value)) out.push({ file, pos: node.start, text: node.value });
    else if (node.type === 'TemplateElement' && CJK.test(node.value?.cooked ?? '')) out.push({ file, pos: node.start, text: node.value.cooked });
    else if (node.type === 'JSXText' && CJK.test(node.value)) out.push({ file, pos: node.start, text: node.value.trim() });
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      walk(node[k], node);
    }
  };
  walk(ast, null);
  return out;
}
