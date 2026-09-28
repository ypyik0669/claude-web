// Text contrast of the default light / dark themes, read straight from styles.css (spec §6, §8):
// body text ≥ 7:1, secondary text and status colours ≥ 4.5:1, auxiliary text (placeholders, timestamps, key hints) ≥ 3:1,
// on both the page (--bg) and the sidebar / card surface (--bg-1).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, themeBlock } from './contrast';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const dark = themeBlock(css, ':root');
// the light block only overrides; anything it leaves out cascades from the dark defaults
const light = { ...dark, ...themeBlock(css, ":root[data-theme='light']") };

const THEMES = { dark, light };
const GROUNDS = ['bg', 'bg-1'] as const;
const RULES: { ink: string; min: number; what: string }[] = [
  { ink: 'fg', min: 7, what: 'body text' },
  { ink: 'fg-1', min: 4.5, what: 'secondary text' },
  { ink: 'fg-2', min: 4.5, what: 'secondary text' },
  { ink: 'green', min: 4.5, what: 'status / diff +' },
  { ink: 'red', min: 4.5, what: 'status / diff −' },
  { ink: 'yellow', min: 4.5, what: 'needs-you' },
  { ink: 'blue', min: 4.5, what: 'info' },
  { ink: 'fg-3', min: 3, what: 'auxiliary text' },
];

describe('theme contrast (WCAG)', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    describe(name, () => {
      for (const r of RULES) {
        for (const g of GROUNDS) {
          it(`${r.what}: --${r.ink} on --${g} ≥ ${r.min}:1`, () => {
            expect(t[r.ink], `--${r.ink} missing in ${name}`).toBeTruthy();
            expect(t[g], `--${g} missing in ${name}`).toBeTruthy();
            expect(contrast(t[r.ink], t[g])).toBeGreaterThanOrEqual(r.min);
          });
        }
      }
      it('user bubble text ≥ 7:1', () => expect(contrast(t.fg, t['user-bg'])).toBeGreaterThanOrEqual(7));
      it('primary button label ≥ 4.5:1', () => {
        expect(t.primary, '--primary must be a literal colour in the default themes').toBeTruthy();
        expect(contrast(t['primary-fg'], t.primary)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }

  it('helpers agree with known WCAG values', () => {
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrast('#777', '#fff')).toBeCloseTo(4.48, 2);
  });
});
