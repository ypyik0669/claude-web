// 「CW Heading」 (UI refresh spec §4.2) is cut down to the characters of a fixed set of headings. The committed font
// and its character list are held against those strings here: give a settings page (the greeting, the automation
// page, a first-run step) a name with a character the font does not have, and this fails until the font is cut again.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { GREETING } from '@/features/home/model';
import { SETTINGS_SECTIONS } from '@/features/settings/catalog';
import { AUTOMATION_TITLE } from '@/features/automation/page';
import { STEP_TITLE } from '@/features/onboarding/steps';
import { HEADING_STRINGS, headingChars, sfntCodePoints } from './heading-text';

const RECUT = 'Cut the font again — npx tsx scripts/subset-heading-font.ts from the repo root — and commit both files in web/src/assets/fonts.';
const FONT = new URL('../assets/fonts/cw-heading.woff2', import.meta.url);
const CHARS = new URL('../assets/fonts/cw-heading.chars.txt', import.meta.url);
const MAX_BYTES = 60 * 1024;

// harfbuzz (the subsetter the font was cut with) also unpacks a woff2: every glyph kept, as plain TrueType
const subsetFont: (font: Uint8Array, text: undefined, o: { targetFormat: 'truetype'; keepAllGlyphs: true }) => Promise<Uint8Array> = createRequire(import.meta.url)('subset-font');
const show = (chars: Iterable<string>) => [...chars].map((c) => `${c} (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`).join(', ');

describe('headingChars', () => {
  it('lists every code point once, in code point order, without the space', () => {
    expect(headingChars(['b a', 'ab？', 'B.1'])).toBe('.1Bab？');
    expect(headingChars(['MCP 与插件', '插件'])).toBe('CMP与件插');
    expect(headingChars([])).toBe('');
  });
  it('keeps a character outside the basic plane whole', () => {
    expect([...headingChars(['𠮷a'])]).toEqual(['a', '𠮷']);
  });
});

describe('HEADING_STRINGS', () => {
  it('has the home greeting, every settings page name, the automation title and the first-run titles', () => {
    expect(HEADING_STRINGS).toContain(GREETING);
    expect(SETTINGS_SECTIONS.length).toBeGreaterThan(15);
    for (const s of SETTINGS_SECTIONS) expect(HEADING_STRINGS, `settings page ${s.id}`).toContain(s.l); // the advanced pages too
    expect(HEADING_STRINGS).toContain(AUTOMATION_TITLE);
    for (const t of Object.values(STEP_TITLE)) expect(HEADING_STRINGS).toContain(t);
  });
  it('is a list of distinct, non-empty strings', () => {
    expect(new Set(HEADING_STRINGS).size).toBe(HEADING_STRINGS.length);
    for (const s of HEADING_STRINGS) expect(s.trim()).not.toBe('');
  });
});

describe('the committed heading font', () => {
  const want = headingChars(HEADING_STRINGS);

  it('has a character list equal to what the headings use now', () => {
    expect(existsSync(CHARS), `web/src/assets/fonts/cw-heading.chars.txt is missing. ${RECUT}`).toBe(true);
    const text = readFileSync(CHARS, 'utf8');
    const have = text.replace(/\n$/, '');
    const added = [...want].filter((c) => !have.includes(c));
    const gone = [...have].filter((c) => !want.includes(c));
    const why = [
      added.length ? `a heading now uses ${show(added)}, which the font does not have` : '',
      gone.length ? `no heading uses ${show(gone)} any more` : '',
    ].filter(Boolean).join('; ') || 'the list is not what the script writes (one line, LF)';
    expect(text, `${why}. ${RECUT}`).toBe(`${want}\n`);
  });

  it('is a woff2 under 60 KB', () => {
    expect(existsSync(FONT), `web/src/assets/fonts/cw-heading.woff2 is missing. ${RECUT}`).toBe(true);
    const font = readFileSync(FONT);
    expect(font.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(font.length).toBeGreaterThan(1024);
    expect(font.length, `${font.length} bytes: a heading font this big was not cut down to the headings`).toBeLessThan(MAX_BYTES);
  });

  it('has a glyph for every character of the list, and for nothing else but the space', async () => {
    const held = sfntCodePoints(await subsetFont(readFileSync(FONT), undefined, { targetFormat: 'truetype', keepAllGlyphs: true }));
    const missing = [...want].filter((c) => !held.has(c.codePointAt(0)!));
    expect(missing, `the font has no glyph for ${show(missing)}. ${RECUT}`).toEqual([]);
    const extra = [...held].filter((cp) => cp !== 0x20 && !want.includes(String.fromCodePoint(cp))).map((cp) => String.fromCodePoint(cp));
    expect(extra, `the font holds ${show(extra)}, which no heading uses. ${RECUT}`).toEqual([]);
    expect(held.has(0x20), 'the font has no space').toBe(true);
  });
});
