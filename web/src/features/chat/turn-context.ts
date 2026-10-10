import { createContext } from 'react';

/** Tool calls blocked on the user right now: their step says 「等你确认」 (yellow = 需要你, spec §6.4). ChatView provides it. */
export const WaitingCtx = createContext<ReadonlySet<string>>(new Set());

/** Called when the user opens something inside a turn that is still running: it then stays open once the turn ends. */
export const TurnTouchCtx = createContext<(() => void) | null>(null);

/**
 * Whether the conversation these messages belong to is running right now (ChatView provides it; false anywhere
 * else — the detail panel, an export). A step that is not finished spins only then: in a conversation that is not
 * running, a step without a result never ran to its end and shows a still mark.
 */
export const LiveCtx = createContext(false);

/**
 * `current` is true only while React renders an event that just arrived for a conversation on screen (ChatView sets
 * it for that one render and clears it after the commit). What mounts then arrived live and may play its entrance;
 * what mounts at any other time — history loading, switching back to a conversation, opening a fold — reads false.
 * A ref on purpose: nothing re-renders when it flips.
 */
export const ArrivalCtx = createContext<{ readonly current: boolean }>({ current: false });

/** When each tool call of the list around a step started, by its id (`stepStarts`): a finished step's time comes from it. */
export const StepStartCtx = createContext<ReadonlyMap<string, number>>(new Map());
