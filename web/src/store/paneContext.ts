import { createContext, useContext } from 'react';

/** Set by each workbench pane so children know which pane/tile/session they render for. */
export interface PaneCtx { paneId: string; tileId: string; sessionId: string | null }
export const PaneContext = createContext<PaneCtx | null>(null);
export const usePaneCtx = () => useContext(PaneContext);
export const winId = new URLSearchParams(location.search).get('win') ?? 'main';
