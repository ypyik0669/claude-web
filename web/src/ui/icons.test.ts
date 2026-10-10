// The icon set (UI refresh spec §4.4). Geometry comes from Lucide: `scripts/gen-icons.mjs` reads `icon-map.json`
// (our name → Lucide name) and writes `icons.generated.ts`; the brand / agent marks stay hand-drawn in `icons.tsx`.
// What must hold: every name the app already uses (423 call sites) still exists; the map only names icons the
// installed lucide-static has; the committed generated file is what the generator produces today; the stroke rule;
// and no old-style sharp rectangle comes back.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_ICONS, ICON_NAMES, strokeFor } from './icons';
import { GENERATED } from './icons.generated';

type Nodes = Record<string, [string, Record<string, string>][]>;
type IconMap = Record<string, string | string[]>;
// a plain .mjs (it is also run by node directly); a computed specifier keeps tsc from wanting a declaration file
const genUrl = new URL('../../../scripts/gen-icons.mjs', import.meta.url).href;
const gen = (await import(/* @vite-ignore */ genUrl)) as {
  generate: (map: IconMap, nodes: Nodes, opts?: { version?: string }) => string;
  lucideDir: () => string;
};

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const map = JSON.parse(read('./icon-map.json')) as IconMap;
const lucide = gen.lucideDir();
const nodes = JSON.parse(readFileSync(`${lucide}/icon-nodes.json`, 'utf8')) as Nodes;
const version = (JSON.parse(readFileSync(`${lucide}/package.json`, 'utf8')) as { version: string }).version;

const mapped = Object.entries(map).filter(([k]) => !k.startsWith('$')) as [string, string][];
const fills = (map.$fill ?? []) as string[];

// every icon name of the hand-drawn set this replaces (icons.tsx at v0.1.10), in its order
const LEGACY = [
  'mission', 'goals', 'orchestra', 'compare', 'approval', 'tasks', 'files', 'usage', 'config', 'terminal', 'inspector', 'android', 'board', 'memory', 'browser',
  'read', 'write', 'edit', 'bash', 'search', 'glob', 'web', 'agent', 'mcp', 'skill', 'todo', 'plan', 'question', 'artifact', 'workflow', 'image',
  'sidebar', 'splitRight', 'splitDown', 'zoom', 'close', 'minimize', 'restore', 'more', 'refresh', 'chevronRight', 'chevronLeft', 'chevronDown', 'plus', 'minus', 'undo',
  'check', 'checkCircle', 'circle', 'dot', 'alert', 'info', 'command', 'keyboard', 'settings', 'star', 'pin', 'archive', 'trash', 'copy', 'quote', 'external', 'share',
  'replace', 'diff', 'folder', 'branch', 'commit', 'play', 'pause', 'stop', 'send', 'mic', 'attach', 'eye', 'filter', 'sun', 'moon', 'monitor', 'lock', 'shield',
  'thumbUp', 'thumbDown', 'cloud', 'gateway', 'grip', 'arrowRight', 'user', 'device', 'machine', 'chat', 'bell', 'bolt',
  'claude', 'codex', 'gemini', 'qwen', 'kimi', 'opencode',
];
// the brand / agent marks: hand-drawn in icons.tsx, never in the map
const HAND_DRAWN = ['claude', 'codex', 'gemini', 'qwen', 'kimi', 'opencode'];
// names that share one glyph — the ones that were already drawn the same before the switch to Lucide
const SAME_GLYPH = [['bash', 'terminal'], ['android', 'device'], ['files', 'write'], ['machine', 'monitor']];

type P = string | [string, Record<string, string | number>];
const TABLE: Record<string, P[]> = GENERATED;
const paths = (name: string) => TABLE[name];
const dOf = (p: P) => (typeof p === 'string' ? p : p[0]);

