import { useEffect, useMemo, useState } from 'react';
import { fancyOpeningHtml } from '@opening';
import type { OpeningInfo } from '@shared';
import { useStore } from '@/store';
import { authToken } from '@/ws/client';
import { appUrl } from '@/util/app-url';
import { packFileUrl, type OpeningCard } from './model';
import type { PreviewRequest } from './preview-state';
import { openingOptions } from './preview-options';
import { packHtml } from './pack-html';

/**
 * A card's little preview while the pointer rests on it (界面改版方案 第 7 版 #opening: 「卡片悬停时小窗预览」): a video
 * pack's loop (or its film from 简短's start), muted; anything else the opening page itself in `thumb` mode — the scene
 * alone, short, a drawn one looping, nothing flying anywhere. Its own lazy chunk (the page generator comes with it).
 */
export default function CardPreview({ card }: { card: OpeningCard }) {
  return card.kind === 'video' ? <FilmThumb pack={card.pack} /> : <PageThumb card={card} />;
}

function FilmThumb({ pack }: { pack: OpeningInfo }) {
  const file = pack.loop ?? pack.intro ?? '';
  const from = pack.loop ? 0 : pack.shortFrom ?? 0;
  return (
    <video
      src={appUrl(packFileUrl(pack.id, file, authToken()))}
      muted autoPlay loop playsInline preload="auto" disablePictureInPicture aria-hidden
      onLoadedMetadata={(e) => { if (from) e.currentTarget.currentTime = from; }}
    />
  );
}

function PageThumb({ card }: { card: Exclude<OpeningCard, { kind: 'video' }> }) {
  const [html, setHtml] = useState<string | null>(card.kind === 'web' ? null : '');
  // the cards are new objects on every render of the picker: the page is built again only when the opening changes
  // (`key` holds everything of the card the page is built from)
  const key = card.kind === 'web' ? `web:${card.pack.id}:${card.pack.entry ?? ''}:${card.pack.maxSeconds}` : card.kind;
  useEffect(() => {
    if (card.kind !== 'web') return;
    let live = true;
    void packHtml(card.pack).then((h) => { if (live) setHtml(h ?? ''); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const doc = useMemo(() => {
    if (html === null) return null;
    const req: PreviewRequest = card.kind === 'web' ? { kind: 'web', pack: card.pack } : card.kind === 'cafe' ? { kind: 'cafe' } : { kind: card.kind };
    return fancyOpeningHtml(openingOptions(req, 'thumb', useStore.getState().settings, html));
  }, [key, html]); // eslint-disable-line react-hooks/exhaustive-deps
  return doc ? <iframe srcDoc={doc} sandbox="allow-scripts" tabIndex={-1} aria-hidden title="" /> : null;
}
