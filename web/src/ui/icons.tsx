/**
 * The app's only icon set: one optical weight everywhere, no emoji, nothing loaded at runtime.
 *
 * Where the geometry comes from:
 *  - `icons.generated.ts` — Lucide (ISC), on its 24×24 grid. `icon-map.json` says which Lucide icon each of our names
 *    is; `scripts/gen-icons.mjs` turns Lucide's shapes into path data and writes the file. Never edit it by hand.
 *  - `HAND` below — the brand / agent marks, which Lucide has no business drawing. A name here wins over a generated one.
 *
 * Every glyph is a path list; `Icon` renders them at `size` in `currentColor`, so an icon inherits whatever colour
 * its row / button already has. A path that needs more than geometry (a fill) carries its own attrs: `[d, attrs]`.
 * The line gets thinner in viewBox units as the icon gets smaller, so it draws at the same width on screen
 * (`strokeFor`). `<name>Fill` is the same glyph with its closed shape filled, for the icons that can be "on"
 * (pinned, favourite, rated).
 *
 * Adding one: pick the Lucide icon for what it MEANS here (prefer the rounded-corner variants: `square-…`,
 * `panel-…`, `file-…`), add `"ourName": "lucide-name"` to `icon-map.json` (and the name to its `$fill` list if it
 * needs a filled twin), then run `node scripts/gen-icons.mjs`. Two names share a Lucide icon only when they are the
 * same thing. If Lucide has nothing for the concept, draw it in `HAND`: inside 2..22, round corners, joins and caps,
 * two strokes rather than a busy outline. `icons.test.ts` fails on a map that was edited without regenerating.
 */
import { GENERATED } from './icons.generated';

type P = string | [string, Record<string, string | number>];

// ---- brand / agent marks (hand-drawn) -------------------------------------
const HAND = {
  claude: ['M12 3.2v17.6M4.4 7.6l15.2 8.8M19.6 7.6L4.4 16.4'],
  codex: ['M12 3.4l7.4 4.3v8.6L12 20.6 4.6 16.3V7.7z', 'M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z'],
  gemini: ['M12 3.2c.6 4.6 4 8 8.6 8.6-4.6.6-8 4-8.6 8.6-.6-4.6-4-8-8.6-8.6 4.6-.6 8-4 8.6-8.6z'],
  qwen: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 3.5a4.25 4.25 0 0 0 0 8.5 4.25 4.25 0 0 1 0 8.5'],
  kimi: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', ['M12 4.6a7.4 7.4 0 0 1 0 14.8z', { fill: 'currentColor', stroke: 'none' }]],
  opencode: ['M9.5 7.5L4.5 12l5 4.5', 'M14.5 7.5l5 4.5-5 4.5', 'M13 6.5l-2 11'],
} satisfies Record<string, P[]>;

const PATHS = { ...GENERATED, ...HAND } satisfies Record<string, P[]>;

export type IconName = keyof typeof PATHS;

/**
 * The `stroke-width` (in the 24-unit viewBox) for an icon drawn at `size` CSS px. On screen a line is
 * `strokeWidth × size / 24` px wide, and it should look the same on every small icon: 1.5px from 16 to 20,
 * 1.35px below 16 (the 11–14px glyphs in rows and chips have less room between their lines). From 24 up it is
 * 1.75 units and grows with the icon; between 20 and 24 the value goes linearly from 1.8 (1.5px at 20) to 1.75.
 */
export function strokeFor(size: number): number {
  if (!(size > 0) || size >= 24) return 1.75;
  const at20 = (1.5 * 24) / 20;
  const w = size > 20 ? at20 + ((size - 20) / 4) * (1.75 - at20) : ((size < 16 ? 1.35 : 1.5) * 24) / size;
  return Math.round(w * 1000) / 1000;
}

export function Icon({ name, size = 16, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeFor(size)} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} focusable="false">
      {title && <title>{title}</title>}
      {(PATHS[name] as P[]).map((p, i) => (typeof p === 'string' ? <path key={i} d={p} /> : <path key={i} d={p[0]} {...p[1]} />))}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** Agent kind → icon. Custom ACP agents (`acp:<id>`) fall back to the generic bot. */
export const AGENT_ICONS: Record<string, IconName> = { claude: 'claude', codex: 'codex', gemini: 'gemini', qwen: 'qwen', kimi: 'kimi', opencode: 'opencode' };
