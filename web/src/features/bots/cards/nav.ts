// 值班 Bot thread: what a card can ask of the thread column it sits in.
import { createContext, useContext } from 'react';

export interface ThreadNav {
  /** show a routine run's conversation in the thread column (← 返回 comes back) */
  openRun: (sessionId: string, title: string) => void;
}

export const ThreadNavContext = createContext<ThreadNav | null>(null);
export const useThreadNav = () => useContext(ThreadNavContext);

/** 9:42 — the time a card was answered. */
export const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
