// 跑过的 → 回放 (2026-11-19): one finished run played again by the times it recorded — in its graph on the 跑过的
// page, or in the cafe. One show at a time: starting one replaces the one before (the design's 「一次只演一场」).
// The clock is one requestAnimationFrame loop while it plays; the store hears from it ~15 times a second.
import { create } from 'zustand';
import type { BgTask } from '@shared';
import { replaySpan, type ReplaySpeed } from './history-model';

export type ReplayWhere = 'graph' | 'cafe';

export interface ReplayShow {
  /** the history row (BgHistoryItem.id) */
  id: string;
  sessionId: string;
  title: string;
  task: BgTask;
  where: ReplayWhere;
  /** absolute ms: the run's first and last moment */
  start: number;
  end: number;
}

interface ReplayState {
  show?: ReplayShow;
  /** ms into the run (0 … end − start) */
  t: number;
  speed: ReplaySpeed;
  playing: boolean;
}

export const useReplay = create<ReplayState>(() => ({ t: 0, speed: 60, playing: false }));

let raf = 0;
let last = 0;
let pushed = 0;
/** the clock between pushes to the store */
let clock = 0;

function frame(now: number) {
  const s = useReplay.getState();
  if (!s.show || !s.playing) { raf = 0; return; }
  // a frame after a gap (a hidden tab) plays on from where it was, not through the gap
  const dt = last ? Math.min(now - last, 250) : 0;
  last = now;
  const dur = s.show.end - s.show.start;
  clock = Math.min(dur, clock + dt * s.speed);
  if (clock >= dur) { raf = 0; useReplay.setState({ t: dur, playing: false }); return; }
  if (now - pushed >= 66) { pushed = now; useReplay.setState({ t: clock }); }
  raf = requestAnimationFrame(frame);
}

function run() {
  clock = useReplay.getState().t;
  last = 0;
  if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);
}

/** Play a run (stopping any other); `t` where to begin, `play: false` to only put it there. */
export function startReplay(show: Omit<ReplayShow, 'start' | 'end'>, o: { play?: boolean; t?: number } = {}): void {
  const { start, end } = replaySpan(show.task);
  const play = o.play ?? true;
  useReplay.setState({ show: { ...show, start, end }, t: Math.max(0, Math.min(end - start, o.t ?? 0)), playing: play });
  if (play) run();
}

/** Play / pause; at the end, play starts it over. */
export function playPause(): void {
  const s = useReplay.getState();
  if (!s.show) return;
  if (s.playing) { useReplay.setState({ playing: false, t: clock }); return; }
  const dur = s.show.end - s.show.start;
  useReplay.setState({ playing: true, t: s.t >= dur ? 0 : s.t });
  run();
}

export function pauseReplay(): void {
  const s = useReplay.getState();
  if (s.playing) useReplay.setState({ playing: false, t: clock });
}

export function seekReplay(t: number): void {
  const s = useReplay.getState();
  if (!s.show) return;
  clock = Math.max(0, Math.min(s.show.end - s.show.start, t));
  useReplay.setState({ t: clock });
}

export function setReplaySpeed(speed: ReplaySpeed): void {
  useReplay.setState({ speed });
}

export function stopReplay(): void {
  if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
  raf = 0;
  useReplay.setState({ show: undefined, t: 0, playing: false });
}
