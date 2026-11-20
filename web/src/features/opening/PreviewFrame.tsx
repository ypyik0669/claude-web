import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { fancyOpeningHtml, openingLength } from '@opening';
import { useStore } from '@/store';
import { authToken } from '@/ws/client';
import { appUrl } from '@/util/app-url';
import { getLocale, tr } from '@/i18n';
import { OPENING_KEYS, fullOf, packFileUrl, soundOf } from './model';
import { closeOpeningPreview, type PreviewRequest } from './preview-state';

/**
 * 试放一次: the desktop's own opening page (desktop/src/opening.ts, `mode: 'preview'`) in a sandboxed frame over the
 * app. It ends on transparent instead of the app's ground — the logo flies into the corner of the real app — and tells
 * this page when it is done or when its sound button was pressed (the same setting a start uses).
 */
export default function PreviewFrame({ req }: { req: PreviewRequest }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const html = useMemo(() => {
    const s = useStore.getState().settings;
    const light = document.documentElement.dataset.theme === 'light' || document.documentElement.dataset.theme === 'paper';
    const abs = (rel: string) => new URL(appUrl(rel), location.href).href;
    // the logo lands on the app's own one where it is on screen (the sidebar's top-left; a Mac's after the traffic lights)
    const logo = document.querySelector('.sidebar .sb-brand svg')?.getBoundingClientRect();
    return fancyOpeningHtml({
      target: logo && logo.width > 0 ? { x: logo.left + logo.width / 2, y: logo.top + logo.height / 2, size: logo.width } : undefined,
      kind: req.kind, mode: 'preview', lang: getLocale(), title: 'Claude Web', full: fullOf(s), sound: soundOf(s),
      reduced: s['ui.reduceMotion'] === true, ground: 'transparent', dark: !light, colorScheme: light ? 'light' : 'dark',
      video: req.kind === 'video' ? { intro: abs(packFileUrl(req.pack.id, req.pack.intro, authToken())), logoAt: req.pack.logoAt ?? null, shortFrom: req.pack.shortFrom ?? 0, maxSeconds: req.pack.maxSeconds } : undefined,
      text: { skip: tr('点一下跳过'), waiting: tr('正在启动…'), soundOn: tr('开声音'), soundOff: tr('关声音'), tap: tr('点一下播放') },
    });
  }, [req]);
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || typeof e.data !== 'object') return;
      if (e.data.cwOpening === 'done') closeOpeningPreview();
      else if (e.data.cwOpening === 'sound') void useStore.getState().setSetting(OPENING_KEYS.sound, e.data.value === true);
    };
    window.addEventListener('message', on);
    // a page that never says it is done (a film that does not play) is not left over the app
    const s = useStore.getState().settings;
    const len = openingLength(req.kind === 'video' ? { kind: 'video', full: fullOf(s), logoAt: req.pack.logoAt ?? null, shortFrom: req.pack.shortFrom ?? 0, maxSeconds: req.pack.maxSeconds } : { kind: 'ignite', full: fullOf(s) });
    const t = setTimeout(closeOpeningPreview, len + 9000);
    return () => { window.removeEventListener('message', on); clearTimeout(t); };
  }, [req]);
  return createPortal(
    <iframe
      ref={ref}
      className="op-preview"
      data-kind={req.kind}
      srcDoc={html}
      sandbox="allow-scripts"
      allow="autoplay"
      title={tr('试放开场动画')}
      onLoad={() => ref.current?.contentWindow?.focus()}
    />,
    document.body,
  );
}
