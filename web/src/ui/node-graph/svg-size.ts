import type { Size } from './viewport';
// issue #17: how big a picture given as SVG markup is. The raw Mermaid view is panned and zoomed in the fullscreen viewer
// like a node graph, and fitting it needs the picture's own size. Mermaid writes `width="100%"` with the size in the
// viewBox (and a `max-width` style); a plain SVG may only say width / height.

/** the value of attribute `name` on the opening tag `tag` (either quote) */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2]).trim() : undefined;
}

/** a length in px (or unitless) above 0; anything else (`100%`, `10em`, missing) is null */
function px(v: string | undefined): number | null {
  if (!v || !/^\d+(?:\.\d+)?(?:px)?$/i.test(v)) return null;
  const n = parseFloat(v);
  return n > 0 ? n : null;
}

/** The root <svg>'s own size: its viewBox, else a width and height in px; null when it says neither. */
export function svgSize(svg: string): Size | null {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!tag) return null;
  const box = attr(tag, 'viewBox')?.split(/[\s,]+/).map(Number);
  if (box && box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) return { w: box[2], h: box[3] };
  const w = px(attr(tag, 'width')), h = px(attr(tag, 'height'));
  return w && h ? { w, h } : null;
}