describe('icon names', () => {
  it('keeps every legacy name', () => {
    expect(LEGACY).toHaveLength(99);
    expect(LEGACY.filter((n) => !(ICON_NAMES as string[]).includes(n))).toEqual([]);
  });

  it('every legacy name is either mapped to Lucide or one of the hand-drawn marks', () => {
    const names = new Set(mapped.map(([k]) => k));
    expect(LEGACY.filter((n) => !names.has(n) && !HAND_DRAWN.includes(n))).toEqual([]);
    expect(HAND_DRAWN.filter((n) => names.has(n)), 'brand / agent marks stay hand-drawn').toEqual([]);
    expect(HAND_DRAWN.filter((n) => n in GENERATED)).toEqual([]);
  });

  it('every agent has its mark', () => {
    expect(Object.keys(AGENT_ICONS).sort()).toEqual([...HAND_DRAWN].sort());
    for (const ic of Object.values(AGENT_ICONS)) expect(ICON_NAMES).toContain(ic);
  });

  it('has the filled variants of the icons that can be "on"', () => {
    expect([...fills].sort()).toEqual(['pin', 'star', 'thumbDown', 'thumbUp']);
    for (const base of fills) {
      expect(ICON_NAMES, `${base}Fill`).toContain(`${base}Fill`);
      const filled = paths(`${base}Fill`);
      // same geometry as the outline, the closed shape filled
      expect(filled.map(dOf)).toEqual(paths(base).map(dOf));
      expect(filled.some((p) => typeof p !== 'string' && p[1].fill === 'currentColor'), `${base}Fill fills a shape`).toBe(true);
    }
  });
});

