// Appearance settings live in meta.json (`ui.*`) and are applied as data attributes / CSS variables on <html>.
import { THEMES, type Theme } from '@/store';

export type UiTheme = Theme | 'system';
export const FONT_SIZES = [12, 13, 14, 15, 16] as const;
export const DENSITIES = [{ id: 'compact', l: '紧凑' }, { id: 'comfortable', l: '舒适' }] as const;
export const CJK_FONTS = [
  { id: '', l: '系统默认' },
  { id: '"Microsoft YaHei UI", "Microsoft YaHei"', l: '微软雅黑' },
  { id: '"PingFang SC", "Hiragino Sans GB"', l: '苹方' },
  { id: '"Noto Sans CJK SC", "Source Han Sans SC"', l: '思源黑体' },
  { id: '"LXGW WenKai", "霞鹜文楷"', l: '霞鹜文楷' },
  { id: '"Sarasa UI SC", "更纱黑体 UI SC"', l: '更纱黑体' },
];

const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let systemListener: (() => void) | null = null;

export function resolveTheme(t: UiTheme | undefined): Theme {
  if (!t || t === 'system') return mq?.matches === false ? 'light' : 'dark';
  return (THEMES as readonly string[]).includes(t) ? (t as Theme) : 'dark';
}

/** Apply every ui.* setting to the document. Idempotent; call after settings load / change. */
export function applyUiSettings(settings: Record<string, unknown>) {
  const root = document.documentElement;
  const theme = settings['ui.theme'] as UiTheme | undefined;
  root.dataset.theme = resolveTheme(theme);
  if (theme === 'system' && mq && !systemListener) {
    systemListener = () => { root.dataset.theme = resolveTheme('system'); };
    mq.addEventListener('change', systemListener);
  } else if (theme !== 'system' && mq && systemListener) {
    mq.removeEventListener('change', systemListener);
    systemListener = null;
  }
  const fs = Number(settings['ui.fontSize']) || 14;
  root.style.setProperty('--ui-font-size', `${fs}px`);
  root.dataset.density = (settings['ui.density'] as string) || 'comfortable';
  const cjk = (settings['ui.cjkFont'] as string) || '';
  root.style.setProperty('--cjk-font', cjk ? `${cjk},` : '');
  root.dataset.reduceMotion = settings['ui.reduceMotion'] ? '1' : '';
}
