// 跑过的 (2026-11-19): the rows the 后台 page lists and the cafe's 刚跑完的 — asked of the server a page at a time
// (background.historyAll), never pushed: what ends shows up the next time the list is opened or refreshed.
import { create } from 'zustand';
import type { BgHistoryItem, BgHistoryKind, BgHistoryPage, BgTask } from '@shared';
import { useStore } from '@/store';
import { ws } from '@/ws/client';
import { HISTORY_PAGE, mergeFirstPage, rowTitle, taskOfItem } from './history-model';
import { startReplay } from './replay';
import { tr } from '@/i18n';

interface HistoryState {
  items: BgHistoryItem[];
  /** the cursor for the page after; none: nothing older */
  next?: string;
  loading: boolean;
  /** the first page came (an empty list is then 还没有) */
  loaded: boolean;
  error?: string;
  q: string;
  only?: BgHistoryKind;
  /** the row open on the right (on a phone: the screen after the list) */
  pick?: string;
  /** the cafe's 刚跑完的: the latest three */
  recent?: BgHistoryItem[];
}

export const useHistory = create<HistoryState>(() => ({ items: [], loading: false, loaded: false, q: '' }));

let seq = 0;

/** Conversations whose title has the words: the server knows no titles, the window does (their rows all match). */
function alsoFor(q: string): string[] | undefined {
  const w = q.trim().toLowerCase();
  if (!w) return undefined;
  const out: string[] = [];
  for (const s of useStore.getState().sessions) {
    if ((s.customTitle || s.title || '').toLowerCase().includes(w)) out.push(s.sessionId);
    if (out.length >= 200) break;
  }
  return out.length ? out : undefined;
}

function query(before?: string) {
  const { q, only } = useHistory.getState();
  const words = q.trim();
  const also = alsoFor(words);
  return { kind: 'background.historyAll' as const, limit: HISTORY_PAGE, ...(before ? { before } : {}), ...(words ? { q: words } : {}), ...(also ? { also } : {}), ...(only ? { only } : {}) };
}

const message = (e: unknown) => String((e as Error)?.message ?? e);

/** The first page again (the rows shown stay until it comes). */
export async function reloadHistory(): Promise<void> {
  const my = ++seq;
  useHistory.setState({ loading: true, error: undefined });
  try {
    const page = await ws.request<BgHistoryPage>(query());
    if (my !== seq) return;
    useHistory.setState({ items: page?.items ?? [], next: page?.next, loading: false, loaded: true });
  } catch (e) {
    if (my === seq) useHistory.setState({ loading: false, loaded: true, error: message(e) });
  }
}

/**
 * Something live ended while the list is on screen: the newest page merged into the rows shown (`mergeFirstPage` — the
 * pages scrolled to below stay). A reload or the next page asked for meanwhile wins; it cancels neither.
 */
export async function refreshHistory(): Promise<void> {
  const s = useHistory.getState();
  if (!s.loaded) return reloadHistory();
  if (s.loading) return;
  const my = seq;
  try {
    const page = await ws.request<BgHistoryPage>(query());
    if (my === seq && page) useHistory.setState((x) => ({ items: mergeFirstPage(x.items, page.items ?? []) }));
  } catch { /* the rows shown stay */ }
}

/** The page after the last row (scrolling down). */
export async function moreHistory(): Promise<void> {
  const s = useHistory.getState();
  if (s.loading || !s.next) return;
  const my = ++seq;
  useHistory.setState({ loading: true });
  try {
    const page = await ws.request<BgHistoryPage>(query(s.next));
    if (my !== seq) return;
    const have = new Set(useHistory.getState().items.map((i) => i.id));
    useHistory.setState((x) => ({ items: [...x.items, ...(page?.items ?? []).filter((i) => !have.has(i.id))], next: page?.next, loading: false }));
  } catch (e) {
    if (my === seq) useHistory.setState({ loading: false, error: message(e) });
  }
}

let typing: ReturnType<typeof setTimeout> | undefined;

/** The words (asked again a moment after the last key) or the kind (at once). */
export function setHistoryQuery(p: { q?: string; only?: BgHistoryKind | null }): void {
  if (p.only !== undefined) {
    useHistory.setState({ only: p.only ?? undefined });
    void reloadHistory();
  }
  if (p.q !== undefined) {
    useHistory.setState({ q: p.q });
    if (typing) clearTimeout(typing);
    typing = setTimeout(() => { typing = undefined; void reloadHistory(); }, 250);
  }
}

export function pickHistory(id: string | undefined): void {
  useHistory.setState({ pick: id });
}

/** The cafe's 刚跑完的 (when nobody is in it). */
export async function loadRecent(): Promise<void> {
  try {
    const page = await ws.request<BgHistoryPage>({ kind: 'background.historyAll', limit: 3 });
    useHistory.setState({ recent: page?.items ?? [] });
  } catch {
    useHistory.setState({ recent: [] });
  }
}

/** A row's task: a workflow's run read from disk; a sub-agent or a command is its row. null: it is gone. */
export async function taskOfRow(it: BgHistoryItem): Promise<BgTask | null> {
  if (it.kind !== 'workflow' || !it.runId) return taskOfItem(it);
  try { return await ws.request<BgTask | null>({ kind: 'background.run', sessionId: it.sessionId, runId: it.runId }); } catch { return null; }
}

/** 回放 in the cafe: the run read (a workflow's from disk), then played there. */
export async function replayInCafe(it: BgHistoryItem): Promise<boolean> {
  const task = await taskOfRow(it);
  if (!task) { useStore.getState().toast(tr('读不到这次运行')); return false; }
  startReplay({ id: it.id, sessionId: it.sessionId, title: rowTitle(it), task, where: 'cafe' });
  return true;
}
