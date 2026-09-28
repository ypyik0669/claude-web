// Text contrast of the themes, read straight from styles.css (spec §6, §8):
// the default light / dark themes: body text ≥ 7:1, secondary text and status colours ≥ 4.5:1, auxiliary text
// (placeholders, timestamps, key hints) ≥ 3:1 — on the page (--bg), the sidebar / card surface (--bg-1), the inset /
// hover / chip surface (--bg-2, where the header's +N −M sits) and floating surfaces (--bg-elev: menus, the composer).
// Every theme: the diff numbers (green / red) and auxiliary text pass on the surfaces they are drawn on.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, themeBlock } from './contrast';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const dark = themeBlock(css, ':root');
// the other blocks only override; anything they leave out cascades from the dark defaults
const theme = (t: string) => ({ ...dark, ...themeBlock(css, `:root[data-theme='${t}']`) });
const DEFAULTS = { dark, light: theme('light') };
const ALL = { ...DEFAULTS, dracula: theme('dracula'), nord: theme('nord'), 'tokyo-night': theme('tokyo-night'), paper: theme('paper') };

const GROUNDS = ['bg', 'bg-1', 'bg-2', 'bg-elev'] as const;
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

const pair = (t: Record<string, string>, ink: string, ground: string) => {
  expect(t[ink], `--${ink} missing`).toBeTruthy();
  expect(t[ground], `--${ground} missing`).toBeTruthy();
  return contrast(t[ink], t[ground]);
};

describe('default themes: full contrast table (WCAG)', () => {
  for (const [name, t] of Object.entries(DEFAULTS)) {
    describe(name, () => {
      for (const r of RULES) {
        for (const g of GROUNDS) {
          it(`${r.what}: --${r.ink} on --${g} ≥ ${r.min}:1`, () => expect(pair(t, r.ink, g)).toBeGreaterThanOrEqual(r.min));
        }
      }
      it('user bubble text ≥ 7:1', () => expect(pair(t, 'fg', 'user-bg')).toBeGreaterThanOrEqual(7));
      it('primary button label ≥ 4.5:1', () => {
        expect(t.primary, '--primary must be a literal colour in the default themes').toBeTruthy();
        expect(contrast(t['primary-fg'], t.primary)).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});

describe('every theme: diff numbers and auxiliary text', () => {
  for (const [name, t] of Object.entries(ALL)) {
    describe(name, () => {
      for (const ink of ['green', 'red']) {
        for (const g of ['bg', 'bg-1', 'bg-2']) {
          it(`--${ink} on --${g} ≥ 4.5:1`, () => expect(pair(t, ink, g)).toBeGreaterThanOrEqual(4.5));
        }
      }
      for (const g of GROUNDS) {
        it(`--fg-3 on --${g} ≥ 3:1`, () => expect(pair(t, 'fg-3', g)).toBeGreaterThanOrEqual(3));
      }
      it('ink keeps its order: --fg-1 > --fg-2 > --fg-3 on --bg', () => {
        expect(pair(t, 'fg-1', 'bg')).toBeGreaterThan(pair(t, 'fg-2', 'bg'));
        expect(pair(t, 'fg-2', 'bg')).toBeGreaterThan(pair(t, 'fg-3', 'bg'));
      });
    });
  }
});

describe('helpers', () => {
  it('agree with known WCAG values', () => {
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrast('#777', '#fff')).toBeCloseTo(4.48, 2);
  });

  it('themeBlock ignores comments (a commented-out value, a brace inside a comment)', () => {
    const src = ":root {\n  --a: #111111; /* was --a: #222222; } */\n  /* --b: #333333; */\n  --c: #444444;\n}\n:root[data-theme='x'] { --a: #fff; }";
    expect(themeBlock(src, ':root')).toEqual({ a: '#111111', c: '#444444' });
    expect(themeBlock(src, ":root[data-theme='x']")).toEqual({ a: '#fff' });
  });
});
