// WCAG 2.x contrast helpers + a tiny reader for the theme primitive blocks in tokens.css. Used by the
// contrast unit test so the token values in the stylesheet are what gets checked (no second copy to drift).

/** `#rgb` / `#rrggbb` → [r, g, b] in 0..1. */
export function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Relative luminance (WCAG 2.x). */
export function luminance(hex: string): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = parseHex(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two opaque colours, 1..21. */
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * The `--name: value` declarations of the first rule whose selector is exactly `selector` (e.g. `:root`,
 * `:root[data-theme='light']`). Only literal values are returned; `var(…)` / `color-mix(…)` are skipped.
 */
export function themeBlock(css: string, selector: string): Record<string, string> {
  // comments first: a commented-out declaration must not count, and a `}` inside one must not end the block
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(src);
  if (!m) throw new Error(`no rule for ${selector}`);
  const out: Record<string, string> = {};
  for (const d of m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    const v = d[2].trim();
    if (/^#[0-9a-f]{3,8}$/i.test(v)) out[d[1]] = v;
  }
  return out;
}