describe('icon-map.json', () => {
  it('only names icons the installed lucide-static has', () => {
    expect(mapped.length).toBeGreaterThan(80);
    expect(mapped.filter(([, l]) => typeof l !== 'string' || !nodes[l]).map(([k, l]) => `${k} → ${String(l)}`)).toEqual([]);
  });

  it('gives two names the same glyph only where they always shared one', () => {
    const by = new Map<string, string[]>();
    for (const [k, l] of mapped) by.set(l, [...(by.get(l) ?? []), k]);
    const shared = [...by.values()].filter((v) => v.length > 1).map((v) => [...v].sort());
    expect(shared.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([...SAME_GLYPH].sort((a, b) => a[0].localeCompare(b[0])));
  });
});

describe('icons.generated.ts', () => {
  it('is what the generator makes from the committed map (run `node scripts/gen-icons.mjs` after editing the map)', () => {
    expect(gen.generate(map, nodes, { version }) === read('./icons.generated.ts'), 'icons.generated.ts is out of date').toBe(true);
  });

  it('says where it came from', () => {
    const head = read('./icons.generated.ts').split('export const')[0];
    expect(head).toContain(`lucide-static@${version}`);
    expect(head).toContain('node scripts/gen-icons.mjs');
    expect(read('./icons.generated.ts')).not.toContain('\r');
  });

  it('has no sharp-cornered full rectangle of the old hand-drawn style', () => {
    const SHARP = /^M[\d.]+ [\d.]+h[\d.]+v[\d.]+h-[\d.]+z$/;
    const bad = Object.entries(TABLE).flatMap(([name, ps]) => ps.map(dOf).filter((d) => SHARP.test(d)).map((d) => `${name}: ${d}`));
    expect(bad).toEqual([]);
  });

  it('holds nothing but path data', () => {
    for (const [name, ps] of Object.entries(TABLE)) {
      expect(ps.length, name).toBeGreaterThan(0);
      for (const p of ps) expect(dOf(p), name).toMatch(/^[Mm][\d\s.,a-zA-Z-]+$/);
    }
  });
});

describe('generate()', () => {
  const one = (node: [string, Record<string, string>]) => {
    const out = gen.generate({ x: 'shape' }, { shape: [node] }, { version: '0.0.0' });
    return /x: \[(.*)\],/.exec(out)![1];
  };

  it('turns every shape into path data', () => {
    expect(one(['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }])).toBe("'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z'");
    // rx alone also rounds vertically; a radius larger than half the side is clamped (a pill has no straight end)
    expect(one(['rect', { x: '2', y: '6', width: '20', height: '8', rx: '5' }])).toBe("'M7 6h10a5 4 0 0 1 5 4a5 4 0 0 1 -5 4h-10a5 4 0 0 1 -5 -4a5 4 0 0 1 5 -4z'");
    expect(one(['rect', { x: '9', y: '9', width: '6', height: '6', rx: '1', ry: '2' }])).toBe("'M10 9h4a1 2 0 0 1 1 2v2a1 2 0 0 1 -1 2h-4a1 2 0 0 1 -1 -2v-2a1 2 0 0 1 1 -2z'");
    expect(one(['rect', { x: '3', y: '4', width: '18', height: '16' }])).toBe("'M3 4h18v16h-18z'");
    expect(one(['circle', { cx: '12', cy: '12', r: '10' }])).toBe("'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0z'");
    expect(one(['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }])).toBe("'M3 5a9 3 0 1 0 18 0a9 3 0 1 0 -18 0z'");
    expect(one(['line', { x1: '4.5', x2: '19.5', y1: '12', y2: '12' }])).toBe("'M4.5 12L19.5 12'");
    expect(one(['polyline', { points: '9 6 15 12 9 18' }])).toBe("'M9 6L15 12L9 18'");
    expect(one(['polygon', { points: '6,3 20,12 6,21' }])).toBe("'M6 3L20 12L6 21z'");
    expect(one(['path', { d: 'M12 5v14' }])).toBe("'M12 5v14'");
  });

  it('keeps what a shape carries besides its geometry', () => {
    expect(one(['circle', { cx: '12', cy: '12', r: '1', fill: 'currentColor' }])).toBe("['M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0z', { fill: 'currentColor' }]");
    expect(one(['path', { d: 'M4 4h1', 'stroke-width': '3' }])).toBe("['M4 4h1', { strokeWidth: '3' }]");
  });

  it('fills the closed shapes of a $fill icon, and only those', () => {
    const out = gen.generate({ $fill: ['thumb'], thumb: 't' }, { t: [['path', { d: 'M7 10v12' }], ['path', { d: 'M15 5 14 10h5a2 2 0 0 1 2 2Z' }]] }, { version: '0.0.0' });
    expect(out).toContain("  thumb: ['M7 10v12', 'M15 5 14 10h5a2 2 0 0 1 2 2Z'],");
    expect(out).toContain("  thumbFill: ['M7 10v12', ['M15 5 14 10h5a2 2 0 0 1 2 2Z', { fill: 'currentColor' }]],");
  });

  it('is sorted by name, whatever the order of the map', () => {
    const n: Nodes = { p: [['path', { d: 'M1 1h1' }]], q: [['path', { d: 'M2 2h1' }]] };
    expect(gen.generate({ b: 'p', a: 'q' }, n, { version: '1' })).toBe(gen.generate({ a: 'q', b: 'p' }, n, { version: '1' }));
    expect(gen.generate({ b: 'p', a: 'q' }, n, { version: '1' })).toMatch(/\n  a: .*\n  b: /);
  });

  it('refuses a map it cannot honour', () => {
    const n: Nodes = { p: [['path', { d: 'M1 1h1' }]], o: [['path', { d: 'M1 1h1z' }]] };
    expect(() => gen.generate({ a: 'nope' }, n)).toThrow(/nope/);
    expect(() => gen.generate({ 'a-b': 'p' }, n)).toThrow(/a-b/);
    expect(() => gen.generate({ $fill: ['a'], a: 'p' }, n)).toThrow(/closed/);
    expect(() => gen.generate({ $fill: ['z'], a: 'p' }, n)).toThrow(/z/);
    expect(() => gen.generate({ $fill: ['a'], a: 'o', aFill: 'p' }, n)).toThrow(/aFill/);
    expect(() => gen.generate({ $typo: 'x', a: 'p' } as IconMap, n)).toThrow(/\$typo/);
    expect(() => gen.generate({ a: 'bad' }, { bad: [['text', {}]] })).toThrow(/text/);
  });
});

describe('strokeFor', () => {
  // rendered width in CSS px = strokeWidth × size / 24
  const px = (size: number) => (strokeFor(size) * size) / 24;

  it('draws 1.35px below 16, 1.5px from 16 to 20, and 1.75 units from 24 up', () => {
    expect(strokeFor(12)).toBeCloseTo(2.7, 6);
    expect(strokeFor(16)).toBeCloseTo(2.25, 6);
    expect(strokeFor(18)).toBeCloseTo(2, 6);
    expect(strokeFor(20)).toBeCloseTo(1.8, 6);
    expect(strokeFor(22)).toBeCloseTo(1.775, 6);
    expect(strokeFor(24)).toBe(1.75);
    expect(strokeFor(32)).toBe(1.75);
    expect(px(12)).toBeCloseTo(1.35, 6);
    expect(px(14)).toBeCloseTo(1.35, 2);
    expect(px(16)).toBeCloseTo(1.5, 6);
    expect(px(18)).toBeCloseTo(1.5, 6);
    expect(px(20)).toBeCloseTo(1.5, 6);
    expect(px(24)).toBeCloseTo(1.75, 6);
  });

  it('never gets thinner as the icon grows from 20 to 24', () => {
    for (let s = 20; s < 24; s += 0.5) expect(px(s + 0.5)).toBeGreaterThan(px(s));
  });

  it('survives a size that is not one', () => {
    expect(strokeFor(0)).toBe(1.75);
    expect(strokeFor(Number.NaN)).toBe(1.75);
  });
});
