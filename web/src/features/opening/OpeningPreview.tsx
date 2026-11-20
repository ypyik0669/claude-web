import { lazy, Suspense } from 'react';
import { useOpeningPreview } from './preview-state';

// the opening page and its generator are tens of KB: fetched the first time 试放一次 is pressed, not with the app
const PreviewFrame = lazy(() => import('./PreviewFrame'));

/** 设置 › 外观 › 试放一次 (preview-state.ts): the opening over the whole window while one is asked for. */
export function OpeningPreviewHost() {
  const req = useOpeningPreview((s) => s.req);
  const n = useOpeningPreview((s) => s.n);
  return req ? <Suspense fallback={null}><PreviewFrame key={n} req={req} /></Suspense> : null;
}
