// The themes as the user picks them (final review §9 #3: dark mode within two clicks — the account popover's
// 浅色 / 深色 / 跟随系统, and swatches on 设置 → 外观 instead of a dropdown of theme ids). Pure: no store import (the
// node unit tests would trip over it), `Theme` is a type only.
import type { Theme } from '@/store';

export type ThemeChoice = Theme | 'system';

/** What a swatch paints: the page, the sidebar, the text, the accent. */
export interface ThemeSwatch { bg: string; side: string; fg: string; accent: string }

/**
 * Each theme's primitives, for the swatches only (the swatch shows another theme than the one applied, so it cannot
 * read the live CSS variables). theme-preview.test.ts checks every value against the theme blocks of styles.css.
 */
export const THEME_PREVIEW: Record<Theme, ThemeSwatch> = {
  dark: { bg: '#1a1a19', side: '#151514', fg: '#ececea', accent: '#d97757' },
  light: { bg: '#ffffff', side: '#f8f8f7', fg: '#1b1b1a', accent: '#d97757' },
  paper: { bg: '#f7f3ea', side: '#f1ece1', fg: '#2b2620', accent: '#b5563a' },
  dracula: { bg: '#282a36', side: '#2c2e3b', fg: '#f8f8f2', accent: '#bd93f9' },
  nord: { bg: '#2e3440', side: '#333a48', fg: '#eceff4', accent: '#88c0d0' },
  'tokyo-night': { bg: '#1a1b26', side: '#1f2030', fg: '#c0caf5', accent: '#7aa2f7' },
};

export const THEME_LABEL: Record<ThemeChoice, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
  paper: '纸张',
  dracula: 'Dracula',
  nord: 'Nord',
  'tokyo-night': 'Tokyo Night',
};

/** The account popover's three (the ones a newcomer looks for). */
export const QUICK_THEMES: readonly ThemeChoice[] = ['light', 'dark', 'system'];
/** 设置 → 外观: every theme, the three first. */
export const THEME_ORDER: readonly ThemeChoice[] = ['system', 'light', 'dark', 'paper', 'dracula', 'nord', 'tokyo-night'];

/** The choice a `ui.theme` value stands for (unset = 跟随系统, an unknown id = none of them). */
export function themeChoice(v: unknown): ThemeChoice | null {
  if (v === undefined || v === null || v === '') return 'system';
  return (THEME_ORDER as readonly unknown[]).includes(v) ? (v as ThemeChoice) : null;
}
