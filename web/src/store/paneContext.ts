import { createContext, useContext } from 'react';

/** Set by each workbench pane so children know which pane/tile/session they render for. */
export interface PaneCtx { paneId: string; tileId: string; sessionId: string | null }
export const PaneContext = createContext<PaneCtx | null>(null);
export const usePaneCtx = () => useContext(PaneContext);
/**
 * Whether what a tile draws can be seen now: not for a tab behind another in its pane, nor for any pane while a page
 * (自动化, Artifacts…) lies over the main area. `useScopedSessionLive` draws streamed frames only while it is true;
 * otherwise it moves with whole messages, like `useScopedSession`, and catches up the moment it is seen again. Four
 * conversations streaming under the 运行中 page redrew one nobody could see, frame by frame (perf-busy 2026-11-20).
 * Outside a tile (a 值班 Bot's thread on its page) it is true.
 */
export const FramesSeenContext = createContext(true);
export const winId = new URLSearchParams(location.search).get('win') ?? 'main';
