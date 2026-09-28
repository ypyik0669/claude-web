import { createContext } from 'react';

/** Tool calls blocked on the user right now: their step says 「等你确认」 (yellow = 需要你, spec §6.4). ChatView provides it. */
export const WaitingCtx = createContext<ReadonlySet<string>>(new Set());

/** Called when the user opens something inside a turn that is still running: it then stays open once the turn ends. */
export const TurnTouchCtx = createContext<(() => void) | null>(null);
