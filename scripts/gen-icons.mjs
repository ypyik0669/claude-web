// Generates web/src/ui/icons.generated.ts: the geometry of the app's icons, taken from Lucide (ISC).
//
//   node scripts/gen-icons.mjs
//
// Input:  web/src/ui/icon-map.json   our icon name → Lucide icon name, plus
//           "$fill": [names]         also emit `<name>Fill`: the same geometry with its closed shapes filled
//           "$comment"               ignored
//         node_modules/lucide-static/icon-nodes.json   every Lucide icon as [tag, attrs] nodes
// Output: one `GENERATED` table, name → list of path `d` strings (or [d, attrs] where a shape carries more than
//         geometry), the shape `Icon` in web/src/ui/icons.tsx draws. rect / circle / ellipse / line / polyline /
//         polygon are converted to path data, so the app ships paths only and never imports Lucide at runtime.
//
// The brand and agent marks are not here: they are hand-drawn in icons.tsx and win over a generated name.
// web/src/ui/icons.test.ts regenerates and compares, so a map edited without running this fails the tests.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAP_FILE = path.join(ROOT, 'web', 'src', 'ui', 'icon-map.json');
export const OUT_FILE = path.join(ROOT, 'web', 'src', 'ui', 'icons.generated.ts');

/** Where lucide-static is installed (npm hoists it to the repository root; a workspace may keep its own copy). */
export function lucideDir(from = path.dirname(MAP_FILE)) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const hit = path.join(dir, 'node_modules', 'lucide-static');
    if (existsSync(path.join(hit, 'icon-nodes.json'))) return hit;
    if (path.dirname(dir) === dir) throw new Error('lucide-static is not installed (npm install)');
  }
}

// ---- shapes → path data ----------------------------------------------------

/** A number as path data writes it: at most 3 decimals, no trailing zeros, no "-0". */
const n = (v) => {
  const x = Math.round(Number(v) * 1000) / 1000;
  if (!Number.isFinite(x)) throw new Error(`not a number: ${JSON.stringify(v)}`);
  return String(Object.is(x, -0) ? 0 : x);
};
const num = (attrs, key, fallback) => {
  if (attrs[key] === undefined) {
    if (fallback === undefined) throw new Error(`missing ${key}`);
    return fallback;
  }
  const x = Number(attrs[key]);
  if (!Number.isFinite(x)) throw new Error(`${key} is not a number: ${JSON.stringify(attrs[key])}`);
  return x;
};
const points = (attrs) => {
  const xs = String(attrs.points ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (xs.length < 4 || xs.length % 2 || xs.some((x) => !Number.isFinite(x))) throw new Error(`bad points: ${JSON.stringify(attrs.points)}`);
  const out = [];
  for (let i = 0; i < xs.length; i += 2) out.push(`${n(xs[i])} ${n(xs[i + 1])}`);
  return out;
};
/** Full ellipse as two half arcs, starting at its leftmost point. */
const ellipse = (cx, cy, rx, ry) => `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0z`;

/** The geometry attributes of each shape; anything else a node carries (fill, stroke-width…) is kept as attrs. */
const SHAPES = {
  path: { keys: ['d'], d: (a) => String(a.d ?? '').trim() },
  line: { keys: ['x1', 'y1', 'x2', 'y2'], d: (a) => `M${n(num(a, 'x1', 0))} ${n(num(a, 'y1', 0))}L${n(num(a, 'x2', 0))} ${n(num(a, 'y2', 0))}` },
  polyline: { keys: ['points'], d: (a) => `M${points(a).join('L')}` },
  polygon: { keys: ['points'], closed: true, d: (a) => `M${points(a).join('L')}z` },
  circle: { keys: ['cx', 'cy', 'r'], closed: true, d: (a) => ellipse(num(a, 'cx', 0), num(a, 'cy', 0), num(a, 'r'), num(a, 'r')) },
  ellipse: { keys: ['cx', 'cy', 'rx', 'ry'], closed: true, d: (a) => ellipse(num(a, 'cx', 0), num(a, 'cy', 0), num(a, 'rx'), num(a, 'ry')) },
  rect: {
    keys: ['x', 'y', 'width', 'height', 'rx', 'ry'],
    closed: true,
    d: (a) => {
      const x = num(a, 'x', 0), y = num(a, 'y', 0), w = num(a, 'width'), h = num(a, 'height');
      // SVG: one radius given → the other takes it; each is clamped to half its side
      let rx = a.rx !== undefined ? num(a, 'rx') : a.ry !== undefined ? num(a, 'ry') : 0;
      let ry = a.ry !== undefined ? num(a, 'ry') : rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (!rx || !ry) return `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}z`;
      const arc = (dx, dy) => `a${n(rx)} ${n(ry)} 0 0 1 ${n(dx)} ${n(dy)}`;
      const side = (cmd, len) => (Math.abs(len) < 1e-9 ? '' : `${cmd}${n(len)}`);
      return `M${n(x + rx)} ${n(y)}${side('h', w - 2 * rx)}${arc(rx, ry)}${side('v', h - 2 * ry)}${arc(-rx, ry)}${side('h', -(w - 2 * rx))}${arc(-rx, -ry)}${side('v', -(h - 2 * ry))}${arc(rx, -ry)}z`;
    },
  },
};

/** Every subpath of the path data is closed — the shape has an inside that can be filled. */
const closedPath = (d) => {
  const closes = (d.match(/[Zz]/g) ?? []).length;
  return closes > 0 && closes >= (d.match(/[Mm]/g) ?? []).length;
};

const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/** One Lucide node → `{ d, attrs, closed }`. */
function convert(tag, attrs) {
  const shape = SHAPES[tag];
  if (!shape) throw new Error(`unsupported element <${tag}>`);
  const d = shape.d(attrs);
  if (!/^[Mm]/.test(d)) throw new Error(`<${tag}> gave no path data`);
  const extra = {};
  for (const k of Object.keys(attrs).sort()) if (!shape.keys.includes(k)) extra[camel(k)] = attrs[k];
  return { d, attrs: extra, closed: shape.closed ?? closedPath(d) };
}

// ---- writing the file --------------------------------------------------------

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : q(k));
const item = ({ d, attrs }) => {
  const ks = Object.keys(attrs).sort();
  return ks.length ? `[${q(d)}, { ${ks.map((k) => `${key(k)}: ${typeof attrs[k] === 'number' ? attrs[k] : q(attrs[k])}`).join(', ')} }]` : q(d);
};

const NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const DIRECTIVES = ['$comment', '$fill'];

/**
 * The text of icons.generated.ts. Pure: `map` is the parsed icon-map.json, `iconNodes` the parsed
 * lucide-static/icon-nodes.json, `version` the lucide-static version named in the header. Throws on a map it
 * cannot honour (unknown Lucide name, a `$fill` icon with nothing to fill…), listing every problem at once.
 */
export function generate(map, iconNodes, { version = 'unknown' } = {}) {
  const problems = [];
  for (const k of Object.keys(map)) if (k.startsWith('$') && !DIRECTIVES.includes(k)) problems.push(`unknown directive ${k} (known: ${DIRECTIVES.join(', ')})`);
  const names = Object.keys(map).filter((k) => !k.startsWith('$'));
  const fills = map.$fill ?? [];
  if (!Array.isArray(fills)) problems.push('$fill must be a list of icon names');

  const table = new Map();
  for (const name of names) {
    const lucide = map[name];
    if (!NAME.test(name)) { problems.push(`${name}: an icon name is letters and digits only (it becomes a key of IconName)`); continue; }
    if (typeof lucide !== 'string' || !Array.isArray(iconNodes[lucide])) { problems.push(`${name}: lucide-static has no icon "${lucide}"`); continue; }
    try {
      table.set(name, iconNodes[lucide].map(([tag, attrs]) => convert(tag, attrs ?? {})));
    } catch (e) {
      problems.push(`${name} (${lucide}): ${e.message}`);
    }
  }
  for (const base of Array.isArray(fills) ? fills : []) {
    const shapes = table.get(base);
    const name = `${base}Fill`;
    if (!shapes) { problems.push(`$fill: ${base} is not an icon in the map`); continue; }
    if (table.has(name)) { problems.push(`$fill: ${name} is already an icon in the map`); continue; }
    if (!shapes.some((s) => s.closed)) { problems.push(`$fill: ${base} has no closed shape to fill`); continue; }
    table.set(name, shapes.map((s) => (s.closed ? { ...s, attrs: { ...s.attrs, fill: 'currentColor' } } : s)));
  }
  if (problems.length) throw new Error(`icon-map.json:\n  ${problems.join('\n  ')}`);

  const sorted = [...table.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    '// GENERATED by scripts/gen-icons.mjs — do not edit by hand.',
    `// Geometry: Lucide (https://lucide.dev, ISC License, © Lucide Contributors), from lucide-static@${version}.`,
    '// Which Lucide icon each name is: web/src/ui/icon-map.json. After editing the map (or upgrading lucide-static):',
    '//   node scripts/gen-icons.mjs',
    '// Every shape (rect, circle, line…) is already path data; the app does not load Lucide at runtime.',
    'type P = string | [string, Record<string, string | number>];',
    '',
    'export const GENERATED = {',
    ...sorted.map((name) => `  ${name}: [${table.get(name).map(item).join(', ')}],`),
    '} satisfies Record<string, P[]>;',
    '',
  ].join('\n');
}

// ---- run directly --------------------------------------------------------------

const same = (a, b) => {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  const dir = lucideDir();
  const version = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const text = generate(JSON.parse(readFileSync(MAP_FILE, 'utf8')), JSON.parse(readFileSync(path.join(dir, 'icon-nodes.json'), 'utf8')), { version });
  const before = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : null;
  if (before !== text) writeFileSync(OUT_FILE, text, 'utf8');
  const count = (text.match(/^  [A-Za-z0-9]+: \[/gm) ?? []).length;
  console.log(`${path.relative(ROOT, OUT_FILE)}: ${count} icons from lucide-static@${version}${before === text ? ' (unchanged)' : ''}`);
}
