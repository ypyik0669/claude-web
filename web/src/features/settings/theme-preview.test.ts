import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { themeBlock } from '@/ui/contrast';
import { QUICK_THEMES, THEME_LABEL, THEME_ORDER, THEME_PREVIEW, themeChoice } from './theme-preview';

const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');
const root = themeBlock(css, ':root');
/** a theme's primitives as the browser resolves them: its own block over the default (dark) one */
const prims = (t: string) => (t === 'dark' ? root : { ...root, ...themeBlock(css, `:root[data-theme='${t}']`) });

describe('theme swatches (final review §9 #3)', () => {
  it('paint each theme with its own colours — the same values as styles.css', () => {
    for (const [t, p] of Object.entries(THEME_PREVIEW)) {
      const b = prims(t);
      expect({ t, bg: p.bg, side: p.side, fg: p.fg, accent: p.accent }).toEqual({ t, bg: b.bg, side: b['bg-1'], fg: b.fg, accent: b.accent });
    }
  });
  it('cover every theme styles.css defines, each with a name', () => {
    const inCss = [...css.matchAll(/^:root\[data-theme='([\w-]+)'\]\s*\{/gm)].map((m) => m[1]);
    expect(new Set(Object.keys(THEME_PREVIEW))).toEqual(new Set(['dark', ...inCss]));
    expect(new Set(THEME_ORDER)).toEqual(new Set(['system', ...Object.keys(THEME_PREVIEW)]));
    for (const t of THEME_ORDER) expect(THEME_LABEL[t]).toBeTruthy();
    expect([...QUICK_THEMES].map((t) => THEME_LABEL[t])).toEqual(['浅色', '深色', '跟随系统']);
  });
  it('an unset ui.theme is 跟随系统; an unknown one is none of them', () => {
    expect(themeChoice(undefined)).toBe('system');
    expect(themeChoice('nord')).toBe('nord');
    expect(themeChoice('solarized')).toBeNull();
  });
});
