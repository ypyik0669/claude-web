import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fancyOpeningHtml, openingLength } from '@opening';
import { useStore } from '@/store';
import { tr } from '@/i18n';
import { OPENING_KEYS, fullOf } from './model';
import { closeOpeningPreview, type PreviewRequest } from './preview-state';
import { openingOptions } from './preview-options';
import { packHtml } from './pack-html';
import { finishTrial, type TrialReport } from './trial';

/**
 * 试放一次: the desktop's own opening page (desktop/src/opening.ts, `mode: 'preview'`) in a sandboxed frame over the
 * app. It ends on transparent instead of the app's ground — the logo flies into the corner of the real app — and tells
 * this page when it is done or when its sound button was pressed (the same setting a start uses). A web pack's page is
 * fetched first (a draft's comes with the request); a trial run's report goes back to the skill (trial.ts).
 */
export default function PreviewFrame({ req }: { req: PreviewRequest }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const trial = req.kind === 'web' ? req.trial : undefined;
  // a web pack's page: given (a draft), or read from the server; null while it comes, '' when it cannot be read
  const [html, setHtml] = useState<string | null>(req.kind === 'web' ? req.html ?? null : '');
  useEffect(() => {
    if (req.kind !== 'web' || typeof req.html === 'string') return;
    let live = true;
    void packHtml(req.pack).then((h) => { if (live) setHtml(h ?? ''); });
    return () => { live = false; };
  }, [req]);
  const doc = useMemo(() => (html === null ? null : fancyOpeningHtml(openingOptions(req, 'preview', useStore.getState().settings, html))), [req, html]);
  useEffect(() => {
    let reported = false;
    const on = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || typeof e.data !== 'object') return;
      if (e.data.cwOpening === 'done') closeOpeningPreview();
      else if (e.data.cwOpening === 'sound') void useStore.getState().setSetting(OPENING_KEYS.sound, e.data.value === true);
      else if (e.data.cwOpening === 'trial' && trial) { reported = true; finishTrial(trial, (e.data.value ?? {}) as TrialReport); }
    };
    window.addEventListener('message', on);
    // a page that never says it is done (a film that does not play) is not left over the app
    const s = useStore.getState().settings;
    const len = req.kind === 'video'
      ? openingLength({ kind: 'video', full: fullOf(s), logoAt: req.pack.logoAt ?? null, shortFrom: req.pack.shortFrom ?? 0, maxSeconds: req.pack.maxSeconds })
      : openingLength({ kind: req.kind, full: fullOf(s), maxSeconds: req.kind === 'web' ? req.pack.maxSeconds : undefined });
    // (a web pack cut at its limit, or a cafe without WebGL, goes on with 点火: its length on top)
    const t = setTimeout(closeOpeningPreview, len + 9000 + (req.kind === 'web' || req.kind === 'cafe' ? 4000 : 0));
    return () => {
      window.removeEventListener('message', on);
      clearTimeout(t);
      // closed before the page reported (replaced by another trial, or the window navigated away)
      if (trial && !reported) finishTrial(trial, { note: tr('试放被打断了：窗口里又开始了别的试放，或者试放被关掉了。') });
    };
  }, [req, trial]);
  if (!doc) return null;
  return createPortal(
    <iframe
      ref={ref}
      className="op-preview"
      data-kind={req.kind}
      data-trial={trial ? '1' : undefined}
      srcDoc={doc}
      sandbox="allow-scripts"
      allow="autoplay"
      title={tr('试放开场动画')}
      onLoad={() => ref.current?.contentWindow?.focus()}
    />,
    document.body,
  );
}
