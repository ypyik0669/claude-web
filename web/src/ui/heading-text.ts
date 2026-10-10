// The text set in the heading face 「CW Heading」 (UI refresh spec §4.2): a Songti cut from Noto Serif SC 600 down to
// the characters of these strings and nothing else — assets/fonts/cw-heading.woff2, with the list of what is in it
// next to it (cw-heading.chars.txt). The home greeting, the name of every settings page, the automation page's
// title and the titles of the first-run steps use it; a conversation's title and anything else a user wrote never do.
//
// Each string is imported from where it is drawn from, so a renamed page changes the list by itself; the font is
// then cut again with `npx tsx scripts/subset-heading-font.ts` (heading-text.test.ts fails until it is). Pure: the
// script and the test both read this module in node.
import { GREETING } from '@/features/home/model';
import { SETTINGS_SECTIONS } from '@/features/settings/catalog';
import { AUTOMATION_TITLE } from '@/features/automation/page';
import { STEP_TITLE } from '@/features/onboarding/steps';

export const HEADING_STRINGS: readonly string[] = [...new Set([
  GREETING,
  ...SETTINGS_SECTIONS.map((s) => s.l),
  AUTOMATION_TITLE,
  ...Object.values(STEP_TITLE),
])];

const SPACE = 0x20;

/**
 * The characters the font needs a glyph for: every code point of the strings once, in code point order. The ASCII
 * space is left out (it draws nothing; the font carries one all the same); Latin letters, digits and punctuation —
 * full-width too — are in.
 */
export function headingChars(strings: readonly string[]): string {
  const points = new Set<number>();
  for (const s of strings) for (const ch of s) { const cp = ch.codePointAt(0)!; if (cp !== SPACE) points.add(cp); }
  return [...points].sort((a, b) => a - b).map((cp) => String.fromCodePoint(cp)).join('');
}

/**
 * The code points an uncompressed (TrueType / OpenType) font file maps to a glyph: its `cmap` table, formats 4 and
 * 12 — what a subsetter writes. How the script and the test see what a cut font really holds.
 */
export function sfntCodePoints(font: Uint8Array): Set<number> {
  const v = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const out = new Set<number>();
  let cmap = -1;
  for (let i = 0, n = v.getUint16(4); i < n; i++) {
    const rec = 12 + i * 16;
    if (v.getUint32(rec) === 0x636d6170 /* 'cmap' */) cmap = v.getUint32(rec + 8);
  }
  if (cmap < 0) return out;
  const read = new Set<number>(); // several encoding records usually share one subtable
  for (let i = 0, n = v.getUint16(cmap + 2); i < n; i++) {
    const sub = cmap + v.getUint32(cmap + 4 + i * 8 + 4);
    if (read.has(sub)) continue;
    read.add(sub);
    const format = v.getUint16(sub);
    if (format === 4) {
      const segs = v.getUint16(sub + 6) / 2;
      const ends = sub + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, offsets = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const start = v.getUint16(starts + s * 2), end = v.getUint16(ends + s * 2);
        const delta = v.getUint16(deltas + s * 2), offset = v.getUint16(offsets + s * 2);
        for (let c = start; c <= end && c < 0xffff; c++) {
          let glyph = offset ? v.getUint16(offsets + s * 2 + offset + (c - start) * 2) : c;
          if (!offset || glyph) glyph = (glyph + delta) & 0xffff;
          if (glyph) out.add(c);
        }
      }
    } else if (format === 12) {
      for (let g = 0, groups = v.getUint32(sub + 12); g < groups; g++) {
        const at = sub + 16 + g * 12;
        const start = v.getUint32(at), end = v.getUint32(at + 4), glyph = v.getUint32(at + 8);
        for (let c = start; c <= end; c++) if (glyph + (c - start)) out.add(c);
      }
    }
  }
  return out;
}
