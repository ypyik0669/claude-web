// What the opening page is built with in the app (试放一次 over the window, a card's little preview): the same page the
// desktop shows at a start (desktop/src/opening.ts), told it is a preview. Types only from @opening: the generator
// itself stays in the lazy chunks that call it (PreviewFrame.tsx, CardPreview.tsx).
import type { FancyOpeningOptions } from '@opening';
import { authToken } from '@/ws/client';
import { appUrl } from '@/util/app-url';
import { getLocale, tr } from '@/i18n';
import { fullOf, packFileUrl, soundOf } from './model';
import type { PreviewRequest } from './preview-state';

/** An address of the app's server, absolute (the opening page is a srcdoc frame: relative addresses mean nothing there). */
export const absUrl = (rel: string) => new URL(appUrl(rel), location.href).href;

/** 网吧开门's script, as the app's server serves it (web/dist/opening, built by vite.opening.config.ts). */
export const CAFE_SCRIPT = 'opening/cafe-opening.js';

const light = () => document.documentElement.dataset.theme === 'light' || document.documentElement.dataset.theme === 'paper';

/**
 * The options for `req`: `preview` over the whole window (ends on transparent — the logo flies into the corner of the
 * real app — and tells this page when it is done), `thumb` in a card (always dark like a film frame, short, loops).
 * A web pack's page must be given (`html`).
 */
export function openingOptions(req: PreviewRequest, mode: 'preview' | 'thumb', s: Record<string, unknown>, html?: string | null): FancyOpeningOptions {
  const thumb = mode === 'thumb';
  const isLight = !thumb && light();
  // the logo lands on the app's own one where it is on screen (the sidebar's top-left; a Mac's after the traffic lights)
  const logo = thumb ? null : document.querySelector('.sidebar .sb-brand svg')?.getBoundingClientRect();
  return {
    kind: req.kind,
    mode,
    lang: getLocale(),
    title: 'Claude Web',
    full: thumb ? false : fullOf(s),
    sound: thumb ? false : soundOf(s),
    reduced: s['ui.reduceMotion'] === true,
    ground: thumb ? '#13110e' : 'transparent',
    dark: !isLight,
    colorScheme: isLight ? 'light' : 'dark',
    target: logo && logo.width > 0 ? { x: logo.left + logo.width / 2, y: logo.top + logo.height / 2, size: logo.width } : undefined,
    video: req.kind === 'video' ? { intro: absUrl(packFileUrl(req.pack.id, req.pack.intro ?? '', authToken())), logoAt: req.pack.logoAt ?? null, shortFrom: req.pack.shortFrom ?? 0, maxSeconds: req.pack.maxSeconds } : undefined,
    cafe: req.kind === 'cafe' ? { src: absUrl(CAFE_SCRIPT), sign: tr('Claude 网吧'), room: tr('包间') } : undefined,
    web: req.kind === 'web' ? { html: html ?? '', maxSeconds: req.pack.maxSeconds } : undefined,
    trial: req.kind === 'web' && !!req.trial,
    text: { skip: tr('点一下跳过'), waiting: tr('正在启动…'), soundOn: tr('开声音'), soundOff: tr('关声音'), tap: tr('点一下播放') },
  };
}
