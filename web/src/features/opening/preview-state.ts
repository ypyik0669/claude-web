// 设置 › 外观 › 试放一次: which opening to play over the app (PreviewFrame.tsx, loaded only when one is asked for — it
// brings the whole opening page with it, @opening). A trial run of the opening-pack skill plays here too (trial.ts).
import { create } from 'zustand';
import type { OpeningInfo } from '@shared';
import type { DrawnId } from './model';

/** What 试放一次 plays: a video pack, a drawn scene, 网吧开门, or a web pack (its page given — a draft — or fetched). */
export type PreviewRequest =
  | { kind: 'video'; pack: OpeningInfo }
  | { kind: DrawnId }
  | { kind: 'cafe' }
  | { kind: 'web'; pack: OpeningInfo; html?: string; trial?: string };

export const useOpeningPreview = create<{ req: PreviewRequest | null; n: number }>(() => ({ req: null, n: 0 }));
/** The opening as it plays at a start, over the whole window, with the app right under it. */
export const playOpening = (req: PreviewRequest) => useOpeningPreview.setState((s) => ({ req, n: s.n + 1 }));
export const closeOpeningPreview = () => useOpeningPreview.setState({ req: null });
